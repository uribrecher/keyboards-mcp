import easymidi from "easymidi";
import type { Channel } from "easymidi";

export interface PortInfo {
  index: number;
  name: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MidiManager {
  private output: easymidi.Output | null = null;
  private connectedPortName: string | null = null;
  private channel: Channel = 0;
  private lowerChannel: Channel = 1;
  private upperChannel: Channel = 2;

  listOutputPorts(): PortInfo[] {
    const names = easymidi.getOutputs();
    return names.map((name, index) => ({ index, name }));
  }

  listInputPorts(): PortInfo[] {
    const names = easymidi.getInputs();
    return names.map((name, index) => ({ index, name }));
  }

  connect(portNameOrIndex: string | number): { success: boolean; portName: string } {
    this.disconnect();

    const ports = this.listOutputPorts();
    let targetPort: PortInfo | undefined;

    if (typeof portNameOrIndex === "number") {
      targetPort = ports[portNameOrIndex];
    } else {
      const lower = portNameOrIndex.toLowerCase();
      targetPort = ports.find((p) => p.name.toLowerCase().includes(lower));
    }

    if (!targetPort) {
      throw new Error(
        `MIDI port not found: ${portNameOrIndex}. Available ports: ${ports.map((p) => p.name).join(", ") || "(none)"}`
      );
    }

    this.output = new easymidi.Output(targetPort.name);
    this.connectedPortName = targetPort.name;
    return { success: true, portName: targetPort.name };
  }

  autoConnect(): { success: boolean; portName: string } {
    const ports = this.listOutputPorts();
    const nordPort = ports.find((p) => p.name.toLowerCase().includes("nord"));
    if (!nordPort) {
      throw new Error(
        `No Nord device found. Available ports: ${ports.map((p) => p.name).join(", ") || "(none)"}`
      );
    }
    return this.connect(nordPort.name);
  }

  disconnect(): void {
    if (this.output) {
      this.output.close();
      this.output = null;
      this.connectedPortName = null;
    }
  }

  isConnected(): boolean {
    return this.output !== null;
  }

  getConnectedPort(): string | null {
    return this.connectedPortName;
  }

  setChannel(channel: Channel): void {
    this.channel = channel;
  }

  getChannel(): Channel {
    return this.channel;
  }

  setPartChannels(lower: Channel, upper: Channel): void {
    this.lowerChannel = lower;
    this.upperChannel = upper;
  }

  getLowerChannel(): Channel {
    return this.lowerChannel;
  }

  getUpperChannel(): Channel {
    return this.upperChannel;
  }

  sendCC(controller: number, value: number, channel?: Channel): void {
    if (!this.output) throw new Error("Not connected to any MIDI device");
    this.output.send("cc", {
      controller,
      value: Math.max(0, Math.min(127, Math.round(value))),
      channel: channel ?? this.channel,
    });
  }

  sendProgramChange(program: number): void {
    if (!this.output) throw new Error("Not connected to any MIDI device");
    this.output.send("program", {
      number: Math.max(0, Math.min(127, Math.round(program))),
      channel: this.channel,
    });
  }

  async sendCCBatch(messages: Array<{ controller: number; value: number; channel?: Channel }>, delayMs = 5): Promise<void> {
    for (const msg of messages) {
      this.sendCC(msg.controller, msg.value, msg.channel);
      if (delayMs > 0) await delay(delayMs);
    }
  }
}
