/**
 * Prophet-6 device instance.
 * Mono-timbral, no parts, no backup. Base class handles everything.
 */

import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import { BaseKeyboardDevice, type BaseDeviceDeps } from "../../../shared/base-keyboard-device.js";
import { GenericParameterState } from "../../../shared/parameter-state.js";
import { validateParameterBatch } from "./validation.js";

export class Prophet6Device extends BaseKeyboardDevice {
  constructor(model: KeyboardModel, deps: BaseDeviceDeps) {
    super(model, deps, new GenericParameterState([], deps.parameterMap));
  }

  protected override validateAfterSet(
    resolvedKeys: Array<{ key: string; value: number | string }>,
    part: string,
  ): string[] {
    return validateParameterBatch(resolvedKeys, this.state, part, this.parameterMap);
  }
}
