import type { Session } from "../core/session.js";

export const AUTO_RESUME_PROMPT =
  "The previous turn was interrupted by a system shutdown before it finished. Inspect `git status` and `git diff` before acting, then continue the original task from where it stopped.";

export interface AutoResumeEligibilityOptions {
  now: Date;
  maxAgeHours: number;
  canResume: boolean;
  liveIdentity: boolean;
}

export function isAutoResumeEligible(
  session: Session,
  { now, maxAgeHours, canResume, liveIdentity }: AutoResumeEligibilityOptions,
): boolean {
  if (session.status !== "interrupted") return false;
  if (session.failure?.code !== "SHUTDOWN" || session.failure.retryable !== true) return false;
  if (session.origin === "open" || !session.nativeSessionId || !canResume || liveIdentity) return false;
  const interruptedAt = session.completedAt ?? session.updatedAt;
  const ageMs = now.getTime() - interruptedAt.getTime();
  return ageMs <= maxAgeHours * 60 * 60 * 1000;
}
