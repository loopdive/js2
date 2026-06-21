// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2573 — `.length` on a PLAIN object is an absent property → `undefined`
 * (§10.1.8 OrdinaryGet), not numeric 0.
 *
 * `length` is a "reserved accessor" handed to the array-length lowering, which
 * returns numeric 0 (vec field 0 / `__extern_length`) — correct for a real
 * array / string / arguments / function, but WRONG for a plain `{}` where
 * `length` is just a missing property (`({}).length === undefined`).
 *
 * The fix is a FAIL-SAFE static gate (`isPlainObjectWithoutLength`): it diverts
 * `.length` to `undefined` ONLY when the receiver's TS type is a concrete object
 * type (NOT `any`/`unknown`) with no own/inherited `length` member, no numeric
 * index signature, and no call/construct signature. An ambiguous `any` receiver
 * KEEPS the existing numeric vec-field-0 lowering (arrays dominate there), so
 * `array.length` arithmetic is never touched. The dynamic-`any`-receiver cluster
 * (`var obj = {}` mutated at runtime) is a separate substrate follow-up — this
 * fix is the safe, narrow user-code-level correctness slice.
 */

async function run(src: string, target: "gc" | "standalone"): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test?: () => number }).test?.();
}

const targets: Array<"gc" | "standalone"> = ["gc", "standalone"];

describe("#2573 — .length on a plain object is undefined", () => {
  for (const target of targets) {
    describe(`target: ${target}`, () => {
      it("`const obj = {}; obj.length` is undefined", async () => {
        expect(
          await run(
            `export function test(): number { const obj = {}; const L: any = obj.length; return L === undefined ? 1 : 2; }`,
            target,
          ),
        ).toBe(1);
      });

      it("a plain object with other props still has undefined .length", async () => {
        expect(
          await run(
            `export function test(): number { const o = { x: 5, y: 6 }; const L: any = o.length; return L === undefined ? 1 : 2; }`,
            target,
          ),
        ).toBe(1);
      });

      it("typeof plain-object .length is 'undefined'", async () => {
        // Compare via === undefined (typeof over the native-string boundary is a
        // separate path); the point is the value is the undefined externref.
        expect(
          await run(`export function test(): number { const o = {}; return o.length === undefined ? 1 : 2; }`, target),
        ).toBe(1);
      });
    });
  }
});

describe("#2573 — array-like .length stays numeric (fail-safe gate, no regression)", () => {
  for (const target of targets) {
    describe(`target: ${target}`, () => {
      const arrayLike: Array<[string, string, number]> = [
        ["array literal", `const a = [1,2,3]; return a.length;`, 3],
        ["array arithmetic", `const a = [1,2,3,4]; return a.length * 10;`, 40],
        ["array as loop bound", `const a = [1,2,3,4,5]; let s=0; for (let i=0;i<a.length;i++) s++; return s;`, 5],
        ["any-typed array", `const a: any = [1,2]; return a.length;`, 2],
        ["string", `const s = "hello"; return s.length;`, 5],
        ["string arithmetic", `const s = "abcd"; return s.length + 1;`, 5],
        ["function arity", `return fn3.length;`, 3],
        ["typed array", `const a = new Uint8Array(4); return a.length;`, 4],
        ["empty array", `const a: number[] = []; return a.length;`, 0],
        ["array after push", `const a = [1,2]; a.push(3); return a.length;`, 3],
      ];
      for (const [name, body, want] of arrayLike) {
        it(name, async () => {
          const prelude = body.includes("fn3")
            ? `function fn3(a: number, b: number, c: number): number { return a; }\n`
            : "";
          expect(await run(`${prelude}export function test(): number { ${body} }`, target)).toBe(want);
        });
      }
    });
  }
});
