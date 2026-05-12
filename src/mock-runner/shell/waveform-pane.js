/**
 * SONG ANALYSIS waveform pane.
 *
 * Stacks six peaks.js instances (one per Demucs stem) and overlays
 * SongFormer section boundaries as translucent colored regions on every
 * row. `other` is the default active stem (audible, seekable); the rest
 * are dimmed + muted. Click an inactive row to activate it.
 *
 * Owns:
 *   • a shared AudioContext (Chromium caps simultaneous contexts; six
 *     separate ones is wasteful and brittle)
 *   • six { peaks instance, audio element, container } records
 *   • the current active stem name
 *
 * Public surface (called from panel-analysis.js):
 *   • mount({ stems, segments? }) — builds the six rows for a job
 *   • setSegments(segments)        — adds/refreshes segment overlays
 *   • setActiveStem(name)          — flips active state
 *   • destroy()                    — full tear-down before re-mount
 *
 * peaks.js + konva + waveform-data are loaded as UMD bundles via
 * <script> tags in index.html, so we reference them off the window
 * globals. NOTE: peaks.ext.min.js sets `window.peaks` (lowercase) —
 * not `Peaks` — even though the ESM export is `Peaks`. Konva +
 * WaveformData stay PascalCase. UMDs are not consistent here.
 */

// htdemucs_6s order matches the upstream stem inventory.
const STEM_ORDER = ["other", "drums", "bass", "vocals", "piano", "guitar"];

// Segment overlay palette, keyed by lowercased SongFormer label. Picked
// for high contrast against the dark chassis even at moderate opacity.
const LABEL_COLORS = {
  intro:       "#ffb84a",   // bright amber
  verse:       "#4adcff",   // bright cyan
  chorus:      "#ff5fbd",   // bright magenta
  bridge:      "#5fff8a",   // bright green
  outro:       "#ff8a44",   // bright orange
  inst:        "#b88aff",   // bright violet
  "pre-chorus":"#4affd0",   // bright teal
  silence:     "#888888",   // gray (a bit brighter)
};
const DEFAULT_COLOR = "#c4c4c4";

// Bumped from 0.22 → 0.5 — segments were barely visible against the dark
// chassis at low opacity. 0.5 + brighter palette reads cleanly without
// drowning the waveform itself.
const PALETTE_OPACITY = 0.5;

let audioContext = null;
function getAudioContext() {
  if (!audioContext) {
    // Single shared context — Peaks doesn't keep it alive between mount
    // cycles, so the same one carries through job switches without
    // bumping Chromium's per-page context count.
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

// Per-row record. Keyed by stem name.
const rows = new Map();

let activeStem = null;
let currentSegments = [];

// Mount generation — bumped on every destroy()/mount() pair. An in-flight
// Peaks.init from a previous mount can resolve AFTER the next mount has
// started; we check the generation before storing the new instance to
// avoid the stale-init writing into the current row map.
let mountGen = 0;

function $row(stem) {
  return document.querySelector(`.waveform-row[data-stem="${stem}"]`);
}

function colorFor(label) {
  return LABEL_COLORS[String(label).toLowerCase()] ?? DEFAULT_COLOR;
}

function buildSegmentList(segments) {
  // SongFormer's segments use {start, end, label}; peaks wants
  // {startTime, endTime, ...}. The `id` keeps each segment uniquely
  // addressable for later updates/removals.
  return (segments ?? []).map((s, i) => ({
    id:        `seg-${i}`,
    startTime: Number(s.start),
    endTime:   Number(s.end),
    color:     colorFor(s.label),
    labelText: s.label,
    overlay:   true,
    markers:   false,
    editable:  false,
  }));
}

async function initInstanceForRow(stem, stemPath, gen) {
  const row = $row(stem);
  if (!row) return null;
  const audioEl = row.querySelector("audio");
  const viewEl  = row.querySelector(".waveform-row__view");
  if (!audioEl || !viewEl) return null;

  // <audio> drives PLAYBACK (timeupdate events that peaks observes for
  // the playhead). Electron's media pipeline loads file:// fine.
  audioEl.src = `file://${stemPath}`;
  audioEl.muted = stem !== activeStem;

  // Web Audio drives WAVEFORM RENDERING. peaks.js's internal fetch for
  // the audio bytes is blocked by Electron's default webSecurity on
  // file:// → file:// requests, so we read the bytes in main and
  // decode here. The decoded AudioBuffer goes into webAudio.audioBuffer
  // so peaks skips its own fetch entirely.
  let audioBuffer = null;
  try {
    const bytes = await window.mockRunnerAPI.audio.readWav(stemPath);
    // IPC delivers a Node Buffer; convert to ArrayBuffer slice for decodeAudioData.
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    audioBuffer = await getAudioContext().decodeAudioData(ab);
  } catch (err) {
    console.error(`failed to decode stem "${stem}" at ${stemPath}:`, err);
    return null;
  }
  // mount() may have been called again while we were decoding.
  if (gen !== mountGen) return null;

  return new Promise((resolve) => {
    const isActive = stem === activeStem;
    window.peaks.init({
      mediaElement: audioEl,
      zoomview: { container: viewEl },
      webAudio: {
        audioBuffer,
        multiChannel: false,
      },
      // Translucent region overlay treatment — no drag handles, no
      // editable boundaries. Per-segment color overrides the default
      // overlayColor. Border dropped to 0 so the visible thing is the
      // fill, not a thin outline.
      segmentOptions: {
        overlay:            true,
        overlayColor:       DEFAULT_COLOR,
        overlayOpacity:     PALETTE_OPACITY,
        overlayBorderColor: "rgba(255,255,255,0.15)",
        overlayBorderWidth: 0,
        overlayLabelColor:  "#fff",
      },
    }, (err, instance) => {
      if (err) {
        console.error(`peaks.init failed for stem "${stem}":`, err);
        resolve(null);
        return;
      }
      // Stale-init guard: if mount() was called again while this init
      // was in flight, the row map belongs to a different job now —
      // drop this instance instead of polluting the live state.
      if (gen !== mountGen) {
        try { instance.destroy(); } catch { /* ignore */ }
        resolve(null);
        return;
      }
      const view = instance.views.getView("zoomview");
      if (view) {
        // Fit the entire track into the row at startup — peaks defaults
        // to a much zoomed-in scale that hides everything past ~30 sec.
        // setZoom({seconds}) re-renders the waveform at the new scale.
        try { view.setZoom({ seconds: audioBuffer.duration }); }
        catch (e) { console.warn(`setZoom failed for "${stem}":`, e); }
        // Inactive views can't seek — clicks on the timeline are ignored.
        if (!isActive) {
          try { view.enableSeek(false); } catch { /* ignore */ }
        }
      }
      rows.set(stem, { peaks: instance, audio: audioEl, view: viewEl });
      // If segments arrived before this instance finished init, replay.
      if (currentSegments.length) {
        try { instance.segments.add(buildSegmentList(currentSegments)); }
        catch (e) { console.warn("segments.add failed:", e); }
      }
      resolve(instance);
    });
  });
}

function attachRowClickHandlers() {
  for (const stem of STEM_ORDER) {
    const row = $row(stem);
    if (!row) continue;
    // Idempotent: replace any previous handler if mount is called twice.
    row.onclick = () => {
      if (stem === activeStem) return;
      setActiveStem(stem);
    };
  }
}

/** Build (or rebuild) the six instances for a job. */
export async function mount({ stems, segments }) {
  // Always start clean — peaks.destroy() releases the Konva stage and
  // detaches Web Audio nodes, no leak across job switches. Bumping
  // mountGen invalidates any peaks.init promises still in flight from
  // the previous mount so they don't write into the new row map.
  destroy();
  const gen = ++mountGen;

  activeStem = "other";
  currentSegments = segments ?? [];

  // Stamp data-active on every row up front so CSS dim states paint
  // before any async peaks init resolves.
  for (const stem of STEM_ORDER) {
    const row = $row(stem);
    if (row) row.setAttribute("data-active", stem === activeStem ? "true" : "false");
  }

  // Build a name -> path map from the stems result.
  const pathByStem = new Map(
    (stems ?? []).map((s) => [s.stem, s.path]),
  );

  // Initialise in parallel — Peaks.init resolves once decode is done;
  // running all six concurrently keeps perceived latency to a single
  // decode pass, not six sequential ones.
  await Promise.all(
    STEM_ORDER
      .filter((stem) => pathByStem.has(stem))
      .map((stem) => initInstanceForRow(stem, pathByStem.get(stem), gen)),
  );

  attachRowClickHandlers();
}

/** Replace the segment overlays on every instance. Used when structure
 * lands after stems (so we mounted stems-only first). */
export function setSegments(segments) {
  currentSegments = segments ?? [];
  const list = buildSegmentList(currentSegments);
  for (const { peaks } of rows.values()) {
    try {
      peaks.segments.removeAll();
      if (list.length) peaks.segments.add(list);
    } catch (e) {
      console.warn("setSegments failed for one instance:", e);
    }
  }
}

/** Flip which stem is the active (audible + seekable) one. */
export function setActiveStem(name) {
  if (!STEM_ORDER.includes(name)) return;
  if (name === activeStem) return;

  // Pause + mute the previous active, unmute + enable seek on the new.
  const prev = activeStem;
  activeStem = name;

  for (const stem of STEM_ORDER) {
    const row = $row(stem);
    const rec = rows.get(stem);
    if (!row || !rec) continue;
    const isActive = stem === activeStem;
    row.setAttribute("data-active", isActive ? "true" : "false");
    rec.audio.muted = !isActive;
    if (!isActive) {
      try { rec.audio.pause(); } catch { /* ignore */ }
    }
    const view = rec.peaks.views.getView("zoomview");
    if (view) {
      try { view.enableSeek(isActive); } catch { /* ignore */ }
    }
  }

  // Convenience: rewind the new active stem so the user hears it from
  // the top, not from wherever the previous active stem's playhead was.
  const newRec = rows.get(activeStem);
  if (newRec) {
    try { newRec.audio.currentTime = 0; } catch { /* ignore */ }
  }
  // No-op suppress unused warning if `prev` ever becomes useful (e.g.
  // for a "was: drums, now: vocals" status line later).
  void prev;
}

/** Full tear-down before mount() rebuilds or before the panel is hidden. */
export function destroy() {
  for (const { peaks, audio } of rows.values()) {
    try { peaks.destroy(); } catch { /* ignore */ }
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch { /* ignore */ }
  }
  rows.clear();
  activeStem = null;
  currentSegments = [];
  for (const stem of STEM_ORDER) {
    const row = $row(stem);
    if (row) row.setAttribute("data-active", "false");
  }
}
