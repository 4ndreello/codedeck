// Web pages and API routes need the session cookie that the token URL
// bootstraps. Tests skip the redirect and send the cookie directly.
export interface WebSessionHandle {
  port: number;
  security: { token: string };
}

export function sessionCookie(handle: WebSessionHandle): string {
  return `codedeck_ui_token_${handle.port}=${handle.security.token}`;
}

export function sessionFetch(handle: WebSessionHandle | undefined) {
  if (!handle) throw new Error("web server was not started");
  return (url: string, init: RequestInit = {}) =>
    fetch(url, {
      ...init,
      headers: { cookie: sessionCookie(handle), ...(init.headers as Record<string, string> | undefined) },
    });
}
