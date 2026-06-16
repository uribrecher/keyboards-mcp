// Copy each keyboard model's mock-UI web assets from src/ into dist/ next to
// the compiled module. `tsc` only emits .js/.d.ts, so the static web/ dirs
// (index.html, app.js, style.css) never reach dist on their own. Consumers
// that bundle only dist/ — notably the Sounds and Recreation .app, which
// serves the model UI via `file://${model.mockUiDir}/index.html` — need them
// there. Run as the build's second step (`tsc && node scripts/copy-web-assets.mjs`).
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, relative } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcModels = join(pkgRoot, "src", "keyboard_models");
const distModels = join(pkgRoot, "dist", "keyboard_models");

if (!existsSync(distModels)) {
  console.error(`copy-web-assets: ${distModels} not found — run \`tsc\` before this script.`);
  process.exit(1);
}

/** Recursively find every dir named "web" under src/keyboard_models. */
function findWebDirs(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === "web") found.push(full);
    else found.push(...findWebDirs(full));
  }
  return found;
}

let copied = 0;
for (const srcWeb of findWebDirs(srcModels)) {
  const distWeb = join(distModels, relative(srcModels, srcWeb));
  cpSync(srcWeb, distWeb, { recursive: true });
  copied++;
  console.log(`copy-web-assets: ${relative(pkgRoot, srcWeb)} -> ${relative(pkgRoot, distWeb)}`);
}

if (copied === 0) console.warn("copy-web-assets: no model web/ dirs found under src/keyboard_models");
else console.log(`copy-web-assets: copied ${copied} model web UI dir(s).`);
