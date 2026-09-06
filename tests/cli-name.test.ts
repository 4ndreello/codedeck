import { afterEach, describe, expect, it } from "vitest";
import { getCliInvocation, getCliName } from "../src/cli/cli-name.js";

afterEach(() => {
  delete process.env.CODEDECK_CLI_NAME;
});

describe("cli name", () => {
  it("defaults to the published name and npx invocation", () => {
    expect(getCliName()).toBe("codedeck");
    expect(getCliInvocation()).toBe("npx codedeck");
  });

  it("uses CODEDECK_CLI_NAME as a bare invocation when set", () => {
    process.env.CODEDECK_CLI_NAME = "codedeck-dev";
    expect(getCliName()).toBe("codedeck-dev");
    expect(getCliInvocation()).toBe("codedeck-dev");
  });

  it("trims the override and falls back when blank", () => {
    process.env.CODEDECK_CLI_NAME = "  codedeck-dev  ";
    expect(getCliName()).toBe("codedeck-dev");
    process.env.CODEDECK_CLI_NAME = "   ";
    expect(getCliName()).toBe("codedeck");
    expect(getCliInvocation()).toBe("npx codedeck");
  });
});
