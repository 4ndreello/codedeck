import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";
import type {
  ClaimAddResult,
  ClaimQueryResult,
  ClaimReleaseResult,
} from "../../daemon/protocol.js";
import type { Claim } from "../../store/claims.js";

interface ClaimsCommandOptions {
  json?: boolean;
  reason?: string;
  session?: string;
}

class ClaimsCommandError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ClaimsCommandError";
  }
}

function publicClaim(claim: Claim): Claim {
  return {
    id: claim.id,
    sessionId: claim.sessionId,
    pathGlob: claim.pathGlob,
    reason: claim.reason,
    createdAt: claim.createdAt,
    active: claim.active,
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return "CLAIMS_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(error: unknown, json: boolean): void {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (json) {
    console.error(JSON.stringify({ error: { code, message } }));
  } else {
    console.error(`Claims error [${code}]: ${message}`);
  }
  process.exitCode = 1;
}

function resolveSessionId(options: ClaimsCommandOptions): string {
  const sessionId = options.session?.trim();
  if (!sessionId) {
    throw new ClaimsCommandError(
      "--session <id> is required; daemon-managed workers do not expose their session id in the environment",
      "SESSION_REQUIRED",
    );
  }
  return sessionId;
}

function resolveReason(options: ClaimsCommandOptions): string {
  if (options.reason === undefined) {
    throw new ClaimsCommandError("--reason <text> is required", "REASON_REQUIRED");
  }
  return options.reason;
}

function resolveClaimId(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ClaimsCommandError(`Invalid claim id "${value}"`, "INVALID_CLAIM_ID");
  }
  const claimId = Number(value);
  if (!Number.isSafeInteger(claimId) || claimId <= 0) {
    throw new ClaimsCommandError(`Invalid claim id "${value}"`, "INVALID_CLAIM_ID");
  }
  return claimId;
}

function printClaim(claim: Claim, verb: string): void {
  console.log(`${verb} claim #${claim.id} ${claim.pathGlob} for session ${claim.sessionId}: ${claim.reason}`);
}

function printClaims(claims: readonly Claim[]): void {
  if (claims.length === 0) {
    console.log("No active claims");
    return;
  }
  for (const claim of claims) {
    console.log(`#${claim.id} ${claim.pathGlob}  ${claim.sessionId}  ${claim.reason}`);
  }
}

export function registerClaimsCommand(program: Command): void {
  const claims = program
    .command("claims")
    .description("List and manage cooperative agent path claims");

  claims
    .command("add")
    .description("Claim a path glob for a session")
    .argument("<pathGlob>", "path or glob to claim")
    .option("--reason <text>", "short reason for the claim (required)")
    .option("--session <id>", "CodeDeck session id (required)")
    .option("--json", "output the claim envelope as JSON")
    .action(async (pathGlob: string, options: ClaimsCommandOptions) => {
      try {
        const sessionId = resolveSessionId(options);
        const reason = resolveReason(options);
        const client = new IpcClient();
        try { await client.ensureDaemonStarted(); } catch {}
        const result = await client.request<ClaimAddResult>("claims.add", {
          sessionId,
          pathGlob,
          reason,
        });
        const claim = publicClaim(result.claim);
        if (options.json) console.log(JSON.stringify({ claim }));
        else printClaim(claim, "Added");
      } catch (error) {
        reportError(error, options.json === true);
      }
    });

  claims
    .command("list")
    .description("List active claims, optionally limited to an overlapping path")
    .argument("[pathOrGlob]", "path or glob to query")
    .option("--session <id>", "CodeDeck session id (required)")
    .option("--json", "output the claims envelope as JSON")
    .action(async (pathOrGlob: string | undefined, options: ClaimsCommandOptions) => {
      try {
        const sessionId = resolveSessionId(options);
        const params = pathOrGlob === undefined
          ? { sessionId }
          : { sessionId, path: pathOrGlob };
        const client = new IpcClient();
        try { await client.ensureDaemonStarted(); } catch {}
        const result = await client.request<ClaimQueryResult>("claims.query", params);
        const claims = result.claims.map(publicClaim);
        if (options.json) console.log(JSON.stringify({ claims }));
        else printClaims(claims);
      } catch (error) {
        reportError(error, options.json === true);
      }
    });

  claims
    .command("release")
    .description("Release a claim owned by a session")
    .argument("<claimId>", "claim id to release")
    .option("--session <id>", "CodeDeck session id (required)")
    .option("--json", "output the claim envelope as JSON")
    .action(async (claimIdValue: string, options: ClaimsCommandOptions) => {
      try {
        const sessionId = resolveSessionId(options);
        const claimId = resolveClaimId(claimIdValue);
        const client = new IpcClient();
        try { await client.ensureDaemonStarted(); } catch {}
        const result = await client.request<ClaimReleaseResult>("claims.release", {
          sessionId,
          claimId,
        });
        const claim = publicClaim(result.claim);
        if (options.json) console.log(JSON.stringify({ claim }));
        else printClaim(claim, "Released");
      } catch (error) {
        reportError(error, options.json === true);
      }
    });
}
