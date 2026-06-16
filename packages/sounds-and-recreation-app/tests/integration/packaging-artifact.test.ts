import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// Heavy electron-builder runs are NOT executed inside the test suite. CI (or a
// developer) runs `npm run sar:dist` first, then sets SAR_CHECK_DIST=1 so these
// tests assert the produced bundle is complete. Uses the same env-gated `skip`
// pattern as the repo's MOCK_WS_URL / IS_DOCKER_WS_MODE integration gates.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const skip = process.env.SAR_CHECK_DIST !== "1";

/** Locate the built .app's Contents/Resources/app dir under any dist-app/mac* arch dir. */
function findAppResourceRoot(): string | null {
  const distApp = join(repoRoot, "dist-app");
  if (!existsSync(distApp)) return null;
  for (const d of readdirSync(distApp).filter((m) => m.startsWith("mac"))) {
    const root = join(distApp, d, "Sounds and Recreation.app", "Contents", "Resources", "app");
    if (existsSync(root)) return root;
  }
  return null;
}

test("sar:dist produced Sounds and Recreation.app", { skip }, () => {
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

test("packaged .app bundles the renderer import-map deps (vendored, not pruned)", { skip }, () => {
  const appRoot = findAppResourceRoot();
  assert.ok(appRoot, "Sounds and Recreation.app/Contents/Resources/app not found — run `npm run sar:dist` first");
  // The renderer's index.html import map resolves `marked` and
  // `@sounds-and-recreation/agent-client` to these VENDORED files. Both are
  // devDependencies that electron-builder prunes from node_modules, so if they
  // are missing, the shell's app.js (an ES module) fails to load and the whole
  // UI is dead (#126). This guards against that regression.
  const vendor = join(appRoot!, "src", "shell", "vendor");
  assert.ok(existsSync(join(vendor, "marked.esm.js")), "vendor/marked.esm.js missing from .app");
  assert.ok(
    existsSync(join(vendor, "agent-client", "index.js")),
    "vendor/agent-client/index.js missing from .app",
  );
});
