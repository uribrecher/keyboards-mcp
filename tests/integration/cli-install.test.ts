import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDaemon, uninstallDaemon, type Runner } from "../../src/cli/install.js";
import { plistPath, DAEMON_LABEL } from "../../src/cli/plist.js";

function recordingRunner(): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => { calls.push([cmd, ...args]); };
  return { runner, calls };
}

describe("installDaemon", () => {
  it("writes the plist and loads it via launchctl (bootout → bootstrap → kickstart)", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-inst-"));
    const { runner, calls } = recordingRunner();

    const healthy = await installDaemon({
      home,
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/kbmcp/dist/cli/index.js",
      runner,
      waitForHealth: async () => true,
      log: () => {},
    });

    assert.equal(healthy, true);
    const plist = plistPath(home);
    assert.ok(existsSync(plist), "plist written");
    const xml = readFileSync(plist, "utf8");
    assert.match(xml, /<string>broker<\/string>/);
    assert.match(xml, new RegExp(DAEMON_LABEL));

    const verbs = calls.map((c) => c[1]); // each call is ["launchctl", <verb>, ...]
    assert.deepEqual(verbs, ["bootout", "bootstrap", "kickstart"]);
  });

  it("returns false (does not throw) when the broker never becomes healthy", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-inst-"));
    const { runner } = recordingRunner();
    const healthy = await installDaemon({
      home, nodePath: "/n", cliPath: "/c", runner,
      waitForHealth: async () => false, log: () => {},
    });
    assert.equal(healthy, false);
    assert.ok(existsSync(plistPath(home)), "plist still written even when unhealthy");
  });
});

describe("uninstallDaemon", () => {
  it("removes the plist and is idempotent when already gone", async () => {
    const home = mkdtempSync(join(tmpdir(), "kbmcp-uninst-"));
    const { runner } = recordingRunner();

    await installDaemon({
      home, nodePath: "/n", cliPath: "/c", runner,
      waitForHealth: async () => true, log: () => {},
    });
    assert.ok(existsSync(plistPath(home)));

    await uninstallDaemon({ home, runner, log: () => {} });
    assert.equal(existsSync(plistPath(home)), false, "plist removed");

    // second uninstall must not throw
    await uninstallDaemon({ home, runner, log: () => {} });
  });
});
