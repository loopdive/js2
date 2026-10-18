// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7020 — two standalone defects the cookie upstream suite exposed.
 *
 * 1. An object literal that receives an expando write (`positive.not = {…}`
 *    after `const positive = { toBe() {…} }`, the upstream `expect()` shim) kept
 *    its bag in the slotless `$ClosurePropEntry` registry: a never-pruned list
 *    walked by `ref.eq`, so every ensure-miss cost O(expandos so far). The
 *    literal's struct now carries the #4241 `$bag` slot.
 * 2. A TS tuple read through `any` answered `Array.isArray(x) === false`.
 *
 * Every case here fails on the parent commit (measured): the timing case by
 * two orders of magnitude, the WAT case because no `$bag` field exists, the
 * tuple case because the answer is 0. The controls pin what must NOT move.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function build(src: string, fileName: string, target: "standalone" | "gc" = "standalone", emitWat = false) {
  const r = await compile(src, { target, allowJs: true, fileName, skipSemanticDiagnostics: true, emitWat });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  return r;
}

async function instantiate(src: string, fileName: string) {
  const r = await build(src, fileName);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: number[]) => number>;
}

/** The upstream-suite `expect()` shape: methods on a literal, expandos added after. */
const EXPECT_SHAPE = `
let failures = 0;
function expectish(actual) {
  const positive = {
    toBe(e) { if (actual !== e) failures++; },
    toEqual(e) { if (actual !== e) failures++; },
  };
  positive.not = { toBe(e) { if (actual === e) failures++; } };
  positive.rejects = { toThrow() { return 1; } };
  return positive;
}
export function run(n) {
  for (let i = 0; i < n; i++) { expectish(i).toBe(i); expectish(i).not.toBe(i + 1); }
  return failures;
}
`;

describe("#7020 — expando writes on an object literal use the $bag slot", () => {
  it("the literal's struct carries a $bag field on standalone, and not on the JS host", async () => {
    const standalone = await build(EXPECT_SHAPE, "expect-shape.js", "standalone", true);
    const literal = standalone.wat.split("\n").find((l) => l.includes("(type $__anon_") && l.includes("$toBe"));
    expect(literal, "the expect() literal struct must exist").toBeDefined();
    expect(literal).toContain("(field $$bag (mut externref))");
    // Control: the JS-host lane never reserves the bag helpers; its layout is unchanged.
    const host = await build(EXPECT_SHAPE, "expect-shape.js", "gc", true);
    const hostLiteral = host.wat.split("\n").find((l) => l.includes("(type $__anon_") && l.includes("$toBe"));
    expect(hostLiteral).toBeDefined();
    expect(hostLiteral).not.toContain("$bag");
  });

  it("a late batch of expect() calls costs about what an early batch costs (no registry walk)", async () => {
    const ex = await instantiate(EXPECT_SHAPE, "expect-shape.js");
    const time = (n: number): number => {
      const t0 = performance.now();
      expect(ex.run!(n)).toBe(0);
      return performance.now() - t0;
    };
    time(200); // warm up the tiers
    const early = time(2000);
    time(12000); // grow the population the registry would have to walk
    const late = time(2000);
    // Parent commit: every ensure-miss walks every earlier entry, so the late
    // batch walks ~28,000 registry entries per ensure and is >10x the early batch.
    // A floor keeps timer granularity on a fast early batch from failing it.
    expect(late).toBeLessThan(Math.max(early, 5) * 6);
  });

  it("expando reads, writes and reflection keep their meaning with the slot", async () => {
    const ex = await instantiate(
      `
      function mk(v) { const o = { a: v, f() { return this.a; } }; o.extra = v + 1; return o; }
      export function independent() { const a = mk(1); const b = mk(10); return a.extra === 2 && b.extra === 11 ? 1 : 0; }
      export function aliased() { const a = mk(1); const b = a; b.extra = 7; return a.extra; }
      export function rewrite() { const o = mk(1); o.extra = 5; o.more = 6; return o.extra + o.more + o.f(); }
      export function deleted() { const o = mk(1); delete o.extra; return ("extra" in o) ? 0 : 1; }
      export function noBagKey() { const o = mk(1); return ("$bag" in o) || Object.keys(o).indexOf("$bag") >= 0 ? 0 : 1; }
      export function untouched() { const q = { a: 3, f() { return 0; } }; return q.extra === undefined ? 1 : 0; }
      `,
      "expando-semantics.js",
    );
    expect(ex.independent!()).toBe(1);
    expect(ex.aliased!()).toBe(7);
    expect(ex.rewrite!()).toBe(12);
    expect(ex.deleted!()).toBe(1);
    expect(ex.noBagKey!()).toBe(1);
    // (Object.keys listing the expando itself is a separate, pre-existing gap:
    // it answers ["a","f"] on the parent commit too, with the registry bag.)
    expect(ex.untouched!()).toBe(1);
  });
});

describe("#7020 — a TS tuple read through `any` is an array", () => {
  const TUPLES = `
    const cases: Array<[string, string, string]> = [];
    cases.push(["a", "b", "c"]);
    function isArr(x: any): number { return Array.isArray(x) ? 1 : 0; }
    function len(x: any): number { return x.length; }
    function at1(x: any): number { return x[1] === "b" ? 1 : 0; }
    // The upstream shim's it.each: spread a row only when every row is an array.
    function each(rows: any, body: (a: any, b: any, c: any) => number): number {
      let expand = rows.length > 0;
      for (let i = 0; i < rows.length; i++) if (!Array.isArray(rows[i])) { expand = false; break; }
      let ok = 0;
      for (let i = 0; i < rows.length; i++) { const row = expand ? rows[i] : [rows[i]]; ok += body(row[0], row[1], row[2]); }
      return ok;
    }
    export function tupleIsArray(): number { return isArr(cases[0]); }
    export function tupleLength(): number { return len(cases[0]); }
    export function tupleIndex(): number { return at1(cases[0]); }
    export function eachSpreads(): number { return each(cases, (a, b, c) => (a === "a" && b === "b" && c === "c" ? 1 : 0)); }
    export function concatSpreads(): number { const t: any = cases[0]; return ([] as any[]).concat(t).length; }
    export function boolNotArray(): number { return isArr(true); }
    export function objNotArray(): number { return isArr({ length: 3, 0: "a" }); }
    export function arrStillArray(): number { return isArr(["x"]); }
  `;

  it("Array.isArray answers true, and the rows spread through the it.each gate", async () => {
    const ex = await instantiate(TUPLES, "tuples.ts");
    expect(ex.tupleIsArray!()).toBe(1);
    expect(ex.eachSpreads!()).toBe(1);
    // IsConcatSpreadable is IsArray: the tuple's three elements are spread.
    expect(ex.concatSpreads!()).toBe(3);
    // Already-working surfaces on the same value stay working.
    expect(ex.tupleLength!()).toBe(3);
    expect(ex.tupleIndex!()).toBe(1);
  });

  it("controls: non-arrays stay non-arrays, arrays stay arrays", async () => {
    const ex = await instantiate(TUPLES, "tuples.ts");
    expect(ex.boolNotArray!()).toBe(0);
    expect(ex.objNotArray!()).toBe(0);
    expect(ex.arrStillArray!()).toBe(1);
  });
});
