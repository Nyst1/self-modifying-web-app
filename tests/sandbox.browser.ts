import test from "node:test";
import assert from "node:assert/strict";
import { Validator } from "../server/validator.ts";
import { ORIGINAL } from "../shared/types.ts";
import { chromium } from "playwright";
import { protectContext } from "../server/browser.ts";
import { sandboxDocument } from "../shared/sandbox.ts";
import { createServer } from "node:http";

test("Calendar and game data transformations run in browser workers and preserve the base", async () => {
  const validator = new Validator();
  try {
    const base = { events: [{ title: "Meeting" }] };
    const calendar = {
      ...ORIGINAL,
      title: "Calendar",
      html: '<h1 id="title"></h1>',
      js: 'const data = await app.readData(); document.querySelector("#title").textContent = data.events[0].title;',
      migrate: "return { ...data, schema: 2 };",
    };
    const game = {
      ...ORIGINAL,
      title: "Game",
      html: '<button id="play">Play</button>',
      js: 'document.querySelector("#play").onclick = async () => { const data = await app.readData(); await app.saveData({ ...data, score: data.score + 1 }); };',
      migrate: "return { score: 0, previous: data };",
    };
    assert.deepEqual(await validator.validate(calendar, base), {
      ...base,
      schema: 2,
    });
    assert.deepEqual(await validator.validate(game, base), {
      score: 0,
      previous: base,
    });
    assert.deepEqual(base, { events: [{ title: "Meeting" }] });
  } finally {
    await validator.close();
  }
});
test("Malformed data, runtime exceptions and nonterminating transformations fail without Node execution", async () => {
  const validator = new Validator();
  try {
    await assert.rejects(
      validator.validate({ ...ORIGINAL, migrate: "return undefined;" }, {}),
    );
    await assert.rejects(
      validator.validate({ ...ORIGINAL, migrate: "while(true) {}" }, {}),
      /2 seconds|8 seconds/,
    );
    await assert.rejects(
      validator.validate(
        { ...ORIGINAL, js: 'throw new Error("broken app");' },
        {},
      ),
      /broken app/,
    );
    await assert.rejects(
      validator.validate({ ...ORIGINAL, migrate: "return process.env;" }, {}),
      /process/,
    );
    await assert.rejects(
      validator.validate({ ...ORIGINAL, js: "while(true) {}" }, {}),
      /8 seconds/,
    );
  } finally {
    await validator.close();
  }
});
test("Generated code cannot reach the parent DOM or fetch local or external services", async () => {
  const validator = new Validator();
  try {
    const attack = {
      ...ORIGINAL,
      js: `
      let blocked = 0;
      try { parent.document.body.innerHTML = 'escaped'; } catch { blocked++; }
      try { await fetch('http://127.0.0.1:11434/api/tags'); } catch { blocked++; }
      try { await fetch('https://example.com'); } catch { blocked++; }
      try { localStorage.setItem('escape', 'yes'); } catch { blocked++; }
      if (blocked !== 4) throw new Error('Isolation failed: ' + blocked);
    `,
    };
    assert.deepEqual(await validator.validate(attack, {}), {});
  } finally {
    await validator.close();
  }
});
test("Cancellation terminates browser validation promptly", async () => {
  const validator = new Validator(),
    controller = new AbortController();
  try {
    const result = validator.validate(
      { ...ORIGINAL, js: "while(true) {}" },
      {},
      controller.signal,
    );
    setTimeout(() => controller.abort(), 1500);
    await assert.rejects(result, /Cancelled/);
  } finally {
    await validator.close();
  }
});

test(
  "The shell stays responsive during an infinite app loop; frame navigation never reaches a local service",
  { timeout: 20000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--site-per-process"],
    });
    const context = await browser.newContext();
    await protectContext(context);
    const page = await context.newPage();
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end("Unexpected access");
    }).listen(4341, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      await page.setContent("<body><h1>Fixed shell</h1></body>");
      const append = async (js: string) =>
        page.evaluate(
          ({ html }) => {
            const frame = document.createElement("iframe");
            frame.setAttribute("sandbox", "allow-scripts");
            frame.srcdoc = html;
            frame.onload = () => {
              const channel = new MessageChannel();
              frame.contentWindow!.postMessage(
                { type: "studio:init", token: "test-token" },
                "*",
                [channel.port2],
              );
            };
            document.body.append(frame);
          },
          {
            html: sandboxDocument(
              { ...ORIGINAL, js },
              "testnonce",
              "test-token",
            ),
          },
        );
      await append('window.location.href = "http://127.0.0.1:4341/leak";');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(requests, 0);
      await page.evaluate(() =>
        document.querySelectorAll("iframe").forEach((frame) => frame.remove()),
      );
      await append("while(true) {}");
      await new Promise((resolve) => setTimeout(resolve, 300));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        page.evaluate(() => {
          document
            .querySelectorAll("iframe")
            .forEach((frame) => frame.remove());
          return document.querySelector("h1")?.textContent;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Generated loop froze the fixed shell")),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      assert.equal(result, "Fixed shell");
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
