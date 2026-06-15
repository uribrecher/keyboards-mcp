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
