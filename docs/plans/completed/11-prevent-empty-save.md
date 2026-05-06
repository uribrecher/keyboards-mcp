# Plan #11 — Prevent saving an empty rack

A `.mockrack` file is supposed to capture a studio setup — a list of
mock tabs with model + label + state. Today the app happily writes a
`.mockrack` whose `tabs` array is empty, in three ways:

1. **Save As… on an empty rack** — creates a useless empty file.
2. **Cmd+S on a previously-loaded rack you've closed all tabs of** —
   overwrites your saved file with empty content. **Data loss.**
3. **Quit / New with `isDirty=true` on an empty rack** —
   `confirmDiscardIfDirty()` offers a **Save** button that triggers
   path 1 or 2.

A "saveable" state is: at least one tab has both `model` and `engine`
(the same filter `buildSetupSnapshot()` already uses).

## Three-layer guard

### Layer 1 — Menu state (UX hint)

Extend `refreshMenuEnabledState()`:

- **Save**: `currentFilePath !== null && hasContentToSave()`
  (was: just `currentFilePath !== null`).
- **Save As…**: `hasContentToSave()` (was: always enabled — minor UX
  change, but right: there's no point in offering to create a
  destination file when there's nothing to put in it).

Add `select-model-for-tab` to the refresh call sites — a tab
transitions to "has model" inside that handler, which is exactly what
flips `hasContentToSave()`.

### Layer 2 — Function guards (defense in depth)

`saveCurrent()` and `saveAs()` early-return with a `menu:console-note`
if `!hasContentToSave()`. Catches any future caller (and the
dirty-prompt's "Save" button if Layer 3 misses).

### Layer 3 — Dirty prompt UX

When the rack has no content, `confirmDiscardIfDirty()` shows just
**Discard | Cancel** — no Save button. Semantically correct: you have
unsaved emptiness; either throw it away or keep editing. There's
nothing to save.

## What stays the same

- `New` still works on empty + dirty (the existing isDirty term in its
  enable condition is unchanged — the "discard" path still resets
  cleanly).
- `Save As…` semantics are unchanged when the rack has content.
- Existing `confirmDiscardIfDirty()` flow is unchanged when the rack
  has content.

## Implementation

In `src/mock-runner/main.ts`:

```ts
function hasContentToSave(): boolean {
  for (const t of tabs.values()) {
    if (t.model && t.engine) return true;
  }
  return false;
}
```

Called from `refreshMenuEnabledState()`, `saveCurrent()`, `saveAs()`,
and `confirmDiscardIfDirty()`. No new state, no async work.
