import { describe, expect, it } from "vitest";
import { parseRows } from "../../plugin/mods/agents/parse.js";

describe("parseRows", () => {
  it("returns the rows of a well formed array of two objects", () => {
    const stdout = JSON.stringify([
      { id: "a83f", name: "power", agent: "claude", status: "running" },
      { id: "b94e", runId: "r-1", origin: null, status: "idle" },
    ]);
    expect(parseRows(stdout)).toEqual([
      { id: "a83f", name: "power", agent: "claude", status: "running" },
      { id: "b94e", runId: "r-1", origin: null, status: "idle" },
    ]);
  });

  it("returns an empty array (not undefined) for an empty JSON array", () => {
    const result = parseRows("[]");
    expect(result).not.toBeUndefined();
    expect(result).toEqual([]);
  });

  it("returns undefined for a string that is not JSON at all", () => {
    expect(parseRows("codedeck: command not found")).toBeUndefined();
  });

  it("returns undefined for truncated JSON cut mid object", () => {
    expect(parseRows('[{"id": "a83f", "na')).toBeUndefined();
  });

  it("returns undefined for JSON that is an object rather than an array", () => {
    expect(parseRows('{"id": "a83f"}')).toBeUndefined();
  });

  it("returns undefined for JSON null", () => {
    expect(parseRows("null")).toBeUndefined();
  });

  it("drops non-object entries and keeps the object ones", () => {
    expect(parseRows('[42, {"id": "a83f"}, "nope", null]')).toEqual([{ id: "a83f" }]);
  });

  it("returns an empty array when every entry is a non-object", () => {
    expect(parseRows("[1, 2, 3]")).toEqual([]);
  });

  it("drops an object entry with no usable string id", () => {
    expect(parseRows('[{"name": "power"}, {"id": 7}, {"id": ""}, {"id": "b94e"}]')).toEqual([
      { id: "b94e" },
    ]);
  });

  it("returns undefined for the empty string", () => {
    expect(parseRows("")).toBeUndefined();
  });
});
