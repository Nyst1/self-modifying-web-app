import { randomUUID } from "node:crypto";
import type { Job, Version } from "../shared/types.ts";
import { Store, Conflict } from "./store.ts";
import { Model } from "./model.ts";
import { Validator } from "./validator.ts";
import { extractJson, validateCode } from "./schema.ts";

export class Jobs {
  active: Job | null = null;
  private controller: AbortController | null = null;
  private task: Promise<void> | null = null;
  constructor(
    private store: Store,
    private model: Model,
    private validator: Validator,
  ) {
    store.recoverJobs();
  }
  start(
    prompt: string,
    count: number,
    revision: number,
    inspirationIds: string[],
  ) {
    if (this.controller)
      throw new Conflict(
        "A generation is already running. Cancel it before starting another.",
      );
    this.store.checkRevision(revision);
    const base = this.store.active();
    const inspirations = inspirationIds.map(
      (id) => this.store.version(id).code,
    );
    this.controller = new AbortController();
    const job: Job = {
      id: randomUUID(),
      status: "queued",
      prompt,
      count,
      current: 0,
      attempt: 0,
      message: "Waiting for the local model…",
      versionIds: [],
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      tokens: 0,
      tokensPerSecond: null,
      error: null,
    };
    this.active = job;
    this.store.saveJob(job);
    this.store.event("prompt", base.id, {
      prompt,
      jobId: job.id,
      count,
      inspirationIds,
    });
    const signal = this.controller.signal;
    this.task = this.run(job, base, revision, inspirations, signal).finally(
      () => {
        this.controller = null;
      },
    );
    return job;
  }
  private async run(
    job: Job,
    base: Version,
    revision: number,
    inspirations: Version["code"][],
    signal: AbortSignal,
  ) {
    const start = Date.now();
    let savedAt = 0;
    const update = () => {
      job.elapsedMs = Date.now() - start;
      this.store.saveJob(job);
    };
    try {
      for (let variant = 1; variant <= job.count; variant++) {
        let repair: { output: string; error: string } | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          job.status = "generating";
          job.current = variant;
          job.attempt = attempt;
          job.message = `${attempt ? "Repairing" : "Creating"} proposal ${variant} of ${job.count}${attempt ? ` · attempt ${attempt + 1}` : ""}…`;
          update();
          let output = "";
          try {
            output = await this.model.generate(
              job.prompt,
              base.code,
              base.data,
              variant,
              job.count,
              inspirations,
              signal,
              (metrics) => {
                job.tokens = metrics.tokens;
                job.tokensPerSecond = metrics.tokensPerSecond;
                if (Date.now() - savedAt > 700) {
                  savedAt = Date.now();
                  update();
                }
              },
              repair,
            );
            signal.throwIfAborted();
            const code = validateCode(extractJson(output));
            job.status = "validating";
            job.message = `Testing proposal ${variant}: data transformation and isolated app…`;
            update();
            const data = await this.validator.validate(code, base.data, signal);
            signal.throwIfAborted();
            const version: Version = {
              id: randomUUID(),
              parentId: base.id,
              jobId: job.id,
              variant,
              code,
              data,
              baseRevision: revision,
              createdAt: new Date().toISOString(),
              validation:
                "Syntax, JSON data transformation, and isolated startup passed. Functionality still needs your review.",
            };
            this.store.transaction(() => {
              this.store.addVersion(version);
              this.store.event("proposal_created", version.id, {
                jobId: job.id,
                variant,
                title: code.title,
                description: code.description,
              });
            });
            job.versionIds.push(version.id);
            update();
            break;
          } catch (error) {
            if (signal.aborted) throw error;
            repair = { output, error: (error as Error).message };
            this.store.event("generation_error", base.id, {
              jobId: job.id,
              variant,
              attempt,
              message: repair.error,
            });
            if (attempt === 2 || !output) throw error;
          }
        }
      }
      job.status = "complete";
      job.message =
        "Your proposals are ready to explore. Nothing changes until you apply one.";
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.error = signal.aborted ? null : (error as Error).message;
      job.message = signal.aborted
        ? "Cancelled. Your active app is unchanged."
        : "Generation failed. Your active app is unchanged.";
      this.store.event(
        job.status === "cancelled"
          ? "generation_cancelled"
          : "generation_failed",
        base.id,
        { jobId: job.id, error: job.error },
      );
    } finally {
      update();
    }
  }
  cancel() {
    this.controller?.abort();
  }
  busy() {
    return !!this.controller;
  }
  current(): Job | null {
    return this.active ?? this.store.latestJob();
  }
  async close() {
    this.cancel();
    await this.task;
  }
}
