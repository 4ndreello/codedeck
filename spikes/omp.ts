#!/usr/bin/env npx tsx
import { OmpDriver } from "../src/drivers/omp/driver.js";

async function main() {
  const driver = new OmpDriver();
  console.log("=== OMP Spike ===\n");
  console.log("1. detect()");
  console.log(JSON.stringify(await driver.detect(), null, 2));
  console.log("\n2. capabilities()");
  console.log(driver.capabilities());

  const sessionId = "spike-omp-" + Date.now().toString(36);
  console.log("\n3. start()");
  const sess = await driver.start({
    sessionId,
    prompt: "what is 2+2? answer with just the number, no explanation",
    cwd: process.cwd(),
  });
  console.log(`Started pid=${sess.pid}`);

  let nativeId: string | undefined;
  let completed = false;
  const timeout = setTimeout(async () => {
    if (!completed) { console.log("\n7. stop()"); await driver.stop(sess as any); }
  }, 20000);

  for await (const ev of driver.events(sess as any)) {
    console.log(`  event: ${ev.type} ${ev.type === "message" ? (ev as any).content.slice(0, 80) : ev.type === "session.failed" ? (ev as any).error.slice(0, 300) : ""}`);
    if ((ev as any).nativeSessionId) nativeId = (ev as any).nativeSessionId;
    if (ev.type === "session.completed" || ev.type === "session.failed") { completed = true; console.log(`\n6. ${ev.type}`); break; }
  }
  clearTimeout(timeout);
  console.log(`\n5. native: ${nativeId || (driver.getHandle(sessionId)?.nativeSessionId)}`);

  if (nativeId) {
    console.log("\n8. resume");
    try {
      await driver.send({ id: sessionId, nativeSessionId: nativeId, cwd: process.cwd() } as any, "what is 3+3? answer with just the number");
      for await (const ev of driver.events({ id: sessionId } as any)) {
        console.log(`  resume event: ${ev.type}`);
        if (ev.type === "session.completed" || ev.type === "session.failed") break;
      }
    } catch (e) { console.log("resume failed", e instanceof Error ? e.message : String(e)); }
  }
  console.log("\n10. done");
}
main().catch((e) => { console.error(e); process.exit(1); });
