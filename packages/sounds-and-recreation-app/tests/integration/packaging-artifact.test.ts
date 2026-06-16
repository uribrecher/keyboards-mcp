import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** The .app's Contents/ dir (where Info.plist lives) under any dist-app/mac* arch dir. */
function findAppContentsDir(): string | null {
  const distApp = join(repoRoot, "dist-app");
  if (!existsSync(distApp)) return null;
  for (const d of readdirSync(distApp).filter((m) => m.startsWith("mac"))) {
    const contents = join(distApp, d, "Sounds and Recreation.app", "Contents");
    if (existsSync(join(contents, "Info.plist"))) return contents;
  }
  return null;
}

/** Read a <string> value for a <key> from an XML Info.plist. */
function plistString(plist: string, key: string): string | null {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
}

/** Models that ship a mock-UI web/ dir, as [manufacturer, model]. */
const MODELS_WITH_WEB_UI = [
  ["nord", "electro_5d"],
  ["roland", "juno_x"],
  ["sequential_circuits", "prophet_6"],
] as const;

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

test("packaged .app stamps the app's own version into Info.plist (not keyboards-mcp's)", { skip }, () => {
  const contents = findAppContentsDir();
  assert.ok(contents, "Sounds and Recreation.app/Contents not found — run `npm run sar:dist` first");
  const shortVersion = plistString(readFileSync(join(contents!, "Info.plist"), "utf8"), "CFBundleShortVersionString");

  // CFBundleShortVersionString comes solely from the app package's own version
  // (electron-builder reads it from this package.json). That is the single
  // source of truth — there is no extraMetadata.version override.
  const appVersion = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
  assert.equal(shortVersion, appVersion, `CFBundleShortVersionString should be the app's own version (${appVersion})`);

  // The bundled keyboards-mcp dependency rides its own 2.0.x line; the .app must
  // NOT inherit it — the pre-monorepo conflation this work undoes (#133/#136).
  const appRoot = findAppResourceRoot();
  assert.ok(appRoot, "Resources/app not found");
  const kbVersion = (
    JSON.parse(readFileSync(join(appRoot!, "node_modules", "keyboards-mcp", "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  assert.notEqual(shortVersion, kbVersion, `app bundle version must not be keyboards-mcp's (${kbVersion})`);
});

test("packaged .app bundles each model's mock-UI web assets at its mockUiDir", { skip }, () => {
  const appRoot = findAppResourceRoot();
  assert.ok(appRoot, "Resources/app not found — run `npm run sar:dist` first");
  for (const [mfr, model] of MODELS_WITH_WEB_UI) {
    const modelDir = join(appRoot!, "node_modules", "keyboards-mcp", "dist", "keyboard_models", mfr, model);
    // The renderer loads `file://${model.mockUiDir}/index.html`, and mockUiDir
    // resolves to `${modelDir}/web` (join(__dirname, "web")). Missing files here
    // = dead model iframes — the #135 split regression this guards.
    for (const f of ["index.html", "app.js", "style.css"]) {
      assert.ok(
        existsSync(join(modelDir, "web", f)),
        `${mfr}/${model}/web/${f} missing from .app — model UI iframe would 404`,
      );
    }
    // Guard the path itself: the compiled model must resolve mockUiDir
    // co-located (join(__dirname, "web")), not the pre-split src/ escape that is
    // never shipped in the bundle.
    const compiled = readFileSync(join(modelDir, "index.js"), "utf8");
    assert.match(
      compiled,
      /mockUiDir:\s*join\(__dirname,\s*"web"\)/,
      `${mfr}/${model} mockUiDir is not co-located in dist`,
    );
  }
});
