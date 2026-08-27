#!/usr/bin/env npx tsx
/**
 * Spike for Claude Code harness
 * Proves:
 * 1. detectar instalação
 * 2. iniciar harness
 * 3. enviar prompt
 * 4. receber eventos estruturados
 * 5. identificar sessão nativa
 * 6. detectar conclusão
 * 7. interromper
 * 8. continuar sessão
 * 9. capturar stderr e falhas
 * 10. finalizar corretamente
 */
import { ClaudeDriver } from "../src/drivers/claude/driver.js";

async function main() {
  const driver = new ClaudeDriver();
  console.log("=== Claude Spike ===\n");

  console.log("1. detect()");
  const inst = await driver.detect();
  console.log(JSON.stringify(inst, null, 2));
  if (!inst.installed) { console.log("Claude not installed, aborting"); return; }

  console.log("\n2. capabilities()");
  console.log(driver.capabilities());

  console.log("\n3. start() - simple prompt");
  const sessionId = "spike-claude-" + Date.now().toString(36);
  const sess = await driver.start({
    sessionId,
    prompt: "what is 2+2? answer with just the number, no explanation",
    cwd: process.cwd(),
  });
  console.log(`Started pid=${sess.pid} native=${sess.nativeSessionId}`);

  console.log("\n4. events() - streaming");
  let nativeId: string | undefined;
  let completed = false;
  let message = "";
  const timeout = setTimeout(async () => {
    if (!completed) {
      console.log("\n7. stop() - interrupting (timeout)");
      await driver.stop(sess);
    }
  }, 20000);

  for await (const ev of driver.events(sess as any)) {
    console.log(`  event: ${ev.type} ${ev.type === "message" ? (ev as any).content.slice(0, 80) : ""} ${ev.type === "session.failed" ? (ev as any).error : ""}`);
    if ((ev as any).nativeSessionId) nativeId = (ev as any).nativeSessionId;
    if (ev.raw && (ev.raw as any).session_id) nativeId = (ev.raw as any).session_id;
    if (ev.type === "message") message += (ev as any).content;
    if (ev.type === "session.completed") { completed = true; console.log("\n6. detected completion"); break; }
    if (ev.type === "session.failed") { completed = true; console.log("\n9. captured failure:", (ev as any).error.slice(0, 500)); break; }
  }
  clearTimeout(timeout);
  console.log(`\n5. nativeSessionId: ${nativeId || sess.nativeSessionId || (driver.getHandle(sessionId)?.nativeSessionId)}`);
  console.log(`   message: ${message.slice(0, 200)}`);

  if (nativeId && completed) {
    console.log("\n8. resume() - continuing session");
    try {
      await driver.send({ id: sessionId, nativeSessionId: nativeId, cwd: process.cwd() } as any, "what is 3+3? answer with just the number");
      console.log("   resume spawned");
      for await (const ev of driver.events({ id: sessionId } as any)) {
        console.log(`  resume event: ${ev.type} ${ev.type === "message" ? (ev as any).content.slice(0, 80) : ""}`);
        if (ev.type === "session.completed" || ev.type === "session.failed") break;
      }
    } catch (e) {
      console.log("   resume failed:", e instanceof Error ? e.message : String(e));
    }
  }

  console.log("\n10. process finalized");
  console.log("Spike done");
}

main().catch((e) => { console.error(e); process.exit(1); });
