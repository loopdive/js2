import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #1967 — higher-order array methods (map/filter/reduce/find*/some/every/
// forEach) silently returned empty/garbage on struct (`ref`) element arrays
// because the dispatch gates in compileArrayMethodCall only passed
// f64/i32/externref element kinds. ref-element receivers fell into the
// generic no-op fallback. The native loop machinery is generic over the
// element ValType, so widening the gate to ref/ref_null is the whole fix
// (mirrors the #1390 sort gate widening).
describe("#1967 higher-order methods on struct-element arrays", () => {
  it("map projects a string struct field", async () => {
    await assertEquivalent(
      `export function test(): string {
        const a = [{ v: "a" }, { v: "b" }];
        const m = a.map((o) => o.v);
        return m[0] + "|" + m.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("map computes a numeric struct field", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        const m = a.map((o) => o.k * 2);
        return m[0] + m[1] + m[2];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("map returns a new struct per element", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }];
        const m = a.map((o) => ({ doubled: o.k * 2 }));
        return m[0].doubled + m[1].doubled;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("filter keeps matching structs (length)", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        return a.filter((o) => o.k > 1).length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("filter result preserves struct fields", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        const f = a.filter((o) => o.k > 1);
        return f[0].k + f[1].k;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  // NOTE: reduce/reduceRight over struct (ref) elements are intentionally NOT
  // covered here — they keep the pre-#1967 f64/i32/externref gate because
  // compileArrayReduce hard-codes a numeric accumulator local (generalising it
  // is #1994). Widening reduce to ref elements regressed ~300 test262 cases, so
  // it was reverted; struct-element reduce stays on the fallback until #1994.

  it("find returns the matching struct", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        const r = a.find((o) => o.k === 2);
        return r ? r.k : -1;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("findIndex locates the matching struct", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        return a.findIndex((o) => o.k === 2);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("findLast returns the last matching struct", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }, { k: 2 }];
        const r = a.findLast((o) => o.k === 2);
        return r ? r.k : -1;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("findLastIndex locates the last matching struct", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }, { k: 2 }];
        return a.findLastIndex((o) => o.k === 2);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("find returns undefined-ish (null) sentinel when no match", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        const r = a.find((o) => o.k === 99);
        return r ? r.k : -1;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("some over structs", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        return a.some((o) => o.k > 2) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("every over structs", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        return a.every((o) => o.k > 0) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("forEach iterates structs", async () => {
    await assertEquivalent(
      `export function test(): number {
        const a = [{ k: 1 }, { k: 2 }, { k: 3 }];
        let sum = 0;
        a.forEach((o) => {
          sum += o.k;
        });
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
