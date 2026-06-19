---
---

Metadata-only change: add `repository`, `homepage`, and `bugs` fields to
`packages/keyboards-mcp/package.json` so npm links back to the GitHub repo and
Pages site (#154). No package release intended — this empty changeset satisfies
the CI `changeset` gate, which flags any edit under `package.json`. The metadata
reaches npm with the next genuine release (no forced publish).
