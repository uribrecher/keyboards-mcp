import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolvePort } from "../../../src/mcb/port-resolver.js";
import type { PortListReader, MockRegistryReader, MockRegistryEntry } from "../../../src/mcb/types.js";

const ports = (outputs: string[], inputs: string[] = []): PortListReader =>
  ({ listOutputs: () => outputs, listInputs: () => inputs });

const reg = (entries: MockRegistryEntry[]): MockRegistryReader => ({
  findByLabel: (l) => entries.find((e) => e.label === l),
  findByMidiPort: (p) => entries.find((e) => e.midiPort === p),
  list: () => entries,
  listAllWithStale: () => [],
});

const mockEntry: MockRegistryEntry = { midiPort: "Nord Mock", wsPort: 3002, label: "nordi", pid: 999, instanceId: "iid-nordi" };

describe("PortResolver", () => {
  it("resolves a mock label (output)", () => {
    const r = resolvePort("nordi", "output", ports(["Nord Mock"]), reg([mockEntry]));
    assert.deepEqual(r, { portName: "Nord Mock", wsPort: 3002, wsOutPort: null });
  });

  it("surfaces the mock's wsOutPort when present (#109)", () => {
    const withOut: MockRegistryEntry = { ...mockEntry, wsOutPort: 3003 };
    const r = resolvePort("nordi", "output", ports(["Nord Mock"]), reg([withOut]));
    assert.deepEqual(r, { portName: "Nord Mock", wsPort: 3002, wsOutPort: 3003 });
  });

  it("rejects mock label for input direction", () => {
    assert.throws(
      () => resolvePort("nordi", "input", ports([], []), reg([mockEntry])),
      { message: /port-not-found/i },
    );
  });

  it("resolves an exact OS output port name", () => {
    const r = resolvePort("Nord Hw", "output", ports(["Nord Hw"]), reg([]));
    assert.deepEqual(r, { portName: "Nord Hw", wsPort: null, wsOutPort: null });
  });

  it("does NOT substring-match", () => {
    assert.throws(
      () => resolvePort("Nord", "output", ports(["Nord Hw"]), reg([])),
      { message: /port-not-found/i },
    );
  });

  it("rejects when registry resolves but OS doesn't show the port", () => {
    assert.throws(
      () => resolvePort("nordi", "output", ports([]), reg([mockEntry])),
      { message: /port-not-found/i },
    );
  });

  it("rejects ambiguous match when label and OS port literal point to different ports", () => {
    // Label "shared" → mock at "Mock A". OS exact "shared" → matches OS port "shared".
    // Two distinct portNames in the candidate set → ambiguous.
    const entries: MockRegistryEntry[] = [
      { midiPort: "Mock A", wsPort: 4001, label: "shared", pid: 1, instanceId: "iid-shared" },
    ];
    assert.throws(
      () => resolvePort("shared", "output", ports(["Mock A", "shared"]), reg(entries)),
      { message: /ambiguous-port/i },
    );
  });
});
