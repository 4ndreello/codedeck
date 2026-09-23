const CARDS_PATH = "m13 25 34-8 6 4-34 8zM13 32l34-8 6 4-34 8zM13 39l34-8 6 4-34 8zM13 46l34-8 6 4-34 8z";
const TOP_CARD_PATH = "m13 25 34-8 6 4-34 8z";

export const BRAND_CSS = `
:root {
  --bg: #000000;
  --surface: #0a0a0a;
  --surface-hover: #111111;
  --surface-raised: #161616;
  --border: #1f1f1f;
  --border-strong: #2e2e2e;
  --grid: #1a1a1a;
  --text: #ededed;
  --text-muted: #a1a1a1;
  --text-faint: #6b6b6b;
  --blue: #0070f3;
  --blue-chart: #3b82f6;
  --blue-2: #93c5fd;
  --blue-3: #1d4ed8;
  --blue-4: #60a5fa;
  --blue-5: #bfdbfe;
  --blue-6: #1e3a8a;
  --neutral: #737373;
  --neutral-dark: #404040;
  --success: #10b981;
  --error: #e5484d;
  --font-sans: "Geist", "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "JetBrains Mono", monospace;
  color-scheme: dark;
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
}
*, *::before, *::after { box-sizing: border-box; }
html { min-width: 320px; background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font-sans); }
button, input, select { color-scheme: dark; font: inherit; }
`;

export function renderLogoSvg(size: 16 | 20 | 64): string {
  const strokeWidth = size === 64 ? 2.2 : size === 20 ? 5 : 6;
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="${CARDS_PATH}" fill="#000" stroke="#ededed" stroke-width="${strokeWidth}" stroke-linejoin="round"/><path d="${TOP_CARD_PATH}" fill="#0070f3" stroke="#0070f3" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`;
}

export const LOGO_FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(renderLogoSvg(64))}`;

export interface WebPageLink {
  label: string;
  path: string;
}

export interface TopBarOptions {
  pages: WebPageLink[];
  activePath: string;
  title: string;
}

export function renderTopBar(options: TopBarOptions): string {
  const links = options.pages.map(({ label, path }) => {
    const active = path === options.activePath;
    return `<a href="${escapeHtml(path)}"${active ? ' aria-current="page" class="active"' : ""}>${escapeHtml(label)}</a>`;
  }).join("");
  return `<header class="topbar"><a class="brand" href="/" aria-label="CodeDeck home">${renderLogoSvg(20)}<span>codedeck</span></a><span class="topbar-title">${escapeHtml(options.title)}</span><nav aria-label="Main navigation">${links}</nav></header>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
