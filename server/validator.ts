import { randomBytes } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { sandboxDocument } from "../shared/sandbox.ts";
import type { AppCode, Json } from "../shared/types.ts";
import { protectContext } from "./browser.ts";
import { validateData } from "./schema.ts";

export class Validator {
  private browser: Browser | null = null;
  async getBrowser() {
    return (this.browser ??= await chromium.launch({
      headless: true,
      args: ["--site-per-process"],
    }));
  }
  async run(
    code: AppCode,
    data: Json,
    mode: "migration" | "app",
    signal?: AbortSignal,
  ): Promise<Json> {
    if (signal?.aborted) throw new Error("Cancelled");
    const browser = await this.getBrowser();
    if (signal?.aborted) throw new Error("Cancelled");
    const context = await browser.newContext();
    await protectContext(context);
    const page = await context.newPage();
    const nonce = randomBytes(16).toString("hex"),
      token = randomBytes(24).toString("hex");
    let closeOnAbort: (() => void) | undefined;
    try {
      const result = await new Promise<Json>(async (resolve, reject) => {
        let done = false;
        const finish = (error?: Error, result: Json = data) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          clearTimeout(smoke);
          error ? reject(error) : resolve(result);
        };
        let smoke: ReturnType<typeof setTimeout> | undefined;
        let timeout = setTimeout(() => {
          finish(new Error("Browser setup did not finish within 30 seconds."));
          void context.close().catch(() => {});
        }, 30000);
        closeOnAbort = () => {
          finish(new Error("Cancelled"));
          void context.close().catch(() => {});
        };
        signal?.addEventListener("abort", closeOnAbort, { once: true });
        try {
          await page.exposeFunction(
            "report",
            (message: { type: string; message?: string; data?: unknown }) => {
              if (
                message.type === "error" ||
                message.type === "migration:error"
              )
                finish(new Error(message.message || "Sandbox error"));
              if (message.type === "migration:result") {
                try {
                  finish(undefined, validateData(message.data));
                } catch (error) {
                  finish(error as Error);
                }
              }
              if (mode === "app" && message.type === "heartbeat")
                smoke ??= setTimeout(() => finish(), 700);
            },
          );
          await page.setContent("<!doctype html><html><body></body></html>");
          await page.evaluate(
            ({ document, token, dataJson }) => {
              let data = JSON.parse(dataJson);
              const frame = window.document.createElement("iframe");
              frame.setAttribute("sandbox", "allow-scripts");
              frame.srcdoc = document;
              frame.addEventListener("load", () => {
                const channel = new MessageChannel();
                channel.port1.onmessage = (event) => {
                  const msg = event.data;
                  if (msg?.token !== token) return;
                  if (msg.type === "read" || msg.type === "save") {
                    if (msg.type === "save") data = msg.data;
                    channel.port1.postMessage({
                      token,
                      id: msg.id,
                      data: msg.type === "read" ? data : true,
                    });
                  }
                  (
                    window as unknown as { report: (value: unknown) => void }
                  ).report(msg);
                };
                frame.contentWindow!.postMessage(
                  { type: "studio:init", token },
                  "*",
                  [channel.port2],
                );
              });
              window.document.body.append(frame);
            },
            {
              document: sandboxDocument(code, nonce, token, mode),
              token,
              dataJson: JSON.stringify(data),
            },
          );
          // Browser setup can be slow under disk/memory pressure. Start the
          // execution watchdog only after the frame has actually been attached.
          if (!done) {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
              finish(new Error("Sandbox did not respond within 8 seconds."));
              void context.close().catch(() => {});
            }, 8000);
          }
        } catch (error) {
          finish(error as Error);
        }
      });
      return result;
    } finally {
      if (closeOnAbort) signal?.removeEventListener("abort", closeOnAbort);
      await context.close().catch(() => {});
    }
  }
  async validate(code: AppCode, data: Json, signal?: AbortSignal) {
    const transformed = await this.run(code, data, "migration", signal);
    await this.run(code, transformed, "app", signal);
    return transformed;
  }
  async close() {
    await this.browser?.close();
    this.browser = null;
  }
}
