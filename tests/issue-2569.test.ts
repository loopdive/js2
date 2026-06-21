// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2569 — a computed property key in a destructuring pattern (`{ [expr()]: x }`)
 * must EVALUATE `expr()` as part of the destructuring (ES2024 §13.15.5.3 →
 * Evaluation of ComputedPropertyName), exactly once, in source order. If
 * `expr()` throws, the destructuring throws.
 *
 * The static fast-path resolves each property by its constant name and, for a
 * non-foldable runtime computed key, skipped the binding element WITHOUT
 * compiling the key expression — so the side effect never ran and a throwing
 * key never propagated (the 4 `…-dflt-obj-ptrn-prop-eval-err` async-gen fails).
 * The fix compiles the key expression for its effect (and drops the value)
 * before skipping the field bind, in both the typed-struct and externref
 * (`destructureParamObject` / `destructureParamObjectExternref`) paths.
 */

async function run(src: string, target: "gc" | "standalone"): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test?: () => number }).test?.();
}

const targets: Array<"gc" | "standalone"> = ["gc", "standalone"];

describe("#2569 — computed key in a destructuring pattern is evaluated", () => {
  for (const target of targets) {
    describe(`target: ${target}`, () => {
      it("runs the computed-key side effect (any/externref receiver)", async () => {
        expect(
          await run(
            `let ran = 0;
             function k(): string { ran++; return "x"; }
             export function test(): number {
               const obj: any = { x: 5 };
               const { [k()]: v } = obj;
               return ran;
             }`,
            target,
          ),
        ).toBe(1);
      });

      it("runs the computed-key side effect (typed-struct receiver)", async () => {
        expect(
          await run(
            `let ran = 0;
             function k(): string { ran++; return "x"; }
             export function test(): number {
               const obj = { x: 5, y: 6 };
               const { [k()]: v } = obj;
               return ran;
             }`,
            target,
          ),
        ).toBe(1);
      });

      it("runs the computed-key side effect exactly once", async () => {
        expect(
          await run(
            `let n = 0;
             function k(): string { n++; return "a"; }
             export function test(): number {
               const obj: any = { a: 1 };
               const { [k()]: v } = obj;
               return n;
             }`,
            target,
          ),
        ).toBe(1);
      });

      it("propagates a throwing computed key", async () => {
        expect(
          await run(
            `function thrower(): string { throw new Error("boom"); }
             export function test(): number {
               const obj: any = {};
               try {
                 const { [thrower()]: v } = obj;
                 return 0;
               } catch (e) {
                 return 1;
               }
             }`,
            target,
          ),
        ).toBe(1);
      });

      it("still binds the field for a constant computed key", async () => {
        // A foldable computed key (`["x"]`) keeps the existing static fast-path:
        // both the side-effect evaluation AND the field bind must work.
        expect(
          await run(
            `export function test(): number {
               const obj = { x: 7, y: 9 };
               const { ["x"]: v } = obj;
               return v;
             }`,
            target,
          ),
        ).toBe(7);
      });
    });
  }
});
