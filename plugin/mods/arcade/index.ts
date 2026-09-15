// Arcade mod: a single demo board (twenty48) plus a companion pet that
// feeds on tool activity. The manifest declaration for this mod lands in a
// parallel slice; this file only names the mod and its boards.

export const ARCADE_MOD_NAME = "arcade";

export const ARCADE_BOARDS = ["twenty48"] as const;

export type ArcadeBoardName = (typeof ARCADE_BOARDS)[number];

export const ARCADE_BOARD_MODULES: Record<ArcadeBoardName, string> = {
  twenty48: "hooks/boards/twenty48.tsx",
};
