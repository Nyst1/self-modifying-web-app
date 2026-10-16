import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ORIGINAL,
  type AppCode,
  type Event,
  type Instruction,
  type Json,
  type Version,
} from "../shared/types.ts";

export class Conflict extends Error {}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, parent_id TEXT, job_id TEXT, variant INTEGER, code TEXT NOT NULL, data TEXT NOT NULL, base_revision INTEGER, created_at TEXT, validation TEXT);
      CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), active_id TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, instruction_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, version_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instructions(id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS undo(id INTEGER PRIMARY KEY AUTOINCREMENT, version_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, json TEXT NOT NULL);
    `);
    if (!this.db.prepare("SELECT id FROM state").get()) {
      this.transaction(() => {
        this.addVersion({
          id: "original",
          parentId: null,
          jobId: null,
          variant: 0,
          code: ORIGINAL,
          data: {},
          baseRevision: 0,
          createdAt: new Date().toISOString(),
          validation: "Built-in original",
        });
        const instruction = this.addInstruction(
          "Build thoughtful, useful apps. Make changes that match the user’s request. Preserve their data when possible.",
        );
        this.db
          .prepare("INSERT INTO state VALUES(1,?,?,0,?)")
          .run("original", "{}", instruction.id);
      });
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  state() {
    const row = this.db.prepare("SELECT * FROM state WHERE id=1").get()!;
    return {
      activeId: row.active_id as string,
      data: JSON.parse(row.data as string) as Json,
      revision: row.revision as number,
      instructionId: row.instruction_id as string,
    };
  }
  active(): Version {
    const state = this.state();
    return { ...this.version(state.activeId), data: state.data };
  }
  version(id: string): Version {
    const row = this.db.prepare("SELECT * FROM versions WHERE id=?").get(id);
    if (!row) throw new Error("Version not found");
    return {
      id: row.id as string,
      parentId: row.parent_id as string | null,
      jobId: row.job_id as string | null,
      variant: row.variant as number,
      code: JSON.parse(row.code as string) as AppCode,
      data: JSON.parse(row.data as string) as Json,
      baseRevision: row.base_revision as number,
      createdAt: row.created_at as string,
      validation: row.validation as string,
    };
  }
  versions(): Version[] {
    return this.db
      .prepare("SELECT id FROM versions ORDER BY created_at DESC")
      .all()
      .map((row) => this.version(row.id as string));
  }
  addVersion(version: Version) {
    this.db
      .prepare("INSERT INTO versions VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        version.id,
        version.parentId,
        version.jobId,
        version.variant,
        JSON.stringify(version.code),
        JSON.stringify(version.data),
        version.baseRevision,
        version.createdAt,
        version.validation,
      );
  }
  event(
    type: string,
    versionId: string | null,
    payload: Record<string, unknown> = {},
  ) {
    this.db
      .prepare(
        "INSERT INTO events(type,version_id,payload,created_at) VALUES(?,?,?,?)",
      )
      .run(type, versionId, JSON.stringify(payload), new Date().toISOString());
  }
  events(query = "", limit = 100): Event[] {
    const rows = query
      ? this.db
          .prepare(
            "SELECT * FROM events WHERE instr(lower(payload), lower(?)) > 0 OR instr(lower(type), lower(?)) > 0 ORDER BY id DESC LIMIT ?",
          )
          .all(query, query, limit)
      : this.db
          .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
          .all(limit);
    return rows.map((row) => ({
      id: row.id as number,
      type: row.type as string,
      versionId: row.version_id as string | null,
      payload: JSON.parse(row.payload as string),
      createdAt: row.created_at as string,
    }));
  }
  historyContext(prompt: string) {
    const recent = this.events("", 16);
    const words =
      prompt
        .toLowerCase()
        .match(/[\p{L}\p{N}]{4,}/gu)
        ?.slice(0, 5) ?? [];
    const relevant = words.flatMap((word) => this.events(word, 3));
    const older = this.db
      .prepare(
        "SELECT type,version_id,COUNT(*) AS count,MIN(id) AS first_id,MAX(id) AS last_id FROM events GROUP BY type,version_id ORDER BY last_id DESC LIMIT 20",
      )
      .all();
    return {
      recent,
      relevant: [
        ...new Map(relevant.map((event) => [event.id, event])).values(),
      ],
      summary: older,
    };
  }
  checkRevision(expected: number) {
    if (this.state().revision !== expected)
      throw new Conflict(
        "The app or its instructions changed. Generate a fresh proposal from the current version.",
      );
  }
  saveData(id: string, data: Json, revision: number) {
    this.transaction(() => {
      this.checkRevision(revision);
      if (id !== this.state().activeId)
        throw new Conflict("This version is no longer active.");
      this.db
        .prepare("UPDATE state SET data=?, revision=revision+1 WHERE id=1")
        .run(JSON.stringify(data));
    });
    return this.state().revision;
  }
  activate(id: string, revision: number) {
    this.transaction(() => {
      this.checkRevision(revision);
      const version = this.version(id),
        state = this.state();
      if (id === "original")
        throw new Error("Use Reset to restore the original.");
      if (version.baseRevision !== revision)
        throw new Conflict(
          "This proposal was made from an older app snapshot. Regenerate it before applying.",
        );
      this.db
        .prepare("INSERT INTO undo(version_id,data) VALUES(?,?)")
        .run(state.activeId, JSON.stringify(state.data));
      this.db
        .prepare(
          "UPDATE state SET active_id=?, data=?, revision=revision+1 WHERE id=1",
        )
        .run(id, JSON.stringify(version.data));
      this.event("selected", id, {
        previousVersionId: state.activeId,
        jobId: version.jobId,
        variant: version.variant,
      });
    });
  }
  reset(revision: number) {
    this.transaction(() => {
      this.checkRevision(revision);
      const state = this.state();
      this.db
        .prepare("INSERT INTO undo(version_id,data) VALUES(?,?)")
        .run(state.activeId, JSON.stringify(state.data));
      this.db
        .prepare(
          "UPDATE state SET active_id=?, data=?, revision=revision+1 WHERE id=1",
        )
        .run("original", "{}");
      this.event("reset", state.activeId, {
        restoredVersionId: "original",
        reason: "unknown",
      });
    });
  }
  canUndo() {
    return !!this.db.prepare("SELECT id FROM undo LIMIT 1").get();
  }
  undo(revision: number) {
    this.transaction(() => {
      this.checkRevision(revision);
      const row = this.db
        .prepare("SELECT * FROM undo ORDER BY id DESC LIMIT 1")
        .get();
      if (!row) throw new Conflict("There is no previous version to restore.");
      const previousId = this.state().activeId;
      this.db
        .prepare(
          "UPDATE state SET active_id=?, data=?, revision=revision+1 WHERE id=1",
        )
        .run(row.version_id as string, row.data as string);
      this.db.prepare("DELETE FROM undo WHERE id=?").run(row.id as number);
      this.event("undo", previousId, {
        restoredVersionId: row.version_id,
        reason: "unknown",
      });
    });
  }
  instructions(): Instruction[] {
    return this.db
      .prepare("SELECT * FROM instructions ORDER BY created_at DESC")
      .all()
      .map((row) => ({
        id: row.id as string,
        text: row.text as string,
        createdAt: row.created_at as string,
      }));
  }
  currentInstruction() {
    return this.instructions().find(
      (item) => item.id === this.state().instructionId,
    )!;
  }
  addInstruction(text: string): Instruction {
    const item = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO instructions VALUES(?,?,?)")
      .run(item.id, item.text, item.createdAt);
    return item;
  }
  setInstruction(
    text: string,
    revision: number,
    expectedInstructionId?: string,
  ) {
    this.transaction(() => {
      if (expectedInstructionId) {
        if (this.state().instructionId !== expectedInstructionId)
          throw new Conflict(
            "Working instructions changed. Review the current instructions before saving.",
          );
      } else this.checkRevision(revision);
      const item = this.addInstruction(text);
      this.db
        .prepare(
          "UPDATE state SET instruction_id=?, revision=revision+1 WHERE id=1",
        )
        .run(item.id);
      this.event("instructions_saved", this.state().activeId, {
        instructionId: item.id,
        text,
      });
    });
  }
  saveJob<T extends { id: string }>(job: T) {
    this.db
      .prepare("INSERT OR REPLACE INTO jobs VALUES(?,?)")
      .run(job.id, JSON.stringify(job));
  }
  recoverJobs() {
    for (const row of this.db.prepare("SELECT * FROM jobs").all()) {
      const job = JSON.parse(row.json as string);
      if (["queued", "generating", "validating"].includes(job.status)) {
        job.status = "failed";
        job.error =
          "Generation was interrupted by a restart. Your active app is unchanged.";
        job.message = job.error;
        this.saveJob(job);
        this.event("generation_interrupted", null, { jobId: job.id });
      }
    }
  }
  latestJob() {
    const row = this.db
      .prepare("SELECT json FROM jobs ORDER BY rowid DESC LIMIT 1")
      .get();
    return row ? JSON.parse(row.json as string) : null;
  }
  close() {
    this.db.close();
  }
}
