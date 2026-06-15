import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  build?: { appId?: string; productName?: string; extraMetadata?: { main?: string }; mac?: { target?: string } };
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("electron-builder config carries the Sounds and Recreation identity", () => {
  assert.equal(pkg.build?.appId, "io.sounds-and-recreation");
  assert.equal(pkg.build?.productName, "Sounds and Recreation");
  assert.equal(pkg.build?.extraMetadata?.main, "dist/sounds-and-recreation-app/main.js");
  assert.equal(pkg.build?.mac?.target, "dir");
});

test("sar:dist script and electron-builder dev dep are present", () => {
  assert.match(pkg.scripts?.["sar:dist"] ?? "", /electron-builder/);
  assert.ok(pkg.devDependencies?.["electron-builder"], "electron-builder must be a devDependency");
});

test("renderer import map points at vendored deps (not node_modules — which electron-builder prunes)", () => {
  const indexHtml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "sounds-and-recreation-app", "shell", "index.html"),
    "utf8",
  );
  // The packaged .app must resolve these from shell/vendor/ (bundled via the
  // files glob), NOT from ../../../node_modules (devDeps, which electron-builder
  // prunes — leaving the renderer's app.js unable to load). See #126.
  assert.match(indexHtml, /"marked":\s*"vendor\/marked\.esm\.js"/);
  assert.match(indexHtml, /"@sounds-and-recreation\/agent-client":\s*"vendor\/agent-client\/index\.js"/);
  assert.doesNotMatch(indexHtml, /node_modules\/(marked|@sounds-and-recreation)/);
});

test("vendor copy scripts cover marked + agent-client, wired into the app build", () => {
  assert.match(pkg.scripts?.["copy:peaks-vendor"] ?? "", /marked\.esm\.js/);
  assert.match(pkg.scripts?.["copy:agent-vendor"] ?? "", /agent-client/);
  assert.match(pkg.scripts?.["presar:dist"] ?? "", /copy:agent-vendor/);
});
