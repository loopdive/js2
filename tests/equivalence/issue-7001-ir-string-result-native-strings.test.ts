// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7001 — a `string`-declared result fed by a dynamic/externref value was
// patched into the slot unchecked: from-ast `coerceReturnValue` and verify
// `returnTypeAssignable` both assumed string ≡ externref, which only holds on
// the JS-host lane. On every native-string lane (standalone, wasi,
// `utf8Storage`) the IR body returned externref into `(ref null $AnyString)`
// and the module FAILED Wasm validation, although the same program compiles
// with `experimentalIR: false`.
//
// Each program exports a numeric `main` that checks the string result inside
// Wasm, so the same assertion runs on every lane (native strings cannot cross
// the JS boundary as JS strings). `main` is also evaluated as JS and the two
// answers must agree.
import { describe, expect, it } from "vitest";
import { irOutcomesAfterEngineRejection } from "../../src/compiler/validation.js";
import { compile, type CompileError, type CompileOptions } from "../../src/index.js";
import type { IrObservedOutcome } from "../../src/ir/outcomes.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

type Lane = { name: string; options: CompileOptions };
const LANES: Lane[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "utf8Storage", options: { target: "standalone", utf8Storage: true } },
  { name: "gc (default)", options: {} },
];

/** Stub every non-host import (WASI) so the module instantiates; `main` never calls them. */
function stubImports(binary: Uint8Array): WebAssembly.Imports {
  const imports: Record<string, Record<string, unknown>> = {};
  for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(binary))) {
    if (imp.kind !== "function") continue;
    (imports[imp.module] ??= {})[imp.name] = () => 0;
  }
  return imports as WebAssembly.Imports;
}

async function runMain(source: string, lane: Lane): Promise<unknown> {
  const result = await compile(source, { fileName: "issue-7001.ts", ...lane.options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const instance =
    lane.name === "gc (default)"
      ? await instantiateWithRuntime(result)
      : (await WebAssembly.instantiate(result.binary, stubImports(result.binary))).instance;
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports.main!();
}

const PROGRAMS: Record<string, string> = {
  "dynamic call result returned as string (`return addOne(s)`)": `
function addOne(x) { return x + 1; }
export function a1(n: number): number { return addOne(n); }
export function a2(s: string): string { return addOne(s); }
export function main(): number { return a2("x") === "x1" && a1(1) === 2 ? 1 : 0; }`,
  "widened local reassigned then returned": `
export function c(n: number): string { let d = n > 0 ? "p" : 0; d = "q"; return d; }
export function main(): number { return c(1) === "q" && c(-1) === "q" ? 1 : 0; }`,
  "typeof helper result returned as string": `
function tof(x) { return typeof x; }
export function c2(n: number): string { return tof(n < 2); }
export function main(): number { return c2(1) === "boolean" ? 1 : 0; }`,
  "untyped `x + x` helper result returned as string": `
function plusplus(x) { return x + x; }
export function d(s: string): string { return plusplus(s); }
export function main(): number { return d("ab") === "abab" ? 1 : 0; }`,
  // The #3551 parity-withdrawal cascade case: `tof2` is withdrawn for ABI
  // parity, and the caller's call into it is inlined/folded away, so the
  // caller holds no reference to it. The caller's body must still be valid.
  "caller of a parity-withdrawn callee whose call was inlined": `
function tof2(x) { return typeof x; }
export function c3(): string { return tof2(1); }
export function c4(): boolean { return tof2(1) === "number"; }
export function main(): number { return c3() === "number" && c4() ? 1 : 0; }`,
};

describe("#7001 IR string result fed by dynamic/externref", () => {
  for (const [label, source] of Object.entries(PROGRAMS)) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const expected = evaluateAsJs(source).main!();
        expect(expected).toBe(1);
        expect(await runMain(source, lane)).toBe(expected);
      }, 120_000);
    }
  }
});

describe("#7001 step 4 — engine-rejected IR body is not recorded as emitted", () => {
  const row = (displayName: string): IrObservedOutcome => ({
    key: `t.ts::function::${displayName}#0`,
    file: "t.ts",
    unitKind: "function",
    displayName,
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: "standalone",
    legacyBodyEmitted: false,
    irBodyEmitted: true,
    kind: "emitted",
    stage: "patch",
  });
  const invalid: CompileError = {
    message:
      'emitted WebAssembly failed validation — WebAssembly.Module(): Compiling function #52:"a2" failed: type error in return[0]',
    line: 1,
    column: 1,
    severity: "error",
    code: "invalid-module",
  };

  it("re-keys only the rejected function's emitted row to an invariant", () => {
    const out = irOutcomesAfterEngineRejection([row("a1"), row("a2")], [invalid])!;
    expect(out[0]!.kind).toBe("emitted");
    expect(out[1]!.kind).toBe("invariant");
    expect(out[1]!.stage).toBe("backend-legality");
    expect((out[1] as { code: string }).code).toBe("backend-legality-failure");
  });

  it("leaves rows untouched without an engine rejection", () => {
    const rows = [row("a2")];
    expect(irOutcomesAfterEngineRejection(rows, [])).toBe(rows);
  });
});
