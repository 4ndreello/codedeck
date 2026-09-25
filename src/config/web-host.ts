import { isIP } from "node:net";

/** Bind address of the web console when `web.host` is not set. */
export const DEFAULT_WEB_HOST = "127.0.0.1";

export interface WebHostResolution {
  host: string;
  /** The raw `web.host` value when it is present but is not an IP address. */
  invalid?: unknown;
}

/**
 * Resolve `web.host` to an IP address, or use loopback when it is absent or
 * invalid. The daemon and CLI share this resolver so they make the same choice.
 */
export function resolveWebHost(config: { web?: unknown }): WebHostResolution {
  const web = config.web;
  if (web === undefined) return { host: DEFAULT_WEB_HOST };
  if (typeof web !== "object" || web === null || Array.isArray(web)) {
    return { host: DEFAULT_WEB_HOST, invalid: web };
  }
  const raw = (web as { host?: unknown }).host;
  if (raw === undefined) return { host: DEFAULT_WEB_HOST };
  if (typeof raw === "string" && isIP(raw) !== 0) return { host: raw };
  return { host: DEFAULT_WEB_HOST, invalid: raw };
}

export function invalidWebHostMessage(value: unknown): string {
  return `Ignoring invalid web.host in config: ${JSON.stringify(value)}`;
}
