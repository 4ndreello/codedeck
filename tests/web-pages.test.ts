import { describe, expect, it } from "vitest";
import { renderHomePage } from "../src/web/home-page.js";

describe("renderHomePage", () => {
  it("links only the pages registered by the active route table", () => {
    const html = renderHomePage([{ label: "Review", path: "/review" }]);

    expect(html).toContain('href="/review"');
    expect(html).toContain("Review");
    expect(html).not.toContain('href="/usage"');
    expect(html).not.toContain('href="/setup"');
    expect(html).toContain("<style>");
  });
});
