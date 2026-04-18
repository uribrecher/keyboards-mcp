import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { discoverModels, loadModelById, autoDetectModel } from "../../src/shared/model-registry.js";

const EXPECTED_MODELS = [
  "nord-electro-5d",
  "roland-juno-x",
  "sequential-prophet-6",
];

describe("model registry", () => {
  // ── 4a. discoverModels ──

  it("discovers all registered models", async () => {
    const models = await discoverModels();
    const ids = models.map((m) => m.id).sort();
    assert.deepStrictEqual(ids, [...EXPECTED_MODELS].sort());
  });

  it("no duplicate model IDs", async () => {
    const models = await discoverModels();
    const ids = models.map((m) => m.id);
    const unique = new Set(ids);
    assert.strictEqual(ids.length, unique.size, `duplicate IDs found: ${ids}`);
  });

  it("each model has non-empty required info fields", async () => {
    const models = await discoverModels();
    for (const info of models) {
      assert.ok(info.id, "missing id");
      assert.ok(info.displayName, "missing displayName");
      assert.ok(info.manufacturer, "missing manufacturer");
      assert.ok(info.midiPortPatterns.length > 0, `${info.id}: empty midiPortPatterns`);
    }
  });

  // ── 4b. loadModelById ──

  for (const modelId of EXPECTED_MODELS) {
    it(`loadModelById("${modelId}") returns matching model`, async () => {
      const model = await loadModelById(modelId);
      assert.strictEqual(model.info.id, modelId);
    });
  }

  it("loadModelById throws for unknown model", async () => {
    await assert.rejects(
      () => loadModelById("nonexistent-model"),
      (err: Error) => err.message.includes("not found") && err.message.includes("nonexistent-model"),
    );
  });

  // ── 4c. createMockHandler and createDevice ──

  for (const modelId of EXPECTED_MODELS) {
    it(`${modelId} has createMockHandler defined`, async () => {
      const model = await loadModelById(modelId);
      assert.ok(
        typeof model.createMockHandler === "function",
        `${modelId}: createMockHandler is not a function`,
      );
      const handler = model.createMockHandler!();
      assert.ok(handler, `${modelId}: createMockHandler returned null/undefined`);
    });

    it(`${modelId} has createDevice defined`, async () => {
      const model = await loadModelById(modelId);
      assert.ok(
        typeof model.createDevice === "function",
        `${modelId}: createDevice is not a function`,
      );
    });
  }

  // ── 4d. autoDetectModel ──

  it("autoDetectModel matches Nord port name", async () => {
    const model = await autoDetectModel(["Nord Electro 5 MIDI Input"]);
    assert.ok(model, "expected Nord model");
    assert.strictEqual(model!.info.id, "nord-electro-5d");
  });

  it("autoDetectModel matches JUNO-X port name", async () => {
    const model = await autoDetectModel(["Roland JUNO-X Mock"]);
    assert.ok(model, "expected JUNO-X model");
    assert.strictEqual(model!.info.id, "roland-juno-x");
  });

  it("autoDetectModel matches Prophet port name", async () => {
    const model = await autoDetectModel(["Sequential Prophet-6"]);
    assert.ok(model, "expected Prophet-6 model");
    assert.strictEqual(model!.info.id, "sequential-prophet-6");
  });

  it("autoDetectModel returns null for unknown port", async () => {
    const model = await autoDetectModel(["Unknown MIDI Device"]);
    assert.strictEqual(model, null);
  });
});
