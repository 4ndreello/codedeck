// Copies plugin/ into dist/ so the launcher can find it in an installed
// package. Node rather than `rm -rf && cp -r`, which npm runs through cmd on
// Windows, where neither exists and the build fails before it copies anything.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "dist", "plugin");

rmSync(target, { recursive: true, force: true });
cpSync(join(root, "plugin"), target, { recursive: true });
