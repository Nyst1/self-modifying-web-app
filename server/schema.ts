import { z } from "zod";
import { parse } from "acorn";
import type { AppCode, Json } from "../shared/types.ts";
export const codeSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
    html: z.string().max(100_000),
    css: z.string().max(100_000),
    js: z.string().max(150_000),
    migrate: z.string().max(30_000),
  })
  .strict();
export function validateCode(input: unknown): AppCode {
  const code = codeSchema.parse(input);
  parse(`async function generatedApp() {\n${code.js}\n}`, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  parse(`function migrate(data) {\n${code.migrate}\n}`, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  return code;
}
export function validateData(data: unknown): Json {
  const value = z.json().parse(data);
  if (JSON.stringify(value).length > 2_000_000)
    throw new Error("App data exceeds the 2 MB limit.");
  return value as Json;
}
export function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{"),
      end = trimmed.lastIndexOf("}");
    if (start < 0 || end < start)
      throw new Error("The model did not return a JSON object.");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
