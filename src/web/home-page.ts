export interface HomePageRoute {
  label: string;
  path: string;
}

export function renderHomePage(routes: readonly HomePageRoute[]): string {
  const links = routes
    .map((route) => `<li><a href="${escapeHtml(route.path)}">${escapeHtml(route.label)}</a></li>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeDeck</title>
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #08090c; color: #f5f5f7;
    font-family: system-ui, sans-serif; }
  main { width: min(720px, 100%); margin: 0 auto; padding: 48px 24px; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  p { margin: 0 0 24px; color: #98989f; }
  ul { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 12px; list-style: none; margin: 0; padding: 0; }
  a { display: block; padding: 18px; border: 1px solid rgba(255,255,255,.12); border-radius: 12px;
    color: #f5f5f7; text-decoration: none; background: rgba(255,255,255,.04); }
  a:hover { border-color: rgba(10,132,255,.7); background: rgba(10,132,255,.12); }
</style>
</head>
<body>
<main>
  <h1>CodeDeck</h1>
  <p>Choose a local console page.</p>
  <ul>${links}</ul>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}
