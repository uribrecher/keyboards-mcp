/**
 * The transport interface that keyboard devices code against.
 * MidiManager implements this. Models never see the full MidiManager class.
 */
export interface MidiConnection {
  sendCC(controller: number, value: number, channel?: number): void;
  sendProgramChange(program: number, channel?: number): void;
  sendSysEx(bytes: number[]): void;
  sendNRPN(msb: number, lsb: number, value: number, channel?: number): void;
  sendCCBatch(
    messages: Array<{ controller: number; value: number; channel?: number }>,
    delayMs?: number,
  ): Promise<void>;
  onCC(callback: (cc: number, value: number, channel: number) => void): void;
  onSysEx(callback: (bytes: number[]) => void): void;
}
