# Plan #10 — File menu: "New" item

Adds **New** under File in the mock-runner Electron menu, plus dynamic
enable/disable for **New** and **Save**.

## Behavior

- **New** (Cmd/Ctrl+N): resets the rack to empty.
  - If `isDirty`, prompt to save first via the existing
    `confirmDiscardIfDirty()` (same flow as **Open…**).
  - Tear down all tabs (`tearDownAllTabs()`).
  - Clear `currentFilePath = null` and `lastActiveTabId = null`.
  - Clear dirty (`clearDirty()` + `pushDirtyChanged()` so the title bar
    drops the file name and bullet).
  - Refresh menu enabled state.
- **New** is disabled when the rack is already in the empty +
  unattached state: `tabs.size === 0 && currentFilePath === null`.
  Otherwise enabled (including when an empty rack is attached to a
  saved `.mockrack` file — choosing New there still meaningfully
  detaches the file).
- **Save** is disabled when `currentFilePath === null` (no file
  attached). The Cmd/Ctrl+S accelerator follows the menu item's
  enabled state — when there's no file, the user uses **Save As…**
  (which prompts for a path) instead.
- **Save As…** is always enabled.

## Implementation sketch

In `src/mock-runner/main.ts`:

1. Add `newSetup()` mirroring `openDialog()`:
   ```
   if (!await confirmDiscardIfDirty()) return;
   restoring = true;
   try {
     await tearDownAllTabs();
     lastActiveTabId = null;
     currentFilePath = null;
   } finally {
     restoring = false;
     clearDirty();
     pushDirtyChanged();
     refreshMenuEnabledState();
   }
   ```
2. Give the **New** and **Save** menu items stable `id`s
   (`"file.new"`, `"file.save"`). Both start with a hardcoded
   `enabled: false` in the template — at `buildMenu()` time the
   application has no tabs, no attached file, and is not dirty, which
   is exactly the disabled condition for both items. Subsequent
   `refreshMenuEnabledState()` calls update them as state evolves.
3. Add `refreshMenuEnabledState()` that fetches both items via
   `Menu.getApplicationMenu()?.getMenuItemById(id)` and toggles
   `.enabled` based on:
   - **New**: enabled iff `tabs.size > 0 || currentFilePath !== null
     || isDirty` (anything to clear / discard).
   - **Save**: enabled iff `currentFilePath !== null`.
4. Call `refreshMenuEnabledState()` after every state transition that
   can flip the conditions:
   - `create-tab`, `close-tab` IPC handlers (tab count changes).
     `select-model-for-tab` is intentionally NOT a refresh site —
     it modifies an existing tab's model field but leaves
     `tabs.size` untouched, so the menu enable conditions don't
     change.
   - `markDirty()` and `clearDirty()` (so **New** picks up the
     dirty-only edge case where the rack is empty but unsaved
     changes remain).
   - `loadSetupFromPath()` end (file path changes).
   - `saveAs()` end (file path changes).
   - `newSetup()` end (already covered above).
5. After auto-load of recents (or an `open-file` cold-launch),
   `loadSetupFromPath()` refreshes both items — so the cold-start
   `enabled: false` is corrected as soon as the rack is populated.

No mock-handler / model-side changes; renderer is unchanged (the
title bar already reacts to `file:dirty-changed`).
