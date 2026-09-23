import { describe, expect, it } from "vitest";
import { BRAND_CSS, LOGO_FAVICON_HREF, renderLogoSvg, renderTopBar } from "../src/web/brand.js";

describe("web brand", () => {
  it("exports the usage palette and type tokens", () => {
    for (const token of [
      "--bg: #000000", "--surface: #0a0a0a", "--surface-hover: #111111", "--surface-raised: #161616",
      "--border: #1f1f1f", "--border-strong: #2e2e2e", "--grid: #1a1a1a", "--text: #ededed",
      "--text-muted: #a1a1a1", "--text-faint: #6b6b6b", "--blue: #0070f3", "--blue-chart: #3b82f6",
      "--success: #10b981", "--error: #e5484d", '"Geist", "Inter", ui-sans-serif',
      '"Geist Mono", ui-monospace, "JetBrains Mono"',
    ]) expect(BRAND_CSS).toContain(token);
  });

  it("renders the stacked deck mark with a heavier stroke at smaller sizes", () => {
    const large = renderLogoSvg(64);
    expect(large).toContain("m13 25 34-8 6 4-34 8zM13 32l34-8 6 4-34 8zM13 39l34-8 6 4-34 8zM13 46l34-8 6 4-34 8z");
    expect(large).toContain('fill="#000" stroke="#ededed"');
    expect(large).toContain('fill="#0070f3" stroke="#0070f3"');
    expect(Number(renderLogoSvg(16).match(/stroke-width="([\d.]+)/)?.[1])).toBeGreaterThan(Number(large.match(/stroke-width="([\d.]+)/)?.[1]));
    expect(Number(renderLogoSvg(20).match(/stroke-width="([\d.]+)/)?.[1])).toBeGreaterThan(Number(large.match(/stroke-width="([\d.]+)/)?.[1]));
  });

  it("uses the logo data URI as a favicon", () => {
    expect(LOGO_FAVICON_HREF).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(LOGO_FAVICON_HREF)).toContain("#0070f3");
  });

  it("renders every nav link and escapes labels", () => {
    const html = renderTopBar({
      pages: [{ label: "Home", path: "/" }, { label: "Usage <today>", path: "/usage?x=1&y=2" }],
      activePath: "/usage?x=1&y=2",
      title: "Usage & analytics",
    });
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/usage?x=1&amp;y=2" aria-current="page" class="active"');
    expect(html).toContain("Usage &lt;today&gt;");
    expect(html).toContain("Usage &amp; analytics");
  });
});
