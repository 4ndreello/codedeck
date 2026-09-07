import type { OrchestratorMode } from "../config/orchestrator-mode.js";

export function composeOrchestratorProse(mode: OrchestratorMode): string {
  const lines: string[] = [];

  if (mode.investigate !== "none" || mode.selfWork !== "none") {
    lines.push(`Investigation allowance: ${mode.investigate}.`);
    lines.push(`Self-work allowance: ${mode.selfWork}.`);
  }

  if (mode.parallelism !== undefined) {
    lines.push(`Run at most ${mode.parallelism} workers concurrently.`);
  }

  return lines.join("\n");
}
