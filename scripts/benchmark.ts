import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { freemem, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { Store } from "../server/store.ts";
import { Model, MODEL, CONTEXT, type Metrics } from "../server/model.ts";
import { Validator } from "../server/validator.ts";
import { extractJson, validateCode } from "../server/schema.ts";
import { ORIGINAL } from "../shared/types.ts";

const directory = resolve("data/benchmarks");
mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const store = new Store(":memory:"),
  model = new Model(store),
  validator = new Validator();
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
let peakUsedRam = totalmem() - freemem();
const memoryTimer = setInterval(() => {
  peakUsedRam = Math.max(peakUsedRam, totalmem() - freemem());
}, 2000);
function gpu() {
  try {
    return execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "Unavailable";
  }
}
const result: Record<string, unknown> = {
  adapter: "bounded-history-and-schema-output",
  startedAt: new Date().toISOString(),
  model: MODEL,
  context: CONTEXT,
  totalRamBytes: totalmem(),
  initialFreeRamBytes: freemem(),
  initialGpu: gpu(),
  proposals: [],
};
const proposals: Record<string, unknown>[] = [];
const prompt =
  "Build a tiny click-counter app with one button and a saved count. Use under 1200 source characters total. Avoid extra features. This is a hardware benchmark.";
try {
  const diagnostics = await model.diagnostics();
  if (!diagnostics.online || !diagnostics.installed)
    throw new Error(diagnostics.message + " Model is not installed yet.");
  for (const count of process.argv.includes("--single")
    ? [1]
    : process.argv.includes("--three")
      ? [3]
      : [1, 3]) {
    const roundStart = Date.now();
    for (let variant = 1; variant <= count; variant++) {
      let lastLog = 0,
        metrics: Metrics | null = null;
      const start = Date.now();
      console.log(
        `Generating ${count === 1 ? "single proposal" : `proposal ${variant} of 3`}…`,
      );
      let raw = "";
      try {
        raw = await model.generate(
          prompt,
          ORIGINAL,
          {},
          variant,
          count,
          [],
          controller.signal,
          (current) => {
            metrics = current;
            if (Date.now() - lastLog > 10000) {
              lastLog = Date.now();
              console.log(
                `  ${Math.round((Date.now() - start) / 1000)}s · ${current.tokens} output chunks${current.tokensPerSecond ? ` · ${current.tokensPerSecond.toFixed(2)} tokens/s` : ""}`,
              );
            }
          },
        );
        const code = validateCode(extractJson(raw));
        const data = await validator.validate(code, {}, controller.signal);
        writeFileSync(
          resolve(directory, `${stamp}-${count}-${variant}.json`),
          JSON.stringify({ code, data }, null, 2),
        );
        proposals.push({
          count,
          variant,
          elapsedMs: Date.now() - start,
          metrics,
          valid: true,
        });
      } catch (error) {
        proposals.push({
          count,
          variant,
          elapsedMs: Date.now() - start,
          metrics,
          valid: false,
          error: (error as Error).message,
        });
        if (raw)
          writeFileSync(
            resolve(directory, `${stamp}-${count}-${variant}-failed.txt`),
            raw,
          );
        if (controller.signal.aborted) throw error;
      }
      console.log(JSON.stringify(proposals[proposals.length - 1]));
    }
    result[`${count}ProposalRoundMs`] = Date.now() - roundStart;
  }
} catch (error) {
  result.error = (error as Error).message;
  process.exitCode = 1;
} finally {
  clearInterval(memoryTimer);
  result.proposals = proposals;
  result.allValid =
    proposals.length > 0 && proposals.every((proposal) => proposal.valid);
  if (!result.allValid) process.exitCode = 1;
  result.peakSystemUsedRamBytes = peakUsedRam;
  result.finalFreeRamBytes = freemem();
  result.finalGpu = gpu();
  result.finishedAt = new Date().toISOString();
  result.ollama = await model.diagnostics();
  const path = resolve(directory, `${stamp}-report.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`Benchmark report: ${path}`);
  await validator.close();
  store.close();
}
