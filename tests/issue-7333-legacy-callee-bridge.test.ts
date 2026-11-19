// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7333 — an IR caller calls a selection-refused callee through the callee's
// legacy body when the callee's legacy ABI is certified to equal its IR
// projection (`legacyCallerAbiIsProjected`, the certificate the caller
// direction already uses). Before, the refusal cascaded: the caller failed
// `call-graph-closure` because the callee was not claimed.
//
// Each runtime case runs through the test262 runner (standalone and gc) and
// asserts the verdict, the caller's IR route and zero post-claim errors.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const dir = mkdtempSync(join(tmpdir(), "issue-7333-"));

function fixture(name: string, body: string): string {
  const path = join(dir, `${name.replace(/\W+/g, "-")}.js`);
  writeFileSync(path, `/*---\ndescription: issue 7333 ${name}\n---*/\n${body}\n`);
  return path;
}

async function standaloneOutcome(path: string, unit: string) {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const result = await compile(assembleOriginalHarness(source, meta).primary.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result.irOutcomes?.find((o) => o.displayName === unit);
}

/** `<module-init>` calls a refused declaration; the callee's value or throw reaches the caller. */
const RUNTIME: Record<string, string> = {
  "a refused callee's result": `function f(a) { delete arguments[0]; return a; }
assert.sameValue(f(4), 4);`,
  "a throw from a refused callee is catchable": `function f({ w: { x } = undefined }) {}
assert.throws(TypeError, function () { f(); });`,
  "a refused callee called from a lifted closure": `var r;
function f(a) { delete arguments[0]; return a; }
var g; assert.throws(TypeError, function () { r = f(5); g(); });
assert.sameValue(r, 5);`,
};

describe("#7333 a refused callee is called through its legacy body", () => {
  for (const [name, body] of Object.entries(RUNTIME)) {
    const path = fixture(name, body);
    it(`${name}: <module-init> keeps the IR route (standalone)`, async () => {
      const callee = await standaloneOutcome(path, "f");
      expect(callee?.irBodyEmitted).toBe(false);
      expect((await standaloneOutcome(path, "<module-init>"))?.irBodyEmitted).toBe(true);
    });
    for (const target of ["standalone", undefined] as const) {
      it(`${name}: passes (${target ?? "gc"})`, async () => {
        const result = await runTest262File(path, "issue-7333", 10000, target);
        expect(result.status, String(result.error ?? "")).toBe("pass");
      });
    }
  }
});

// The issue's two shapes on every lane: `t` is refused (or, where its own
// closure's callee is certified, claimed), and `<module-init>` is IR.
const SHAPES: Record<string, string> = {
  "an unclaimed declaration": `function f(o: any): number { const { w: { x } = {} as any } = o; return 1; }
function t(x: number): number { const c = (y: number): number => f(y); return c(x); }
export function run(): number { return t(1); }
t(1);`,
  "an ambient call": `function t(x: number): number { const c = (y: number): number => { RegExp("a"); return y; }; return c(x); }
export function run(): number { return t(2); }
t(2);`,
};

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc", options: {} },
];

describe("#7333 the caller of a refused unit stays IR", () => {
  for (const [name, source] of Object.entries(SHAPES)) {
    for (const lane of LANES) {
      it(`${name}: <module-init> is IR (${lane.name})`, async () => {
        const result = await compile(source, { fileName: "issue-7333.ts", trackIrOutcomes: true, ...lane.options });
        expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect(result.irOutcomes?.find((o) => o.displayName === "<module-init>")?.irBodyEmitted).toBe(true);
        expect(result.irOutcomes?.find((o) => o.displayName === "f")?.irBodyEmitted ?? false).toBe(false);
      });
    }
  }
});
