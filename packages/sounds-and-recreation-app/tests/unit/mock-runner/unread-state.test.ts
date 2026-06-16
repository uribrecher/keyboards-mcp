import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { nextUnread } from "../../../src/shell/unread-state.js";

describe("unread-state", () => {
  it("nextUnread starts at the incoming severity from null", () => {
    assert.equal(nextUnread(null, "info"), "info");
    assert.equal(nextUnread(null, "warn"), "warn");
    assert.equal(nextUnread(null, "error"), "error");
  });

  it("nextUnread upgrades to higher severity", () => {
    assert.equal(nextUnread("info", "warn"), "warn");
    assert.equal(nextUnread("info", "error"), "error");
    assert.equal(nextUnread("warn", "error"), "error");
  });

  it("nextUnread never downgrades", () => {
    assert.equal(nextUnread("error", "warn"), "error");
    assert.equal(nextUnread("error", "info"), "error");
    assert.equal(nextUnread("warn", "info"), "warn");
  });

  it("nextUnread holds equal severity", () => {
    assert.equal(nextUnread("warn", "warn"), "warn");
  });
});
