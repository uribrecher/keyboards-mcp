/**
 * Prophet-6 disabled-section warnings.
 *
 * The arpeggiator section is gated by `arp_on_off`. Glide is a per-param
 * sub-rule — `glide_mode` lives in the always-on `performance` section,
 * but only matters when `glide_on_off` is on.
 */

import type { ParameterMap, StateManager } from "../../../shared/keyboard-model.js";
import { disabledSectionWarnings, disabledParamWarnings } from "../../../shared/disabled-section-rule.js";

export function validateParameterBatch(
  parameters: ReadonlyArray<{ key: string; value: number | string }>,
  state: StateManager,
  _part: string,
  parameterMap: ParameterMap,
): string[] {
  const sectionWarnings = disabledSectionWarnings(parameters, state, parameterMap, {
    sectionGates: { arpeggiator: "arp_on_off" },
    display: { arpeggiator: "Arpeggiator" },
  });
  const paramWarnings = disabledParamWarnings(parameters, state, parameterMap, {
    paramGates: { glide_mode: "glide_on_off" },
    display: { glide_on_off: "Glide" },
  });
  return [...sectionWarnings, ...paramWarnings];
}
