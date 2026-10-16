import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { chromium } from "playwright";
import { Store } from "../server/store.ts";
import { Jobs } from "../server/jobs.ts";
import { Model } from "../server/model.ts";
import { Validator } from "../server/validator.ts";
import { createApp } from "../server/app.ts";
import { protectContext } from "../server/browser.ts";
import { ORIGINAL, type AppCode } from "../shared/types.ts";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

class FixtureModel extends Model {
  instructionDelayMs = 0;
  calls: { data: unknown; variant: number }[] = [];
  override async diagnostics() {
    return {
      online: true,
      installed: true,
      model: "fixture",
      context: 8192,
      models: [],
      running: {},
      message: "Test model",
    };
  }
  override async generate(...args: Parameters<Model["generate"]>) {
    const [prompt, , data, variant, , , signal, progress] = args;
    this.calls.push({ data: structuredClone(data), variant });
    if (prompt.includes("cancel"))
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Cancelled")), {
          once: true,
        }),
      );
    progress({ tokens: 90, tokensPerSecond: 30, elapsedMs: 10 });
    if (prompt.includes("broken"))
      return JSON.stringify({
        ...ORIGINAL,
        js: 'throw new Error("fixture failure")',
      });
    if (prompt.includes("repair") && !args[8]) return '{"title":';
    const game = prompt.toLowerCase().includes("game");
    const code: AppCode = {
      title: `${game ? "Tiny game" : "My calendar"} ${variant}`,
      description: game
        ? "A small game with a saved score."
        : "A calendar with a saved event counter.",
      html: `<main><h1>${game ? "Tiny game" : "My calendar"}</h1><p id="value"></p><button id="add">${game ? "Play" : "Add event"}</button></main>`,
      css: "body{background:#edf2e5;font-family:system-ui;text-align:center;padding:40px;color:#465d33}h1{font-family:Georgia;font-weight:400;font-size:40px}button{padding:12px 24px;background:#526b40;color:white;border:0;border-radius:8px}",
      js: `let data = await app.readData(); const paint = () => document.querySelector('#value').textContent = String(data.${game ? "score" : "count"}); paint(); document.querySelector('#add').onclick = async () => { data.${game ? "score" : "count"}++; await app.saveData(data); paint(); };`,
      migrate: game
        ? "return { score: 0, previous: data };"
        : "return { ...data, count: data.count ?? 0 };",
    };
    return JSON.stringify(code);
  }
  override async instructionProposal(request: string) {
    if (this.instructionDelayMs)
      await new Promise((resolve) =>
        setTimeout(resolve, this.instructionDelayMs),
      );
    return JSON.stringify({ text: `Keep useful apps. ${request}` });
  }
}

test(
  "Full studio: generate 3, isolated previews, apply, persistent data, feedback, instructions, Undo, Reset and cancellation",
  { timeout: 180000 },
  async () => {
    const store = new Store(":memory:"),
      model = new FixtureModel(store),
      validator = new Validator(),
      jobs = new Jobs(store, model, validator);
    const origin = "http://127.0.0.1:4330";
    const { app } = createApp(store, model, jobs, origin);
    app.use(express.static(resolve("dist")));
    const server = app.listen(4330, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const browser = await chromium.launch({
      headless: true,
      args: ["--site-per-process"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await protectContext(context, origin);
    await context.addInitScript(() =>
      Object.defineProperty(window, "__studioProtected", { value: true }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    mkdirSync("test-results", { recursive: true });
    try {
      await page.goto(origin);
      await page.getByRole("heading", { name: "A place to begin" }).waitFor();
      await page.screenshot({
        path: "test-results/studio-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: "test-results/studio-mobile.png",
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page
        .getByLabel("What would you like to change?")
        .fill("Make a calendar");
      await page.getByRole("switch").click();
      await page.getByRole("button", { name: /^Explore 3 directions/ }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".proposal-card").length === 3 &&
          !document.querySelector(".job-card"),
        undefined,
        { timeout: 90000 },
      );
      assert.equal(model.calls.length, 3);
      assert.deepEqual(
        model.calls.map((c) => c.data),
        [{}, {}, {}],
      );
      // Editing a preview never changes its saved snapshot or the active original.
      await page
        .frameLocator(".proposal-card iframe")
        .first()
        .getByRole("button", { name: "Add event" })
        .click();
      await page
        .frameLocator(".proposal-card iframe")
        .first()
        .locator("#value")
        .filter({ hasText: "1" })
        .waitFor();
      assert.deepEqual(store.active().data, {});
      assert.deepEqual(
        store.versions().find((v) => v.code.title === "My calendar 1")!.data,
        { count: 0 },
      );
      await page
        .locator(".proposal-card")
        .first()
        .getByRole("button", { name: "Apply", exact: true })
        .click();
      await page
        .frameLocator(".canvas iframe")
        .getByRole("button", { name: "Add event" })
        .click();
      await page
        .frameLocator(".canvas iframe")
        .locator("#value")
        .filter({ hasText: "1" })
        .waitFor();
      assert.deepEqual(store.active().data, { count: 1 });
      await page.reload();
      await page
        .frameLocator(".canvas iframe")
        .locator("#value")
        .filter({ hasText: "1" })
        .waitFor();
      await page.getByRole("button", { name: "Like this version" }).click();
      await page.getByLabel("Optional feedback note").fill("The calm colours");
      await page
        .getByRole("button", { name: "Save like", exact: true })
        .click();
      await page
        .getByRole("button", { name: "AI instructions", exact: true })
        .click();
      await page
        .getByLabel("How should your AI work?")
        .fill("Be more adventurous");
      model.instructionDelayMs = 2500;
      await page.getByRole("button", { name: /^Propose instructions/ }).click();
      // The active app can save immediately while the model is still thinking.
      await page
        .frameLocator(".canvas iframe")
        .getByRole("button", { name: "Add event" })
        .click();
      await page
        .frameLocator(".canvas iframe")
        .locator("#value")
        .filter({ hasText: "2" })
        .waitFor({ timeout: 1500 });
      assert.deepEqual(store.active().data, { count: 2 });
      await page
        .getByRole("dialog", { name: "Review your AI instructions" })
        .waitFor();
      assert.ok(!store.currentInstruction().text.includes("adventurous"));
      await page
        .getByRole("button", { name: "Save instructions", exact: true })
        .click();
      await page.waitForFunction(() => !document.querySelector(".small-modal"));
      assert.ok(store.currentInstruction().text.includes("adventurous"));
      await page
        .getByRole("button", { name: "Change app", exact: true })
        .click();
      await page
        .getByLabel("What would you like to change?")
        .fill("Make a game");
      if (
        (await page.getByRole("switch").getAttribute("aria-checked")) === "true"
      )
        await page.getByRole("switch").click();
      await page.getByRole("button", { name: /^Create a proposal/ }).click();
      await page
        .locator(".proposal-card")
        .getByRole("button", { name: "Apply", exact: true })
        .waitFor();
      await page
        .locator(".proposal-card")
        .getByRole("button", { name: "Apply", exact: true })
        .click();
      await page
        .frameLocator(".canvas iframe")
        .getByRole("button", { name: "Play" })
        .waitFor();
      assert.deepEqual(store.active().data, {
        score: 0,
        previous: { count: 2 },
      });
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await page
        .frameLocator(".canvas iframe")
        .locator("#value")
        .filter({ hasText: "2" })
        .waitFor();
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await page
        .getByRole("button", { name: "Reset to original", exact: true })
        .click();
      await page.getByRole("heading", { name: "A place to begin" }).waitFor();
      assert.ok(store.currentInstruction().text.includes("adventurous"));
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await page
        .frameLocator(".canvas iframe")
        .locator("#value")
        .filter({ hasText: "2" })
        .waitFor();
      await page
        .getByLabel("What would you like to change?")
        .fill("cancel this request");
      await page.getByRole("button", { name: /^Create a proposal/ }).click();
      await page
        .getByRole("button", { name: "Cancel generation", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector(".job-card strong")
          ?.textContent?.includes("Cancelled"),
      );
      assert.deepEqual(store.active().data, { count: 2 });
      assert.ok(
        store
          .events()
          .some(
            (e) =>
              e.type === "thumbs_up" && e.payload.note === "The calm colours",
          ),
      );
      assert.equal(errors.length, 0, errors.join("\n"));
      // A stale script in a second window must not overwrite newer data after
      // the trusted shell has refreshed its own revision.
      store.saveData(store.active().id, { count: 99 }, store.state().revision);
      await page.waitForResponse((response) =>
        response.url().endsWith("/api/state"),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await page
        .frameLocator(".canvas iframe")
        .getByRole("button", { name: "Add event" })
        .click();
      await page
        .locator(".canvas .preview-error")
        .filter({ hasText: "App data changed in another window" })
        .waitFor();
      assert.deepEqual(store.active().data, { count: 99 });
      await page
        .locator(".canvas .preview-tools")
        .getByRole("button", { name: /Reload/ })
        .click();
      await page
        .frameLocator(".canvas iframe")
        .locator("#value")
        .filter({ hasText: "99" })
        .waitFor();
      await page.screenshot({
        path: "test-results/studio-calendar.png",
        fullPage: true,
      });
    } catch (error) {
      console.log("Job at failure:", jobs.current());
      console.log("Recent events:", store.events("", 6));
      await page.screenshot({
        path: "test-results/studio-failure.png",
        fullPage: true,
      });
      throw error;
    } finally {
      await jobs.close();
      await validator.close();
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  },
);
