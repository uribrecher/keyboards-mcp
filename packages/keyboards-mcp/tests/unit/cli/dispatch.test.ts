import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolveCommand } from "../../../src/cli/main.js";

function argv(...rest: string[]): string[] {
  return ["node", "/path/to/cli.js", ...rest];
}

describe("resolveCommand", () => {
  it("no subcommand → server", () => assert.equal(resolveCommand(argv()), "server"));
  it("install → install", () => assert.equal(resolveCommand(argv("install")), "install"));
  it("uninstall → uninstall", () => assert.equal(resolveCommand(argv("uninstall")), "uninstall"));
  it("broker → broker", () => assert.equal(resolveCommand(argv("broker")), "broker"));
  it("doctor → doctor", () => assert.equal(resolveCommand(argv("doctor")), "doctor"));
  it("--help → help", () => assert.equal(resolveCommand(argv("--help")), "help"));
  it("bogus → unknown", () => assert.equal(resolveCommand(argv("frobnicate")), "unknown"));
});
