/**
 * Display name of this CLI.
 *
 * `CODEDECK_CLI_NAME` overrides it, so a local alias can present itself
 * under another name (for example `codedeck-dev`) in `--help`, examples
 * and follow-up hints. Blank or unset falls back to the published name.
 */
export function getCliName(): string {
  const raw = process.env.CODEDECK_CLI_NAME?.trim();
  return raw || "codedeck";
}

/**
 * How examples and hints should invoke the CLI. The published tool runs
 * through npx, while a renamed alias already is the command.
 */
export function getCliInvocation(): string {
  const name = getCliName();
  return name === "codedeck" ? "npx codedeck" : name;
}
