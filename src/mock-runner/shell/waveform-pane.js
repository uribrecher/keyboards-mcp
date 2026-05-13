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

// Per-row record. Keyed by stem name. `duration` is stored so the
// ResizeObserver path can call setZoom() without re-decoding the audio.
const rows = new Map();

let activeStem = null;
// Decoupled from activeStem: selection is "what I'm inspecting / scrubbing",
// playback is "what I'm hearing". Clicking another row changes the former
// without disturbing the latter — only spacebar / dblclick mutate this.
let playingStem = null;
let keydownHandler = null;
let currentSegments = [];

// Mount generation — bumped on every destroy()/mount() pair. An in-flight
// Peaks.init from a previous mount can resolve AFTER the next mount has
// started; we check the generation before storing the new instance to
// avoid the stale-init writing into the current row map.
let mountGen = 0;

// ResizeObserver lives until destroy() — the waveforms parent grows /
// shrinks whenever the operator collapses or expands the chat console,
// and peaks doesn't auto-refit. Debounce so a smooth drag doesn't spam
// fitToContainer calls.
let resizeObserver = null;
let resizeDebounce = null;

// Shared wheel-navigation state. zoomSeconds is the duration currently
// visible inside the zoomview canvas; we mirror it across all six peaks
// instances so the timeline stays in sync. Scroll position lives inside
// each peaks view (getStartTime/scrollWaveform); we don't shadow it.
let zoomSeconds = 0;
let wheelHandler = null;
const MIN_ZOOM_SECONDS = 2;

function $row(stem) {
  return document.querySelector(`.waveform-row[data-stem="${stem}"]`);
}

function colorFor(label) {
  return LABEL_COLORS[String(label).toLowerCase()] ?? DEFAULT_COLOR;
}

function buildSegmentList(segments) {
  // SongFormer's segments use {start, end, label}; peaks wants
  // {startTime, endTime, ...}. The `id` keeps each segment uniquely
  // addressable for later updates/removals. No `labelText` — segments
  // are pure colored regions; the FULL label rides on a custom
  // `sectionLabel` property and surfaces only as a hover tooltip
  // (see attachSegmentTooltipHandlers).
  return (segments ?? []).map((s, i) => ({
    id:           `seg-${i}`,
    startTime:    Number(s.start),
    endTime:      Number(s.end),
    color:        colorFor(s.label),
    overlay:      true,
    markers:      false,
    editable:     false,
    sectionLabel: s.label,
  }));
}

function showTooltip(evt, label) {
  const el = document.getElementById("segment-tooltip");
  if (!el || !label) return;
  el.textContent = label;
  // Position near the cursor; pin to viewport via position: fixed in
  // CSS so we don't have to compute offsets against the waveform pane.
  el.style.left = `${evt.clientX + 12}px`;
  el.style.top  = `${evt.clientY + 12}px`;
  el.hidden = false;
}

function hideTooltip() {
  const el = document.getElementById("segment-tooltip");
  if (el) el.hidden = true;
}

function attachSegmentTooltipHandlers(instance) {
  // peaks fires segments.mouseenter / mouseleave with { segment, evt }
  // when overlay rendering is enabled. We read the full label from the
  // custom `sectionLabel` field set in buildSegmentList.
  instance.on("segments.mouseenter", (event) => {
    showTooltip(event.evt, event.segment.sectionLabel);
  });
  instance.on("segments.mouseleave", () => {
    hideTooltip();
  });
}

async function initInstanceForRow(stem, stemPath, gen) {
  const row = $row(stem);
  if (!row) return null;
  const audioEl = row.querySelector("audio");
  const viewEl  = row.querySelector(".waveform-row__view");
  if (!audioEl || !viewEl) return null;

  // <audio> drives PLAYBACK (timeupdate events that peaks observes for
  // the playhead). Electron's media pipeline loads file:// fine.
  // encodeURI escapes spaces, '#', '?', and other URL-unsafe chars
  // while leaving '/' alone — workspace paths can in principle contain
  // any of those if the source filename did. Path is absolute on macOS
  // (always starts with '/'), so `file://` + `/Users/...` → `file:///...`
  // which is the canonical three-slash form.
  audioEl.src = "file://" + encodeURI(stemPath);
  // Mute every stem at init; only the currently-playing stem (set by
  // startPlayback) is unmuted. Active != playing in this pane.
  audioEl.muted = true;

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
      // editable boundaries, no inline label (segments are pure color
      // bands; the full label surfaces via a hover tooltip wired on
      // the segments.mouseenter event below).
      segmentOptions: {
        overlay:            true,
        overlayColor:       DEFAULT_COLOR,
        overlayOpacity:     PALETTE_OPACITY,
        overlayBorderColor: "rgba(255,255,255,0.15)",
        overlayBorderWidth: 0,
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
        // fitToContainer first: peaks sized the canvas at init time from
        // the container's then-current width, which can be stale by a
        // few px once flex layout settles. Force a recompute against
        // the live width. setZoom uses the current shared zoomSeconds
        // (the first instance to init sets it; subsequent instances
        // inherit so they match).
        if (zoomSeconds <= 0) zoomSeconds = audioBuffer.duration;
        try {
          view.fitToContainer();
          view.setZoom({ seconds: zoomSeconds });
        } catch (e) {
          console.warn(`fitToContainer/setZoom failed for "${stem}":`, e);
        }
        // Take ownership of wheel events — our handler on #waveforms
        // does both scroll (plain wheel) and zoom (Cmd/Ctrl + wheel)
        // with cross-stem sync; peaks's built-in scroll mode would
        // double-apply on the row that received the event.
        try { view.setWheelMode("none"); } catch { /* ignore */ }
        // Inactive views can't seek — clicks on the timeline are ignored.
        if (!isActive) {
          try { view.enableSeek(false); } catch { /* ignore */ }
        }
      }
      rows.set(stem, {
        peaks:    instance,
        audio:    audioEl,
        view:     viewEl,
        duration: audioBuffer.duration,
      });
      attachSegmentTooltipHandlers(instance);
      // Natural end-of-track: clear playback state so the row's
      // data-playing styling drops and spacebar / dblclick toggle from
      // a clean slate next time.
      audioEl.addEventListener("ended", () => {
        if (playingStem === stem) {
          playingStem = null;
          setPlayingDOM(stem, false);
        }
      });
      // If segments arrived before this instance finished init, replay.
      if (currentSegments.length) {
        try { instance.segments.add(buildSegmentList(currentSegments)); }
        catch (e) { console.warn("segments.add failed:", e); }
      }
      resolve(instance);
    });
  });
}

// Refit every active peaks instance against its container's current
// size. Called on the resize-debounce trailing edge. Cheap — peaks
// reuses the decoded AudioBuffer; no re-decode.
function maxDuration() {
  let max = 0;
  for (const rec of rows.values()) {
    if (rec.duration > max) max = rec.duration;
  }
  return max || MIN_ZOOM_SECONDS;
}

function refitAllPeaks() {
  // Refit to the operator's CURRENT zoom level, not the full-track
  // fit. Without this, every chat-console collapse would snap the
  // waveforms back to whole-track and discard the user's zoom-in.
  const target = zoomSeconds > 0 ? zoomSeconds : maxDuration();
  for (const rec of rows.values()) {
    const view = rec.peaks.views.getView("zoomview");
    if (!view) continue;
    try {
      view.fitToContainer();
      view.setZoom({ seconds: target });
    } catch (e) {
      console.warn("waveform refit failed:", e);
    }
  }
}

function installResizeObserver() {
  if (resizeObserver) return;
  const waveformsEl = document.getElementById("waveforms");
  if (!waveformsEl) return;
  resizeObserver = new ResizeObserver(() => {
    // Debounce — a smooth chat-console drag fires many entries; we
    // only need a refit on the trailing edge.
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      resizeDebounce = null;
      refitAllPeaks();
    }, 60);
  });
  resizeObserver.observe(waveformsEl);
}

// ─── Wheel zoom / scroll, synced across all six instances ──────────
//
// peaks.js's built-in `setWheelMode("scroll")` is disabled in
// initInstanceForRow so we can own the wheel handling: vertical wheel
// scrolls the timeline; Cmd / Ctrl + wheel zooms (Chromium also emits
// pinch-to-zoom on trackpads as wheel + ctrlKey, so pinch works for
// free); horizontal wheel (trackpad two-finger) also scrolls. Every
// computed zoom or scroll fans out to ALL peaks instances so the six
// stems stay in lock-step.

function applyZoom(nextSeconds) {
  const max = maxDuration();
  const clamped = Math.max(MIN_ZOOM_SECONDS, Math.min(max, nextSeconds));
  if (clamped === zoomSeconds) return;
  zoomSeconds = clamped;
  for (const { peaks } of rows.values()) {
    const view = peaks.views.getView("zoomview");
    if (!view) continue;
    try { view.setZoom({ seconds: zoomSeconds }); } catch { /* ignore */ }
  }
}

function applyScroll(deltaSeconds) {
  if (!deltaSeconds) return;
  for (const { peaks } of rows.values()) {
    const view = peaks.views.getView("zoomview");
    if (!view) continue;
    // peaks clamps at track edges internally — no double-clamp needed.
    try { view.scrollWaveform({ seconds: deltaSeconds }); } catch { /* ignore */ }
  }
}

function applyAbsoluteStart(startSeconds) {
  const t = Math.max(0, startSeconds);
  for (const { peaks } of rows.values()) {
    const view = peaks.views.getView("zoomview");
    if (!view) continue;
    try { view.setStartTime(t); } catch { /* ignore */ }
  }
}

function onWheel(e) {
  // Only act when the wheel target is inside the waveforms section.
  // (We attach to #waveforms so this is implicit, but defensive.)
  if (rows.size === 0) return;

  const isZoom = e.ctrlKey || e.metaKey;

  // Decide whether we're going to consume this event BEFORE calling
  // preventDefault — vertical wheel without a modifier should fall
  // through to native page scroll so the operator can scroll the
  // panel up/down past the waveforms naturally. We only capture:
  //   • zoom gestures (Cmd/Ctrl held, or trackpad pinch)
  //   • horizontal-dominant wheels (trackpad two-finger horizontal,
  //     dedicated horizontal mouse wheels)
  if (isZoom) {
    e.preventDefault();
    // Zoom-to-cursor: the time directly under the mouse must stay
    // under the mouse after the zoom changes scale. Without this
    // anchor, setZoom keeps the LEFT EDGE pinned at the old start
    // time, which makes the operator's point of interest fly off
    // screen as you zoom in.
    //
    //   1. Find the cursor's fractional X position inside the canvas
    //      (cursorFrac ∈ [0, 1]).
    //   2. Compute the time currently at that X (tCursor).
    //   3. Apply the new zoom scale.
    //   4. Pick a new startTime so tCursor lands at the same X again:
    //        startTime_new = tCursor − cursorFrac × zoomSeconds_new
    const sampleRow = rows.values().next().value;
    if (!sampleRow) return;
    const rect = sampleRow.view.getBoundingClientRect();
    const width = rect.width || 1;
    const cursorFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / width));
    const leadView = sampleRow.peaks.views.getView("zoomview");
    const startBefore = leadView?.getStartTime?.() ?? 0;
    const tCursor = startBefore + cursorFrac * zoomSeconds;

    // deltaY > 0 = wheel down = zoom OUT (more seconds visible).
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const before = zoomSeconds;
    applyZoom(zoomSeconds * factor);
    if (zoomSeconds === before) return;     // clamped at min/max — no shift needed

    applyAbsoluteStart(tCursor - cursorFrac * zoomSeconds);
    return;
  }

  // Horizontal scroll only. Skip vertical-dominant wheels so the
  // surrounding page can scroll. Tiny noise in deltaX (a few px during
  // a vertical-dominant trackpad swipe) shouldn't pull focus — require
  // |deltaX| to actually exceed |deltaY|.
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  // Convert pixel delta → seconds at the current zoom: 1 px on screen
  // represents (zoomSeconds / canvasWidth) seconds of audio.
  const sampleRow = rows.values().next().value;
  const canvasWidthPx = sampleRow?.view?.clientWidth || 1;
  const deltaSeconds = (e.deltaX / canvasWidthPx) * zoomSeconds;
  applyScroll(deltaSeconds);
}

function installWheelHandler() {
  if (wheelHandler) return;
  const waveformsEl = document.getElementById("waveforms");
  if (!waveformsEl) return;
  wheelHandler = onWheel;
  // `passive: false` so preventDefault() works — Chromium defaults
  // wheel listeners on document-scrolling regions to passive.
  waveformsEl.addEventListener("wheel", wheelHandler, { passive: false });
}

// ─── Playback (spacebar + double-click) ────────────────────────────
//
// Selection (activeStem) is decoupled from playback (playingStem):
// single-click only changes selection; spacebar toggles playback of
// the selected stem; double-click selects then toggles. At most ONE
// stem plays at a time — startPlayback always stops the previous.

function setPlayingDOM(stem, on) {
  const row = $row(stem);
  if (row) row.setAttribute("data-playing", on ? "true" : "false");
}

function stopPlayback() {
  if (!playingStem) return;
  const rec = rows.get(playingStem);
  const wasPlaying = playingStem;
  playingStem = null;
  setPlayingDOM(wasPlaying, false);
  if (!rec) return;
  // Prefer peaks.player.pause so peaks's internal state stays consistent
  // with the underlying audio element. Fall back to the raw element if
  // the player API is missing for any reason.
  try {
    if (rec.peaks?.player?.pause) rec.peaks.player.pause();
    else rec.audio.pause();
  } catch { /* ignore */ }
  // Re-mute so a future direct audio.play() (shouldn't happen, but
  // defensive) doesn't leak sound from this row.
  try { rec.audio.muted = true; } catch { /* ignore */ }
}

function startPlayback(stem) {
  const rec = rows.get(stem);
  if (!rec) return;
  // Enforce single-playback invariant — if another stem is playing,
  // pause it first so the two don't overlap.
  if (playingStem && playingStem !== stem) stopPlayback();
  try { rec.audio.muted = false; } catch { /* ignore */ }
  playingStem = stem;
  setPlayingDOM(stem, true);
  try {
    const p = rec.peaks?.player?.play
      ? rec.peaks.player.play()
      : rec.audio.play();
    // play() returns a Promise; an autoplay rejection (unlikely after a
    // user gesture, but possible) should unwind the playing state.
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        console.warn(`play() rejected for stem "${stem}":`, err);
        if (playingStem === stem) {
          playingStem = null;
          setPlayingDOM(stem, false);
          try { rec.audio.muted = true; } catch { /* ignore */ }
        }
      });
    }
  } catch (err) {
    console.warn(`play() threw for stem "${stem}":`, err);
    playingStem = null;
    setPlayingDOM(stem, false);
    try { rec.audio.muted = true; } catch { /* ignore */ }
  }
}

function togglePlay(stem) {
  if (!stem || !rows.has(stem)) return;
  if (playingStem === stem) stopPlayback();
  else startPlayback(stem);
}

function onWaveformsKeyDown(e) {
  if (e.code !== "Space") return;
  if (e.repeat) return;
  // Don't hijack space when the user is typing somewhere.
  const tgt = e.target;
  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  if (!activeStem || !rows.has(activeStem)) return;
  e.preventDefault();
  togglePlay(activeStem);
}

function installKeydownHandler() {
  if (keydownHandler) return;
  const waveformsEl = document.getElementById("waveforms");
  if (!waveformsEl) return;
  // Container needs tabindex so it (and its descendants) can hold
  // focus — without focus, keydown won't fire on the container.
  if (!waveformsEl.hasAttribute("tabindex")) waveformsEl.setAttribute("tabindex", "-1");
  keydownHandler = onWaveformsKeyDown;
  waveformsEl.addEventListener("keydown", keydownHandler);
}

function attachRowClickHandlers() {
  for (const stem of STEM_ORDER) {
    const row = $row(stem);
    if (!row) continue;
    // Make rows keyboard-operable: focusable + Enter activates +
    // aria-pressed reflects the active state for screen readers. Space
    // is reserved for play/pause (see installKeydownHandler).
    // role="button" matches the click-to-activate semantics; aria-pressed
    // is a toggle indicator, which fits "only one row is active at a time"
    // without forcing us into a full radio-group pattern.
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-pressed", stem === activeStem ? "true" : "false");
    row.setAttribute("aria-label", `Activate ${stem} stem`);
    // Idempotent: replace any previous handlers if mount is called twice.
    row.onclick = () => {
      if (stem === activeStem) return;
      setActiveStem(stem);
    };
    // Double-click: select (if needed) then toggle playback on this stem.
    // Same semantics as spacebar after the dblclick — pause if it was
    // already playing, otherwise start.
    row.ondblclick = (e) => {
      // Don't let dblclick bubble up to anything that might also act on
      // it (e.g. a parent panel collapser).
      e.preventDefault();
      if (stem !== activeStem) setActiveStem(stem);
      togglePlay(stem);
    };
    // Space is now reserved for play/pause (handled at the #waveforms
    // container); Enter still selects the focused row for keyboard users.
    row.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
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
  // Reset shared zoom — the first stem to decode will seed it to its
  // duration in initInstanceForRow. Without this reset, switching to a
  // shorter / longer song would inherit the previous job's zoom level
  // and either clamp weirdly or display half a track.
  zoomSeconds = 0;

  activeStem = "other";
  currentSegments = segments ?? [];

  // Stamp data-active + data-playing on every row up front so CSS
  // states paint before any async peaks init resolves.
  for (const stem of STEM_ORDER) {
    const row = $row(stem);
    if (!row) continue;
    row.setAttribute("data-active", stem === activeStem ? "true" : "false");
    row.setAttribute("data-playing", "false");
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
  installResizeObserver();
  installWheelHandler();
  installKeydownHandler();
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

/** Flip which stem is the active (seekable / inspected) one.
 *
 * Selection-only — does NOT pause, mute, or rewind any audio. Playback
 * is owned by playingStem and only mutated by start/stopPlayback.
 * Clicking a different row while a stem is playing leaves that stem
 * playing; the new selection just becomes the seek target.
 */
export function setActiveStem(name) {
  if (!STEM_ORDER.includes(name)) return;
  if (name === activeStem) return;

  activeStem = name;

  for (const stem of STEM_ORDER) {
    const row = $row(stem);
    const rec = rows.get(stem);
    if (!row) continue;
    const isActive = stem === activeStem;
    row.setAttribute("data-active", isActive ? "true" : "false");
    row.setAttribute("aria-pressed", isActive ? "true" : "false");
    if (!rec) continue;
    // Only the active row can be seeked by clicking on its timeline —
    // makes the "this is my inspection target" affordance clear without
    // interfering with whichever row is currently audible.
    const view = rec.peaks.views.getView("zoomview");
    if (view) {
      try { view.enableSeek(isActive); } catch { /* ignore */ }
    }
  }
}

/** Full tear-down before mount() rebuilds or before the panel is hidden. */
export function destroy() {
  if (resizeObserver) {
    try { resizeObserver.disconnect(); } catch { /* ignore */ }
    resizeObserver = null;
  }
  if (resizeDebounce) {
    clearTimeout(resizeDebounce);
    resizeDebounce = null;
  }
  if (wheelHandler) {
    const waveformsEl = document.getElementById("waveforms");
    if (waveformsEl) waveformsEl.removeEventListener("wheel", wheelHandler);
    wheelHandler = null;
  }
  if (keydownHandler) {
    const waveformsEl = document.getElementById("waveforms");
    if (waveformsEl) waveformsEl.removeEventListener("keydown", keydownHandler);
    keydownHandler = null;
  }
  // Stop audio before peaks.destroy() so we don't leak playback past
  // unmount; clears playingStem and any data-playing styling.
  stopPlayback();
  hideTooltip();
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
  playingStem = null;
  currentSegments = [];
  zoomSeconds = 0;
  for (const stem of STEM_ORDER) {
    const row = $row(stem);
    if (row) {
      row.setAttribute("data-active", "false");
      row.setAttribute("data-playing", "false");
    }
  }
}
