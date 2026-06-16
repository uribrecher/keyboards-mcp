/**
 * Minimal MIDI send interface that keyboard models depend on.
 * MidiManager implements this, but models don't need the full class.
 */
export interface MidiSender {
  sendCC(controller: number, value: number, channel?: number): void;
  sendProgramChange(program: number): void;
  sendCCBatch(
    messages: Array<{ controller: number; value: number; channel?: number }>,
    delayMs?: number,
  ): Promise<void>;
}
