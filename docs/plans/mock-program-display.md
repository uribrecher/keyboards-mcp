# Plan: Add program display and MIDI PC/Bank Select support to mock device

## Context

The mock device currently receives Program Change and Bank Select MIDI messages but doesn't track or display them. When `load_program` sends Bank Select (CC0 + CC32) followed by Program Change, the mock just logs them as "unmapped". We need the mock to track the current program (bank:slot) and display it in the web UI, optionally resolving the program name from the inventory cache.

## Changes

### 1. Add program state to mock device

**File:** `src/mock-device.ts`

- Add module-level state: `let currentBank = 0;` (0-indexed, from CC32) and `let currentProgram = 0;` (0-indexed, from PC message)
- In the CC handler, intercept CC0 (Bank Select MSB, ignored — always 0) and CC32 (Bank Select LSB) to update `currentBank`
- In the existing `midiInput.on("program", ...)` handler, update `currentProgram` from `msg.number`
- These should NOT go through the normal CC→param routing (CC0 and CC32 are not Nord parameters)

### 2. Add program info to StateMessage

**File:** `src/mock-device.ts`

- Add to `StateMessage` interface:
  ```typescript
  program?: {
    bank: number;    // 1-indexed (display)
    slot: number;    // 1-indexed (display)
    name?: string;   // from inventory cache, if available
  };
  ```
- In `buildStateMessage()`, populate from `currentBank` and `currentProgram`:
  - `bank: currentBank + 1` (convert to 1-indexed)
  - `slot: currentProgram + 1` (convert to 1-indexed)
  - Look up program name from `getBackupData()?.programs` matching bank/slot
- Update the program change handler to broadcast with program info
- Update console log to show `Program ${bank}:${slot} (name)` instead of just `Program Change #N`

### 3. Add program display to web UI

**File:** `src/web/index.html`

- Add a program display element in the header area (between header and parts bar), using existing `.display` pattern:
  ```html
  <div class="program-display" id="display-program">
    <span class="display-label">PROGRAM</span>
    <span class="display-value" id="val-program">-</span>
  </div>
  ```

**File:** `src/web/style.css`

- Style the program display — use similar styling to the existing `.display` class but positioned prominently

**File:** `src/web/app.js`

- In the WebSocket message handler / `updateUI()`, read `data.program` and update the display:
  - Show `"bank:slot"` (e.g., "1:10")
  - If name is available, show `"bank:slot — Name"` (e.g., "1:10 — Italian Grand")
  - Show `"-"` when no program has been loaded

### 4. Intercept Bank Select CCs before normal routing

**File:** `src/mock-device.ts`

- In the CC handler, add early return for CC0 and CC32:
  - CC0: ignore (MSB is always 0 for Nord)
  - CC32: store as `currentBank = msg.value`
  - Log both but don't route through param lookup or broadcast (the program display updates on PC message)

## Files to modify

- `src/mock-device.ts` — program state, CC0/CC32 interception, PC handler, StateMessage
- `src/web/index.html` — program display element
- `src/web/style.css` — program display styling
- `src/web/app.js` — program display update from WebSocket data

## Verification

1. `npm run build` — no errors
2. Start mock device, connect MCP to Nord
3. Call `load_program` with bank 1, slot 10 — mock console should show `Program 1:10 (Italian Grand)`
4. Web UI should display "1:10 — Italian Grand" in the program display
5. Changing programs should update the display in real time
