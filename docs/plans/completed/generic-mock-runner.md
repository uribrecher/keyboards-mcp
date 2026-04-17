# Generic Mock Runner

## Context

The Electron mock device app (`src/electron/main.ts`, 664 lines) and HTTP mock device (`src/mock-device.ts`) are hardcoded to Nord Electro 5D with massive code duplication. We're converting the Electron app into a generic "mock_runner" that starts with a model picker, loads any registered model dynamically, and contains zero model-specific references. The HTTP mock is being deleted.

## Architecture

```
src/mock-runner/
  main.ts          — Electron main process (generic, no model refs)
  engine.ts        — Mock device engine (MIDI + WebSocket + state)
  preload.cjs      — IPC bridge for renderer
  shell/
    index.html     — Model picker UI
    style.css
    app.js

src/keyboard_models/nord/electro_5d/
  mock-handler.ts  — NEW: Nord-specific mock logic (extracted from electron/main.ts)
```

## Changes

### 1. `src/shared/keyboard-model.ts` — Add MockHandler interfaces

```typescript
export interface MockContext {
  channelState: Map<number, Map<number, number>>;
  lowerChannel: number;
  upperChannel: number;
  parameterMap: ParameterMap;
}

export interface MockHandler {
  init(ctx: MockContext): void;
  onCC(cc: number, value: number, channel: number, ctx: MockContext): { handled?: boolean } | void;
  onProgramChange(program: number, channel: number, ctx: MockContext): void;
  getExtraState(includeInventory: boolean, ctx: MockContext): Record<string, any>;
  onCacheReload?(ctx: MockContext): void;
}
```

Add `createMockHandler?(): MockHandler` to `KeyboardModel`. Remove the unused `applyProgramToMock?()`.

### 2. `src/keyboard_models/nord/electro_5d/mock-handler.ts` — Extract Nord logic

Move all Nord-specific mock state and logic from `electron/main.ts` into a factory function `createNordElectro5DMockHandler(): MockHandler`.

**Closure-scoped state** (not module-level):
- `presetDrawbarState`, `presetOrganToggles`
- `currentBank`, `currentProgram`, `programLoaded`
- `setListMode`, `currentSetList`, `currentSong`, `currentPart`
- `_backup`, `_pianoModels`, `_sampleNames`

**Private helpers in closure:**
- `getActivePreset(ctx)`, `applyProgramParams(params, ctx)`, `applyDrawbars(presetKey, str, ctx)`
- `isRotaryBothForced(ctx)`, `buildInventoryFromCache()`, `resolveSetListSong()`, `loadSetListPart()`

**Imports from:**
- `./backup-cache.js` — `createBackupCache`, `getBackupData`, `getPianoModelsForType`
- `./backup-parser.js` — `ProgramParams` type
- `./midi-map.js` — `PARAMS` (for specific CC lookups: `organ_preset_select`, `program_setlist_mode`, etc.)
- `../../../shared/parameter-resolution.js` — `drawbarToMidi`, `midiToDiscrete`, `resolveValue`

### 3. `src/keyboard_models/nord/electro_5d/index.ts` — Wire mock handler

Import and add `createMockHandler` to the model object.

### 4. `src/mock-runner/engine.ts` — Generic MockEngine class

```typescript
class MockEngine {
  constructor(model: KeyboardModel, opts: { lowerChannel, upperChannel, wsPort })
  start(): void    // Create MIDI port, WebSocket, init channels, handler.init()
  stop(): Promise<void>  // Close MIDI, WebSocket, HTTP server
}
```

**Generic responsibilities:**
- MIDI port named `"${model.info.displayName} Mock"`
- channelState: init from `parameterMap.params` defaults
- CC handling: call handler.onCC(), update channelState, broadcast
- Program Change: call handler.onProgramChange(), broadcast
- State message: build lower/upper/global from parameterMap, merge handler.getExtraState()
- WebSocket: UI clients vs MCP clients (same `?client=mcp` pattern)
- Label formatting: `labelFor()` and `buildParamEntry()` (already generic in current code)

### 5. `src/mock-runner/shell/` — Model picker UI

**index.html**: Title "Keyboard Mock Runner", model list container, loading state.

**app.js**: Calls `window.mockRunnerAPI.getModels()`, renders cards with displayName + manufacturer. On click calls `window.mockRunnerAPI.selectModel(id)`. Auto-selects if only one model.

**style.css**: Dark theme, centered cards, hover states.

### 6. `src/mock-runner/main.ts` — Electron main process

**Zero model-specific imports.** Uses `discoverModels()` and `loadModelById()` from model-registry.

**Flow:**
1. `app.whenReady()` → create BrowserWindow loading `shell/index.html`
2. IPC `get-models` → `discoverModels()`, returns `KeyboardModelInfo[]`
3. IPC `select-model` → `switchModel(modelId)`
4. IPC `open-backup-dialog` → native file dialog (generic filters)

**`switchModel(modelId)`:**
1. Stop existing engine (if any)
2. `loadModelById(modelId)`
3. Create + start new MockEngine
4. Update window title
5. Load `model.mockUiDir/index.html` into BrowserWindow

**Menu bar:** File > Switch Model (loads shell/index.html), File > Quit

### 7. `src/mock-runner/preload.cjs`

Exposes `window.mockRunnerAPI`:
- `getModels()`, `selectModel(id)`, `getCurrentModel()`, `openBackupDialog()`

### 8. Nord web UI update

In `src/keyboard_models/nord/electro_5d/web/app.js`: replace `window.electronAPI` → `window.mockRunnerAPI`.

### 9. `package.json` updates

- Remove `"mock"` script
- Change `"mock:electron"` → `"mock:runner": "electron dist/mock-runner/main.js"`

### 10. Delete old files

- `src/mock-device.ts`
- `src/electron/main.ts`
- `src/electron/preload.cjs`

## Verification

1. `npm run build` — compiles clean
2. `npm run mock:runner` — model picker appears
3. Select Nord Electro 5D — UI loads, MIDI port created
4. Connect MCP, send CC/Program Change — state updates in UI
5. File > Switch Model — returns to picker
6. Re-extract button works (openBackupDialog)