import { resolve } from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { Store } from "./store.ts";
import { Model } from "./model.ts";
import { Validator } from "./validator.ts";
import { Jobs } from "./jobs.ts";
import { createApp } from "./app.ts";
import { launchStudio } from "./browser.ts";
import { createConnection } from "node:net";

const port = Number(process.env.PORT || 4317),
  origin = `http://127.0.0.1:${port}`;
// Check before opening the database: a second launch must never mark the
// first process's in-progress jobs as interrupted.
const occupied = await new Promise<boolean>((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(1000);
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => {
    socket.destroy();
    resolve(false);
  });
  socket.once("timeout", () => {
    socket.destroy();
    resolve(false);
  });
});
if (occupied) {
  const health = await fetch(`${origin}/api/health`, {
    signal: AbortSignal.timeout(2000),
  })
    .then((r) => r.json())
    .catch(() => null);
  if (health?.application !== "evolution-studio")
    throw new Error(`Port ${port} is in use by another process.`);
  if (process.argv.includes("--no-open"))
    throw new Error("The studio is already running.");
  console.log("Opening another protected window for the existing studio.");
  const existingBrowser = await launchStudio(origin);
  process.on("SIGINT", () => void existingBrowser.close());
  await new Promise<void>((resolve) =>
    existingBrowser.once("disconnected", () => resolve()),
  );
  process.exit(0);
}
const store = new Store(
  resolve(process.env.STUDIO_DATA_DIR || "data", "studio.sqlite"),
);
const model = new Model(store),
  validator = new Validator(),
  jobs = new Jobs(store, model, validator);
const { app, cancelInstructions } = createApp(store, model, jobs, origin);
const production = process.argv.includes("--production");
let vite: ViteDevServer | undefined;
if (production) {
  if (!existsSync("dist/index.html"))
    throw new Error("Build the app first: npm.cmd run build");
  app.use(express.static(resolve("dist")));
  app.get("/", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, "127.0.0.1", () =>
  console.log(
    `Evolution studio: ${origin}\nLocal data: ${resolve(process.env.STUDIO_DATA_DIR || "data")}\nUse the protected browser window for generated apps.`,
  ),
);
await new Promise<void>((done, reject) => {
  server.once("listening", done);
  server.once("error", reject);
});
let browser: Awaited<ReturnType<typeof launchStudio>> | undefined;
if (!process.argv.includes("--no-open")) {
  try {
    browser = await launchStudio(origin);
  } catch (error) {
    console.error(
      `Could not open the protected browser: ${(error as Error).message}\nRun: npx.cmd playwright install chromium`,
    );
  }
}
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  cancelInstructions();
  await jobs.close();
  await validator.close();
  await browser?.close();
  await vite?.close();
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
