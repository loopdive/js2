// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1929 — CompileError gains a `file` field and stops truncating TS diagnostic
 * message chains.
 *
 * - Before: `CompileError` had no `file`, so a multi-file compile couldn't say
 *   *which* file an error came from. Now populated from `diag.file.fileName`.
 * - Before: the message was `diag.messageText.messageText` — only the head of a
 *   `DiagnosticMessageChain`, dropping TS's "…because…" elaboration. Now
 *   `ts.flattenDiagnosticMessageText(diag.messageText, "\n")`.
 */
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

describe("#1929 CompileError.file + flattened diagnostic chains", () => {
  it("attributes a multi-file error to the file it originated in (the imported file)", async () => {
    const files = {
      "main.ts": 'import { v } from "./other"; export function test(): number { return v; }',
      // The type error lives in the SECOND (imported) file, not the entry.
      "other.ts": 'export const v: number = "not a number";',
    };
    const r = await compileMulti(files, "main.ts");
    expect(r.success).toBe(false);
    const err = r.errors.find((e) => e.severity === "error");
    expect(err, "expected a type error").toBeTruthy();
    expect(err!.file).toBe("other.ts");
  });

  it("flattens a DiagnosticMessageChain to keep the 'because' elaboration", async () => {
    // A callback whose parameter type is incompatible produces a 3-level chain:
    // the head ('… not assignable to parameter of type Cb') plus the nested
    // 'Types of parameters … are incompatible' / 'Type X is not assignable to Y'
    // elaboration. The old `.messageText.messageText` kept only the head line.
    const src = `
type Cb = (n: number) => number;
function run(cb: Cb): number { return cb(1); }
export function test(): number { return run((s: string) => s.length); }`;
    const r = await compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(false);
    const err = r.errors.find((e) => e.severity === "error");
    expect(err, "expected a type error").toBeTruthy();
    // The flattened message must include the nested elaboration, not just the head.
    expect(err!.message).toMatch(/not assignable to parameter of type 'Cb'/);
    expect(err!.message).toMatch(/incompatible|not assignable to type 'string'/);
    expect(err!.message.split("\n").length).toBeGreaterThan(1);
  });

  it("single-file diagnostics still carry their file name (additive, non-breaking)", async () => {
    const r = await compile('export const v: number = "x"; export function test(): number { return v; }', {
      fileName: "solo.ts",
    });
    expect(r.success).toBe(false);
    const err = r.errors.find((e) => e.severity === "error");
    expect(err!.file).toBe("solo.ts");
  });
});
