/**
 * SONG ANALYSIS panel — jobs explorer + analyze flow.
 *
 * Owns:
 *   • mockRunnerAPI.listAnalysisJobs() polling on mount + on
 *     `audio-analysis:jobs-changed` IPC events.
 *   • Active job selection (in-memory; resets on reload — by design).
 *   • +NEW JOB flow: open file dialog → importAudio → wait for the
 *     jobs-changed event → auto-select the newly created row.
 *   • ANALYZE flow: fires separateStems + analyzeStructure in parallel
 *     as two async iterables, updates two progress bars independently.
 *   • Health chip: probes /healthz periodically (10s) + on view show.
 *
 * Imports the in-repo AudioAnalysisClient via its compiled artifact.
 * The shell is plain JS served from src/mock-runner/shell/; the client
 * is TypeScript compiled into dist/audio-analysis-client/.
 */

import { AudioAnalysisClient } from "../../../dist/audio-analysis-client/index.js";

// ─── DOM refs ──────────────────────────────────────────────────────
const jobsListEl       = document.getElementById("jobs-list");
const jobsListOlEl     = document.getElementById("jobs-list-ol");
const jobNewBtnEl      = document.getElementById("job-new-btn");
const jobDetailEl      = document.getElementById("job-detail");
const jobDetailBodyEl  = document.getElementById("job-detail-body");
const jobDetailEmptyEl = document.getElementById("job-detail-empty");
const jobNameEl        = document.getElementById("job-detail-name");
const jobPathEl        = document.getElementById("job-detail-path");
const analyzeBtnEl     = document.getElementById("job-analyze-btn");
const carrierEl        = document.getElementById("progress-carrier");
const healthEl         = document.getElementById("analysis-health");
const healthLabelEl    = document.getElementById("analysis-health-label");

const progressRows = {
  stems:     document.querySelector('.progress-row[data-kind="stems"]'),
  structure: document.querySelector('.progress-row[data-kind="structure"]'),
};

const resultsStemsListEl     = document.getElementById("results-stems-list");
const resultsStructureListEl = document.getElementById("results-structure-list");

// ─── State ─────────────────────────────────────────────────────────
let jobs = [];                  // AnalysisJobSummary[]
let activeJobName = null;       // string | null
let pendingImportBasename = null;
let analyzeInFlight = false;
// Cached results per job, keyed by job.name. Populated on result events
// and (best-effort) on initial selection by reading the structure JSON
// — but for now we just rely on live results from the SSE stream.
const cachedResults = new Map();
let client = null;
let mounted = false;
let healthTimer = null;

// ─── Utilities ─────────────────────────────────────────────────────
function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSampleRate(hz) {
  if (hz == null) return null;
  return hz % 1000 === 0 ? `${hz / 1000}k` : `${(hz / 1000).toFixed(1)}k`;
}

function jobStatus(job) {
  if (!job.hasSource) return "missing";
  if (job.hasStems || job.hasStructure) return "done";
  return "ready";
}

function metaLine(job) {
  const parts = [];
  const dur = fmtDuration(job.durationSeconds);
  const sr  = fmtSampleRate(job.sampleRate);
  if (dur) parts.push(dur);
  if (sr)  parts.push(sr);
  if (job.channels === 1)      parts.push("mono");
  else if (job.channels === 2) parts.push("stereo");
  else if (job.channels)        parts.push(`${job.channels}ch`);
  return parts.join(" · ");
}

// Strip the extension; preserve the rest of the basename verbatim (the
// user typed "Kind Of Blue.mp3" and expects to see "Kind Of Blue").
function deriveDisplayName(filePath) {
  const base = filePath.replace(/^.*[/\\]/, "");
  return base.replace(/\.[^.]+$/, "");
}

// ─── Rendering ─────────────────────────────────────────────────────
function renderJobsList() {
  if (!jobsListOlEl) return;
  const empty = jobs.length === 0 && !pendingImportBasename;
  jobsListEl?.setAttribute("data-empty", empty ? "true" : "false");

  // Reuse rows in-place where possible to avoid flashing the active
  // highlight when fs.watch fires for unrelated reasons. Easiest: full
  // rebuild keyed by name — the list is small (single digits typical).
  jobsListOlEl.replaceChildren();

  if (pendingImportBasename) {
    const li = document.createElement("li");
    li.className = "job-row";
    li.setAttribute("data-status", "importing");
    li.setAttribute("data-active", "false");
    const lamp = document.createElement("span");
    lamp.className = "job-row__lamp";
    const name = document.createElement("span");
    name.className = "job-row__name";
    name.textContent = `importing… ${pendingImportBasename}`;
    const meta = document.createElement("span");
    meta.className = "job-row__meta";
    meta.textContent = "normalizing audio";
    li.append(lamp, name, meta);
    jobsListOlEl.append(li);
  }

  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = "job-row";
    li.setAttribute("data-status", jobStatus(job));
    li.setAttribute("data-active", job.name === activeJobName ? "true" : "false");
    // `data-titled` flips typography: titled rows use Fraunces (song-title
    // feel) where slug-only rows fall back to Roboto Mono (identifier feel).
    li.setAttribute("data-titled", job.displayName ? "true" : "false");
    li.setAttribute("role", "button");
    li.tabIndex = 0;

    const lamp = document.createElement("span");
    lamp.className = "job-row__lamp";

    const name = document.createElement("span");
    name.className = "job-row__name";
    name.textContent = job.displayName ?? job.name;
    name.title = job.displayName ? `${job.displayName}  (slug: ${job.name})` : job.name;

    const meta = document.createElement("span");
    meta.className = "job-row__meta";
    const m = metaLine(job);
    meta.textContent = m || (job.hasSource ? "ready" : "no source");

    li.append(lamp, name, meta);
    li.addEventListener("click", () => selectJob(job.name));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectJob(job.name);
      }
    });

    jobsListOlEl.append(li);
  }
}

function renderJobDetail() {
  const job = jobs.find((j) => j.name === activeJobName);
  if (!job) {
    jobDetailEl?.setAttribute("data-active", "false");
    if (jobDetailBodyEl) jobDetailBodyEl.hidden = true;
    if (jobDetailEmptyEl) jobDetailEmptyEl.style.display = "";
    return;
  }
  jobDetailEl?.setAttribute("data-active", "true");
  if (jobDetailBodyEl) jobDetailBodyEl.hidden = false;
  if (jobDetailEmptyEl) jobDetailEmptyEl.style.display = "none";

  if (jobNameEl) jobNameEl.textContent = job.displayName ?? job.name;
  if (jobPathEl) {
    // When a displayName is set, surface the slug as part of the path
    // so the operator can still see/copy the canonical job identifier
    // — useful for grep, ls, etc.
    jobPathEl.textContent = job.displayName ? `${job.name}  ·  ${job.path}` : job.path;
  }

  if (analyzeBtnEl) {
    analyzeBtnEl.disabled = analyzeInFlight || !job.hasSource;
    analyzeBtnEl.textContent = analyzeInFlight ? "ANALYZING…" : "ANALYZE";
  }

  renderResults(job);
}

function renderResults(job) {
  const cached = cachedResults.get(job.name) ?? {};

  // Stems list — only render once we have live results in cache.
  if (resultsStemsListEl) {
    resultsStemsListEl.replaceChildren();
    const stems = cached.stems?.stems ?? [];
    for (const s of stems) {
      const li = document.createElement("li");
      const key = document.createElement("span");
      key.className = "results-key";
      key.textContent = s.stem;
      const val = document.createElement("span");
      val.textContent = s.path.replace(/^.*\//, "");
      val.title = s.path;
      li.append(key, val);
      resultsStemsListEl.append(li);
    }
  }

  // Structure segments
  if (resultsStructureListEl) {
    resultsStructureListEl.replaceChildren();
    const segs = cached.structure?.segments ?? [];
    for (const seg of segs) {
      const li = document.createElement("li");
      const key = document.createElement("span");
      key.className = "results-key";
      key.textContent = seg.label;
      const val = document.createElement("span");
      val.textContent = `${fmtTime(seg.start)} – ${fmtTime(seg.end)}`;
      li.append(key, val);
      resultsStructureListEl.append(li);
    }
  }
}

function fmtTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function setProgress(kind, { fraction, stage, detail, state }) {
  const row = progressRows[kind];
  if (!row) return;
  if (state) row.setAttribute("data-state", state);
  const fill = row.querySelector(".progress-row__fill");
  const pct  = row.querySelector(".progress-row__pct");
  const det  = row.querySelector(".progress-row__detail");
  if (fill && typeof fraction === "number") {
    fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }
  if (pct && typeof fraction === "number") {
    pct.textContent = `${Math.round(fraction * 100)}%`;
  } else if (pct && state === "idle") {
    pct.textContent = "—";
  }
  if (det) {
    const parts = [];
    if (stage)  parts.push(stage);
    if (detail) parts.push(detail);
    det.textContent = parts.join(" · ") || (state ?? "idle");
  }
  refreshCarrier();
}

function resetProgress(kind) {
  setProgress(kind, { fraction: 0, stage: null, detail: null, state: "idle" });
}

function refreshCarrier() {
  const anyRunning = Object.values(progressRows).some(
    (r) => r?.getAttribute("data-state") === "running",
  );
  carrierEl?.setAttribute("data-running", anyRunning ? "true" : "false");
}

// ─── Selection ─────────────────────────────────────────────────────
function selectJob(name) {
  if (activeJobName === name) return;
  activeJobName = name;
  // Reset progress rows when switching jobs — stale percentages from a
  // previous job would mislead the operator.
  resetProgress("stems");
  resetProgress("structure");
  renderJobsList();
  renderJobDetail();
}

// ─── Workspace polling ─────────────────────────────────────────────
async function refreshJobs() {
  if (!window.mockRunnerAPI?.listAnalysisJobs) return;
  try {
    jobs = await window.mockRunnerAPI.listAnalysisJobs();
  } catch (err) {
    console.error("listAnalysisJobs failed:", err);
    jobs = [];
  }

  // If we were waiting for an import to land, check whether it did.
  if (pendingImportBasename) {
    const slug = pendingImportBasename
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const landed = jobs.find((j) => j.name === slug);
    if (landed) {
      pendingImportBasename = null;
      activeJobName = landed.name;
    }
  }

  // Drop an active selection that no longer corresponds to a real job.
  if (activeJobName && !jobs.some((j) => j.name === activeJobName)) {
    activeJobName = null;
  }

  renderJobsList();
  renderJobDetail();
}

// ─── Import flow ───────────────────────────────────────────────────
async function onNewJob() {
  if (!window.mockRunnerAPI?.openAudioImportDialog) return;
  const filePath = await window.mockRunnerAPI.openAudioImportDialog();
  if (!filePath) return;

  const basename = filePath.replace(/^.*[/\\]/, "");
  const displayName = deriveDisplayName(filePath);
  pendingImportBasename = basename;
  jobNewBtnEl.disabled = true;
  jobNewBtnEl.textContent = "IMPORTING…";
  renderJobsList();

  try {
    const result = await client.importAudio({ file_path: filePath });
    // Persist the unsanitized title alongside the job on disk so future
    // sessions show the friendly name instead of the slug. Best-effort —
    // a write failure shouldn't block the import flow.
    const jobPath = result?.audio_path?.replace(/\/source\.wav$/, "") ?? null;
    if (jobPath && window.mockRunnerAPI?.writeJobMetadata) {
      try {
        await window.mockRunnerAPI.writeJobMetadata({
          jobPath,
          displayName,
          originalFilename: basename,
        });
      } catch (metaErr) {
        console.warn("writeJobMetadata failed (continuing):", metaErr);
      }
    }
    // The watcher fires before the import returns (source.wav exists by
    // then), but refresh anyway so we don't depend on watcher timing.
    await refreshJobs();
  } catch (err) {
    console.error("importAudio failed:", err);
    pendingImportBasename = null;
    // Surface in the empty-state strip — for now just log + revert UI.
    alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    jobNewBtnEl.disabled = false;
    jobNewBtnEl.textContent = "+ NEW JOB…";
    renderJobsList();
  }
}

// ─── Analyze flow ──────────────────────────────────────────────────
async function onAnalyze() {
  const job = jobs.find((j) => j.name === activeJobName);
  if (!job || !job.hasSource) return;
  analyzeInFlight = true;
  renderJobDetail();

  resetProgress("stems");
  resetProgress("structure");
  setProgress("stems",     { fraction: 0, stage: "starting", state: "running" });
  setProgress("structure", { fraction: 0, stage: "starting", state: "running" });

  const audio_path = `${job.path}/source.wav`;
  const controllers = {
    stems: new AbortController(),
    structure: new AbortController(),
  };

  const consumeStems = async () => {
    try {
      for await (const ev of client.separateStems({ audio_path }, { signal: controllers.stems.signal })) {
        applyEvent("stems", ev);
      }
    } catch (err) {
      setProgress("stems", { stage: "error", detail: errStr(err), state: "error" });
    }
  };

  const consumeStructure = async () => {
    try {
      for await (const ev of client.analyzeStructure({ audio_path }, { signal: controllers.structure.signal })) {
        applyEvent("structure", ev);
      }
    } catch (err) {
      setProgress("structure", { stage: "error", detail: errStr(err), state: "error" });
    }
  };

  await Promise.allSettled([consumeStems(), consumeStructure()]);

  analyzeInFlight = false;
  // The result events landed real files on disk — refresh so the LED
  // flips green and the metadata line picks up any updates.
  await refreshJobs();
  renderJobDetail();
}

function applyEvent(kind, ev) {
  if (ev.type === "progress") {
    setProgress(kind, {
      fraction: ev.fraction,
      stage:    ev.stage,
      detail:   ev.detail ?? null,
      state:    "running",
    });
  } else if (ev.type === "result") {
    const job = jobs.find((j) => j.name === activeJobName);
    if (job) {
      const slot = cachedResults.get(job.name) ?? {};
      slot[kind] = ev.result;
      cachedResults.set(job.name, slot);
      renderResults(job);
    }
    const cached = ev.result?.cached ? "cached" : "fresh";
    setProgress(kind, {
      fraction: 1,
      stage:    "done",
      detail:   cached,
      state:    "done",
    });
  } else if (ev.type === "error") {
    setProgress(kind, {
      stage:  ev.errorType || "error",
      detail: ev.message,
      state:  "error",
    });
  }
}

function errStr(err) {
  if (err?.name === "AbortError") return "aborted";
  return err instanceof Error ? err.message : String(err);
}

// ─── Health probe ──────────────────────────────────────────────────
async function probeHealth() {
  if (!client) return;
  let up = false;
  try { up = await client.healthz(); } catch { up = false; }
  if (!healthEl) return;
  healthEl.setAttribute("data-state", up ? "up" : "down");
  if (healthLabelEl) healthLabelEl.textContent = up ? "service up" : "service down";
}

function startHealthLoop() {
  if (healthTimer) return;
  void probeHealth();
  healthTimer = setInterval(probeHealth, 10_000);
}

// ─── Mount ─────────────────────────────────────────────────────────
export async function mount() {
  if (mounted) return;
  mounted = true;

  const serverUrl = (await window.mockRunnerAPI?.getAudioServiceUrl?.())
    ?? "http://127.0.0.1:8765";
  client = new AudioAnalysisClient({ serverUrl });

  jobNewBtnEl?.addEventListener("click", () => { void onNewJob(); });
  analyzeBtnEl?.addEventListener("click", () => { void onAnalyze(); });
  jobPathEl?.addEventListener("click", () => {
    const path = jobPathEl.textContent ?? "";
    if (path) navigator.clipboard?.writeText(path).catch(() => { /* ignore */ });
  });

  window.mockRunnerAPI?.onAnalysisJobsChanged?.(() => {
    void refreshJobs();
  });

  resetProgress("stems");
  resetProgress("structure");

  await refreshJobs();
  startHealthLoop();
}

export function onShow() {
  // Cheap re-sync on every panel show — covers the case where the user
  // edited the workspace dir externally while the panel was hidden.
  void refreshJobs();
  void probeHealth();
}
