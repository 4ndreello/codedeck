import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebSecurity {
  port: number;
  token: string;
  cookieName: string;
}

export interface WebRoutePolicy {
  htmlPage?: boolean;
  api?: boolean;
}

export const WEB_FORBIDDEN_MESSAGE = "forbidden";
export const WEB_PAGE_FORBIDDEN_MESSAGE = 'Run "codedeck ui" once in a terminal to open CodeDeck in this browser.';
/** One year: a bookmark keeps working as long as the page is opened at least once a year. */
export const WEB_COOKIE_MAX_AGE_SECONDS = 31_536_000;

export function createWebSecurity(port: number, token = randomBytes(32).toString("hex")): WebSecurity {
  return {
    port,
    token,
    cookieName: `codedeck_ui_token_${port}`,
  };
}

export function isAllowedWebHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

export function getTokenUrl(url: string, token: string): string {
  const tokenUrl = new URL(url);
  tokenUrl.searchParams.set("t", token);
  return tokenUrl.toString();
}

export function checkWebRequest(
  request: IncomingMessage,
  response: ServerResponse,
  security: WebSecurity,
  policy: WebRoutePolicy = {},
): boolean {
  if (!isAllowedWebHost(request.headers.host, security.port)) {
    reject(response);
    return false;
  }

  if (request.method === "POST" && !hasValidActionCredentials(request, security)) {
    reject(response);
    return false;
  }

  if (policy.api && !hasSessionCookie(request, security)) {
    reject(response);
    return false;
  }

  if (policy.htmlPage) {
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    if (request.method === "GET") {
      if (redirectToCanonicalHost(request, response, security)) return false;
      if (redirectWithSessionCookie(request, response, security)) return false;
      if (!hasSessionCookie(request, security)) {
        reject(response, WEB_PAGE_FORBIDDEN_MESSAGE);
        return false;
      }
      response.setHeader("Set-Cookie", sessionCookie(security));
    }
  }

  return true;
}

function hasSessionCookie(request: IncomingMessage, security: WebSecurity): boolean {
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${security.cookieName}=`));
  return cookie?.slice(security.cookieName.length + 1) === security.token;
}

function hasValidActionCredentials(request: IncomingMessage, security: WebSecurity): boolean {
  if (!hasSessionCookie(request, security)) return false;

  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;

  try {
    const parsedOrigin = new URL(origin);
    return (
      parsedOrigin.protocol === "http:" &&
      parsedOrigin.host.toLowerCase() === host.toLowerCase() &&
      parsedOrigin.port === String(security.port)
    );
  } catch {
    return false;
  }
}

function redirectWithSessionCookie(
  request: IncomingMessage,
  response: ServerResponse,
  security: WebSecurity,
): boolean {
  let url: URL;
  try {
    url = new URL(request.url || "/", `http://127.0.0.1:${security.port}`);
  } catch {
    return false;
  }

  const tokens = url.searchParams.getAll("t");
  if (tokens.length !== 1 || tokens[0] !== security.token) return false;

  url.searchParams.delete("t");
  response.setHeader("Set-Cookie", sessionCookie(security));
  response.writeHead(303, { Location: `${url.pathname}${url.search}` });
  response.end();
  return true;
}

function sessionCookie(security: WebSecurity): string {
  return `${security.cookieName}=${security.token}; Path=/; Max-Age=${WEB_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict`;
}

// A cookie set for 127.0.0.1 is never sent to localhost (RFC 6265 5.1.3), so
// pages live on 127.0.0.1 only and a localhost bookmark is sent there.
function redirectToCanonicalHost(
  request: IncomingMessage,
  response: ServerResponse,
  security: WebSecurity,
): boolean {
  if (request.headers.host?.toLowerCase() !== `localhost:${security.port}`) return false;
  let url: URL;
  try {
    url = new URL(request.url || "/", `http://127.0.0.1:${security.port}`);
  } catch {
    return false;
  }
  response.writeHead(302, { Location: `http://127.0.0.1:${security.port}${url.pathname}${url.search}` });
  response.end();
  return true;
}

function reject(response: ServerResponse, message = WEB_FORBIDDEN_MESSAGE): void {
  response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}
