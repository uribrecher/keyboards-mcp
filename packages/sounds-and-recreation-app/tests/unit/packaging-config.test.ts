import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  private?: boolean;
  version?: string;
  build?: {
    appId?: string;
    productName?: string;
    extraMetadata?: { main?: string; version?: string };
    mac?: { target?: string };
  };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("electron-builder config carries the Sounds and Recreation identity", () => {
  assert.equal(pkg.build?.appId, "io.sounds-and-recreation");
  assert.equal(pkg.build?.productName, "Sounds and Recreation");
  assert.equal(pkg.build?.extraMetadata?.main, "dist/main.js");
  assert.equal(pkg.build?.mac?.target, "dir");
});

test("app is a private, independently-versioned package coupled to keyboards-mcp by range", () => {
  // .app/.dmg-only: Changesets versions it and writes its changelog but never
  // publishes it (#133/#136).
  assert.equal(pkg.private, true, "the app package must be private (never npm-published)");

  // Its own SemVer line, independent of keyboards-mcp's 2.0.x.
  assert.match(pkg.version ?? "", /^\d+\.\d+\.\d+/, "app must declare its own SemVer version");

  // Coupling is expressed as a dependency (a version range), not a shared
  // number — electron-builder reads CFBundleShortVersionString from `version`
  // above, so there is deliberately no extraMetadata.version override.
  assert.match(
    pkg.dependencies?.["keyboards-mcp"] ?? "",
    /^[\^~]?\d/,
    "app must depend on keyboards-mcp by version range",
  );
  assert.equal(
    pkg.build?.extraMetadata?.version,
    undefined,
    "no extraMetadata.version override — package `version` is the single source of truth",
  );
});

test("sar:dist script and electron-builder dev dep are present", () => {
  assert.match(pkg.scripts?.["sar:dist"] ?? "", /electron-builder/);
  assert.ok(pkg.devDependencies?.["electron-builder"], "electron-builder must be a devDependency");
});

test("renderer import map: vendored + non-bare addresses (so the .app's app.js loads)", () => {
  const indexHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "shell", "index.html"),
    "utf8",
  );
  const m = indexHtml.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/);
  assert.ok(m, "importmap <script> not found in index.html");
  const map = JSON.parse(m![1]) as { imports: Record<string, string> };

  // Must resolve from shell/vendor/ (bundled via the files glob), NOT
  // ../../../node_modules (devDeps that electron-builder prunes). See #126.
  assert.equal(map.imports["marked"], "./vendor/marked.esm.js");
  assert.equal(map.imports["@sounds-and-recreation/agent-client"], "./vendor/agent-client/index.js");

  // CRITICAL: import-map ADDRESSES must be absolute or start with ./ ../ or /.
  // A bare value like "vendor/x.js" is rejected by Chromium ("blocked by a null
  // value") and the module fails to load — which left the .app's UI dead (#126).
  for (const [spec, addr] of Object.entries(map.imports)) {
    assert.match(addr, /^(\.{0,2}\/|https?:)/, `import-map address for "${spec}" is a bare specifier: "${addr}"`);
    assert.doesNotMatch(addr, /node_modules/, `import-map address for "${spec}" must not point at node_modules: "${addr}"`);
  }
});

test("vendor copy scripts cover marked + agent-client, wired into the app build", () => {
  assert.match(pkg.scripts?.["copy:peaks-vendor"] ?? "", /marked\.esm\.js/);
  assert.match(pkg.scripts?.["copy:agent-vendor"] ?? "", /agent-client/);
  assert.match(pkg.scripts?.["presar:dist"] ?? "", /copy:agent-vendor/);
});
