import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentFile = (name: string) => path.join(root, "plugin", "agents", `${name}.md`);

describe("orchestrator tier agent files", () => {
  it.each(["orchestrator", "orchestrator-read", "orchestrator-edit"])(
    "pins the frontmatter and body for %s",
    (name) => {
      expect(fs.readFileSync(agentFile(name), "utf8")).toMatchSnapshot();
    },
  );
});
