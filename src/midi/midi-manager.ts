import easymidi from "easymidi";
import type { Channel } from "easymidi";
import WebSocket from "ws";
import type { MidiConnection } from "../shared/midi-connection.js";

export interface PortInfo {
  index: number;
  name: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MidiManager implements MidiConnection {
  private output: easymidi.Output | null = null;
  private connectedPortName: string | null = null;
  private input: easymidi.Input | null = null;
  private connectedInputPortName: string | null = null;
  private forwardOutput: easymidi.Output | null = null;
  private connectedForwardPortName: string | null = null;
  private mockWs: WebSocket | null = null;
  private onCCCallback: ((msg: { controller: number; value: number; channel: number }) => void) | null = null;
  private onProgramChangeCallback: ((msg: { number: number; channel: number }) => void) | null = null;
  private onMockDisconnectCallback: (() => void) | null = null;
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

  autoConnect(patterns?: string[]): { success: boolean; portName: string } {
    const ports = this.listOutputPorts();
    const match = patterns
      ? ports.find((p) => patterns.some((pat) => p.name.toLowerCase().includes(pat.toLowerCase())))
      : ports.find((p) => !p.name.toLowerCase().includes("mock"));
    if (!match) {
      throw new Error(
        `No matching MIDI device found. Available ports: ${ports.map((p) => p.name).join(", ") || "(none)"}`
      );
    }
    return this.connect(match.name);
  }

  disconnect(): void {
    if (this.output) {
      this.output.close();
      this.output = null;
      this.connectedPortName = null;
    }
    this.disconnectInput();
    this.disconnectForward();
  }

  isConnected(): boolean {
    if (this.output === null) return false;
    // If a mock device port exists, we must be forwarding AND have a live WebSocket
    if (this.hasMockPort()) {
      if (this.forwardOutput === null) return false;
      if (!this.mockWs || this.mockWs.readyState !== WebSocket.OPEN) return false;
    }
    return true;
  }

  hasMockPort(): boolean {
    const ports = this.listOutputPorts();
    return ports.some((p) => p.name.toLowerCase().includes("mock"));
  }

  isMockWsOpen(): boolean {
    return this.mockWs !== null && this.mockWs.readyState === WebSocket.OPEN;
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
    const msg = {
      controller,
      value: Math.max(0, Math.min(127, Math.round(value))),
      channel: channel ?? this.channel,
    };
    this.output.send("cc", msg);
    // Also forward to mock device if connected
    if (this.forwardOutput) {
      try { this.forwardOutput.send("cc", msg); } catch {}
    }
  }

  sendProgramChange(program: number, channel?: Channel): void {
    if (!this.output) throw new Error("Not connected to any MIDI device");
    const msg = {
      number: Math.max(0, Math.min(127, Math.round(program))),
      channel: channel ?? this.channel,
    };
    this.output.send("program", msg);
    // Also forward to mock device if connected
    if (this.forwardOutput) {
      try { this.forwardOutput.send("program", msg); } catch {}
    }
  }

  async sendCCBatch(messages: Array<{ controller: number; value: number; channel?: Channel }>, delayMs = 5): Promise<void> {
    for (const msg of messages) {
      this.sendCC(msg.controller, msg.value, msg.channel);
      if (delayMs > 0) await delay(delayMs);
    }
  }

  sendSysEx(bytes: number[]): void {
    if (!this.output) throw new Error("Not connected to any MIDI device");
    // easymidi expects a raw array for sysex (checks args[0]===0xf0, args[length-1]===0xf7)
    this.output.send("sysex", bytes as any);
    if (this.forwardOutput) {
      try { this.forwardOutput.send("sysex", bytes as any); } catch {}
    }
  }

  sendNRPN(msb: number, lsb: number, value: number, channel?: Channel): void {
    const ch = channel ?? this.channel;
    // NRPN is 4 CC messages: CC99 (param MSB), CC98 (param LSB), CC6 (value MSB), CC38 (value LSB)
    this.sendCC(99, msb, ch);
    this.sendCC(98, lsb, ch);
    this.sendCC(6, (value >> 7) & 0x7f, ch);
    this.sendCC(38, value & 0x7f, ch);
  }

  /** MidiConnection interface: register a CC listener */
  onCC(callback: (cc: number, value: number, channel: number) => void): void {
    this.setOnCC((msg) => callback(msg.controller, msg.value, msg.channel));
  }

  /** MidiConnection interface: register a SysEx listener (stub — requires input port) */
  onSysEx(_callback: (bytes: number[]) => void): void {
    // SysEx input listening not yet implemented — requires input port handling
  }

  setOnCC(callback: (msg: { controller: number; value: number; channel: number }) => void): void {
    this.onCCCallback = callback;
  }

  setOnProgramChange(callback: (msg: { number: number; channel: number }) => void): void {
    this.onProgramChangeCallback = callback;
  }

  setOnMockDisconnect(callback: () => void): void {
    this.onMockDisconnectCallback = callback;
  }

  connectInput(portNameOrIndex: string | number): { success: boolean; portName: string } {
    this.disconnectInput();

    const ports = this.listInputPorts();
    let targetPort: PortInfo | undefined;

    if (typeof portNameOrIndex === "number") {
      targetPort = ports[portNameOrIndex];
    } else {
      const lower = portNameOrIndex.toLowerCase();
      targetPort = ports.find((p) => p.name.toLowerCase().includes(lower));
    }

    if (!targetPort) {
      throw new Error(
        `MIDI input port not found: ${portNameOrIndex}. Available: ${ports.map((p) => p.name).join(", ") || "(none)"}`
      );
    }

    this.input = new easymidi.Input(targetPort.name);
    this.connectedInputPortName = targetPort.name;

    // Set up message forwarding and callbacks
    const messageTypes = ["noteon", "noteoff", "poly aftertouch", "cc", "program", "channel aftertouch", "pitch"] as const;

    for (const type of messageTypes) {
      this.input.on(type as any, (msg: any) => {
        // Forward to mock device if connected
        if (this.forwardOutput) {
          try { this.forwardOutput.send(type as any, msg); } catch {}
        }

        // Fire callbacks
        if (type === "cc" && this.onCCCallback) {
          this.onCCCallback(msg);
        } else if (type === "program" && this.onProgramChangeCallback) {
          this.onProgramChangeCallback(msg);
        }
      });
    }

    return { success: true, portName: targetPort.name };
  }

  autoConnectInput(patterns?: string[]): { success: boolean; portName: string } {
    const ports = this.listInputPorts();
    const match = patterns
      ? ports.find((p) => patterns.some((pat) => p.name.toLowerCase().includes(pat.toLowerCase())) && !p.name.toLowerCase().includes("mock"))
      : ports.find((p) => !p.name.toLowerCase().includes("mock"));
    if (!match) {
      throw new Error(
        `No matching MIDI input port found. Available: ${ports.map((p) => p.name).join(", ") || "(none)"}`
      );
    }
    return this.connectInput(match.name);
  }

  disconnectInput(): void {
    if (this.input) {
      this.input.close();
      this.input = null;
      this.connectedInputPortName = null;
    }
  }

  getConnectedInputPort(): string | null {
    return this.connectedInputPortName;
  }

  connectForward(portNameOrIndex: string | number): { success: boolean; portName: string } {
    this.disconnectForward();

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
        `MIDI forward port not found: ${portNameOrIndex}. Available: ${ports.map((p) => p.name).join(", ") || "(none)"}`
      );
    }

    this.forwardOutput = new easymidi.Output(targetPort.name);
    this.connectedForwardPortName = targetPort.name;
    this.connectMockWs();
    return { success: true, portName: targetPort.name };
  }

  autoConnectForward(): { success: boolean; portName: string } {
    const ports = this.listOutputPorts();
    const mockPort = ports.find((p) => p.name.toLowerCase().includes("mock"));
    if (!mockPort) {
      throw new Error(
        `No Mock device port found. Available: ${ports.map((p) => p.name).join(", ") || "(none)"}`
      );
    }
    return this.connectForward(mockPort.name);
  }

  disconnectForward(): void {
    this.disconnectMockWs();
    if (this.forwardOutput) {
      this.forwardOutput.close();
      this.forwardOutput = null;
      this.connectedForwardPortName = null;
    }
  }

  private connectMockWs(): void {
    this.disconnectMockWs();
    try {
      const ws = new WebSocket("ws://localhost:3000?client=mcp");
      ws.on("error", () => {}); // Swallow — best-effort signaling
      ws.on("close", () => {
        // Mock device was unloaded — trigger full disconnect
        if (this.mockWs === ws) {
          console.error("Mock device disconnected — dropping MIDI connection");
          this.disconnect();
          this.onMockDisconnectCallback?.();
        }
      });
      this.mockWs = ws;
    } catch {
      // WebSocket connection is best-effort; MIDI forwarding still works
    }
  }

  private disconnectMockWs(): void {
    if (this.mockWs) {
      try { this.mockWs.close(); } catch {}
      this.mockWs = null;
    }
  }

  getConnectedForwardPort(): string | null {
    return this.connectedForwardPortName;
  }
}
