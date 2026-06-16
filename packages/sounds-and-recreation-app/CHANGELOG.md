# sounds-and-recreation-app

## 0.1.0

### Minor Changes

- Renamed the Electron desktop app from "Mock Runner" to **Sounds and Recreation**
  and added `npm run sar:dist` to build a standalone, unsigned `Sounds and Recreation.app`
  (UI facade + in-process mock keyboards). The renderer's import-map dependencies
  (`marked`, `@sounds-and-recreation/agent-client`) are vendored into `shell/vendor/`
  so the packaged app launches and is fully interactive. Internal mock/`.mockrack`
  formats unchanged. (#126, #131, #132)
