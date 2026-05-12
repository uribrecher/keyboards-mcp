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
 * The renderer is sandboxed and does NOT make HTTP calls directly.
 * `mockRunnerAPI.audio` is an IPC relay to the main process, which owns
 * the AudioAnalysisClient. Streaming methods come back as async iterables
 * driven by `audio:analyze:event:<id>` / `audio:analyze:done:<id>` events.
 */

// Async-iterable backed by IPC events. The main process iterates the
// real SSE stream and forwards each event over webContents.send; this
// wrapper exposes the same `for await` shape the panel used to consume
// directly from the in-renderer AudioAnalysisClient.
function ipcAnalyzeStream(kind, req, signal) {
  return {
    [Symbol.asyncIterator]() {
      const queue = [];
      const waiters = [];          // { resolve, reject }
      let finished = false;
      let finishError = null;
      let streamId = null;
      let unsubEvent = () => {};

      // Drop events that arrive after the consumer is done (abort / error
      // before analyzeStart resolved leaves the subscription installed but
      // no one is awaiting — without this guard we'd grow `queue` forever).
      const push = (ev) => {
        if (finished) return;
        if (waiters.length) waiters.shift().resolve({ value: ev, done: false });
        else queue.push(ev);
      };
      const finish = (err) => {
        if (finished) return;
        finished = true;
        finishError = err;
        unsubEvent();
        while (waiters.length) {
          const w = waiters.shift();
          if (err) w.reject(err);
          else w.resolve({ value: undefined, done: true });
        }
      };

      const ready = (async () => {
        streamId = await window.mockRunnerAPI.audio.analyzeStart(kind, req);
        // The consumer may have aborted (or hit an error) while we were
        // awaiting the IPC. Skip the subscription and cancel the stream
        // server-side instead of leaking the subscription.
        if (finished) {
          void window.mockRunnerAPI.audio.analyzeCancel(streamId);
          return;
        }
        unsubEvent = window.mockRunnerAPI.audio.onAnalyzeEvent(streamId, push);
        window.mockRunnerAPI.audio.onAnalyzeDone(streamId, (payload) => {
          if (payload && payload.ok === false) {
            const err = new Error(payload.error || "analyze failed");
            err.name = payload.errorName || "Error";
            finish(err);
          } else {
            finish(null);
          }
        });
      })().catch((err) => finish(err));

      if (signal) {
        if (signal.aborted) {
          finish(new DOMException("aborted", "AbortError"));
        } else {
          signal.addEventListener("abort", () => {
            // streamId is null if abort beat analyzeStart's resolution; the
            // post-await `if (finished)` check above will cancel server-side
            // once the id lands.
            if (streamId) void window.mockRunnerAPI.audio.analyzeCancel(streamId);
            finish(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }
      }

      return {
        async next() {
          await ready;
          if (queue.length) return { value: queue.shift(), done: false };
          if (finished) {
            if (finishError) throw finishError;
            return { value: undefined, done: true };
          }
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        async return() {
          if (streamId) await window.mockRunnerAPI.audio.analyzeCancel(streamId);
          finish(null);
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// Drop-in replacement for AudioAnalysisClient — same shape, backed by IPC.
function createIpcAudioClient() {
  return {
    healthz: () => window.mockRunnerAPI.audio.healthz(),
    importAudio: (req) => window.mockRunnerAPI.audio.importAudio(req),
    separateStems: (req, opts = {}) => ipcAnalyzeStream("stems", req, opts.signal),
    analyzeStructure: (req, opts = {}) => ipcAnalyzeStream("structure", req, opts.signal),
  };
}

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
const presetSelectorEl = document.getElementById("preset-selector");
const presetBtnEls     = presetSelectorEl ? Array.from(presetSelectorEl.querySelectorAll(".preset-btn")) : [];
const carrierEl        = document.getElementById("progress-carrier");
const healthEl         = document.getElementById("analysis-health");
const healthLabelEl    = document.getElementById("analysis-health-label");

// DOM-side flip of the segmented control. Pure UI; the per-job store
// below is the source of truth.
function setPresetDom(name) {
  for (const b of presetBtnEls) {
    b.setAttribute("aria-checked", b.dataset.preset === name ? "true" : "false");
  }
}

const progressRows = {
  stems:     document.querySelector('.progress-row[data-kind="stems"]'),
  structure: document.querySelector('.progress-row[data-kind="structure"]'),
};

const resultsStemsListEl     = document.getElementById("results-stems-list");
const resultsStructureListEl = document.getElementById("results-structure-list");

// ─── State ─────────────────────────────────────────────────────────
let jobs = [];                  // AnalysisJobSummary[]
let activeJobName = null;       // string | null
let activeJobPath = null;       // string | null — used for click-to-copy
let pendingImportBasename = null;
// Per-job in-flight set: ANALYZE is "ANALYZING…" for jobs in here, idle
// for everyone else. The previous single-boolean version greyed out
// ANALYZE on every job whenever any one was running.
const inFlightJobs = new Set();
// Per-job preset selection so switching to a different job restores the
// preset that was last picked for THAT job, not the panel-global one.
// Default "medium" until the user picks something for a given job.
const jobPreset = new Map();
let serviceUp = null;           // null = unknown, true/false = last probe result

function isInFlight(jobName) {
  return jobName != null && inFlightJobs.has(jobName);
}

function getPresetFor(jobName) {
  return (jobName != null && jobPreset.get(jobName)) || "medium";
}

function paintPresetForActive() {
  setPresetDom(getPresetFor(activeJobName));
}
// Cached results per job, keyed by job.name. Populated on result events
// and (best-effort) on initial selection by reading the structure JSON
// — but for now we just rely on live results from the SSE stream.
const cachedResults = new Map();
// Per-job progress snapshots so switching jobs mid-run paints the bars
// for whichever job is currently selected (instead of leaking the
// previously-active job's bars or showing stale idle bars). Keyed by
// job.name; each slot holds { stems: snap|null, structure: snap|null }
// where a snap is the same shape setProgress() accepts.
const jobProgress = new Map();
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
  // Track the canonical path so click-to-copy lands a real filesystem
  // path on the clipboard even when the visible text is the mixed
  // "slug · path" form above.
  activeJobPath = job.path;

  if (analyzeBtnEl) {
    const serviceDown = serviceUp === false;
    const running = isInFlight(job.name);
    analyzeBtnEl.disabled = running || !job.hasSource || serviceDown;
    analyzeBtnEl.textContent = running
      ? "ANALYZING…"
      : serviceDown ? "SERVICE DOWN" : "ANALYZE";
  }

  if (presetSelectorEl) {
    presetSelectorEl.setAttribute("data-disabled", isInFlight(job.name) ? "true" : "false");
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

// Persist a progress snapshot under a specific job — recorded regardless
// of whether that job is currently selected, so switching to it later
// can re-paint the bars from the last known state.
function recordProgress(jobName, kind, snap) {
  let slot = jobProgress.get(jobName);
  if (!slot) {
    slot = { stems: null, structure: null };
    jobProgress.set(jobName, slot);
  }
  slot[kind] = snap;
}

// Repaint both progress rows from the active job's stored snapshots.
// Falls back to the idle state when nothing has been recorded for the
// job yet (or when no job is selected).
function paintProgressForActive() {
  const slot = activeJobName ? jobProgress.get(activeJobName) : null;
  for (const kind of ["stems", "structure"]) {
    const snap = slot?.[kind];
    if (snap) setProgress(kind, snap);
    else resetProgress(kind);
  }
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
  // Repaint the progress rows and the preset selector from the newly-
  // selected job's recorded state — if it's running we want its current
  // fraction, if it had a preset picked we want that preset highlighted.
  // The previous code reset progress to idle and left the preset DOM at
  // whatever the previous job had, both of which leaked across jobs.
  paintProgressForActive();
  paintPresetForActive();
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

  // refreshJobs can flip activeJobName above without going through
  // selectJob (auto-select after import; orphaned selection cleared),
  // so re-paint the per-job UI bits here too.
  paintProgressForActive();
  paintPresetForActive();
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
  // Capture the job identity at start. If the operator switches jobs
  // mid-analysis, results land under THIS job, not whatever is selected
  // when the result event arrives.
  const owningJobName = job.name;
  if (inFlightJobs.has(owningJobName)) return;  // already analyzing this job
  inFlightJobs.add(owningJobName);
  renderJobDetail();

  const startSnap = { fraction: 0, stage: "starting", detail: null, state: "running" };
  recordProgress(owningJobName, "stems", startSnap);
  recordProgress(owningJobName, "structure", startSnap);
  // Repaint only if the operator is still on this job. paintProgressForActive
  // resolves to startSnap when owning === active, and to whatever the
  // previously-selected job has when not.
  paintProgressForActive();

  const audio_path = `${job.path}/source.wav`;
  // Capture the preset at start too — read from the per-job store so a
  // mid-run switch to another job (where the user picks a different
  // preset) doesn't change the request the panel "thinks" it sent for
  // THIS job. The service has already accepted the original preset
  // anyway, so the captured value is what's actually running.
  const preset = getPresetFor(owningJobName);
  const controllers = {
    stems: new AbortController(),
    structure: new AbortController(),
  };

  const failKind = (kind, err) => {
    const snap = { stage: "error", detail: errStr(err), state: "error" };
    recordProgress(owningJobName, kind, snap);
    if (owningJobName === activeJobName) setProgress(kind, snap);
  };

  const consumeStems = async () => {
    try {
      for await (const ev of client.separateStems({ audio_path, preset }, { signal: controllers.stems.signal })) {
        applyEvent("stems", ev, owningJobName);
      }
    } catch (err) {
      failKind("stems", err);
    }
  };

  const consumeStructure = async () => {
    try {
      for await (const ev of client.analyzeStructure({ audio_path }, { signal: controllers.structure.signal })) {
        applyEvent("structure", ev, owningJobName);
      }
    } catch (err) {
      failKind("structure", err);
    }
  };

  await Promise.allSettled([consumeStems(), consumeStructure()]);

  inFlightJobs.delete(owningJobName);
  // The result events landed real files on disk — refresh so the LED
  // flips green and the metadata line picks up any updates.
  await refreshJobs();
  renderJobDetail();
}

function applyEvent(kind, ev, owningJobName) {
  // Always cache results under the job the analysis was started on, even
  // if the operator has since selected a different one.
  if (ev.type === "result") {
    const slot = cachedResults.get(owningJobName) ?? {};
    slot[kind] = ev.result;
    cachedResults.set(owningJobName, slot);
    if (owningJobName === activeJobName) {
      const job = jobs.find((j) => j.name === activeJobName);
      if (job) renderResults(job);
    }
  }

  // Build the progress snapshot for the event. Recording happens for the
  // owning job no matter what's currently selected, so a later switch
  // back can repaint from this exact state.
  let snap = null;
  if (ev.type === "progress") {
    snap = {
      fraction: ev.fraction,
      stage:    ev.stage,
      detail:   ev.detail ?? null,
      state:    "running",
    };
  } else if (ev.type === "result") {
    const cached = ev.result?.cached ? "cached" : "fresh";
    snap = { fraction: 1, stage: "done", detail: cached, state: "done" };
  } else if (ev.type === "error") {
    snap = { stage: ev.errorType || "error", detail: ev.message, state: "error" };
  }
  if (snap) recordProgress(owningJobName, kind, snap);

  // Paint only when the operator is still looking at this job.
  if (snap && owningJobName === activeJobName) setProgress(kind, snap);
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
  const changed = serviceUp !== up;
  serviceUp = up;
  if (healthEl) {
    healthEl.setAttribute("data-state", up ? "up" : "down");
  }
  if (healthLabelEl) healthLabelEl.textContent = up ? "service up" : "service down";
  // The ANALYZE button's disabled state depends on serviceUp — re-render
  // the job detail so it picks up the new status without waiting for the
  // next selection change.
  if (changed) renderJobDetail();
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

  client = createIpcAudioClient();

  jobNewBtnEl?.addEventListener("click", () => { void onNewJob(); });
  analyzeBtnEl?.addEventListener("click", () => { void onAnalyze(); });
  jobPathEl?.addEventListener("click", () => {
    // The visible text can be `${slug}  ·  ${path}` when a displayName
    // is set — copy only the real filesystem path.
    if (activeJobPath) navigator.clipboard?.writeText(activeJobPath).catch(() => { /* ignore */ });
  });
  for (const btn of presetBtnEls) {
    btn.addEventListener("click", () => {
      if (activeJobName == null) return;
      // Can't change preset for an analysis already in flight on this
      // job — the service has accepted the original preset.
      if (isInFlight(activeJobName)) return;
      const name = btn.dataset.preset;
      jobPreset.set(activeJobName, name);
      setPresetDom(name);
    });
  }

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
