import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Conflict } from "../server/store.ts";
import { ORIGINAL, type Version } from "../shared/types.ts";
import { validateCode, validateData, extractJson } from "../server/schema.ts";

function candidate(store: Store, id: string, data: Version["data"]): Version {
  const version = {
    id,
    parentId: store.active().id,
    jobId: "job",
    variant: 1,
    code: { ...ORIGINAL, title: id },
    data,
    baseRevision: store.state().revision,
    createdAt: new Date().toISOString(),
    validation: "Test",
  };
  store.addVersion(version);
  return version;
}
test("Undo restores exact pre-transition data; Reset is itself undoable and preserves preferences/history", () => {
  const store = new Store(":memory:");
  try {
    store.setInstruction("Be more adventurous.", 0);
    const first = candidate(store, "calendar", { events: [] });
    store.activate(first.id, 1);
    store.saveData(first.id, { events: [{ title: "Keep me" }] }, 2);
    const second = candidate(store, "game", { scores: [9] });
    store.activate(second.id, 3);
    store.saveData(second.id, { scores: [99] }, 4);
    store.undo(5);
    assert.equal(store.active().id, "calendar");
    assert.deepEqual(store.active().data, { events: [{ title: "Keep me" }] });
    store.reset(6);
    assert.equal(store.active().id, "original");
    assert.deepEqual(store.active().data, {});
    assert.equal(store.currentInstruction().text, "Be more adventurous.");
    store.undo(7);
    assert.deepEqual(store.active().data, { events: [{ title: "Keep me" }] });
    assert.ok(store.events().some((e) => e.type === "reset"));
    assert.equal(store.versions().length, 3);
  } finally {
    store.close();
  }
});
test("Candidates remain independent and stale activation cannot overwrite current data", () => {
  const store = new Store(":memory:");
  try {
    const a = candidate(store, "a", { kind: "a" }),
      b = candidate(store, "b", { kind: "b" });
    store.saveData("original", { changed: true }, 0);
    assert.throws(() => store.activate(a.id, 1), Conflict);
    assert.deepEqual(store.active().data, { changed: true });
    assert.deepEqual(store.version(b.id).data, { kind: "b" });
    assert.equal(store.canUndo(), false);
    assert.throws(() => store.saveData("b", {}, 1), Conflict);
  } finally {
    store.close();
  }
});
test("A failed transaction leaves the active pointer, data and undo stack unchanged", () => {
  const store = new Store(":memory:");
  try {
    assert.throws(() =>
      store.transaction(() => {
        store.db
          .prepare("UPDATE state SET data=? WHERE id=1")
          .run('{"bad":true}');
        throw new Error("Simulated failure");
      }),
    );
    assert.deepEqual(store.active().data, {});
    assert.equal(store.state().revision, 0);
    assert.equal(store.canUndo(), false);
  } finally {
    store.close();
  }
});
test("Disk restart preserves data and candidates and marks incomplete jobs interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "evolution-store-"));
  try {
    let store = new Store(join(dir, "studio.sqlite"));
    candidate(store, "saved", { things: [1] });
    store.activate("saved", 0);
    store.saveData("saved", { things: [1, 2] }, 1);
    store.saveJob({ id: "unfinished", status: "generating" });
    store.close();
    store = new Store(join(dir, "studio.sqlite"));
    store.recoverJobs();
    assert.deepEqual(store.active().data, { things: [1, 2] });
    assert.equal(store.latestJob().status, "failed");
    assert.equal(store.canUndo(), true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("Validate model output, syntax and JSON size before any code can be applied", () => {
  assert.equal(
    validateCode({ ...ORIGINAL, js: "const data = await app.readData();" }).js,
    "const data = await app.readData();",
  );
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => validateCode({ ...ORIGINAL, js: "const = ;" }));
  assert.throws(() => validateCode({ ...ORIGINAL, migrate: "return ( ;" }));
  assert.throws(() => validateCode({ ...ORIGINAL, extra: "unsupported" }));
  assert.throws(() => validateData({ huge: "x".repeat(2_000_001) }));
});

test("Instruction proposals survive unrelated data edits but cannot overwrite newer instructions", () => {
  const store = new Store(":memory:");
  try {
    const baseId = store.state().instructionId;
    store.saveData("original", { editedWhileThinking: true }, 0);
    store.setInstruction("More adventurous", 0, baseId);
    assert.deepEqual(store.active().data, { editedWhileThinking: true });
    assert.throws(
      () => store.setInstruction("Stale proposal", 0, baseId),
      Conflict,
    );
    assert.equal(store.currentInstruction().text, "More adventurous");
  } finally {
    store.close();
  }
});
