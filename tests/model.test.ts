import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.ts";
import { Model } from "../server/model.ts";
import { ORIGINAL } from "../shared/types.ts";

function response(
  message: unknown,
  counts: { tokens?: number; loadMs?: number } = {},
) {
  return new Response(
    JSON.stringify({
      message,
      done: true,
      eval_count: counts.tokens ?? 100,
      eval_duration: 50e9,
      load_duration: (counts.loadMs ?? 10) * 1e6,
      prompt_eval_count: 200,
    }) + "\n",
  );
}
test("An empty history goes directly to a schema-constrained app response", async () => {
  const store = new Store(":memory:"),
    model = new Model(store),
    originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(init!.body as string);
      assert.equal(body.tools, undefined);
      assert.deepEqual(body.format.required, [
        "title",
        "description",
        "html",
        "css",
        "js",
        "migrate",
      ]);
      return response({ role: "assistant", content: JSON.stringify(ORIGINAL) });
    };
    const output = await model.generate(
      "Make an app",
      ORIGINAL,
      {},
      1,
      1,
      [],
      new AbortController().signal,
      () => {},
    );
    assert.deepEqual(JSON.parse(output), ORIGINAL);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});
test("History tools get one bounded round, then a required structured result; loading metrics include all requests", async () => {
  const store = new Store(":memory:"),
    model = new Model(store),
    originalFetch = globalThis.fetch;
  store.event("thumbs_up", "original", { note: "Calm colours" });
  store.event("prompt", "original", { prompt: "Build" });
  let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(init!.body as string);
      if (calls === 1) {
        assert.equal(body.tools[0].function.name, "search_history");
        return response(
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "search_history",
                  arguments: { query: "Calm" },
                },
              },
            ],
          },
          { tokens: 20, loadMs: 180 },
        );
      }
      assert.equal(body.tools, undefined);
      assert.ok(body.format.properties.js);
      assert.ok(
        body.messages.some(
          (message: { role: string; content: string }) =>
            message.role === "tool" && message.content.includes("Calm colours"),
        ),
      );
      return response({ role: "assistant", content: JSON.stringify(ORIGINAL) });
    };
    await model.generate(
      "Make an app",
      ORIGINAL,
      {},
      1,
      1,
      [],
      new AbortController().signal,
      () => {},
    );
    assert.equal(calls, 2);
    assert.equal(model.lastMetrics!.loadMs, 190);
    assert.equal(model.lastMetrics!.tokens, 120);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});
test("A model that keeps requesting tools is stopped after two requests", async () => {
  const store = new Store(":memory:"),
    model = new Model(store),
    originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return response({
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "search_history", arguments: { query: "" } } },
        ],
      });
    };
    await assert.rejects(
      model.chat(
        [{ role: "user", content: "Build" }],
        new AbortController().signal,
        () => {},
      ),
      /budget exceeded/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
  }
});
