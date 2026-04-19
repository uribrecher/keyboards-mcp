# keyboards-mcp Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move keyboards-mcp into a shared parent folder, remove agent code and dependencies, and update docs/configs for the new multi-repo structure.

**Architecture:** keyboards-mcp sheds its agent responsibilities (`agent.ts`, `openai` dep, `recreate-sound.md`) and becomes a pure MCP server + mock device simulator. The mock runner stays but will later gain agent-launcher capability (plan 6).

**Tech Stack:** Node.js, TypeScript, npm

**Spec:** `docs/superpowers/specs/2026-04-19-multi-repo-split-design.md`

---

### Task 1: Create parent folder and move repo

**Files:**
- Create: `~/test/sounds-and-recreation/` (parent directory)

- [ ] **Step 1: Create the parent directory**

```bash
mkdir -p ~/test/sounds-and-recreation
```

- [ ] **Step 2: Move keyboards-mcp into the parent folder**

```bash
mv ~/test/keyboards-mcp ~/test/sounds-and-recreation/keyboards-mcp
```

- [ ] **Step 3: Verify the move**

```bash
cd ~/test/sounds-and-recreation/keyboards-mcp
git status
npm run build
```

Expected: clean git status, successful build.

- [ ] **Step 4: Update .mcp.json with new path**

Update the absolute path in `.mcp.json`:

```json
{
  "mcpServers": {
    "keyboards-mcp": {
      "command": "node",
      "args": ["~/test/sounds-and-recreation/keyboards-mcp/dist/index.js"]
    }
  }
}
```

- [ ] **Step 5: Verify MCP server works from new location**

Reload the MCP server in Claude Code (`/mcp`) and verify tools are available.

---

### Task 2: Remove agent.ts and openai dependency

**Files:**
- Delete: `src/agent.ts`
- Modify: `package.json`

- [ ] **Step 1: Delete agent.ts**

```bash
rm src/agent.ts
```

- [ ] **Step 2: Remove openai dependency**

```bash
npm uninstall openai
```

- [ ] **Step 3: Remove agent-related scripts from package.json**

Remove these scripts from `package.json`:

```json
"agent": "tsx src/agent.ts",
"run:mlx": "mlx_lm.server --model ${MLX_MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit} --port ${MLX_PORT:-8080}",
```

- [ ] **Step 4: Verify build and lint still pass**

```bash
npm run build && npm run lint
```

Expected: PASS (no references to agent.ts from other source files).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove agent.ts and openai dependency

Agent functionality is moving to the sound-recreation-agent repo."
```

---

### Task 3: Move recreate-sound.md and agent-redesign-research.md

**Files:**
- Delete: `docs/recreate-sound.md`
- Delete: `docs/plans/pending/agent-redesign-research.md`

These files will be recreated in the sound-recreation-agent repo (plan 8b). We delete them here so they don't cause confusion.

- [ ] **Step 1: Delete recreate-sound.md**

```bash
rm docs/recreate-sound.md
```

- [ ] **Step 2: Delete agent-redesign-research.md**

```bash
rm docs/plans/pending/agent-redesign-research.md
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove agent-related docs (moved to sound-recreation-agent repo)"
```

---

### Task 4: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Remove agent-related sections and update the architecture description.

- [ ] **Step 1: Remove agent script references from Build & Run**

Remove the `npm run agent` line (it no longer exists). Keep `mock:runner` and `mock:headless`.

- [ ] **Step 2: Remove the Agent mode section**

Remove the `### Agent mode` section near the bottom of CLAUDE.md that describes `src/agent.ts`.

- [ ] **Step 3: Update architecture description**

In the architecture section, remove any references to the agent bridging a chat UI. The architecture is now:

```
Claude Code <-MCP/stdio-> MCP Server <-MIDI-> Keyboard (or Mock)
```

- [ ] **Step 4: Update the save-plans convention**

Update the convention to note the multi-repo structure:

```markdown
- Save implementation plans to `docs/plans/` before starting work
- Parent workspace: `~/test/sounds-and-recreation/` (sibling repos: sound-recreation-agent, audio-analysis-mcp, macos-packager)
```

- [ ] **Step 5: Verify CLAUDE.md is consistent**

Read through the file and ensure no dangling references to `agent.ts`, `openai`, or `recreate-sound.md`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for multi-repo structure"
```

---

### Task 5: Update plans and verify

**Files:**
- Modify: `docs/plans/pending/todo-list.md` (if it references agent work)

- [ ] **Step 1: Check todo-list.md for agent references**

Read `docs/plans/pending/todo-list.md` and remove any tasks that are now in the agent repo's scope (agent redesign, Vercel AI SDK migration, etc.). Add a note pointing to the sound-recreation-agent repo.

- [ ] **Step 2: Run full test suite**

```bash
npm run test:ci
```

Expected: All tests pass. No test should reference agent.ts.

- [ ] **Step 3: Verify build is clean**

```bash
npm run build
```

Expected: No errors, `dist/` has no `agent.js`.

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "chore: clean up remaining agent references in plans"
```

---

### Task 6: Create placeholder directories for sibling repos

**Files:**
- Create: `~/test/sounds-and-recreation/sound-recreation-agent/.gitkeep`
- Create: `~/test/sounds-and-recreation/audio-analysis-mcp/.gitkeep`
- Create: `~/test/sounds-and-recreation/macos-packager/.gitkeep`

- [ ] **Step 1: Create empty directories for sibling repos**

```bash
mkdir -p ~/test/sounds-and-recreation/sound-recreation-agent
mkdir -p ~/test/sounds-and-recreation/audio-analysis-mcp
mkdir -p ~/test/sounds-and-recreation/macos-packager
```

These will be populated by plans 8b, 8c, and 8d respectively.

- [ ] **Step 2: Verify workspace layout**

```bash
ls ~/test/sounds-and-recreation/
```

Expected output:
```
audio-analysis-mcp
keyboards-mcp
macos-packager
sound-recreation-agent
```