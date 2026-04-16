# Audio Analysis MCP Server

> **Execution order: 7 of 7** — Separate Python repo. Phase 1 (audio pipeline) has no dependencies on keyboards-mcp plans. Phase 2+ (inverse synthesis) needs the architecture plan for the parameter contract. Can be developed in parallel with plans 2-6.

## Context

A synthesizer is a mathematical function: `f(params) → audio`. Recreating a song's keyboard sound means solving the inverse: `f⁻¹(audio) → params`. Today the AI agent can research gear and set parameters, but cannot listen — requiring human ears in the loop.

This plan adds a standalone MCP server with two layers:
1. **Audio pipeline tools** — stem separation, audio capture, spectral analysis
2. **Inverse synthesis models** — ML models trained per synth type that directly predict parameter vectors from audio, replacing the iterative guess-and-check loop

## The Inverse Synthesis Problem

```
Forward (the synth):     param_vector  →  synth_engine  →  audio
Inverse (what we need):  audio         →  trained_model →  param_vector
```

### Why ML, not iterative A/B

An iterative loop (render → compare → tweak → repeat) is slow and fragile — it requires an agent to interpret spectral diffs and decide which knob to turn. A trained inverse model produces the parameter vector in one forward pass.

### Prior art

| Paper | Approach | Key insight |
|-------|----------|-------------|
| [InverSynth](https://arxiv.org/abs/1812.06349) (2018) | CNN on spectrograms → quantized params (16 levels per param) | Classification > regression for synth params |
| [DiffMoog](https://arxiv.org/abs/2401.12570) (2024) | Differentiable synth + encoder network, signal-chain loss | Self-generated training data; loss at every stage of signal chain |
| [DDSP](https://magenta.tensorflow.org/ddsp-vst-blog) (Google) | Neural net predicts controls for classical DSP elements | Interpretable: network outputs map directly to oscillators/filters |

### Training data is free

The critical insight: we don't need labeled real-world audio. We generate unlimited training data by randomizing the parameter vector and rendering through the synth:

```
for i in 1..N:
    params = random_param_vector(synth_definition)
    audio  = render(synth_engine, params, note=C4, duration=2s)
    dataset.append((audio, params))
```

This is fully self-supervised — the synth itself is the ground truth.

### One model per synth type

Different synthesis types have fundamentally different parameter spaces and audio characteristics. A model trained on subtractive synthesis won't generalize to FM or sample-based. We need:

| Synthesis type | Example hardware | Parameter space character |
|---------------|-----------------|--------------------------|
| Subtractive | Prophet-6, Moog, Juno | Oscillator shapes, filter cutoff/resonance, envelopes |
| FM | DX7, FM8 | Operator ratios, modulation indices, algorithms |
| Additive/Organ | Hammond B3, drawbar organs | Drawbar levels, percussion, vibrato/chorus |
| Sample-based | Nord piano/sample engine | Sample selection, EQ, effects (smaller param space) |

Each model learns the specific `f⁻¹` for its synthesis type. Could potentially fine-tune per specific synth model (e.g., Prophet-6 vs Moog Sub 37).

## Decision: Pure Python

The audio/ML ecosystem lives in Python (PyTorch, Demucs, librosa). Use the Python MCP SDK (`mcp` package) with `stdio_server` transport.

## Project Structure

```
audio-analysis-mcp/
  pyproject.toml
  README.md
  CLAUDE.md
  .mcp.json
  src/
    audio_analysis_mcp/
      __init__.py
      server.py                        # MCP server, tool registration
      workspace.py                     # Temp/workspace directory management
      tools/
        __init__.py
        fetch_audio.py                 # YouTube download / local file import
        stem_separate.py               # Demucs stem separation
        spectrum_analyze.py            # Spectral feature extraction
        audio_compare.py               # A/B spectral diff (fallback for untrained synths)
        audio_render.py                # Capture audio from system device
        inverse_synth.py               # ML-based param prediction
        train_model.py                 # Generate dataset + train inverse model
        list_models.py                 # List available trained models
      analysis/
        __init__.py
        spectral.py                    # Librosa-based feature extraction
        comparison.py                  # A/B spectral diff
      models/
        __init__.py
        architecture.py               # Shared encoder architecture (ResNet/CNN backbone + MLP heads)
        dataset.py                     # Dataset generation: random params → render → spectrogram pairs
        augmentation.py                # Effects chain, noise injection, stem bleed simulation
        trainer.py                     # Training loop (param loss + contrastive loss), checkpointing
        inference.py                   # Load trained model, predict params from audio
        synth_renderers/
          __init__.py
          base.py                      # Abstract renderer interface
          subtractive.py               # Renders subtractive synth patches (e.g., via SurgeXT, Dexed)
          fm.py                        # FM synthesis renderer
          organ.py                     # Additive/organ renderer
      audio/
        __init__.py
        capture.py                     # sounddevice recording
        normalize.py                   # WAV normalization
  trained_models/                      # Stored model checkpoints
    subtractive_prophet6/
    fm_dx7/
    organ_b3/
  tests/
    test_spectral.py
    test_dataset_generation.py
    test_inference.py
```

## Dependencies

```toml
[project]
name = "audio-analysis-mcp"
requires-python = ">=3.10"
dependencies = [
  "mcp>=1.0.0",
  "demucs>=4.0.0",         # Stem separation
  "librosa>=0.10.0",       # Spectral analysis
  "torch>=2.0",            # ML models (already pulled by Demucs)
  "torchaudio>=2.0",       # Audio transforms, mel spectrograms
  "numpy>=1.24",
  "scipy>=1.10",
  "soundfile>=0.12",       # WAV I/O
  "sounddevice>=0.4",      # Audio capture
  "yt-dlp>=2024.0",        # YouTube download
  "pydantic>=2.0",         # Structured output schemas
]
```

## Tools

### Audio Pipeline Tools

#### 1. `fetch_audio`

Download from YouTube or import a local file. Normalize to 44.1kHz 16-bit WAV.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| source | string | yes | YouTube URL or local file path |
| start_time | float | no | Trim start (seconds) |
| duration | float | no | Trim duration (seconds) |

**Returns:** Path to normalized WAV in `{workspace}/fetched/`.

#### 2. `stem_separate`

Demucs stem separation → vocals, drums, bass, other (keyboards/synths).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| audio_path | string | yes | Path to audio file |
| model | string | no | Demucs model (default: `htdemucs`) |

**Returns:** Paths to all stem WAV files. Cached by input hash.

**Long-running:** 1-5 min. Runs as async subprocess with 10 min timeout.

#### 3. `audio_render`

Capture audio from a system audio device (BlackHole, USB audio).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| duration | float | yes | Recording duration (seconds) |
| device | string | no | Audio input device name/index |
| list_devices | bool | no | Just list available devices |

**Returns:** Path to recorded WAV, or device list.

#### 4. `spectrum_analyze`

Extract spectral features — useful for diagnostics and for synths without a trained model.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| audio_path | string | yes | Path to audio file |
| start_time | float | no | Analysis window start |
| duration | float | no | Analysis window (default: 5s) |

**Returns:** Harmonic profile, spectral envelope, ADSR, modulation detection, synth hints (JSON).

#### 5. `audio_compare`

A/B spectral diff — fallback for iterative matching when no trained model exists.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| target_path | string | yes | Reference audio |
| rendered_path | string | yes | Synthesized attempt |

**Returns:** Similarity scores, frequency band diffs, prioritized action items (JSON).

### Inverse Synthesis Tools

#### 6. `inverse_synth`

**The core tool.** Given audio and a target synthesis type, predict a raw parameter vector.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| audio_path | string | yes | Path to audio file (stem or recording) |
| synth_type | string | yes | Synthesis type: `subtractive`, `fm`, `organ` |
| top_k | int | no | Return top K predictions ranked by confidence (default: 1) |

**Returns:** A raw numeric vector — not device-specific parameter names. The vector represents the synthesis type's parameter space (e.g., subtractive: oscillator shapes, filter cutoff, envelopes).

```json
{
  "synth_type": "subtractive",
  "predictions": [
    {
      "confidence": 0.87,
      "vector": [0.99, 0.50, 0.99, 0.59, 0.72, 0.09, 0.02, 0.99, ...],
      "vector_labels": ["osc1_shape", "osc1_pulse_width", "osc2_shape", "osc2_freq", "lp_freq", "lp_resonance", "vca_env_attack", "vca_env_sustain", ...],
      "notes": "Pulse wave oscillators with moderate LP filter — consistent with Prophet-style organ pad"
    }
  ],
  "model_version": "v1.2",
  "training_samples": 50000
}
```

**Design decisions:**
- **One model per synthesis type**, not per hardware device. A `subtractive` model covers Prophet-6, Moog, Juno-X, etc.
- **Output is a normalized vector (0.0-1.0)**, not device-specific 0-127 values. The vector represents abstract synthesis parameters.
- **Mapping vector → device params is an open research problem.** Options under investigation include: vector DB lookup against known patches, per-device mapping models, or direct parameter-name matching when the device's params align with the vector labels.
- **Constrained pairing:** Each synthesis type model should only be paired with devices of the matching type. A sample-based keyboard (e.g., Nord piano/sample engine) is NOT a valid target for `inverse_synth` — use the fallback research workflow (Step 4b) instead.

**Implementation:**
1. Convert audio to mel spectrogram (standardized input representation)
2. Load trained model checkpoint for the specified synthesis type
3. Forward pass → raw parameter predictions (0-1 normalized)
4. Return as-is — scaling to device-specific ranges happens downstream
5. Optionally return multiple predictions if `top_k > 1` (useful when the many-to-one problem means multiple param combos could match)

#### 7. `train_model`

Generate training data and train (or fine-tune) an inverse model for a synthesis type.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| synth_type | string | yes | Synthesis type: `subtractive`, `fm`, `organ` |
| num_samples | int | no | Training samples to generate (default: 50000) |
| epochs | int | no | Training epochs (default: 100) |
| resume_from | string | no | Checkpoint path to resume/fine-tune from |

**Returns:** Training metrics (loss curve, validation accuracy), model checkpoint path.

**Dataset generation pipeline:**
```
for each sample:
  1. Generate random param_vector within synth's valid ranges
  2. Generate random musical content (pitch, polyphony, duration, velocity)
  3. Render dry audio through synth engine
  4. Apply random effects augmentation (reverb, chorus, compression, EQ)
  5. Apply random noise/degradation (hiss, hum, stem bleed)
  6. Compute mel spectrogram of augmented audio
  7. Store (spectrogram, param_vector) pair
  8. Also store clean dry render (for contrastive loss triplet mining)
```

Each param vector should produce ~5-10 augmented variants (different notes, effects, noise levels) to train invariance. 50K unique patches × 8 variants = 400K training pairs.

**Rendering backends** (in `models/synth_renderers/`):
- Software synths via headless plugins: SurgeXT (subtractive), Dexed (FM), setBfree (organ)
- Or: keyboards-mcp itself — send params via MIDI, capture via `audio_render`, but much slower
- Or: pure Python DSP (simplest for v1 — implement basic oscillators + filters in numpy)

**Training approach:**
- Input: mel spectrogram (128 bins x T frames)
- Backbone: ResNet-18 or lightweight CNN with temporal pooling
- Per-parameter MLP heads (one per param)
- Continuous params: sigmoid output + MSE loss
- Discrete params (waveform type, filter type): classification + cross-entropy loss
- Contrastive/triplet loss on the embedding layer (same patch = close, different patch = far)
- Validation: render predicted params, compare audio via spectral similarity

#### 8. `list_models`

List available trained inverse models with their metadata.

**Returns:**
```json
{
  "models": [
    {
      "synth_type": "subtractive",
      "version": "v1.2",
      "vector_size": 31,
      "vector_labels": ["osc1_shape", "osc1_pulse_width", ...],
      "training_samples": 50000,
      "validation_accuracy": 0.84,
      "checkpoint_path": "trained_models/subtractive/v1.2.pt"
    }
  ]
}
```

## Model Architecture Detail

### The Timbre Embedding Problem

A synth patch defines a **timbre** — the tonal character independent of which notes are played, how many notes sound simultaneously, how long they sustain, or what effects are applied downstream. The model must learn an embedding (latent vector) that captures this timbre identity while being invariant to everything else.

**Variables the embedding must be invariant to:**

| Variable | Real-world reality | Training data strategy |
|----------|-------------------|----------------------|
| **Pitch** | Stems contain melodies and bass lines across the full range | Render each patch at multiple random pitches (C2-C6), not just C4 |
| **Polyphony** | Chord progressions, not single notes | Render monophonic, 2-note intervals, 3-4 note chords, full voicings |
| **Duration** | Notes from staccato 100ms to held pads | Vary note lengths: 0.1s, 0.5s, 1s, 2s, 4s |
| **Velocity** | Players hit keys at varying intensity | Randomize MIDI velocity (40-127) per note |
| **Noise** | Audio interface hiss, cable noise, preamp coloring | Add Gaussian noise, pink noise, hum (50/60Hz) at varying SNR levels |
| **Effects (wetness)** | Reverb, delay, chorus, compression from mixing | Apply random effect chains to rendered audio (see below) |
| **Stem bleed** | Demucs isn't perfect — other instruments leak into "other" stem | Mix in small amounts of drums/bass/vocals stems as contamination |

### Data Augmentation Pipeline

Training on clean monophonic C4 renders produces a model that only works on clean monophonic C4 input. The training data must span the full variability the model will encounter at inference time.

**Level 1 — Musical variation (during rendering):**
```
for each sample:
  params = random_param_vector()
  notes  = random_musical_content()   # See below
  audio  = render(synth, params, notes)
```

Where `random_musical_content()` produces one of:
- Single note at random pitch (C2-C6), random velocity, random duration
- Two-note interval (3rd, 5th, octave) at random root
- 3-4 note chord (major, minor, 7th voicings) at random root
- Short melodic phrase (3-5 notes, random rhythm)

**Level 2 — Effects augmentation (post-render):**

Apply random subsets of these to the dry render:
- Reverb (convolution with random IR, wet/dry 10-60%)
- Delay (100-500ms, feedback 10-40%)
- Chorus (rate 0.5-3Hz, depth 20-60%)
- Compression (ratio 2:1-8:1, threshold -20 to -6dB)
- EQ (random 2-band boost/cut, ±6dB)
- Saturation/overdrive (mild, 5-20%)

This teaches the model to "hear through" the effects to the dry timbre underneath.

**Level 3 — Noise and degradation (post-effects):**
- Additive Gaussian noise (SNR 20-50dB)
- Pink noise / hum (SNR 30-60dB)
- Bandpass filtering (simulating lo-fi recording)
- Mix in small stem bleed from other instruments (0-10% level)

### Architecture

The model has two stages: **timbre encoder** (produces the embedding) and **parameter decoder** (maps embedding to param vector).

```
Input: Mel spectrogram (1 x 128 x T)
        │
  ┌─────┴──────────────────┐
  │  Timbre Encoder         │
  │  CNN/ResNet backbone    │
  │  + temporal pooling     │  ← Pooling across time makes it
  └─────┬──────────────────┘    duration/note-count invariant
        │
  Timbre Embedding (512-dim)   ← This vector IS the patch identity
        │                        Same patch → similar vectors regardless
        │                        of notes, polyphony, effects, noise
  ┌─────┼──────┬──────┬─── ... ──┐
  │     │      │      │          │
 MLP₁  MLP₂  MLP₃  MLP₄      MLPₙ     Per-parameter heads
  │     │      │      │          │
 osc1   osc1   osc2   lp       vca      Parameter predictions
 shape  pw     freq   freq     attack
```

**Key design: temporal pooling.** The backbone produces per-frame features. A global pooling layer (average + attention-weighted) collapses the time dimension into a fixed-size embedding. This is what makes the embedding invariant to duration and note content — it extracts "what kind of sound is this" regardless of "what is being played."

**Training loss — multi-component:**
- **Parameter loss** (primary): MSE for continuous params, cross-entropy for discrete
- **Triplet/contrastive loss** (embedding quality): same patch with different notes/effects should have closer embeddings than different patches
  - Anchor: patch A, chord voicing, dry
  - Positive: patch A, single note, with reverb
  - Negative: patch B, chord voicing, dry
  - This explicitly trains invariance into the embedding space
- **Audio reconstruction loss** (validation): render predicted params, measure spectral similarity to clean dry version

### The Many-to-One Problem

Multiple parameter combinations can produce perceptually identical sounds (e.g., two detuned saws vs. one saw + chorus). Mitigation strategies:
- **Signal-chain loss** (from DiffMoog): loss computed at each stage of the synth, not just final output — constrains the solution space
- **Contrastive embedding**: the triplet loss naturally clusters perceptually-similar patches together, accepting that they may have different param vectors
- **Top-K predictions**: return multiple plausible param vectors, ranked by confidence
- **Audio-domain validation**: after prediction, render the predicted params and verify via `audio_compare`

### Inference on Real Stems

At inference time, a real stem from a song will contain:
- Polyphonic content (chord progressions)
- Effects from mixing (reverb, compression, EQ)
- Stem separation artifacts (bleed from other instruments)
- Recording noise

Because the model was trained with all of these augmentations, the timbre encoder should produce an embedding that's in the same space as the clean training data. The parameter heads then decode this to the best-fit dry patch parameters — the effects are implicitly stripped by the invariance.

## Workspace

```
~/.audio-analysis-mcp/
  workspace/
    fetched/          # Downloaded/imported audio
    stems/            # Demucs output
    rendered/         # Captured synth recordings
  trained_models/     # Model checkpoints
  training_data/      # Generated datasets (can be large)
```

## MCP Configuration

```json
{
  "mcpServers": {
    "audio-analysis-mcp": {
      "command": "/path/to/audio-analysis-mcp/.venv/bin/python",
      "args": ["-m", "audio_analysis_mcp"]
    }
  }
}
```

## Agent Workflow (with trained model)

```
1. fetch_audio("youtube.com/watch?v=...")         → full_mix.wav
2. stem_separate(full_mix.wav)                     → other.wav (keyboards)
3. inverse_synth(other.wav, "subtractive")         → raw parameter vector (0-1)
4. Agent maps vector to target device params       → (open research problem)
5. Agent calls keyboards-mcp set_parameters(...)   → synth is configured
6. (Optional) audio_render + audio_compare         → validate & fine-tune
```

Steps 1-3 replace the research + manual patch design process. Step 4 (vector → device params) is under active research — initial approach may be direct parameter-name matching for devices whose params align with the vector labels.

## Agent Workflow (without trained model — fallback)

```
1. fetch_audio → stem_separate → other.wav
2. spectrum_analyze(other.wav)                     → spectral features + synth hints
3. Agent uses synth hints to set initial params via keyboards-mcp
4. audio_render → audio_compare                    → spectral diff + action items
5. Agent adjusts params based on action_items, repeat 4-5
```

## Implementation Sequence

### Phase 1: Audio Pipeline (MCP tools, no ML)
1. Scaffold: `pyproject.toml`, project structure, `server.py`
2. `workspace.py`: directory management
3. `fetch_audio`: YouTube + local file
4. `stem_separate`: Demucs subprocess with caching
5. `audio_render`: device listing + capture
6. `spectrum_analyze`: spectral features + synth hints
7. `audio_compare`: A/B diff + action items

### Phase 2: Inverse Synthesis Framework
8. `models/dataset.py`: dataset generation pipeline
9. `models/synth_renderers/base.py`: abstract renderer interface
10. `models/synth_renderers/subtractive.py`: first renderer (pure Python DSP or SurgeXT)
11. `models/architecture.py`: CNN backbone + per-param MLP heads
12. `models/trainer.py`: training loop with validation
13. `models/inference.py`: load checkpoint, predict

### Phase 3: First Trained Model (subtractive)
14. Define the subtractive synthesis parameter vector (oscillators, filter, envelopes, LFO)
15. Generate 50K samples using subtractive renderer
16. Train inverse model, validate on held-out set
17. `inverse_synth` tool: wire up inference to MCP
18. `train_model` tool: expose training pipeline to agent
19. `list_models` tool: model inventory

### Phase 4: Expand synthesis types
20. Additional renderers (FM, organ)
21. Train models per synthesis type
22. Research vector → device param mapping (vector DB, name matching, learned mapping)

## Verification

1. **Audio pipeline:** `fetch_audio` → `stem_separate` → verify 4 stems produced
2. **Spectrum:** `spectrum_analyze` on pure sine at 440Hz → fundamental ~440Hz, no harmonics
3. **Dataset gen:** Generate 100 samples for Prophet-6, verify (spectrogram, param_vector) pairs
4. **Training:** Train on 1K samples, verify loss decreases, predictions are reasonable
5. **Round-trip:** Generate random params → render → predict via model → compare predicted vs original params
6. **End-to-end:** Separate a song → `inverse_synth` → apply params to keyboard → `audio_render` → `audio_compare` → similarity score