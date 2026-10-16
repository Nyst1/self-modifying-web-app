import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Store, Conflict } from "../server/store.ts";
import { Model } from "../server/model.ts";
import { Jobs } from "../server/jobs.ts";
import { Validator } from "../server/validator.ts";
import { ORIGINAL, type Json } from "../shared/types.ts";

class CopyValidator extends Validator {
  override async validate(
    _code: Parameters<Validator["validate"]>[0],
    data: Json,
  ) {
    return structuredClone(data);
  }
}
class ControlledModel extends Model {
  attempts = 0;
  behavior: "repair" | "broken" | "partial" = "repair";
  override async generate(...args: Parameters<Model["generate"]>) {
    this.attempts++;
    if (this.behavior === "partial" && args[3] === 2)
      return new Promise<string>((_resolve, reject) =>
        args[6].addEventListener(
          "abort",
          () => reject(new Error("Cancelled")),
          { once: true },
        ),
      );
    if (
      this.behavior === "broken" ||
      (this.behavior === "repair" && this.attempts === 1)
    )
      return JSON.stringify({ ...ORIGINAL, js: "const = broken;" });
    return JSON.stringify({ ...ORIGINAL, title: `Proposal ${args[3]}` });
  }
}
async function settle(jobs: Jobs) {
  for (let attempt = 0; jobs.busy() && attempt < 100; attempt++)
    await setImmediate();
  assert.equal(jobs.busy(), false);
}

test("Validation repairs are bounded; successful repair is only a proposal and failures never replace the app", async () => {
  const store = new Store(":memory:"),
    model = new ControlledModel(store),
    validator = new CopyValidator(),
    jobs = new Jobs(store, model, validator);
  try {
    jobs.start("Repair this", 1, 0, []);
    await settle(jobs);
    assert.equal(model.attempts, 2);
    assert.equal(jobs.current()!.status, "complete");
    assert.equal(store.active().id, "original");
    assert.equal(store.versions().length, 2);
    model.behavior = "broken";
    model.attempts = 0;
    jobs.start("Cannot repair this", 1, 0, []);
    await settle(jobs);
    assert.equal(model.attempts, 3);
    assert.equal(jobs.current()!.status, "failed");
    assert.deepEqual(store.active().data, {});
    assert.equal(store.canUndo(), false);
  } finally {
    await jobs.close();
    store.close();
  }
});
test("Cancellation retains a completed alternative, blocks concurrent work, and does not replace newer active data", async () => {
  const store = new Store(":memory:"),
    model = new ControlledModel(store),
    validator = new CopyValidator(),
    jobs = new Jobs(store, model, validator);
  model.behavior = "partial";
  try {
    jobs.start("Three proposals", 3, 0, []);
    for (
      let attempt = 0;
      jobs.current()!.versionIds.length < 1 && attempt < 100;
      attempt++
    )
      await setImmediate();
    assert.equal(jobs.current()!.versionIds.length, 1);
    assert.throws(() => jobs.start("Concurrent job", 1, 0, []), Conflict);
    store.saveData("original", { newlyAdded: true }, 0);
    jobs.cancel();
    await settle(jobs);
    assert.equal(jobs.current()!.status, "cancelled");
    assert.deepEqual(store.active().data, { newlyAdded: true });
    assert.equal(store.versions().length, 2);
    assert.throws(
      () => store.activate(jobs.current()!.versionIds[0], 1),
      Conflict,
    );
  } finally {
    await jobs.close();
    store.close();
  }
});
