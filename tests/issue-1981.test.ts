import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

/**
 * #1981 — the IR `tryFoldNullCompare` folded `=== null` / `!== null` to a
 * constant for `class`/`object`/`closure`-typed operands, which lower to
 * nullable WasmGC ref shapes. A class-typed value passed as `null` at runtime
 * then bypassed its own defensive guard: `=== null` folded to `false` (wrong
 * value) and `!== null` folded to `true` (then a null dereference trapped).
 * The fold now bails for these ref-shaped kinds so a runtime `ref.is_null`
 * check is emitted instead.
 */
describe("#1981 null-compare guards on ref-shaped values are not folded", () => {
  it("class === null guard fires when the arg is null", async () => {
    await assertEquivalent(
      `class A { v: number = 7; }
       export function f(p: A): number {
         if (p === null) return -1;
         return 0;
       }`,
      [{ fn: "f", args: [null] }],
    );
  });

  it("class !== null guard protects a field access when null", async () => {
    await assertEquivalent(
      `class A { v: number = 7; }
       export function g(p: A): number {
         if (p !== null) return p.v;
         return -1;
       }`,
      [{ fn: "g", args: [null] }],
    );
  });

  it("loose == null guard fires when the arg is null", async () => {
    await assertEquivalent(
      `class A { v: number = 1; }
       export function h(p: A): number {
         if (p == null) return -1;
         return p.v;
       }`,
      [{ fn: "h", args: [null] }],
    );
  });

  it("non-null class receiver still returns the field (no spurious guard)", async () => {
    await assertEquivalent(
      `class A { v: number = 42; }
       export function k(): number {
         const a = new A();
         if (a === null) return -1;
         return a.v;
       }`,
      [{ fn: "k", args: [] }],
    );
  });
});
