// Vite decides whether a specifier is a Node builtin by stripping `node:` and
// checking module.builtinModules, which contains "node:sqlite" but NOT "sqlite"
// (verified on Node v26.7.0). node:sqlite therefore looks like an npm package
// and fails to resolve. Loading it through createRequire bypasses Vite's
// resolver entirely and hands the specifier straight to Node.
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
export default sqlite;
