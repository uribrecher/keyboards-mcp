/**
 * JUNO-X disabled-section warnings.
 *
 * Scene-level effects (chorus / delay / reverb / drive) each have a switch
 * parameter that gates every other param in the same section.
 *
 * Out of scope here: the per-part `part_switch` gate (per-part state needs
 * its own treatment) and engine-specific gating inside ZCore / Analog Synth
 * (deferred until a concrete user-facing case shows up).
 */

import type { ParameterMap, StateManager } from "../../../shared/keyboard-model.js";
import { disabledSectionWarnings } from "../../../shared/disabled-section-rule.js";

export function validateParameterBatch(
  parameters: ReadonlyArray<{ key: string; value: number | string }>,
  state: StateManager,
  _part: string,
  parameterMap: ParameterMap,
): string[] {
  return disabledSectionWarnings(parameters, state, parameterMap, {
    sectionGates: {
      "scene-chorus": "chorus_switch",
      "scene-delay": "delay_switch",
      "scene-reverb": "reverb_switch",
      "scene-drive": "drive_switch",
    },
    display: {
      "scene-chorus": "Scene Chorus",
      "scene-delay": "Scene Delay",
      "scene-reverb": "Scene Reverb",
      "scene-drive": "Scene Drive",
    },
    order: ["scene-chorus", "scene-delay", "scene-reverb", "scene-drive"],
  });
}
