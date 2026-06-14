import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  DAEMON_LABEL,
  plistPath,
  launchAgentDir,
  brokerLogPath,
  renderLaunchAgentPlist,
} from "../../../src/cli/plist.js";

describe("plist paths", () => {
  it("plistPath is <home>/Library/LaunchAgents/<label>.plist", () => {
    assert.equal(
      plistPath("/Users/test"),
      `/Users/test/Library/LaunchAgents/${DAEMON_LABEL}.plist`,
    );
  });

  it("launchAgentDir is <home>/Library/LaunchAgents", () => {
    assert.equal(launchAgentDir("/Users/test"), "/Users/test/Library/LaunchAgents");
  });

  it("brokerLogPath is <home>/.mcb/mcb.log", () => {
    assert.equal(brokerLogPath("/Users/test"), "/Users/test/.mcb/mcb.log");
  });
});

describe("renderLaunchAgentPlist", () => {
  const xml = renderLaunchAgentPlist({
    nodePath: "/usr/local/bin/node",
    cliPath: "/usr/local/lib/node_modules/keyboards-mcp/dist/cli/index.js",
    logPath: "/Users/test/.mcb/mcb.log",
  });

  it("uses the daemon label", () => {
    // Structure via regex; exact label via a literal string match (DAEMON_LABEL
    // contains '.' which are regex wildcards — don't interpolate it into a RegExp).
    assert.match(xml, /<key>Label<\/key>\s*<string>/);
    assert.ok(xml.includes(`<string>${DAEMON_LABEL}</string>`), "exact daemon label present");
  });

  it("invokes node, then the cli, then the broker subcommand", () => {
    const i = xml.indexOf("/usr/local/bin/node");
    const j = xml.indexOf("dist/cli/index.js");
    const k = xml.indexOf("<string>broker</string>");
    assert.ok(i > -1 && j > i && k > j, "expected node → cli → broker ordering");
  });

  it("sets RunAtLoad and KeepAlive true", () => {
    assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("routes stdout and stderr to the log path", () => {
    assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/test\/\.mcb\/mcb\.log<\/string>/);
    assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/test\/\.mcb\/mcb\.log<\/string>/);
  });

  it("XML-escapes &, <, > in interpolated paths", () => {
    const escaped = renderLaunchAgentPlist({
      nodePath: "/usr/local/bin/node",
      cliPath: "/Users/test/Mike & <Co>/dist/cli/index.js",
      logPath: "/Users/test/.mcb/mcb.log",
    });
    assert.match(escaped, /Mike &amp; &lt;Co&gt;/);
    assert.doesNotMatch(escaped, /Mike & </);
  });
});
