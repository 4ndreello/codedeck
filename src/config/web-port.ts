/** Port of the web console when `web.port` does not name another. */
export const DEFAULT_WEB_PORT = 7777;

export interface WebPortResolution {
  port: number;
  /** The raw `web.port` value when it is present but not a usable port. */
  invalid?: unknown;
}

/**
 * The preferred console port: `web.port` when it is an integer in 1-65535,
 * else 7777. The daemon and the CLI both resolve it here; the web child only
 * receives the result as an argument.
 */
export function resolveWebPort(config: { web?: unknown }): WebPortResolution {
  const web = config.web;
  if (web === undefined) return { port: DEFAULT_WEB_PORT };
  if (typeof web !== "object" || web === null || Array.isArray(web)) return { port: DEFAULT_WEB_PORT, invalid: web };
  const raw = (web as { port?: unknown }).port;
  if (raw === undefined) return { port: DEFAULT_WEB_PORT };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 65535) return { port: raw };
  return { port: DEFAULT_WEB_PORT, invalid: raw };
}

export function invalidWebPortMessage(value: unknown): string {
  return `Ignoring invalid web.port in config: ${JSON.stringify(value)}`;
}
