import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// Each keyboard model ships a mock-UI under keyboard_models/<mfr>/<model>/web/
// (index.html + app.js + style.css). The Sounds and Recreation app serves it by
// navigating an iframe to `file://${model.mockUiDir}/index.html`, where
// mockUiDir is co-located with the compiled module (dist/.../web). `tsc` does
// NOT copy non-TS files, so the build must copy src/.../web -> dist/.../web.
//
// Without that copy the packaged .app's model iframes 404 — the exact
// regression the #135 monorepo split introduced when keyboard_models became a
// dependency the app consumes via dist only. This guards the build's copy step
// (CI builds keyboards-mcp before test:ci, so dist/ is populated here).
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcModels = join(pkgRoot, "src", "keyboard_models");
const distModels = join(pkgRoot, "dist", "keyboard_models");

// This guards a BUILD output, so it only runs where the build is expected to
// have run: the Docker CI services build keyboards-mcp and set MOCK_WS_URL
// (the same signal sibling integration tests gate on). A bare local `npm test`
// (no prior build, no MOCK_WS_URL) skips rather than failing on a missing
// dist/ — but in CI the test runs and still fails if dist/ is unexpectedly absent.
const skip = !process.env.MOCK_WS_URL;

/** [mfr, model] for every src/keyboard_models/<mfr>/<model> that has a web/ UI. */
function modelsWithWebUi(): Array<{ mfr: string; model: string }> {
  const out: Array<{ mfr: string; model: string }> = [];
  for (const mfr of readdirSync(srcModels)) {
    const mfrDir = join(srcModels, mfr);
    if (!statSync(mfrDir).isDirectory()) continue;
    for (const model of readdirSync(mfrDir)) {
      if (existsSync(join(mfrDir, model, "web", "index.html"))) out.push({ mfr, model });
    }
  }
  return out;
}

test("build copies every model's web mock-UI into dist alongside the compiled module", { skip }, () => {
  assert.ok(existsSync(distModels), "dist/keyboard_models missing — CI image must build keyboards-mcp first");

  const models = modelsWithWebUi();
  assert.ok(models.length >= 3, `expected >=3 models with a web/ UI in src, found ${models.length}`);

  for (const { mfr, model } of models) {
    const srcWeb = join(srcModels, mfr, model, "web");
    const distWeb = join(distModels, mfr, model, "web");
    for (const file of readdirSync(srcWeb)) {
      assert.ok(
        existsSync(join(distWeb, file)),
        `dist/keyboard_models/${mfr}/${model}/web/${file} missing — build did not copy web assets`,
      );
    }
  }
});
