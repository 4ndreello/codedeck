/** @jsx h */
import type { Register } from "claude-code";

import { feed, newPet, petEvent, type Pet } from "../mods/arcade/games/pet.js";
import { isBetter } from "../mods/arcade/games/best.js";
import { ARCADE_BOARDS } from "../mods/arcade/index.js";

const PET_KEY = "pet";
const COLORBLIND_KEY = "colorblind";
const bestKey = (game: string): string => `best:${game}`;

export const register: Register = (on) => {
  let pet: Pet = newPet();
  let best: Record<string, number> = {};
  let colorblind = false;
  let turnClock = 0;
  let lastTurnMs = 0;
  let openBoard: string | null = null;
  let done = 0;

  on("session.start", async ($, e, next) => {
    try {
      const savedPet = await $.store.get(PET_KEY);
      if (savedPet) pet = savedPet as Pet;
      for (const board of ARCADE_BOARDS) {
        const saved = await $.store.get(bestKey(board));
        if (typeof saved === "number") best[board] = saved;
      }
      const savedColorblind = await $.store.get(COLORBLIND_KEY);
      if (typeof savedColorblind === "boolean") colorblind = savedColorblind;
    } catch (err) {
      $.ui.log(`arcade restore failed: ${String(err)}`);
    }
    await $.command.register({ name: "arcade", immediate: true });
    return next(e);
  });

  on("command.run", { command: "arcade" }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === "") {
      openBoard = null;
      await $.ui.invalidate("ui.render");
      return { text: "arcade boards: twenty48" };
    }
    if (arg === "list") {
      return { text: "arcade boards: twenty48" };
    }
    if (arg === "open" || arg.startsWith("open ")) {
      const name = arg === "open" ? "twenty48" : arg.slice("open ".length).trim() || "twenty48";
      if (!(ARCADE_BOARDS as readonly string[]).includes(name)) {
        return { text: `no game called "${name}"` };
      }
      openBoard = name;
      await $.ui.invalidate("ui.render");
      return { text: `opened ${name}` };
    }
    if (arg === "stop") {
      openBoard = null;
      await $.ui.invalidate("ui.render");
      return { text: "arcade closed" };
    }
    return { text: `no game called "${arg}"` };
  });

  on("turn.start", async ($, e, next) => {
    turnClock = Date.now();
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    lastTurnMs = Date.now() - turnClock;
    void lastTurnMs;
    done += 1;
    await $.ui.invalidate("ui.render");
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    const r = await next(e);
    // petEvent already ignores denied calls; only classified events feed the pet.
    const command = (e as { command?: string }).command ?? undefined;
    const denied = "deny" in (r as Record<string, unknown>);
    const ok = denied ? undefined : !(r as { isError?: boolean }).isError;
    const event = petEvent({ tool: e.tool, command, ok, denied });
    if (event !== undefined) {
      pet = feed(pet, event);
      await $.store.set(PET_KEY, { xp: pet.xp, mood: pet.mood, tests: pet.tests, commits: pet.commits, edits: pet.edits });
    }
    return r;
  });

  on("ui.message", async ($, e, next) => {
    const posted = e.data as { game?: string; score?: number } | undefined;
    if (!posted || typeof posted.game !== "string" || typeof posted.score !== "number") {
      return next(e);
    }
    if (isBetter(posted.game, posted.score, best)) {
      best[posted.game] = posted.score;
      await $.store.set(bestKey(posted.game), posted.score);
      $.ui.toast(`New arcade record in ${posted.game}: ${posted.score}`);
    }
    return { game: posted.game, score: posted.score };
  });

  on("ui.render", async ($, e, next) => {
    if (e.surface !== "terminal") return await next(e);
    const { Box, Button, Client, Text } = await $.ui.resolve(e, "Box", "Button", "Client", "Text");
    if (openBoard === null) {
      return [
        <Box>
          <Text>Arcade boards</Text>
          <Button>twenty48</Button>
        </Box>,
        await next(e),
      ];
    }
    return [
      <Client module="./boards/twenty48.tsx" done={done} colorblind={colorblind} best={best[openBoard] ?? 0} />,
      await next(e),
    ];
  });
};
