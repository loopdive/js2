// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A constant eval Script whose tail is a call to a void-returning closure
// (`var g = function () {}; eval("g()")`) used to compile to nothing: the
// public `compileExpression` answers `null` for a void value, the static splice
// (`compileInlinedEvalStatements`, eval-inline.ts) read that `null` as
// "unreachable" and returned it, and the eval call's own `compileExpression`
// then rolled the whole splice back as "no usable value". g never ran and no
// exception was thrown. Top-level `function g() {}` only escaped because
// `registerReassignedFunctionGlobals` routes those calls through an
// externref-returning live global.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const PROBES = {
  direct: 'eval("g()");',
  indirect: '(0, eval)("g()");',
} as const;

function probeSource(evalStatement: string): string {
  return [
    "/*---",
    "description: probe",
    "flags: [noStrict]",
    "---*/",
    'var log = "";',
    'var g = function () { log += "g"; };',
    evalStatement,
    'throw new Test262Error("log=" + log);',
  ].join("\n");
}

describe("#7106 eval splice keeps a void closure call", () => {
  const dir = mkdtempSync(join(tmpdir(), "js2wasm-7106-eval-void-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each(Object.entries(PROBES))("%s eval runs g on standalone (test262 runner)", async (kind, evalStatement) => {
    const file = join(dir, `${kind}.js`);
    writeFileSync(file, probeSource(evalStatement));
    const result = await runTest262File(file, "issue-7106-eval-void-call", 30_000, "standalone");
    // The probe always throws; the message carries what ran before the throw.
    expect(result.error ?? result.reason ?? "").toContain("log=g ");
  });

  it("returns undefined from the spliced void call and runs it once", async () => {
    const src = `
      var log = "";
      var g = function () { log += "g"; };
      var r = eval("g()");
      export function test(): number { return (log === "g" ? 1 : 0) + (r === undefined ? 2 : 0); }
    `;
    const compiled = await compile(src, { target: "standalone" });
    expect(compiled.success, compiled.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(compiled.binary, {});
    // 1: g ran exactly once; 2: the eval result is undefined.
    expect((instance.exports as { test: () => number }).test()).toBe(3);
  });
});
