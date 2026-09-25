import { describe, expect, it } from "vitest";
import { invalidWebPortMessage, resolveWebPort } from "../src/config/web-port.js";
import { invalidWebHostMessage, resolveWebHost } from "../src/config/web-host.js";

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

describe("resolveWebHost", () => {
  it.each([
    ["no web section", {}],
    ["a web section without host", { web: {} }],
  ])("defaults to loopback with %s", (_label, config) => {
    expect(resolveWebHost(config)).toEqual({ host: "127.0.0.1" });
  });

  it.each(["0.0.0.0", "100.64.0.5", "::", "::1"])("accepts the IP address %s", (host) => {
    expect(resolveWebHost({ web: { host } })).toEqual({ host });
  });

  it.each([
    ["a hostname", "deck.local"],
    ["a numeric value", 7777],
    ["null", null],
    ["a non-object web section", "x"],
  ])("falls back to loopback and reports %s as invalid", (_label, value) => {
    const config = value === "x" ? { web: value } : { web: { host: value } };
    expect(resolveWebHost(config)).toEqual({ host: "127.0.0.1", invalid: value });
  });

  it("renders an invalid host value as JSON in the warning", () => {
    expect(invalidWebHostMessage("deck.local")).toBe('Ignoring invalid web.host in config: "deck.local"');
    expect(invalidWebHostMessage(null)).toBe("Ignoring invalid web.host in config: null");
  });
});
