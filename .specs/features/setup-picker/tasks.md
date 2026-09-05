# Setup Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar o wizard de linha única por um picker em raw mode, uma tela por agente, filtrável e rolável.

**Architecture:** Três camadas com fronteira dura. `ui.ts` desenha frames a partir de estado e não toca em I/O. `picker.ts` tem a máquina de estado pura e, separada dela, a sessão de raw mode que é dona do stdin, dos listeners e da limpeza. `setup.ts` orquestra: monta telas, roda a sessão, persiste.

**Tech Stack:** Node >= 24, ESM, TypeScript strict, vitest. `node:readline` (`emitKeypressEvents`) e `process.stdin.setRawMode`, ambos stdlib.

**Spec:** `.specs/features/setup-picker/spec.md`

## Global Constraints

- Uma única dependência de runtime: `commander`. Nenhuma biblioteca de TUI pode ser adicionada.
- Node >= 24, ESM, TypeScript strict, ES2022.
- **Nunca rodar a suíte inteira.** Sempre `npx vitest run <arquivo>` ou com `-t`.
- Commits em inglês, conventional commits, imperativo, máximo 70 caracteres no subject.
- Sem travessão (—) em nenhum texto.
- Deixar o `undefined` implícito do JS valer: nada de `return` solto no fim de função.
- `runModelSetupWizard` é o **dono único** de raw mode, listeners e limpeza. Nenhuma função por agente instala ou remove esses recursos.
- Ordem obrigatória de partida: validar TTY nos dois streams; anunciar descoberta; descobrir **sem** raw mode; ler dimensões; sair se menos de 8 linhas; instalar handlers; ligar raw mode; instalar resize; rodar telas; persistir.

---

## Estrutura de arquivos

| arquivo | responsabilidade |
| - | - |
| `src/cli/ui.ts` (modificar) | Primitivas puras de texto: cor como fábrica, largura ciente de ANSI, truncamento, e o renderer de frame. Não lê `process`. |
| `src/cli/picker-state.ts` (criar) | Máquina de estado pura: tecla mais estado dá estado novo mais ação. Sem I/O, sem timers. |
| `src/cli/picker.ts` (criar) | Sessão de raw mode: adquire stdin uma vez, encaminha teclas pra máquina, redesenha, restaura. |
| `src/cli/commands/setup.ts` (modificar) | Monta as telas a partir de `HarnessModels`, roda a sessão, junta e grava. |
| `src/cli/commands/open.ts` (modificar) | Só a mensagem de recuperação quando o modelo salvo saiu do catálogo. |
| `tests/ui-render.test.ts` (criar) | Primitivas e frames. |
| `tests/picker-state.test.ts` (criar) | Máquina de estado, incluindo paste e confirmação. |
| `tests/picker-session.test.ts` (criar) | Sessão dirigida por stdin falso, e a limpeza. |
| `tests/setup-wizard.test.ts` (modificar) | Telas, gravação, e os seis testes portados. |

---

## Task 1: Primitivas de texto em `ui.ts`

Cobre `SETUP-20`, `SETUP-24`.

**Files:**
- Modify: `src/cli/ui.ts`
- Test: `tests/ui-render.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  export interface Dimensions { rows: number; columns: number }
  export interface Colors { bold(s: string): string; dim(s: string): string; invert(s: string): string }
  export function colors(enabled: boolean): Colors
  export function visibleWidth(text: string): number
  export function truncate(text: string, width: number): string
  export function readDimensions(stdout: { rows?: number; columns?: number }): Dimensions
  ```

- [ ] **Step 1: Write the failing test**

Criar `tests/ui-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { colors, readDimensions, truncate, visibleWidth } from "../src/cli/ui.js";

describe("text primitives", () => {
  // Com cor ligada, string.length conta os escapes e mente sobre a largura.
  it("measures width without counting ANSI escapes", () => {
    const painted = colors(true).bold("abcde");

    expect(painted.length).toBeGreaterThan(5);
    expect(visibleWidth(painted)).toBe(5);
  });

  it("returns plain text when color is off, so width is length", () => {
    const plain = colors(false).bold("abcde");

    expect(plain).toBe("abcde");
    expect(visibleWidth(plain)).toBe(5);
  });

  // Um id de 55 caracteres enrolava e quebrava a conta do redraw.
  it("truncates to the visible width it was given", () => {
    const id = "amazon-bedrock/anthropic.claude-3-5-haiku-20241022-v1:0";

    expect(visibleWidth(truncate(id, 20))).toBeLessThanOrEqual(20);
    expect(truncate(id, 20)).toContain("amazon");
  });

  it("leaves a string that already fits untouched", () => {
    expect(truncate("short", 20)).toBe("short");
  });

  it("truncates painted text without cutting an escape in half", () => {
    const painted = colors(true).bold("abcdefghij");
    const cut = truncate(painted, 4);

    expect(visibleWidth(cut)).toBeLessThanOrEqual(4);
    expect(cut.endsWith("[0m")).toBe(true);
  });

  // Um pty sem winsize reporta 0, e `??` deixava passar.
  it.each([
    ["reported size", { rows: 40, columns: 120 }, { rows: 40, columns: 120 }],
    ["zero from a pty with no winsize", { rows: 0, columns: 0 }, { rows: 24, columns: 80 }],
    ["absent off a tty", {}, { rows: 24, columns: 80 }],
  ])("normalizes %s", (_label, given, expected) => {
    expect(readDimensions(given)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui-render.test.ts`
Expected: FAIL, `colors`, `visibleWidth`, `truncate` e `readDimensions` não existem em `ui.ts`.

- [ ] **Step 3: Write minimal implementation**

Em `src/cli/ui.ts`, acrescentar:

```ts
export interface Dimensions {
  rows: number;
  columns: number;
}

export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  invert(s: string): string;
}

const RESET = "[0m";

/**
 * Cor é fábrica, não leitura de ambiente, porque o renderer precisa ser puro:
 * com cor desligada nos testes, largura visível é o comprimento da string.
 */
export function colors(enabled: boolean): Colors {
  const paint = (code: string) => (s: string) => (enabled ? `[${code}m${s}${RESET}` : s);
  return { bold: paint("1"), dim: paint("2"), invert: paint("7") };
}

const ANSI = /\[[0-9;]*m/g;

export function visibleWidth(text: string): number {
  return text.replace(ANSI, "").length;
}

/**
 * Corta contando só caracteres visíveis e devolve os escapes abertos ao fim,
 * senão a cor vaza para o resto da linha.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;

  let out = "";
  let seen = 0;
  let painted = false;
  ANSI.lastIndex = 0;
  for (let i = 0; i < text.length; ) {
    ANSI.lastIndex = i;
    const match = ANSI.exec(text);
    if (match && match.index === i) {
      out += match[0];
      painted = match[0] !== RESET;
      i += match[0].length;
      continue;
    }
    if (seen === width) break;
    out += text[i];
    seen += 1;
    i += 1;
  }
  return painted ? `${out}${RESET}` : out;
}

const FALLBACK: Dimensions = { rows: 24, columns: 80 };

/**
 * `0` e `undefined` são a mesma coisa aqui: um terminal que não disse o tamanho.
 * `??` trataria `0` como resposta e colapsaria toda grade para uma coluna.
 */
export function readDimensions(stdout: { rows?: number; columns?: number }): Dimensions {
  return {
    rows: stdout.rows || FALLBACK.rows,
    columns: stdout.columns || FALLBACK.columns,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui-render.test.ts`
Expected: PASS, 7 testes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ui.ts tests/ui-render.test.ts
git commit -m "feat(ui): add ANSI-aware width, truncation and color factory"
```

---

## Task 2: Máquina de estado do picker

Cobre `SETUP-10`, `SETUP-11`, `SETUP-12`, `SETUP-13`, `SETUP-04` (filtro), `SETUP-45` (confirmação).

**Files:**
- Create: `src/cli/picker-state.ts`
- Test: `tests/picker-state.test.ts`

**Interfaces:**
- Consumes: nada de Task 1.
- Produces:
  ```ts
  export interface PickerItem { id: string; label: string; group?: string; note?: string; synthetic?: true }
  export interface Screen {
    agent: string; title: string; counter: string; error?: string;
    items: PickerItem[]; pinned: boolean; known: ReadonlySet<string>;
  }
  export interface PickerState {
    screen: Screen; filter: string; cursor: number; offset: number;
    pasting: boolean; confirming?: string;
  }
  export interface Key { sequence: string; name?: string; ctrl: boolean; meta: boolean }
  export type PickerAction =
    | { kind: "none" } | { kind: "picked"; id: string }
    | { kind: "skipped" } | { kind: "aborted" };
  export function initialState(screen: Screen): PickerState
  export function visibleItems(state: PickerState): PickerItem[]
  export function applyKey(state: PickerState, key: Key, viewport: number): { state: PickerState; action: PickerAction }
  ```

- [ ] **Step 1: Write the failing test**

Criar `tests/picker-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyKey,
  initialState,
  visibleItems,
  type Key,
  type Screen,
} from "../src/cli/picker-state.js";

const key = (name: string, extra: Partial<Key> = {}): Key => ({
  sequence: extra.sequence ?? name,
  name,
  ctrl: false,
  meta: false,
  ...extra,
});

const screen = (overrides: Partial<Screen> = {}): Screen => ({
  agent: "opencode",
  title: "opencode",
  counter: "agente 3 de 4",
  pinned: false,
  known: new Set(["opencode/big-pickle", "opencode/claude-sonnet-4-6", "openrouter/z-ai/glm-5"]),
  items: [
    { id: "opencode/big-pickle", label: "opencode/big-pickle", group: "opencode" },
    { id: "opencode/claude-sonnet-4-6", label: "opencode/claude-sonnet-4-6", group: "opencode" },
    { id: "openrouter/z-ai/glm-5", label: "openrouter/z-ai/glm-5", group: "openrouter" },
  ],
  ...overrides,
});

const press = (state: ReturnType<typeof initialState>, keys: Key[], viewport = 10) =>
  keys.reduce(
    (acc, k) => {
      const next = applyKey(acc.state, k, viewport);
      return { state: next.state, action: next.action.kind === "none" ? acc.action : next.action };
    },
    { state, action: { kind: "none" } as ReturnType<typeof applyKey>["action"] },
  );

describe("navigation", () => {
  it("moves the cursor and picks the highlighted item", () => {
    const { action } = press(initialState(screen()), [key("down"), key("return")]);

    expect(action).toEqual({ kind: "picked", id: "opencode/claude-sonnet-4-6" });
  });

  it("stops at the ends instead of wrapping", () => {
    const top = press(initialState(screen()), [key("up"), key("up")]);
    expect(top.state.cursor).toBe(0);

    const bottom = press(initialState(screen()), [key("down"), key("down"), key("down"), key("down")]);
    expect(bottom.state.cursor).toBe(2);
  });
});

describe("filtering", () => {
  it("narrows on every keystroke and resets the cursor to the top", () => {
    const { state } = press(initialState(screen()), [key("down"), ...[..."glm"].map((c) => key(c))]);

    expect(state.filter).toBe("glm");
    expect(visibleItems(state).map((item) => item.id)).toEqual(["openrouter/z-ai/glm-5"]);
    expect(state.cursor).toBe(0);
  });

  it("matches case-insensitively", () => {
    const { state } = press(initialState(screen()), [key("G"), key("L")]);

    expect(visibleItems(state)).toHaveLength(1);
  });

  it("drops the last character on backspace", () => {
    const { state } = press(initialState(screen()), [key("g"), key("l"), key("backspace")]);

    expect(state.filter).toBe("g");
  });

  // Sem itens reais, a única linha é a que grava o texto cru.
  it("offers a synthetic row when nothing matches", () => {
    const { state } = press(initialState(screen()), [...[..."zzz"].map((c) => key(c))]);
    const items = visibleItems(state);

    expect(items).toHaveLength(1);
    expect(items[0].synthetic).toBe(true);
    expect(items[0].id).toBe("zzz");
  });

  // Catálogo vazio abre já sem lista, e Enter no vazio não pode gravar "".
  it("refuses to pick an empty synthetic id", () => {
    const empty = initialState(screen({ items: [], known: new Set() }));
    const { action } = press(empty, [key("return")]);

    expect(action).toEqual({ kind: "none" });
  });
});

describe("skip and abort", () => {
  it("skips on ctrl-g", () => {
    const { action } = press(initialState(screen()), [key("g", { ctrl: true, sequence: "" })]);

    expect(action).toEqual({ kind: "skipped" });
  });

  // Raw mode não gera SIGINT: o ctrl-c chega como byte e a máquina trata.
  it("aborts on ctrl-c", () => {
    const { action } = press(initialState(screen()), [key("c", { ctrl: true, sequence: "" })]);

    expect(action).toEqual({ kind: "aborted" });
  });

  // Esc sozinho leva 500ms e uma seta fragmentada chega como escape isolado.
  it("does not skip on escape", () => {
    const { action } = press(initialState(screen()), [key("escape", { sequence: "" })]);

    expect(action).toEqual({ kind: "none" });
  });
});

describe("bracketed paste", () => {
  // Colar "alpha\nbeta" escolhia um modelo no meio da colagem.
  it("buffers the whole paste into the filter without acting on it", () => {
    const start = key("paste-start", { sequence: "[200~" });
    const end = key("paste-end", { sequence: "[201~" });
    const body = [...[..."alpha"].map((c) => key(c)), key("return"), ...[..."beta"].map((c) => key(c))];

    const { state, action } = press(initialState(screen()), [start, ...body, end]);

    expect(state.filter).toBe("alphabeta");
    expect(state.pasting).toBe(false);
    expect(action).toEqual({ kind: "none" });
  });

  it("ignores arrows and ctrl-g while pasting", () => {
    const start = key("paste-start", { sequence: "[200~" });
    const end = key("paste-end", { sequence: "[201~" });

    const { state, action } = press(initialState(screen()), [
      start,
      key("down"),
      key("g", { ctrl: true, sequence: "" }),
      end,
    ]);

    expect(state.cursor).toBe(0);
    expect(action).toEqual({ kind: "none" });
  });
});

describe("confirming an id the catalog does not know", () => {
  const typed = (text: string) => press(initialState(screen()), [...text].map((c) => key(c)));

  it("asks before writing and writes on the second enter", () => {
    const first = applyKey(typed("nope").state, key("return"), 10);
    expect(first.action).toEqual({ kind: "none" });
    expect(first.state.confirming).toBe("nope");

    const second = applyKey(first.state, key("return"), 10);
    expect(second.action).toEqual({ kind: "picked", id: "nope" });
  });

  it("cancels the confirmation on any other key", () => {
    const first = applyKey(typed("nope").state, key("return"), 10);
    const cancelled = applyKey(first.state, key("x"), 10);

    expect(cancelled.state.confirming).toBeUndefined();
    expect(cancelled.action).toEqual({ kind: "none" });
  });

  // Id que o catálogo conhece não precisa de segunda pergunta.
  it("writes a known id on the first enter", () => {
    const { action } = press(initialState(screen()), [
      ...[..."big-pickle"].map((c) => key(c)),
      key("return"),
    ]);

    expect(action).toEqual({ kind: "picked", id: "opencode/big-pickle" });
  });
});

describe("viewport", () => {
  it("scrolls the offset to keep the cursor visible", () => {
    const many = screen({
      items: Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, label: `m-${i}`, group: "g" })),
      known: new Set(),
    });
    const { state } = press(initialState(many), Array.from({ length: 12 }, () => key("down")), 5);

    expect(state.cursor).toBe(12);
    expect(state.offset).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/picker-state.test.ts`
Expected: FAIL, `src/cli/picker-state.ts` não existe.

- [ ] **Step 3: Write minimal implementation**

Criar `src/cli/picker-state.ts`:

```ts
export interface PickerItem {
  id: string;
  label: string;
  group?: string;
  note?: string;
  synthetic?: true;
}

export interface Screen {
  agent: string;
  title: string;
  counter: string;
  error?: string;
  items: PickerItem[];
  /** `items[0]` é linha fixa, desenhada acima dos cabeçalhos de provider. */
  pinned: boolean;
  known: ReadonlySet<string>;
}

export interface PickerState {
  screen: Screen;
  filter: string;
  cursor: number;
  offset: number;
  pasting: boolean;
  /** Texto aguardando o segundo Enter porque o catálogo não o conhece. */
  confirming?: string;
}

export interface Key {
  sequence: string;
  name?: string;
  ctrl: boolean;
  meta: boolean;
}

export type PickerAction =
  | { kind: "none" }
  | { kind: "picked"; id: string }
  | { kind: "skipped" }
  | { kind: "aborted" };

export function initialState(screen: Screen): PickerState {
  return { screen, filter: "", cursor: 0, offset: 0, pasting: false };
}

function matches(item: PickerItem, filter: string): boolean {
  return item.label.toLowerCase().includes(filter) || item.id.toLowerCase().includes(filter);
}

export function visibleItems(state: PickerState): PickerItem[] {
  const filter = state.filter.trim().toLowerCase();
  if (!filter) return state.screen.items;

  const hits = state.screen.items.filter((item) => matches(item, filter));
  if (hits.length > 0) return hits;
  // Nada casou, então a única saída é gravar o texto cru. É esta linha que
  // cobre o harness sem catálogo nenhum, que nunca teria lista pra filtrar.
  return [{ id: state.filter.trim(), label: `usar "${state.filter.trim()}" como id`, synthetic: true }];
}

function scrolled(state: PickerState, cursor: number, viewport: number): PickerState {
  const offset = Math.min(state.offset, cursor);
  return { ...state, cursor, offset: Math.max(offset, cursor - viewport + 1) };
}

const none = (state: PickerState): { state: PickerState; action: PickerAction } => ({
  state,
  action: { kind: "none" },
});

export function applyKey(
  state: PickerState,
  key: Key,
  viewport: number,
): { state: PickerState; action: PickerAction } {
  if (key.name === "paste-start") return none({ ...state, pasting: true });
  if (key.name === "paste-end") return none({ ...state, pasting: false });

  // Durante um paste, só texto entra. Um `\n` no meio do que foi colado não
  // pode escolher modelo, e um `\x1b[A` colado não pode mover o cursor.
  if (state.pasting) {
    if (key.ctrl || key.meta || !key.sequence || key.sequence.length !== 1) return none(state);
    if (key.sequence === "\n" || key.sequence === "\r") return none(state);
    return none({ ...state, filter: state.filter + key.sequence, cursor: 0, offset: 0 });
  }

  if (key.ctrl && key.name === "c") return { state, action: { kind: "aborted" } };
  if (key.ctrl && key.name === "g") return { state, action: { kind: "skipped" } };

  const items = visibleItems(state);
  const pending = state.confirming;
  const cleared = pending === undefined ? state : { ...state, confirming: undefined };

  if (key.name === "return") {
    const item = items[cleared.cursor];
    if (!item) return none(cleared);
    if (item.synthetic && item.id === "") return none(cleared);
    if (!item.synthetic || cleared.screen.known.has(item.id)) {
      return { state: cleared, action: { kind: "picked", id: item.id } };
    }
    if (pending === item.id) return { state: cleared, action: { kind: "picked", id: item.id } };
    return none({ ...cleared, confirming: item.id });
  }

  if (key.name === "up") return none(scrolled(cleared, Math.max(0, cleared.cursor - 1), viewport));
  if (key.name === "down") {
    return none(scrolled(cleared, Math.min(items.length - 1, cleared.cursor + 1), viewport));
  }
  if (key.name === "backspace") {
    return none({ ...cleared, filter: cleared.filter.slice(0, -1), cursor: 0, offset: 0 });
  }
  // Esc nunca pula: uma sequência de seta que chegue fragmentada aparece como
  // escape isolado, e pular por isso perderia a resposta do usuário.
  if (key.ctrl || key.meta || !key.sequence || key.sequence.length !== 1) return none(cleared);
  if (key.sequence < " ") return none(cleared);

  return none({ ...cleared, filter: cleared.filter + key.sequence, cursor: 0, offset: 0 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/picker-state.test.ts`
Expected: PASS, 15 testes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/picker-state.ts tests/picker-state.test.ts
git commit -m "feat(picker): add the pure key-to-state machine"
```

---

## Task 3: Renderer de frame

Cobre `SETUP-03`, `SETUP-04`, `SETUP-05`, `SETUP-23` (logo abaixo de 15 linhas).

**Files:**
- Modify: `src/cli/ui.ts`
- Test: `tests/ui-render.test.ts`

**Interfaces:**
- Consumes: `Colors`, `Dimensions`, `truncate`, `visibleWidth` (Task 1); `PickerState`, `visibleItems` (Task 2).
- Produces:
  ```ts
  export function chromeHeight(state: PickerState, dim: Dimensions): number
  export function viewportHeight(state: PickerState, dim: Dimensions): number
  export function renderFrame(state: PickerState, dim: Dimensions, c: Colors): string[]
  ```

- [ ] **Step 1: Write the failing test**

Acrescentar a `tests/ui-render.test.ts`:

```ts
import { chromeHeight, renderFrame, viewportHeight } from "../src/cli/ui.js";
import { applyKey, initialState, type Screen } from "../src/cli/picker-state.js";

const plain = colors(false);

const catalog = (): Screen => ({
  agent: "opencode",
  title: "opencode",
  counter: "agente 3 de 4",
  pinned: false,
  known: new Set(),
  items: [
    { id: "opencode/a", label: "opencode/a", group: "opencode" },
    { id: "opencode/b", label: "opencode/b", group: "opencode" },
    { id: "openrouter/c", label: "openrouter/c", group: "openrouter" },
  ],
});

describe("frame", () => {
  it("groups by provider with a count while the filter is empty", () => {
    const lines = renderFrame(initialState(catalog()), { rows: 40, columns: 80 }, plain);
    const text = lines.join("\n");

    expect(text).toContain("opencode");
    expect(text).toContain("openrouter");
    expect(text).toMatch(/opencode.*2/s);
  });

  // Com filtro os cabeçalhos somem e o provider vira sufixo de cada linha.
  it("drops the headers and counts the hits once filtering", () => {
    const state = applyKey(initialState(catalog()), { sequence: "c", name: "c", ctrl: false, meta: false }, 10).state;
    const text = renderFrame(state, { rows: 40, columns: 80 }, plain).join("\n");

    expect(text).not.toMatch(/^\s*--/m);
    expect(text).toContain("de 3");
  });

  it("never writes a line wider than the terminal", () => {
    const wide = catalog();
    wide.items = [{ id: "x", label: "amazon-bedrock/anthropic.claude-3-5-haiku-20241022-v1:0", group: "g" }];

    for (const line of renderFrame(initialState(wide), { rows: 40, columns: 20 }, plain)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("shows the harness error in the header when there is one", () => {
    const broken = { ...catalog(), error: "discovery timed out", items: [], known: new Set<string>() };

    expect(renderFrame(initialState(broken), { rows: 40, columns: 80 }, plain).join("\n")).toContain(
      "discovery timed out",
    );
  });

  // O chrome é contado, não constante: a linha de erro só existe às vezes.
  it("counts only the chrome it actually draws", () => {
    const tall = { rows: 40, columns: 80 };
    const withError = { ...catalog(), error: "boom" };

    expect(chromeHeight(initialState(withError), tall)).toBe(
      chromeHeight(initialState(catalog()), tall) + 1,
    );
  });

  it("drops the logo on a short terminal so the list keeps its rows", () => {
    const short = { rows: 12, columns: 80 };
    const tall = { rows: 40, columns: 80 };

    expect(renderFrame(initialState(catalog()), tall, plain).join("\n")).toContain("╔═╗");
    expect(renderFrame(initialState(catalog()), short, plain).join("\n")).not.toContain("╔═╗");
    expect(viewportHeight(initialState(catalog()), short)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui-render.test.ts -t "frame"`
Expected: FAIL, `renderFrame` não existe.

- [ ] **Step 3: Write minimal implementation**

Em `src/cli/ui.ts`, acrescentar:

```ts
import { visibleItems, type PickerState } from "./picker-state.js";

/** Abaixo disso o logo custa mais linhas do que vale. */
const LOGO_MIN_ROWS = 15;

function drawsLogo(dim: Dimensions): boolean {
  return dim.rows >= LOGO_MIN_ROWS;
}

/**
 * Contado, não constante: a linha de erro e o logo só existem às vezes, e uma
 * constante errada aqui corta itens da lista sem ninguém perceber.
 */
export function chromeHeight(state: PickerState, dim: Dimensions): number {
  const logo = drawsLogo(dim) ? LOGO.length + 1 : 0;
  const header = 1;
  const error = state.screen.error ? 1 : 0;
  const filterLine = 1;
  const footer = 1;
  const blanks = 2;
  return logo + header + error + filterLine + footer + blanks;
}

export function viewportHeight(state: PickerState, dim: Dimensions): number {
  return Math.max(1, dim.rows - chromeHeight(state, dim));
}

function groupHeader(group: string, count: number, width: number): string {
  const label = ` ${group} `;
  const tail = ` ${count} `;
  const room = Math.max(0, width - INDENT.length - label.length - tail.length - 2);
  return `${INDENT}--${label}${"-".repeat(room)}${tail}--`;
}

export function renderFrame(state: PickerState, dim: Dimensions, c: Colors): string[] {
  const width = dim.columns;
  const lines: string[] = [];

  if (drawsLogo(dim)) {
    for (const row of LOGO) lines.push(`${INDENT}${row}`);
    lines.push("");
  }

  const header = state.screen.error
    ? `${state.screen.title}  ~  ${state.screen.counter}`
    : `${state.screen.title}  ~  ${state.screen.counter}`;
  lines.push(`${INDENT}${c.bold(header)}`);
  if (state.screen.error) lines.push(`${INDENT}${c.dim(state.screen.error)}`);

  lines.push("");
  lines.push(`${INDENT}filtrar: ${state.filter}`);

  const items = visibleItems(state);
  const viewport = viewportHeight(state, dim);
  const filtering = state.filter.trim().length > 0;
  let lastGroup: string | undefined;

  for (let i = state.offset; i < Math.min(items.length, state.offset + viewport); i++) {
    const item = items[i];
    if (!filtering && item.group && item.group !== lastGroup && !(state.screen.pinned && i === 0)) {
      lastGroup = item.group;
      const count = state.screen.items.filter((candidate) => candidate.group === item.group).length;
      lines.push(groupHeader(item.group, count, width));
    }
    const marker = i === state.cursor ? "› " : "  ";
    const note = filtering && item.group ? `  ${c.dim(item.group)}` : item.note ? `  ${c.dim(item.note)}` : "";
    lines.push(`${INDENT}${marker}${item.label}${note}`);
  }

  const footer = state.confirming
    ? `"${state.confirming}" nao esta no catalogo. Enter de novo pra gravar assim mesmo, ^G pra voltar`
    : filtering
      ? `${items.length} de ${state.screen.items.length}   ↑↓ move   ⏎ escolhe   ^G pula   ^C sai`
      : `↑↓ move   ⏎ escolhe   ^G pula   ^C sai`;
  lines.push(`${INDENT}${c.dim(footer)}`);

  return lines.map((line) => truncate(line, width));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui-render.test.ts`
Expected: PASS, 13 testes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ui.ts tests/ui-render.test.ts
git commit -m "feat(ui): render the picker frame from state"
```

---

## Task 4: Sessão de raw mode

Cobre `SETUP-02`, `SETUP-12`, `SETUP-21`, `SETUP-22`, `SETUP-30`, `SETUP-31`, `SETUP-13` (desligar paste).

**Files:**
- Create: `src/cli/picker.ts`
- Test: `tests/picker-session.test.ts`

**Interfaces:**
- Consumes: `renderFrame`, `viewportHeight`, `readDimensions`, `Colors` (Tasks 1 e 3); `applyKey`, `initialState`, `Screen` (Task 2).
- Produces:
  ```ts
  export type ScreenResult =
    | { kind: "picked"; agent: string; id: string }
    | { kind: "skipped"; agent: string }
    | { kind: "aborted" };
  export interface PickerIO {
    input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(value: boolean): void };
    output: NodeJS.WritableStream & { rows?: number; columns?: number };
    onResize?(listener: () => void): () => void;
  }
  export function runScreens(screens: Screen[], io: PickerIO, c: Colors): Promise<ScreenResult[]>
  ```

- [ ] **Step 1: Write the failing test**

Criar `tests/picker-session.test.ts`:

```ts
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runScreens, type PickerIO } from "../src/cli/picker.js";
import { colors } from "../src/cli/ui.js";
import type { Screen } from "../src/cli/picker-state.js";

const plain = colors(false);

function fakeIO() {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (v: boolean) => void };
  input.isTTY = true;
  const rawCalls: boolean[] = [];
  input.setRawMode = (value: boolean) => {
    rawCalls.push(value);
    return input;
  };

  const output = new PassThrough() as PassThrough & { rows?: number; columns?: number };
  output.rows = 40;
  output.columns = 80;
  const written: string[] = [];
  output.on("data", (chunk) => written.push(String(chunk)));

  const resizeListeners: Array<() => void> = [];
  const io: PickerIO = {
    input,
    output,
    onResize(listener) {
      resizeListeners.push(listener);
      return () => {
        const at = resizeListeners.indexOf(listener);
        if (at >= 0) resizeListeners.splice(at, 1);
      };
    },
  };
  return { io, input, written, rawCalls, resizeListeners };
}

const screen = (agent: string): Screen => ({
  agent,
  title: agent,
  counter: `agente 1 de 1`,
  pinned: false,
  known: new Set(["alpha", "beta"]),
  items: [
    { id: "alpha", label: "alpha", group: "g" },
    { id: "beta", label: "beta", group: "g" },
  ],
});

const type = (input: PassThrough, keys: string[]) => {
  setImmediate(() => {
    for (const k of keys) input.write(k);
  });
};

describe("picker session", () => {
  it("drives a screen from a fake stdin with a no-op setRawMode", async () => {
    const { io, input, rawCalls } = fakeIO();
    type(input, ["[B", "\r"]);

    const results = await runScreens([screen("claude")], io, plain);

    expect(results).toEqual([{ kind: "picked", agent: "claude", id: "beta" }]);
    expect(rawCalls).toEqual([true, false]);
  });

  // Uma sessão só pra todas as telas: adquirir stdin por tela deixaria a
  // digitação adiantada de uma vazar pra próxima.
  it("acquires raw mode once for every screen", async () => {
    const { io, input, rawCalls } = fakeIO();
    type(input, ["\r", "", "\r"]);

    const results = await runScreens([screen("a"), screen("b"), screen("c")], io, plain);

    expect(results.map((r) => r.kind)).toEqual(["picked", "skipped", "picked"]);
    expect(rawCalls).toEqual([true, false]);
  });

  it("aborts every remaining screen on ctrl-c", async () => {
    const { io, input } = fakeIO();
    type(input, [""]);

    const results = await runScreens([screen("a"), screen("b")], io, plain);

    expect(results).toEqual([{ kind: "aborted" }]);
  });

  it("restores raw mode when a screen throws", async () => {
    const { io, input, rawCalls } = fakeIO();
    const broken = { ...screen("a"), get items(): never { throw new Error("boom"); } };
    type(input, ["\r"]);

    await expect(runScreens([broken as unknown as Screen], io, plain)).rejects.toThrow("boom");
    expect(rawCalls.at(-1)).toBe(false);
  });

  // Um listener por tela acumulava quatro numa execução de quatro agentes.
  it("installs one resize listener and removes it at the end", async () => {
    const { io, input, resizeListeners } = fakeIO();
    type(input, ["\r", "\r", "\r"]);

    await runScreens([screen("a"), screen("b"), screen("c")], io, plain);

    expect(resizeListeners).toHaveLength(0);
  });

  it("turns bracketed paste on at the start and off at the end", async () => {
    const { io, input, written } = fakeIO();
    type(input, ["\r"]);

    await runScreens([screen("a")], io, plain);
    const all = written.join("");

    expect(all).toContain("[?2004h");
    expect(all).toContain("[?2004l");
  });

  // Frame que encolhe tem que limpar as linhas físicas do anterior.
  it("clears the previous frame before writing a smaller one", async () => {
    const { io, input, written } = fakeIO();
    type(input, ["a", "l", "\r"]);

    await runScreens([screen("a")], io, plain);

    expect(written.join("")).toMatch(/\[\d+A/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/picker-session.test.ts`
Expected: FAIL, `src/cli/picker.ts` não existe.

- [ ] **Step 3: Write minimal implementation**

Criar `src/cli/picker.ts`:

```ts
import { emitKeypressEvents } from "node:readline";
import { applyKey, initialState, type Key, type Screen } from "./picker-state.js";
import { readDimensions, renderFrame, viewportHeight, type Colors } from "./ui.js";

export type ScreenResult =
  | { kind: "picked"; agent: string; id: string }
  | { kind: "skipped"; agent: string }
  | { kind: "aborted" };

export interface PickerIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(value: boolean): void };
  output: NodeJS.WritableStream & { rows?: number; columns?: number };
  onResize?(listener: () => void): () => void;
}

const PASTE_ON = "[?2004h";
const PASTE_OFF = "[?2004l";

/**
 * Dono único de raw mode, listeners e limpeza. Adquirir por tela deixaria a
 * digitação adiantada de uma tela vazar pra próxima, que é o bug que a tela
 * única tinha fechado.
 */
export async function runScreens(screens: Screen[], io: PickerIO, c: Colors): Promise<ScreenResult[]> {
  const { input, output } = io;
  const results: ScreenResult[] = [];

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    output.write(`${PASTE_OFF}\n`);
    input.setRawMode?.(false);
    input.pause();
  };

  // SIGTERM não roda o handler de `exit`, e contar com o Node restaurar o TTY
  // sozinho é contar com sorte.
  const onExit = () => restore();
  const onSigterm = () => {
    restore();
    process.exit(143);
  };
  process.on("exit", onExit);
  process.on("SIGTERM", onSigterm);

  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  output.write(PASTE_ON);

  let height = 0;
  let redraw = () => {};
  const stopResize = io.onResize?.(() => redraw());

  try {
    for (const screen of screens) {
      const result = await runScreen(screen, io, c, {
        get height() {
          return height;
        },
        set height(value: number) {
          height = value;
        },
        bind(fn: () => void) {
          redraw = fn;
        },
      });
      if (result.kind === "aborted") {
        results.push(result);
        break;
      }
      results.push(result);
    }
  } finally {
    redraw = () => {};
    stopResize?.();
    process.off("exit", onExit);
    process.off("SIGTERM", onSigterm);
    restore();
  }

  return results;
}

interface FrameSlot {
  height: number;
  bind(fn: () => void): void;
}

function runScreen(screen: Screen, io: PickerIO, c: Colors, slot: FrameSlot): Promise<ScreenResult> {
  return new Promise<ScreenResult>((resolve, reject) => {
    const { input, output } = io;
    let state = initialState(screen);

    const paint = () => {
      const dim = readDimensions(output);
      const lines = renderFrame(state, dim, c);
      // Sobe pela altura do frame anterior e limpa dali pra baixo, senão um
      // frame menor deixa as sobras do maior na tela.
      const prefix = slot.height > 0 ? `[${slot.height}A[0J` : "";
      output.write(`${prefix}${lines.join("\n")}\n`);
      slot.height = lines.length;
    };

    const onKey = (sequence: string | undefined, key: Key | undefined) => {
      const resolved: Key = key ?? { sequence: sequence ?? "", ctrl: false, meta: false };
      let outcome;
      try {
        outcome = applyKey(state, { ...resolved, sequence: resolved.sequence ?? sequence ?? "" },
          viewportHeight(state, readDimensions(output)));
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      state = outcome.state;
      if (outcome.action.kind === "none") {
        paint();
        return;
      }
      cleanup();
      if (outcome.action.kind === "picked") {
        resolve({ kind: "picked", agent: screen.agent, id: outcome.action.id });
        return;
      }
      if (outcome.action.kind === "skipped") {
        resolve({ kind: "skipped", agent: screen.agent });
        return;
      }
      resolve({ kind: "aborted" });
    };

    const cleanup = () => {
      input.off("keypress", onKey);
      slot.bind(() => {});
    };

    input.on("keypress", onKey);
    slot.bind(paint);
    try {
      paint();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/picker-session.test.ts`
Expected: PASS, 7 testes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/picker.ts tests/picker-session.test.ts
git commit -m "feat(picker): own raw mode for the whole screen sequence"
```

---

## Task 5: Montagem das telas em `setup.ts`

Cobre `SETUP-01`, `SETUP-42`, `SETUP-43`, `SETUP-44`, `SETUP-05` (total deduplicado).

**Files:**
- Modify: `src/cli/commands/setup.ts`
- Test: `tests/setup-wizard.test.ts`

**Interfaces:**
- Consumes: `Screen`, `PickerItem` (Task 2).
- Produces:
  ```ts
  export function buildAgentScreen(
    harness: HarnessModels, index: number, total: number, configured?: string,
  ): Screen
  export function buildScreens(
    harnesses: HarnessModels[], configured: Partial<Record<AgentId, string>>,
  ): Screen[]
  ```

- [ ] **Step 1: Write the failing test**

Substituir os `describe("model menu")` e `describe("model selection")` de `tests/setup-wizard.test.ts` por:

```ts
import { buildAgentScreen, buildScreens } from "../src/cli/commands/setup.js";

const harness = (agent: AgentId, providers: Array<[string, string[]]>, defaults: string[] = []): HarnessModels => ({
  agent,
  available: true,
  providers: providers.map(([provider, ids]) => ({
    provider,
    models: ids.map((id) => ({ id, name: id, provider, isDefault: defaults.includes(id) })),
  })),
});

describe("agent screens", () => {
  it("gives one screen per installed harness, numbered", () => {
    const screens = buildScreens(
      [harness("claude", [["anthropic", ["a"]]]), { agent: "codex", available: false, providers: [] }],
      {},
    );

    expect(screens).toHaveLength(1);
    expect(screens[0].counter).toBe("agente 1 de 1");
  });

  // A linha fixa fica fora do agrupamento, senão ela contradiz a ordem dos providers.
  it("pins the configured model above the groups and marks it atual", () => {
    const screen = buildAgentScreen(harness("opencode", [["a", ["a/1"]], ["b", ["b/2"]]]), 0, 1, "b/2");

    expect(screen.pinned).toBe(true);
    expect(screen.items[0]).toMatchObject({ id: "b/2", note: "atual" });
    expect(screen.items[0].group).toBeUndefined();
  });

  it("pins a real isDefault and marks it padrao", () => {
    const screen = buildAgentScreen(harness("claude", [["anthropic", ["x", "y"]]], ["y"]), 0, 1);

    expect(screen.items[0]).toMatchObject({ id: "y", note: "padrao" });
  });

  // omp e opencode nao declaram isDefault: ids[0] e acidente alfabetico.
  it("pins nothing when neither config nor isDefault exists", () => {
    const screen = buildAgentScreen(harness("omp", [["bedrock", ["a", "b"]]]), 0, 1);

    expect(screen.pinned).toBe(false);
    expect(screen.items[0].note).toBeUndefined();
  });

  it("keeps a harness with an empty catalog on screen with nothing to list", () => {
    const screen = buildAgentScreen({ agent: "omp", available: true, providers: [] }, 1, 3);

    expect(screen.items).toEqual([]);
    expect(screen.counter).toBe("agente 2 de 3");
  });

  it("carries the discovery error so an empty list is not mistaken for no models", () => {
    const screen = buildAgentScreen(
      { agent: "omp", available: true, error: "discovery timed out", providers: [] },
      0,
      1,
    );

    expect(screen.error).toBe("discovery timed out");
  });

  it("counts an id once even when two providers report it", () => {
    const screen = buildAgentScreen(harness("opencode", [["a", ["dup"]], ["b", ["dup"]]]), 0, 1);

    expect(screen.items.filter((item) => item.id === "dup")).toHaveLength(1);
  });

  it("lists every model, with no cap", () => {
    const many = Array.from({ length: 600 }, (_, i) => `m-${i}`);

    expect(buildAgentScreen(harness("opencode", [["p", many]]), 0, 1).items).toHaveLength(600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/setup-wizard.test.ts -t "agent screens"`
Expected: FAIL, `buildAgentScreen` não existe.

- [ ] **Step 3: Write minimal implementation**

Em `src/cli/commands/setup.ts`, remover `buildModelMenu`, `parseModelSelection`, `ModelMenu`, `ModelChoice`, `ModelSelection`, `MAX_LISTED` e `getDefaultModel`, e acrescentar:

```ts
import type { PickerItem, Screen } from "../picker-state.js";

function pinnedFor(harness: HarnessModels, ids: string[], configured?: string): PickerItem | undefined {
  if (configured && ids.includes(configured)) {
    return { id: configured, label: configured, note: "atual" };
  }
  for (const provider of harness.providers) {
    const real = provider.models.find((model) => model.isDefault && ids.includes(model.id));
    if (real) return { id: real.id, label: real.id, note: "padrao" };
  }
  // Sem config e sem isDefault, ids[0] é só ordem alfabética. Içar isso e
  // chamar de padrão carimbaria um sorteio como recomendação.
}

export function buildAgentScreen(
  harness: HarnessModels,
  index: number,
  total: number,
  configured?: string,
): Screen {
  const seen = new Set<string>();
  const grouped: PickerItem[] = [];
  for (const provider of harness.providers) {
    for (const model of provider.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      grouped.push({ id: model.id, label: model.id, group: provider.provider });
    }
  }

  const pinned = pinnedFor(harness, [...seen], configured);
  const items = pinned ? [pinned, ...grouped.filter((item) => item.id !== pinned.id)] : grouped;

  return {
    agent: harness.agent,
    title: agentLabel(harness.agent),
    counter: `agente ${index + 1} de ${total}`,
    error: harness.error,
    items,
    pinned: pinned !== undefined,
    known: seen,
  };
}

export function buildScreens(
  harnesses: HarnessModels[],
  configured: Partial<Record<AgentId, string>>,
): Screen[] {
  const seen = new Set<AgentId>();
  // Um cache de disco mesclado pode trazer o mesmo agente duas vezes.
  const installed = harnesses.filter((harness) => {
    if (!harness.available || seen.has(harness.agent)) return false;
    seen.add(harness.agent);
    return true;
  });
  return installed.map((harness, index) =>
    buildAgentScreen(harness, index, installed.length, configured[harness.agent]),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/setup-wizard.test.ts -t "agent screens"`
Expected: PASS, 8 testes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/setup.ts tests/setup-wizard.test.ts
git commit -m "feat(setup): build one picker screen per installed agent"
```

---

## Task 6: Gravação

Cobre `SETUP-40`, `SETUP-41`, `SETUP-47`.

**Files:**
- Modify: `src/cli/commands/setup.ts`
- Test: `tests/setup-wizard.test.ts`

**Interfaces:**
- Consumes: `ScreenResult` (Task 4).
- Produces:
  ```ts
  export function collectSelections(
    results: ScreenResult[], existing: Partial<Record<AgentId, string>> | undefined, shown: number,
  ): { models: Partial<Record<AgentId, string>>; write: boolean }
  ```

- [ ] **Step 1: Write the failing test**

Acrescentar a `tests/setup-wizard.test.ts`:

```ts
import { collectSelections } from "../src/cli/commands/setup.js";

describe("collecting selections", () => {
  it("writes what was picked", () => {
    expect(collectSelections([{ kind: "picked", agent: "claude", id: "x" }], undefined, 1)).toEqual({
      models: { claude: "x" },
      write: true,
    });
  });

  // Pular significa "nao mexe", nunca "desconfigura".
  it("leaves an earlier choice untouched when the agent is skipped", () => {
    expect(collectSelections([{ kind: "skipped", agent: "codex" }], { codex: "gpt-x" }, 1)).toEqual({
      models: { codex: "gpt-x" },
      write: true,
    });
  });

  it("writes the empty sentinel when everything was skipped and nothing was configured", () => {
    expect(collectSelections([{ kind: "skipped", agent: "claude" }], undefined, 1)).toEqual({
      models: {},
      write: true,
    });
  });

  // Sem tela mostrada, gravar queimaria a unica pergunta que o usuario recebe.
  it("writes nothing when no screen was shown at all", () => {
    expect(collectSelections([], undefined, 0)).toEqual({ models: {}, write: false });
  });

  it("writes nothing when the run was aborted", () => {
    expect(collectSelections([{ kind: "aborted" }], { claude: "keep" }, 2)).toEqual({
      models: { claude: "keep" },
      write: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/setup-wizard.test.ts -t "collecting selections"`
Expected: FAIL, `collectSelections` não existe.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ScreenResult } from "../picker.js";

export function collectSelections(
  results: ScreenResult[],
  existing: Partial<Record<AgentId, string>> | undefined,
  shown: number,
): { models: Partial<Record<AgentId, string>>; write: boolean } {
  // Parte do que já estava gravado: pular tem que deixar intacto, e o mapa
  // novo em folha apagaria a escolha de uma execução anterior.
  const models: Partial<Record<AgentId, string>> = { ...(existing ?? {}) };
  for (const result of results) {
    if (result.kind === "picked") models[result.agent as AgentId] = result.id;
  }
  const aborted = results.some((result) => result.kind === "aborted");
  return { models, write: shown > 0 && !aborted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/setup-wizard.test.ts -t "collecting selections"`
Expected: PASS, 5 testes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/setup.ts tests/setup-wizard.test.ts
git commit -m "feat(setup): merge selections instead of rebuilding the map"
```

---

## Task 7: Orquestração e comando

Cobre `SETUP-23` (saída abaixo de 8 linhas), `SETUP-50`, `SETUP-51`, `SETUP-52`, e a ordem obrigatória de partida.

**Files:**
- Modify: `src/cli/commands/setup.ts`
- Test: `tests/setup-wizard.test.ts`

**Interfaces:**
- Consumes: `buildScreens` (Task 5), `collectSelections` (Task 6), `runScreens` (Task 4), `readDimensions`, `colors` (Task 1).
- Produces: `ModelWizardOptions` perde `width?: number` e ganha:
  ```ts
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(value: boolean): void };
  output?: NodeJS.WritableStream & { rows?: number; columns?: number };
  refresh?: boolean;
  dimensions?: Dimensions;
  discoverModels?: (registry: DriverRegistry, refresh: boolean) => Promise<HarnessModels[]>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
describe("runModelSetupWizard", () => {
  const io = () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (v: boolean) => void };
    input.isTTY = true;
    input.setRawMode = () => input;
    const output = new PassThrough() as PassThrough & { rows?: number; columns?: number };
    output.rows = 40;
    output.columns = 80;
    const seen: string[] = [];
    output.on("data", (chunk) => seen.push(String(chunk)));
    return { input, output, seen };
  };

  it("says it is discovering before it blocks on discovery", async () => {
    const { input, output, seen } = io();
    setImmediate(() => input.write(""));

    await runModelSetupWizard({
      config: { defaultAgent: "claude", worktree: false },
      registry: {} as DriverRegistry,
      input,
      output,
      isTTY: true,
      discoverModels: async () => discoveredHarnesses(),
    });

    expect(seen.join("")).toContain("discovering models");
  });

  it("passes refresh through to discovery", async () => {
    const { input, output } = io();
    const discoverModels = vi.fn(async () => discoveredHarnesses());
    setImmediate(() => input.write(""));

    await runModelSetupWizard({
      config: { defaultAgent: "claude", worktree: false },
      registry: {} as DriverRegistry,
      input,
      output,
      isTTY: true,
      refresh: true,
      discoverModels,
    });

    expect(discoverModels).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("leaves the config alone on a terminal too short to draw", async () => {
    const { input, output } = io();
    output.rows = 5;
    const save = vi.fn();

    const result = await runModelSetupWizard({
      config: { defaultAgent: "claude", worktree: false },
      registry: {} as DriverRegistry,
      input,
      output,
      isTTY: true,
      save,
      discoverModels: async () => discoveredHarnesses(),
    });

    expect(save).not.toHaveBeenCalled();
    expect(result.models).toBeUndefined();
  });

  it("warns and keeps going when the config cannot be saved", async () => {
    const { input, output } = io();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    setImmediate(() => {
      input.write("\r");
      input.write("\r");
    });

    const result = await runModelSetupWizard({
      config: { defaultAgent: "claude", worktree: false },
      registry: {} as DriverRegistry,
      input,
      output,
      isTTY: true,
      save: () => {
        throw new Error("disk full");
      },
      discoverModels: async () => discoveredHarnesses(),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(result.models).toBeDefined();
    warn.mockRestore();
  });

  it("does not discover, prompt, or write when the streams are not a terminal", async () => {
    const discoverModels = vi.fn(async () => discoveredHarnesses());
    const save = vi.fn();

    await runModelSetupWizard({
      config: { defaultAgent: "claude", worktree: false },
      registry: {} as DriverRegistry,
      isTTY: false,
      save,
      discoverModels,
    });

    expect(discoverModels).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the config untouched when no agent had anything to offer", async () => {
    const { input, output } = io();
    const save = vi.fn();

    const result = await runModelSetupWizard({
      config: { defaultAgent: "claude", worktree: false },
      registry: {} as DriverRegistry,
      input,
      output,
      isTTY: true,
      save,
      discoverModels: async () => [],
    });

    expect(save).not.toHaveBeenCalled();
    expect(result.models).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/setup-wizard.test.ts -t "runModelSetupWizard"`
Expected: FAIL, o runner atual usa `readline` e não conhece `refresh`.

- [ ] **Step 3: Write minimal implementation**

Substituir o corpo de `runModelSetupWizard` por:

Primeiro alargar `ModelWizardOptions` conforme o bloco Interfaces acima, depois trocar
o corpo:

```ts
/** Abaixo disso não sobra lista pra desenhar depois do chrome. */
const MIN_ROWS = 8;

export async function runModelSetupWizard(options: ModelWizardOptions = {}): Promise<RunAgentConfig> {
  const config = options.config ?? loadConfig();
  if (!(options.isTTY ?? isInteractiveTerminal())) return config;

  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const registry = options.registry ?? getRegistry();

  // Ordem: anunciar, descobrir sem raw mode, só então medir e desenhar.
  output.write("\n  discovering models...\n");
  let harnesses: HarnessModels[];
  try {
    const discover =
      options.discoverModels ??
      ((selected: DriverRegistry, refresh: boolean) => getCachedOrDiscoverModels(selected, { refresh }));
    harnesses = await discover(registry, options.refresh ?? false);
  } catch (error) {
    // Catálogo inalcançável não é resposta do usuário. Cai no guard de baixo,
    // que sai sem gravar e deixa a próxima execução perguntar de novo.
    console.error(`Warning: Could not discover models: ${error instanceof Error ? error.message : String(error)}`);
    harnesses = [];
  }
  const screens = buildScreens(harnesses, config.models ?? {});

  if (screens.length === 0) {
    console.error("Warning: No installed agent reported any model; skipping model setup.");
    return config;
  }

  const dim = options.dimensions ?? readDimensions(output as { rows?: number; columns?: number });
  if (dim.rows < MIN_ROWS) {
    console.error(`Warning: Terminal is ${dim.rows} rows; model setup needs ${MIN_ROWS}. Nothing was saved.`);
    return config;
  }

  const paint = colors(Boolean((output as { isTTY?: boolean }).isTTY) && !process.env.NO_COLOR);
  const results = await runScreens(screens, {
    input,
    output: output as PickerIO["output"],
    onResize: (listener) => {
      process.stdout.on("resize", listener);
      return () => process.stdout.off("resize", listener);
    },
  }, paint);

  const { models, write } = collectSelections(results, config.models, screens.length);
  if (!write) return config;

  const updatedConfig: RunAgentConfig = { ...config, models };
  try {
    (options.save ?? saveConfig)(updatedConfig);
  } catch (error) {
    console.error(`Warning: Could not save config: ${error instanceof Error ? error.message : String(error)}`);
  }

  const summary = screens
    .map((screen) => `${screen.title} ${models[screen.agent as AgentId] ?? "unset"}`)
    .join(" · ");
  output.write(`\n  saved: ${summary}\n\n`);
  return updatedConfig;
}
```

E em `registerSetupCommand`:

```ts
export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Choose the model each installed agent should use")
    .option("--refresh", "ignore the cached catalog and rediscover")
    .action(async (opts: { refresh?: boolean }) => {
      // A mensagem vive aqui e não no wizard: o `open` chama a mesma função e
      // OPEN-22 exige silêncio dele.
      if (!isInteractiveTerminal()) {
        console.error("codedeck setup needs a terminal on both stdin and stdout.");
        process.exitCode = 1;
        return;
      }
      await runModelSetupWizard({
        config: loadConfig(),
        registry: getRegistry(),
        refresh: opts.refresh,
      });
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/setup-wizard.test.ts`
Expected: PASS, toda a suíte do arquivo.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/setup.ts tests/setup-wizard.test.ts
git commit -m "feat(setup): run the picker and add a refresh flag"
```

---

## Task 8: Recuperação quando o modelo salvo saiu do catálogo

Cobre `SETUP-46`.

**Files:**
- Modify: `src/cli/commands/open.ts`
- Test: `tests/open-args.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `judgeModel` ganha um parâmetro `fromConfig: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
describe("a saved model that left the catalog", () => {
  const catalogs = [
    {
      agent: "claude" as const,
      available: true,
      providers: [{ provider: "anthropic", models: [{ id: "claude-opus-5", name: "o", provider: "anthropic" }] }],
    },
  ];

  it("tells the user to run setup when the model came from config", () => {
    const verdict = judgeModel("claude-opus-4", catalogs, true);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).toContain("codedeck setup");
  });

  // Um --model errado é erro de digitação de agora, não config velha.
  it("does not mention setup when the model came from a flag", () => {
    const verdict = judgeModel("claude-opus-4", catalogs, false);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).not.toContain("codedeck setup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/open-args.test.ts -t "left the catalog"`
Expected: FAIL, `judgeModel` aceita dois argumentos.

- [ ] **Step 3: Write minimal implementation**

Em `src/cli/commands/open.ts`:

```ts
export function judgeModel(model: string, catalogs: HarnessModels[] | undefined, fromConfig: boolean): ModelVerdict {
  // ... corpo atual até o final ...
  const suggestion = findClosestModel(model, candidates);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : " No close model was found.";
  // Um modelo pode sair do catálogo sozinho, sem ninguém ter digitado errado,
  // e `needsModelSetup` nunca mais pergunta, então a saída tem que ser dita.
  const recovery = fromConfig ? " Run `codedeck setup` to pick another." : "";
  return { kind: "rejected", error: `Model "${model}" is not in the Claude catalog.${hint}${recovery}` };
}
```

`preflightModel` vira `preflightModel(model: string, fromConfig: boolean)` e repassa o
parâmetro pro `judgeModel`. No `action`, `src/cli/commands/open.ts:593` vira:

```ts
// Veio da config só quando ninguém digitou modelo agora, nem por flag nem por
// passthrough, e a config de fato tinha um.
const fromConfig =
  opts.model === undefined &&
  effectiveModel(invocation.passthrough) === undefined &&
  resolveModel("claude", undefined, config) !== undefined;

await preflightModel(model, fromConfig);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/open-args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/open.ts tests/open-args.test.ts
git commit -m "fix(open): point at setup when a saved model left the catalog"
```

---

## Task 9: Limpeza e documentação

**Files:**
- Modify: `src/cli/ui.ts`, `README.md`, `.specs/features/setup-picker/spec.md`
- Test: `tests/setup-wizard.test.ts`, `tests/ui-render.test.ts`

- [ ] **Step 1: Remover o que ficou órfão**

Apagar de `src/cli/ui.ts`: `columnize`, `headingWith`, `blockWidth` e `FALLBACK_WIDTH`
(`src/cli/ui.ts:17`, usado só por `columnize`). Manter `renderLogo`, `INDENT` e `LOGO`.

Confirmar que nada mais os importa:

```bash
rg -n "columnize|headingWith|blockWidth|buildModelMenu|parseModelSelection|MAX_LISTED" src tests
```

Expected: nenhuma saída.

- [ ] **Step 2: Rodar os quatro arquivos de teste tocados, em batch**

```bash
npx vitest run tests/ui-render.test.ts tests/picker-state.test.ts
npx vitest run tests/picker-session.test.ts tests/setup-wizard.test.ts
npx vitest run tests/open-args.test.ts tests/config-models.test.ts
```

Expected: PASS nos três batches. Nunca rodar a suíte inteira de uma vez.

- [ ] **Step 3: Conferir tipos e build**

```bash
npx tsc --noEmit && npm run build
```

Expected: sem saída de erro.

- [ ] **Step 4: Atualizar o README**

Trocar a seção "Choosing a model per agent" pelo fluxo novo: uma tela por agente, setas e filtro, `^G` pula, `^C` sai, e `--refresh`. Remover o exemplo da linha `> 2 6` e a frase sobre shortlist de dezesseis.

- [ ] **Step 5: Marcar a rastreabilidade e commitar**

Na tabela de `.specs/features/setup-picker/spec.md`, trocar `Pending` por `Done` nos 27 ids.

```bash
git add -A
git commit -m "chore(setup): drop the line wizard and document the picker"
```

---

## Auto-revisão do plano

**Cobertura da spec.** Os 27 ids têm tarefa: `SETUP-01` (5, 7), `02` (4), `03`/`04`/`05` (3, 5), `10` a `13` (2, 4), `20` (1), `21`/`22` (4), `23` (1, 3, 7), `24` (1), `30`/`31` (4), `40`/`41` (6), `42` a `44` (5), `45` (2), `46` (8), `47` (6), `50` a `52` (7).

**Testes portados.** Os seis da spec caem assim: `needsModelSetup` e sem-TTY na Task 7; falha ao salvar na Task 7; guard da pergunta queimada nas Tasks 6 e 7; harness não instalado, catálogo vazio e default na Task 5; largura zero na Task 1.

**Consistência de tipos.** `Screen`, `PickerItem`, `PickerState`, `Key` e `PickerAction` são definidos na Task 2 e usados sem renomear nas Tasks 3, 4 e 5. `ScreenResult` nasce na Task 4 e é consumido na Task 6. `Dimensions` e `Colors` nascem na Task 1 e atravessam 3, 4 e 7.

**Risco conhecido.** A Task 4 é a única que mistura I/O com controle de fluxo, e é onde os probes acharam mais armadilha. Se ela custar mais que o previsto, as Tasks 1 a 3 já estão commitadas e testadas, e o custo de abandonar é um arquivo.
