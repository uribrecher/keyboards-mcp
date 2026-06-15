import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// Heavy electron-builder runs are NOT executed inside the test suite. CI (or a
// developer) runs `npm run sar:dist` first, then sets SAR_CHECK_DIST=1 so this
// test asserts the produced bundle exists. Uses the same env-gated `skip`
// pattern as the repo's MOCK_WS_URL / IS_DOCKER_WS_MODE integration gates.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("sar:dist produced Sounds and Recreation.app", { skip: process.env.SAR_CHECK_DIST !== "1" }, () => {
  const distApp = join(repoRoot, "dist-app");
  assert.ok(existsSync(distApp), "dist-app/ missing — run `npm run sar:dist` first");
  // electron-builder emits to dist-app/mac/ or dist-app/mac-arm64/ depending on arch.
  const macDirs = readdirSync(distApp).filter((d) => d.startsWith("mac"));
  assert.ok(macDirs.length > 0, "no dist-app/mac* output dir found");
  // Drill to the Mach-O executable (not just the .app dir) so a partial/empty
  // bundle can't pass. Accept the executable under ANY mac* arch dir.
  const found = macDirs.some((d) =>
    existsSync(join(distApp, d, "Sounds and Recreation.app", "Contents", "MacOS", "Sounds and Recreation")),
  );
  assert.ok(found, `Sounds and Recreation.app executable not found under dist-app/${macDirs.join(", ")}`);
});
