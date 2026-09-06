import type { Role } from "../../core/roles.js";

export type PermissionValue = "allow" | "ask" | "deny";

/**
 * Claude `tools:` becomes opencode `permission:`. Every key below was
 * resolved live through `opencode debug agent`: `edit: deny` turns off edit
 * and write, `read: deny` turns off read with bash intact, `task: deny`
 * turns off dispatch, and `"*": "allow"` turns everything on. No role leans
 * on user defaults, so `general` stays unrestricted and the restricted three
 * stay restricted whatever the user configured globally.
 */
export function rolePermission(role: Role): Record<string, PermissionValue> {
  switch (role) {
    case "general":
      return { "*": "allow" };
    case "orchestrator":
      return { read: "deny", edit: "deny", write: "deny", task: "deny", bash: "allow" };
    case "reviewer":
      return { edit: "deny", write: "deny", task: "deny", bash: "allow" };
    case "auditor":
      return { edit: "deny", write: "deny", task: "allow", bash: "allow" };
  }
}
