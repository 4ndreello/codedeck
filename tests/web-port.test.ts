import { describe, expect, it } from "vitest";
import { invalidWebPortMessage, resolveWebPort } from "../src/config/web-port.js";

describe("resolveWebPort", () => {
  it.each([
    ["no web section", {}],
    ["a web section without port", { web: {} }],
  ])("prefers 7777 with %s", (_label, config) => {
    expect(resolveWebPort(config)).toEqual({ port: 7777 });
  });

  it.each([7788, 1, 65535])("prefers a valid web.port %s", (port) => {
    expect(resolveWebPort({ web: { port } })).toEqual({ port });
  });

  it.each([
    ["a numeric string", { web: { port: "7788" } }, "7788"],
    ["zero", { web: { port: 0 } }, 0],
    ["65536", { web: { port: 65536 } }, 65536],
    ["a fraction", { web: { port: 7.5 } }, 7.5],
    ["a non-object web section", { web: "x" }, "x"],
  ])("falls back to 7777 and reports %s as invalid", (_label, config, invalid) => {
    expect(resolveWebPort(config)).toEqual({ port: 7777, invalid });
  });

  it("renders the invalid value as JSON in the warning", () => {
    expect(invalidWebPortMessage("7788")).toBe('Ignoring invalid web.port in config: "7788"');
    expect(invalidWebPortMessage(0)).toBe("Ignoring invalid web.port in config: 0");
  });
});
