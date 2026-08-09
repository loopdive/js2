// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2688 — struct-element `.map` typed its result array from the FIRST-registered
// ref-element struct, not the callback's return struct.
//
// Root cause: `getOrRegisterArrayType`/`getOrRegisterVecType` cached ref-element
// arrays/vecs under the plain `"ref"` key (ignoring the struct typeIdx), so every
// distinct ref-struct array collapsed onto the first one registered. A
// shape-transforming `.map` (`Directive[].map(d => ({kind, justification}))` in
// eslint's apply-disable-directives.js) then stored a struct-B value into an
// array typed for struct-A → `array.set expected (ref null A), found call_ref of
// type (ref null B)` WebAssembly validation failure on the Linter.verify path.
//
// Fix: qualify the registry cache key with the struct typeIdx for ref/ref_null
// elements (the existing `ref_<typeIdx>` convention), and route struct-element
// `.map` receivers through `compileArrayMap` (gate widening) with typeIdx-aware
// result-element reconciliation.
import { describe, it, expect } from "vitest";
import { compile, compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, requireEslintFile, resolveEslintFile } from "./helpers/eslint.js";

const ESLINT_APPLY_DISABLE_DIRECTIVES = resolveEslintFile("lib/linter/apply-disable-directives.js");

async function run(src: string, fn = "test"): Promise<unknown> {
  const result = await compile(src);
  if (!result.success) {
    throw new Error("Compile failed: " + result.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  }
  expect(WebAssembly.validate(result.binary), "binary must validate").toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#2688 — struct-element .map result-array element type", () => {
  it("a .map over a struct array returning a DIFFERENT struct shape validates + works", async () => {
    expect(
      await run(`
        interface In { a: number; b: number; c: number; }
        interface Out { x: number; y: number; }
        export function test(): number {
          const ins: In[] = [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }];
          const outs: Out[] = ins.map((i: In) => ({ x: i.a + i.b, y: i.c }));
          return outs[0].x + outs[0].y + outs[1].x + outs[1].y; // 3+3 + 9+6 = 21
        }
      `),
    ).toBe(21);
  });

  it("two distinct struct-shape maps do NOT collapse to one array type", async () => {
    expect(
      await run(`
        interface D { id: number; tag: number; }
        export function test(): number {
          const src: D[] = [{ id: 1, tag: 9 }];
          // first ref-struct array shape
          const pairs = src.map((d: D) => ({ k: d.id, v: d.tag }));   // {k,v}
          // second, DIFFERENT ref-struct array shape from the same receiver
          const singles = src.map((d: D) => ({ only: d.id + d.tag }));// {only}
          return pairs[0].k + pairs[0].v + singles[0].only;           // 1+9 + 10 = 20
        }
      `),
    ).toBe(20);
  });

  it("map callback returning a smaller struct than the receiver element", async () => {
    expect(
      await run(`
        interface Big { a: number; b: number; c: number; d: number; }
        export function test(): number {
          const xs: Big[] = [{ a: 10, b: 20, c: 30, d: 40 }];
          const ys = xs.map((x: Big) => ({ sum: x.a + x.b }));  // 2-field from 4-field
          return ys[0].sum; // 30
        }
      `),
    ).toBe(30);
  });

  it.skipIf(ESLINT_APPLY_DISABLE_DIRECTIVES === null)(
    `eslint apply-disable-directives.js compiles AND validates (Linter.verify path) ${ESLINT_DEV_DEPENDENCY_SKIP}`,
    async () => {
      const entry = requireEslintFile(ESLINT_APPLY_DISABLE_DIRECTIVES, "lib/linter/apply-disable-directives.js");
      const r = await compileProject(entry, {
        allowJs: true,
      } as Parameters<typeof compileProject>[1]);
      expect(r.success, JSON.stringify(r.errors?.slice?.(0, 2))).toBe(true);
      expect(WebAssembly.validate(r.binary), "apply-disable-directives.js binary must validate").toBe(true);
    },
  );
});
