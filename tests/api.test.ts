import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { Model } from "../server/model.ts";
import { Jobs } from "../server/jobs.ts";
import { Validator } from "../server/validator.ts";
import { request } from "node:http";

test("API requires host, same-origin session and CSRF; rejects stale data saves", async () => {
  const store = new Store(":memory:"),
    model = new Model(store),
    validator = new Validator(),
    jobs = new Jobs(store, model, validator);
  const origin = "http://127.0.0.1:4329";
  const { app } = createApp(store, model, jobs, origin);
  const server = app.listen(4329, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/api/bootstrap`, {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    const invalidHostStatus = await new Promise<number>((resolve) => {
      const req = request(
        `${origin}/api/bootstrap`,
        { headers: { Host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end();
    });
    assert.equal(invalidHostStatus, 403);
    const boot = await fetch(`${origin}/api/bootstrap`);
    const cookie = boot.headers.get("set-cookie")!.split(";")[0];
    const state = await boot.json();
    assert.equal(
      (
        await fetch(`${origin}/api/reset`, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ revision: 0 }),
        })
      ).status,
      403,
    );
    const headers = {
      Cookie: cookie,
      Origin: origin,
      "X-CSRF-Token": state.csrf,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(`${origin}/api/data`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            revision: 0,
            id: "original",
            data: { saved: true },
          }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/data`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            revision: 0,
            id: "original",
            data: { overwrite: true },
          }),
        })
      ).status,
      409,
    );
    assert.deepEqual(store.active().data, { saved: true });
  } finally {
    await jobs.close();
    await validator.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
