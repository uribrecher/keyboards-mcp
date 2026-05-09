/**
 * Prophet-6 device instance.
 * Mono-timbral, no parts, no backup. Base class handles everything.
 */

import type { KeyboardModel } from "../../../shared/keyboard-model.js";
import type { ToolResult } from "../../../shared/tool-result.js";
import { textResult } from "../../../shared/tool-result.js";
import { BaseKeyboardDevice, type BaseDeviceDeps } from "../../../shared/base-keyboard-device.js";

export class Prophet6Device extends BaseKeyboardDevice {
  constructor(model: KeyboardModel, deps: BaseDeviceDeps) {
    super(model, deps);
  }

  override getState(_section?: string): ToolResult {
    return textResult(
      "Prophet-6 has no implemented query path — get_current_state is not supported on this model. " +
      "The agent owns its memory of what it set; the hardware itself is the ground truth.",
    );
  }
}
