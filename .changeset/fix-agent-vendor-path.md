---
---

Fix `npm run sar` launching a non-responsive app (no release — private app,
build-script only).

`copy:agent-vendor` looked for the `@sounds-and-recreation/agent-client`
`file:` dep in the hoisted root `node_modules`, but npm keeps that symlink in
the **app-local** `node_modules` (only registry deps like peaks.js hoist to
root). So the guard never found it, the agent client was never vendored into
`src/shell/vendor/agent-client/`, and `app.js`'s top-level `import` 404'd —
taking the whole renderer down. The check now tries app-local first, then root
(the latter covers the SDK once it's published, sound-recreation-agent#37).
