import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getPaths } from "../config/paths.js";

const TOKEN_PATTERN = /^[0-9a-f]{64}\n?$/;

export interface ResolveWebTokenOptions {
  /** Directory holding `web-token`; defaults to the run-agent base directory. */
  dir?: string;
  /** Seam for the publishing `link`, so a test can lose the creation race on purpose. */
  link?: (existing: string, target: string) => void;
}

/**
 * The console token every web server on this machine shares, so a browser
 * cookie survives web child and daemon restarts. A new token is written to a
 * temp file and published with `link`, which never exposes a partial file.
 */
export function resolveWebToken(options: ResolveWebTokenOptions = {}): string {
  const file = path.join(options.dir ?? getPaths().base, "web-token");
  const stored = readToken(file);
  if (stored) return stored;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  try {
    try {
      (options.link ?? fs.linkSync)(tmp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = readToken(file);
      if (winner) return winner;
      fs.renameSync(tmp, file);
    }
    const token = readToken(file);
    if (!token) throw new Error(`could not store the web token in ${file}`);
    return token;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readToken(file: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!TOKEN_PATTERN.test(raw)) return undefined;
  if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  return raw.slice(0, 64);
}
