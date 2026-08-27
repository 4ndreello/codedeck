import type { AgentDriver, AgentInstallation } from "../core/driver.js";
import type { AgentId } from "../core/session.js";
import { ClaudeDriver } from "./claude/driver.js";
import { CodexDriver } from "./codex/driver.js";
import { OpencodeDriver } from "./opencode/driver.js";
import { OmpDriver } from "./omp/driver.js";

export class DriverRegistry {
  private drivers: Map<AgentId, AgentDriver>;

  constructor() {
    this.drivers = new Map();
    this.register(new ClaudeDriver());
    this.register(new CodexDriver());
    this.register(new OpencodeDriver());
    this.register(new OmpDriver());
  }

  register(driver: AgentDriver): void {
    this.drivers.set(driver.id, driver);
  }

  get(agent: AgentId): AgentDriver {
    const d = this.drivers.get(agent);
    if (!d) throw new Error(`Unknown agent: ${agent}`);
    return d;
  }

  has(agent: AgentId): boolean {
    return this.drivers.has(agent);
  }

  list(): AgentDriver[] {
    return [...this.drivers.values()];
  }

  async detectAll(): Promise<Record<AgentId, AgentInstallation>> {
    const result: Record<string, AgentInstallation> = {};
    await Promise.all(
      [...this.drivers.entries()].map(async ([id, driver]) => {
        try {
          result[id] = await driver.detect();
        } catch (e) {
          result[id] = { installed: false, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return result as Record<AgentId, AgentInstallation>;
  }
}

let singleton: DriverRegistry | null = null;

export function getRegistry(): DriverRegistry {
  if (!singleton) singleton = new DriverRegistry();
  return singleton;
}
