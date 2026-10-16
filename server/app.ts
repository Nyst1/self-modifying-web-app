import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.ts";
import { Conflict } from "./store.ts";
import type { Model } from "./model.ts";
import type { Jobs } from "./jobs.ts";
import { extractJson, validateData } from "./schema.ts";

export function createApp(
  store: Store,
  model: Model,
  jobs: Jobs,
  origin: string,
) {
  const app = express();
  const session = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex");
  let instructionController: AbortController | null = null;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(origin).host) {
      res.status(403).json({ error: "Invalid local host." });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=()",
    );
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      const requestOrigin = req.headers.origin;
      if (
        (requestOrigin && requestOrigin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        res.status(403).json({ error: "Cross-origin access is not allowed." });
        return;
      }
      if (req.path !== "/api/bootstrap" && req.path !== "/api/health") {
        const cookie = req.headers.cookie
          ?.split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("studio_session="))
          ?.slice(15);
        if (
          !cookie ||
          cookie.length !== session.length ||
          !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))
        ) {
          res
            .status(401)
            .json({ error: "Reload the studio to start a local session." });
          return;
        }
        if (req.method !== "GET" && req.headers["x-csrf-token"] !== csrf) {
          res.status(403).json({ error: "Invalid session token." });
          return;
        }
      }
    }
    next();
  });
  app.use(express.json({ limit: "3mb" }));
  const snapshot = () => ({
    active: store.active(),
    revision: store.state().revision,
    csrf,
    versions: store.versions(),
    events: store.events("", 100),
    instructions: store.instructions(),
    currentInstructionId: store.state().instructionId,
    canUndo: store.canUndo(),
    job: jobs.current(),
  });
  const revisionSchema = z.object({ revision: z.number().int().nonnegative() });
  app.get("/api/health", (_req, res) =>
    res.json({ application: "evolution-studio" }),
  );
  app.get("/api/bootstrap", (_req, res) => {
    res.cookie("studio_session", session, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    res.json(snapshot());
  });
  app.get("/api/state", (_req, res) => res.json(snapshot()));
  app.get("/api/diagnostics", async (_req, res) =>
    res.json(await model.diagnostics()),
  );
  app.get("/api/history", (req, res) => {
    const query = z
      .string()
      .max(200)
      .parse(req.query.q || "");
    const before = req.query.before
      ? z.coerce.number().int().positive().parse(req.query.before)
      : null;
    // Exact pagination for the whole history; search returns a bounded matching page.
    if (query) res.json(store.events(query, 100));
    else {
      const rows = before
        ? store.db
            .prepare(
              "SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT 100",
            )
            .all(before)
        : store.db
            .prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100")
            .all();
      res.json(
        rows.map((row) => ({
          id: row.id,
          type: row.type,
          versionId: row.version_id,
          payload: JSON.parse(row.payload as string),
          createdAt: row.created_at,
        })),
      );
    }
  });
  app.post("/api/generate", (req, res) => {
    if (instructionController)
      throw new Conflict("An instruction proposal is being generated.");
    const input = z
      .object({
        prompt: z.string().trim().min(1).max(4000),
        count: z.union([z.literal(1), z.literal(3)]),
        revision: z.number().int().nonnegative(),
        inspirationIds: z.array(z.string().max(100)).max(2).default([]),
      })
      .parse(req.body);
    res
      .status(202)
      .json(
        jobs.start(
          input.prompt,
          input.count,
          input.revision,
          input.inspirationIds,
        ),
      );
  });
  app.post("/api/cancel", (_req, res) => {
    jobs.cancel();
    instructionController?.abort();
    res.json({ ok: true });
  });
  app.post("/api/activate", (req, res) => {
    const input = revisionSchema
      .extend({ id: z.string().max(100) })
      .parse(req.body);
    store.activate(input.id, input.revision);
    res.json(snapshot());
  });
  app.post("/api/reset", (req, res) => {
    store.reset(revisionSchema.parse(req.body).revision);
    res.json(snapshot());
  });
  app.post("/api/undo", (req, res) => {
    store.undo(revisionSchema.parse(req.body).revision);
    res.json(snapshot());
  });
  app.post("/api/data", (req, res) => {
    const input = revisionSchema
      .extend({ id: z.string().max(100), data: z.unknown() })
      .parse(req.body);
    const revision = store.saveData(
      input.id,
      validateData(input.data),
      input.revision,
    );
    res.json({ revision });
  });
  app.post("/api/feedback", (req, res) => {
    const input = z
      .object({
        id: z.string().max(100),
        note: z.string().max(1000).default(""),
      })
      .parse(req.body);
    store.version(input.id);
    store.event("thumbs_up", input.id, { note: input.note });
    res.json(snapshot());
  });
  app.post("/api/instructions/propose", async (req, res) => {
    if (instructionController || jobs.busy())
      throw new Conflict("A generation is already running.");
    const input = revisionSchema
      .extend({ request: z.string().trim().min(1).max(2000) })
      .parse(req.body);
    store.checkRevision(input.revision);
    const instructionId = store.state().instructionId;
    const controller = new AbortController();
    instructionController = controller;
    store.event("instruction_request", store.state().activeId, {
      request: input.request,
    });
    try {
      const output = await model.instructionProposal(
        input.request,
        controller.signal,
        () => {},
      );
      const proposal = z
        .object({ text: z.string().min(1).max(4000) })
        .parse(extractJson(output));
      store.event("instruction_proposal", store.state().activeId, {
        request: input.request,
        text: proposal.text,
      });
      res.json({ ...proposal, revision: input.revision, instructionId });
    } catch (error) {
      store.event(
        controller.signal.aborted
          ? "instruction_cancelled"
          : "instruction_failed",
        store.state().activeId,
        { message: (error as Error).message },
      );
      throw error;
    } finally {
      instructionController = null;
    }
  });
  app.post("/api/instructions/save", (req, res) => {
    const input = revisionSchema
      .extend({
        text: z.string().trim().min(1).max(4000),
        instructionId: z.string().max(100).optional(),
      })
      .parse(req.body);
    store.setInstruction(input.text, input.revision, input.instructionId);
    res.json(snapshot());
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Unknown API route." }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const message =
        error instanceof Error ? error.message : "Unexpected error";
      res
        .status(
          error instanceof Conflict
            ? 409
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? 400
              : 500,
        )
        .json({ error: message.slice(0, 1500) });
    },
  );
  return { app, cancelInstructions: () => instructionController?.abort() };
}
