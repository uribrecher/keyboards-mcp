/**
 * Sequential Circuits Prophet-6 MidiCodec — CC-only.
 *
 * Plan: docs/plans/pending/30-midi-codec-architecture.md (stage 1).
 */

import type { MidiCodec } from "../../../shared/midi-codec.js";
import { createCcCodec } from "../../../shared/midi-codec.js";
import { createParameterMap } from "./midi-map.js";

export function createProphet6Codec(): MidiCodec {
  return createCcCodec(createParameterMap());
}
