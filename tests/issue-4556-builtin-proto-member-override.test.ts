// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4556 bucket A) A user override of a builtin prototype member must win over
// the builtin lowering:
//
//   Array.prototype.toString = Object.prototype.toString;
//   Array().toString();   // "[object Array]", not ""
//
// The WRITE always landed — after the assignment
// `Array.prototype.hasOwnProperty("toString")` is true and the descriptor's
// value is a function. What was missing was the CONSULT: every reader answered
// from the builtin member ladder first, so the entry was written and never
// seen. `proto-index-store.ts` recorded that as a deliberate boundary.
//
// The consult order was wrong on BOTH paths, which is why a routing change
// alone could not fix it: the static `arr.toString()` never reaches the dynamic
// reader (`compileArrayMethodCall` claims it), and forcing the same call down
// the dynamic path still answered `""` because `__extern_method_call`'s builtin
// arms answer before the store. Hence a two-arm branch at the CALL SITE.
//
// The negative cases matter as much as the positive ones: a module that does
// not override must keep the builtin lowering exactly, and the branch is gated
// on a pre-scan flag so it is never even built there.
//
// KNOWN BOUNDARY, deliberately not asserted here because it is still wrong: an
// `any`-TYPED receiver (`(x as any).toString()`) bypasses the array method path
// entirely and reaches `__extern_method_call`, whose builtin arms still answer
// before the store. Measured: the dynamic reader is INCONSISTENT about this —
// it honours the override for a member with no builtin arm (`join` on an `any`
// receiver picks up the override today) and ignores it for one that has an arm
// (`toString` does not). Fixing that is the consult-order inversion inside the
// dynamic reader, a strictly larger change than this call-site branch.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// STANDALONE ONLY. The two-arm is gated on `ctx.standalone` — in host mode the
// override already works through the JS engine's own prototype chain, and the
// gc lane's `[1,2,3].toString()` does not round-trip through this harness's
// in-wasm string comparison at all (it fails identically on the merge base), so
// asserting it here would pin the harness, not the compiler.
type Lane = "standalone";
const LANES: Lane[] = ["standalone"];

async function run(src: string, target: Lane): Promise<unknown> {
  const r = await compile(src, target === "standalone" ? { target: "standalone" as const } : {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const imports = target === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

describe.each(LANES)("#4556 — Array.prototype member override (%s)", (lane) => {
  // The test262 spelling (`built-ins/Array/S15.4.1_A1.1_T2` and its two twins),
  // which is what the override family actually uses.
  it("an overridden toString is used by an instance call", async () => {
    expect(
      await run(
        `(Array.prototype as any).toString = (Object.prototype as any).toString;
         export function test(): number {
           const x: any[] = [];
           return x.toString() === "[object Array]" ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("an overridden join is used, and receives the arguments", async () => {
    expect(
      await run(
        `(Array.prototype as any).join = function (this: any, sep: any): any { return "J" + sep; };
         export function test(): number {
           const x: any[] = [1, 2];
           return x.join("-") === "J-" ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("the builtin is unchanged for a member the module does NOT override", async () => {
    expect(
      await run(
        `(Array.prototype as any).toString = (Object.prototype as any).toString;
         export function test(): number {
           const x: any[] = [1, 2, 3];
           return x.join(",") === "1,2,3" ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });

  it("a module with no proto write keeps the builtin lowering", async () => {
    expect(
      await run(
        `export function test(): number {
           const x: any[] = [1, 2, 3];
           return x.toString() === "1,2,3" ? 1 : 0;
         }`,
        lane,
      ),
    ).toBe(1);
  });
});
