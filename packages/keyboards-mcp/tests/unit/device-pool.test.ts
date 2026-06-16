import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { DevicePool } from "../../src/shared/device-pool.js";
import type { KeyboardDevice, KeyboardModel } from "../../src/shared/keyboard-model.js";

function makeStubDevice(id: string, displayName: string): KeyboardDevice & { detached: number } {
  const model = {
    info: { id, displayName, manufacturer: "Test", midiPortPatterns: [] },
  } as unknown as KeyboardModel;

  const device: any = {
    model,
    label: undefined as string | undefined,
    detached: 0,
    attach() {},
    detach() { this.detached++; },
    listParameters() { return { content: [{ type: "text", text: "" }] }; },
    setParameters() { return { content: [{ type: "text", text: "" }] }; },
    getState() { return { content: [{ type: "text", text: "" }] }; },
    loadProgram() { return { content: [{ type: "text", text: "" }] }; },
    loadSong() { return { content: [{ type: "text", text: "" }] }; },
    listPrograms() { return { content: [{ type: "text", text: "" }] }; },
    listSongs() { return { content: [{ type: "text", text: "" }] }; },
    getSystemPrompt() { return { content: [{ type: "text", text: "" }] }; },
  };
  return device;
}

describe("DevicePool", () => {
  let pool: DevicePool;

  beforeEach(() => { pool = new DevicePool(); });

  describe("connect", () => {
    it("assigns index 1 to the first device", () => {
      const d1 = makeStubDevice("a", "A");
      assert.equal(pool.connect(d1), 1);
    });

    it("assigns index 2 to the second device", () => {
      pool.connect(makeStubDevice("a", "A"));
      assert.equal(pool.connect(makeStubDevice("b", "B")), 2);
    });

    it("stores device by index", () => {
      const d1 = makeStubDevice("a", "A");
      pool.connect(d1);
      assert.equal(pool.get(1)?.device, d1);
    });
  });

  describe("get / require", () => {
    it("get returns undefined for unknown index", () => {
      assert.equal(pool.get(99), undefined);
    });

    it("require throws with a user-friendly message including connected devices", () => {
      pool.connect(makeStubDevice("nord", "Nord Electro 5D"));
      assert.throws(
        () => pool.require(99),
        (err: Error) => /No device at index 99/.test(err.message)
          && /Nord Electro 5D/.test(err.message),
      );
    });

    it("require returns the entry when it exists", () => {
      const d1 = makeStubDevice("nord", "Nord");
      pool.connect(d1);
      assert.equal(pool.require(1).device, d1);
    });
  });

  describe("requireSingle", () => {
    it("throws on zero devices", () => {
      assert.throws(() => pool.requireSingle(), /No keyboard connected/);
    });

    it("returns the lone device", () => {
      const d1 = makeStubDevice("nord", "Nord");
      pool.connect(d1);
      assert.equal(pool.requireSingle().device, d1);
    });

    it("throws on multiple devices, listing them all", () => {
      pool.connect(makeStubDevice("nord", "Nord Electro 5D"));
      pool.connect(makeStubDevice("p6", "Prophet-6"));
      assert.throws(
        () => pool.requireSingle(),
        (err: Error) => /Multiple devices connected/.test(err.message)
          && /Nord Electro 5D/.test(err.message)
          && /Prophet-6/.test(err.message),
      );
    });
  });

  describe("resolve", () => {
    it("with explicit index uses require()", () => {
      const d1 = makeStubDevice("a", "A");
      pool.connect(d1);
      pool.connect(makeStubDevice("b", "B"));
      assert.equal(pool.resolve(1).device, d1);
    });

    it("without index uses requireSingle()", () => {
      const d1 = makeStubDevice("a", "A");
      pool.connect(d1);
      assert.equal(pool.resolve().device, d1);
    });

    it("without index and multiple devices throws ambiguous error", () => {
      pool.connect(makeStubDevice("a", "A"));
      pool.connect(makeStubDevice("b", "B"));
      assert.throws(() => pool.resolve(), /Multiple devices connected/);
    });
  });

  describe("disconnect", () => {
    it("removes the device", () => {
      pool.connect(makeStubDevice("a", "A"));
      pool.disconnect(1);
      assert.equal(pool.get(1), undefined);
      assert.equal(pool.size(), 0);
    });

    it("calls device.detach()", () => {
      const d1 = makeStubDevice("a", "A");
      pool.connect(d1);
      pool.disconnect(1);
      assert.equal((d1 as any).detached, 1);
    });

    it("runs onDispose after detach", () => {
      const d1 = makeStubDevice("a", "A");
      let disposed = false;
      pool.connect(d1, () => { disposed = true; });
      pool.disconnect(1);
      assert.equal(disposed, true);
    });

    it("throws on unknown index", () => {
      assert.throws(() => pool.disconnect(42), /No device at index 42/);
    });
  });

  describe("stable indices", () => {
    it("does not renumber surviving devices when one is removed", () => {
      const d1 = makeStubDevice("a", "A");
      const d2 = makeStubDevice("b", "B");
      pool.connect(d1);
      pool.connect(d2);
      pool.disconnect(1);
      assert.equal(pool.get(2)?.device, d2);
    });

    it("the next connection gets the next fresh index, not a recycled one", () => {
      pool.connect(makeStubDevice("a", "A"));
      pool.connect(makeStubDevice("b", "B"));
      pool.disconnect(1);
      assert.equal(pool.connect(makeStubDevice("c", "C")), 3);
    });
  });

  describe("list", () => {
    it("returns connected entries in insertion order", () => {
      const d1 = makeStubDevice("a", "A");
      const d2 = makeStubDevice("b", "B");
      pool.connect(d1);
      pool.connect(d2);
      const list = pool.list();
      assert.equal(list.length, 2);
      assert.equal(list[0].device, d1);
      assert.equal(list[1].device, d2);
    });
  });

  describe("labels", () => {
    it("preserves device.label on the entry", () => {
      const d1 = makeStubDevice("a", "A");
      d1.label = "studio";
      pool.connect(d1);
      assert.equal(pool.get(1)?.device.label, "studio");
    });
  });
});
