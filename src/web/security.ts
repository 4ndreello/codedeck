import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebSecurity {
  port: number;
  token: string;
  cookieName: string;
}

export interface WebRoutePolicy {
  htmlPage?: boolean;
}

export const WEB_FORBIDDEN_MESSAGE = "forbidden";

export function createWebSecurity(port: number): WebSecurity {
  const token = randomBytes(32).toString("hex");
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

  if (policy.htmlPage) {
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    if (request.method === "GET" && redirectWithSessionCookie(request, response, security)) return false;
  }

  return true;
}

function hasValidActionCredentials(request: IncomingMessage, security: WebSecurity): boolean {
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${security.cookieName}=`));
  if (cookie?.slice(security.cookieName.length + 1) !== security.token) return false;

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
  response.setHeader(
    "Set-Cookie",
    `${security.cookieName}=${security.token}; Path=/; HttpOnly; SameSite=Strict`,
  );
  response.writeHead(303, { Location: `${url.pathname}${url.search}` });
  response.end();
  return true;
}

function reject(response: ServerResponse): void {
  response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
  response.end(WEB_FORBIDDEN_MESSAGE);
}
