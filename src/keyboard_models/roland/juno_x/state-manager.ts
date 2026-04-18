import type { ParameterMap } from "../../../shared/keyboard-model.js";
import { GenericParameterState } from "../../../shared/parameter-state.js";
import { PART_NAMES, JunoXEngine } from "./engines/engine-types.js";

export class JunoXState extends GenericParameterState {
  private engines: JunoXEngine[] = [
    JunoXEngine.AnalogSynth,
    JunoXEngine.AnalogSynth,
    JunoXEngine.AnalogSynth,
    JunoXEngine.AnalogSynth,
    JunoXEngine.AnalogSynth,
  ];

  constructor(parameterMap: ParameterMap) {
    super(PART_NAMES, parameterMap);
  }

  getEngine(partIndex: number): JunoXEngine {
    return this.engines[partIndex] ?? JunoXEngine.AnalogSynth;
  }

  setEngine(partIndex: number, engine: JunoXEngine): void {
    if (partIndex >= 0 && partIndex < this.engines.length) {
      this.engines[partIndex] = engine;
    }
  }

  getAllEngines(): JunoXEngine[] {
    return [...this.engines];
  }
}
