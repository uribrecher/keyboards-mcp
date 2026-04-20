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

  // ── synthEngines ──

  /** Load model and assert synthEngines is a non-empty array, returning the engines. */
  async function loadEngines(modelId: string) {
    const model = await loadModelById(modelId);
    assert.ok(Array.isArray(model.synthEngines), `${modelId}: synthEngines is not an array`);
    assert.ok(model.synthEngines.length > 0, `${modelId}: synthEngines is empty`);
    return model.synthEngines;
  }

  for (const modelId of EXPECTED_MODELS) {
    it(`${modelId} has synthEngines defined`, async () => {
      await loadEngines(modelId);
    });

    it(`${modelId} synthEngines have valid fields`, async () => {
      const engines = await loadEngines(modelId);
      for (const engine of engines) {
        assert.ok(engine.id, `${modelId}: engine missing id`);
        assert.ok(engine.displayName, `${modelId}/${engine.id}: missing displayName`);
        assert.ok(engine.category, `${modelId}/${engine.id}: missing category`);
        assert.ok(engine.description, `${modelId}/${engine.id}: missing description`);
        assert.strictEqual(
          typeof engine.inverseSynthEligible, "boolean",
          `${modelId}/${engine.id}: inverseSynthEligible must be boolean`,
        );
      }
    });

    it(`${modelId} synthEngines have no duplicate IDs`, async () => {
      const engines = await loadEngines(modelId);
      const ids = engines.map((e) => e.id);
      const unique = new Set(ids);
      assert.strictEqual(ids.length, unique.size, `${modelId}: duplicate engine IDs: ${ids}`);
    });

    it(`${modelId} synthEngines use valid categories`, async () => {
      const validCategories = [
        "subtractive", "fm", "wavetable", "organ",
        "piano", "electric-piano", "sample", "modeling",
      ];
      const engines = await loadEngines(modelId);
      for (const engine of engines) {
        assert.ok(
          validCategories.includes(engine.category),
          `${modelId}/${engine.id}: invalid category "${engine.category}"`,
        );
      }
    });
  }

  it("nord-electro-5d has organ, piano, electric-piano, and sample engines", async () => {
    const engines = await loadEngines("nord-electro-5d");
    const categories = engines.map((e) => e.category).sort();
    assert.ok(categories.includes("organ"), "missing organ engine");
    assert.ok(categories.includes("piano"), "missing piano engine");
    assert.ok(categories.includes("electric-piano"), "missing electric-piano engine");
    assert.ok(categories.includes("sample"), "missing sample engine");
  });

  it("nord-electro-5d organ engine is inverse synth eligible", async () => {
    const engines = await loadEngines("nord-electro-5d");
    const organ = engines.find((e) => e.category === "organ");
    assert.ok(organ, "organ engine not found");
    assert.strictEqual(organ.inverseSynthEligible, true);
  });

  it("nord-electro-5d piano/ep engines are NOT inverse synth eligible", async () => {
    const engines = await loadEngines("nord-electro-5d");
    const pianoEngines = engines.filter(
      (e) => e.category === "piano" || e.category === "electric-piano" || e.category === "sample",
    );
    for (const engine of pianoEngines) {
      assert.strictEqual(
        engine.inverseSynthEligible, false,
        `${engine.id} should not be inverse synth eligible`,
      );
    }
  });

  it("roland-juno-x has subtractive and electric-piano engines", async () => {
    const engines = await loadEngines("roland-juno-x");
    const categories = new Set(engines.map((e) => e.category));
    assert.ok(categories.has("subtractive"), "missing subtractive engine");
    assert.ok(categories.has("electric-piano"), "missing electric-piano engine");
  });

  it("roland-juno-x RD Piano is NOT inverse synth eligible", async () => {
    const engines = await loadEngines("roland-juno-x");
    const rdPiano = engines.find((e) => e.id === "rd-piano");
    assert.ok(rdPiano, "rd-piano engine not found");
    assert.strictEqual(rdPiano.inverseSynthEligible, false);
  });

  it("sequential-prophet-6 has exactly one subtractive engine", async () => {
    const engines = await loadEngines("sequential-prophet-6");
    assert.strictEqual(engines.length, 1);
    assert.strictEqual(engines[0].category, "subtractive");
    assert.strictEqual(engines[0].inverseSynthEligible, true);
  });
});
