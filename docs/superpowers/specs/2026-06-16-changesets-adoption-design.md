---
topic: changesets-adoption
issue: https://github.com/uribrecher/keyboards-mcp/issues/137
epic: https://github.com/uribrecher/keyboards-mcp/issues/133
status: design
related:
  - ./2026-06-16-monorepo-workspaces-split-design.md          # #135 — the workspaces split this builds on
  - ./2026-06-15-sounds-and-recreation-app-rename-design.md   # #126/#131 — the app rename whose changelog entry moves here
---

# Adopt Changesets for per-package versions + changelogs

## Problem

The workspaces split (#135) and the independent app version (#136) are landed: the repo
is now an npm-workspaces monorepo with `packages/keyboards-mcp` (published, `2.0.0`) and
`packages/sounds-and-recreation-app` (private, `0.1.0`). But there is still **no release
tooling**: nothing produces per-package version bumps or per-package changelogs, and the
two packages have no shared way to declare "this change bumps package X by a minor."

Concretely:
- `packages/keyboards-mcp/CHANGELOG.md` is hand-maintained in **Keep-a-Changelog** format,
  and its `[Unreleased]` section actually describes the **app rename** (#126/#131/#132) —
  app-facing content mis-filed under the MCP server.
- `packages/sounds-and-recreation-app` has **no `CHANGELOG.md`** at all.
- There is no machine-readable record of pending changes, so a release means hand-editing
  versions and changelogs across two packages.

This is sub-issue **#137** of epic **#133**. It delivers only the **Changesets adoption**
(config + flow + changelog migration); the CI release automation that drives the flow is
deferred to sibling sub-issue **#138** (see Scope).

## Goal

Adopt [Changesets](https://github.com/changesets/changesets) so that the two packages
version and changelog **independently** from machine-readable changeset files, with the
private app versioned-but-never-published. Specifically, `changeset version` must produce
correct per-package bumps + changelogs, and `changeset publish` must publish only
`keyboards-mcp` and skip the private app.

## Decisions (settled with the issue author)

1. **Changelog generator — `@changesets/changelog-github`.** Chosen over the default
   `@changesets/cli/changelog` because the repo already references PRs by number
   (`(#126, #131, #132)`) and values author/PR attribution. It needs a `GITHUB_TOKEN` at
   `changeset version` time: CI (the #138 `changesets/action`) supplies it automatically;
   local runs use `GITHUB_TOKEN=$(gh auth token)`. Config form:
   `["@changesets/changelog-github", { "repo": "uribrecher/keyboards-mcp" }]`.

2. **The mis-filed `[Unreleased]` entry moves to the app.** The app-rename content
   (#126/#131/#132) is seeded into a new `packages/sounds-and-recreation-app/CHANGELOG.md`
   as the app's `## 0.1.0` entry (Changesets format), and the `[Unreleased]` block is
   **removed** from `keyboards-mcp`'s changelog — leaving it clean at `[2.0.0]`. This
   realizes the epic's "split by audience" goal. (The app is already at `0.1.0`; this is a
   historical seed, **not** a version bump.)

3. **Pure-infra PR — no version bump, no publish.** #137 adds tooling and migrates
   changelogs only. It deliberately ships **no changeset file** and **no version bump**:
   bumping `2.0.0 → 2.0.1` for a chore that doesn't touch published code would be
   misleading, and the actual release cadence belongs to #138 / future feature PRs. The
   first real changeset arrives with the next change that affects a package.

4. **Independent versioning — empty `linked`/`fixed`.** The two packages must bump on
   their own cadence (the whole point of #133), so no linking. The coupling is the
   existing `"keyboards-mcp": "^2"` dependency: a keyboards-mcp *minor* stays within `^2`
   and will **not** force-bump the app; only a keyboards-mcp *major* (out of `^2`) makes
   Changesets bump the app and update its range. Default `updateInternalDependencies`
   (`"patch"`) is kept.

5. **Private app skipped at publish via `private: true`.** `privatePackages` is set to
   `{ "version": true, "tag": false }` exactly as the issue specifies — Changesets
   *versions* the app and writes its changelog but creates **no git tag** for it. The app
   is **never published** because its `package.json` has `"private": true`, which both npm
   and `changeset publish` honor.

## Changes (file-by-file)

### 1. `.changeset/config.json` (new)

```json
{
  "$schema": "https://unpkg.com/@changesets/config@<installed-version>/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "uribrecher/keyboards-mcp" }],
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "privatePackages": { "version": true, "tag": false },
  "ignore": []
}
```

- `$schema` is pinned to the installed `@changesets/config` version for editor validation.
- `access: "public"` — `keyboards-mcp` publishes publicly (the app is private and unaffected).
- `commit: false` — Changesets does not auto-commit; the human / CI owns commits.

### 2. `.changeset/README.md` (new)

The standard Changesets folder readme (as written by `changeset init`), explaining what
the directory is and linking the docs. Committed alongside the config.

### 3. Root `package.json`

- Add devDeps: `@changesets/cli` and `@changesets/changelog-github`.
- Add scripts (named to avoid the `version`/`prepublish` npm lifecycle collisions):
  ```jsonc
  "changeset": "changeset",
  "changeset:version": "changeset version",
  "changeset:publish": "changeset publish"
  ```

### 4. `packages/keyboards-mcp/CHANGELOG.md` (restructure)

- H1 `# Changelog` → `# keyboards-mcp`. Changesets prepends new entries immediately after
  line 1, so the H1 **must** be the package name for future entries to slot in cleanly.
- Drop the Keep-a-Changelog preamble — including the "Releases are published … when a
  `vX.Y.Z` tag is pushed" note, which #138 is about to invalidate.
- **Remove** the `[Unreleased]` block (its content moves to the app, decision 2).
- **Normalize the 2.0.0 entry to native Changesets format** so it matches the app changelog
  and the entries `changeset version` will prepend going forward:
  `## [2.0.0] - 2026-06-14` → `## 2.0.0`; the Keep-a-Changelog `### Added/Changed/Removed`
  headings become a single `### Major Changes` section (2.0.0 is the major release) with the
  original Added/Changed/Removed groups kept as **bold sub-labels** so no published detail is
  lost; drop the `[2.0.0]: …` reference link (native format doesn't use one). The change
  *wording* is preserved verbatim — only the heading/section structure is normalized.

  > **Revised during PR #145 review.** The first cut of this spec kept the 2.0.0 block
  > verbatim in Keep-a-Changelog format. The issue author found the two changelogs being in
  > different formats confusing, so we normalized 2.0.0 to the native format below. Changesets
  > never rewrites existing entries on its own — this is a one-time manual normalization.

Result:

```markdown
# keyboards-mcp

## 2.0.0

### Major Changes

First release published to npm. (Earlier `1.x` development was never published.)

**Added**
- … (original bullets, unchanged)

**Changed**
- … (original bullets, unchanged)

**Removed**
- … (original bullets, unchanged)
```

> Note: native Changesets sections are bump-type (`### Major/Minor/Patch Changes`), **not**
> the Keep-a-Changelog `### Added/Changed/Removed`. The bold `**Added/Changed/Removed**` here
> are intentional sub-labels *inside* `### Major Changes`, kept only to preserve the original
> 2.0.0 detail — not headings.

### 5. `packages/sounds-and-recreation-app/CHANGELOG.md` (new)

```markdown
# sounds-and-recreation-app

## 0.1.0

### Minor Changes

- Renamed the Electron desktop app from "Mock Runner" to **Sounds and Recreation**;
  added `npm run sar:dist` to build a standalone, unsigned `Sounds and Recreation.app`
  (UI facade + in-process mock keyboards); vendored the renderer's import-map deps
  (`marked`, `@sounds-and-recreation/agent-client`) into `shell/vendor/` so the packaged
  app launches and is fully interactive. Internal mock/`.mockrack` formats unchanged.
  (#126, #131, #132)
```

### Out of scope (left untouched)

- `.github/workflows/release.yml` — the tag-driven single-package publish flow. Switching
  it to the `changesets/action` flow is **#138**. #137 does not touch it; adopting
  Changesets does not break it (it triggers on tag push, independent of these files).
- Any real version bump, any `npm publish`, any committed changeset file.

## Verification of the "Done when"

Both checks run **inside the worktree and are reverted** — nothing version-bumped is
committed:

1. **`changeset version` produces correct per-package bumps + changelogs.**
   Hand-author a throwaway changeset targeting both packages (keyboards-mcp `patch`, app
   `minor`), then:
   ```bash
   GITHUB_TOKEN=$(gh auth token) npx changeset version
   ```
   Assert: `keyboards-mcp` `2.0.0 → 2.0.1` with a new `## 2.0.1` CHANGELOG entry; app
   `0.1.0 → 0.2.0` with a new `## 0.2.0` entry; entries carry the PR/author links from the
   github generator. Then `git restore .` + delete the scratch changeset to discard.

2. **`changeset publish` publishes only `keyboards-mcp`, skips the private app.**
   Demonstrated auth-free (no npm token needed) via per-workspace dry runs:
   ```bash
   npm publish --dry-run -w keyboards-mcp              # prints a tarball → publishable
   npm publish --dry-run -w sounds-and-recreation-app  # errors "marked as private" → skipped
   ```
   `changeset publish` defers to exactly this `private` flag, so the app is never a publish
   candidate. (A live `changeset publish` is not run — it requires npm OIDC/token and would
   actually publish; the dry runs prove the targeting.)

3. **Sanity:** `npx changeset status` runs cleanly against the config; `npm run lint` and
   `npm run test:check` stay green (no source changed, but confirm the root scripts/devDep
   additions don't break install or the delegators).

## Scope

- **In:** `.changeset/config.json` + `.changeset/README.md`; root `package.json` devDeps +
  scripts; `keyboards-mcp` changelog restructure; new app `CHANGELOG.md` seeded from the
  moved `[Unreleased]` entry; local verification of the version + publish-targeting flow.
- **Out:** CI release automation / `release.yml` rewrite (#138); any actual version bump or
  publish; a third "core" package (rejected in #135); changing the app's `0.1.0` version.

## References

- Epic #133 · sub-issues #135 (split, done) · #136 (independent app version, done) ·
  #138 (release automation, next).
- Sibling specs: `2026-06-16-monorepo-workspaces-split-design.md`,
  `2026-06-15-sounds-and-recreation-app-rename-design.md`.
- [Changesets docs](https://github.com/changesets/changesets) ·
  [`@changesets/changelog-github`](https://github.com/changesets/changesets/tree/main/packages/changelog-github) ·
  [config schema](https://github.com/changesets/changesets/blob/main/docs/config-file-options.md).
