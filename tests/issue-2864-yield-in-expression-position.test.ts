// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2864 S1 — a `yield` in EXPRESSION POSITION inside a standalone generator.
 *
 * A general Wasm-native generator carrier already existed; what still fell out
 * of `buildNativeGeneratorPlan` (and therefore leaked the whole
 * `env::__create_generator` / `__gen_*` host-import family, or refused with the
 * #680 diagnostic in standalone) was a yield that is not the WHOLE statement
 * and not the WHOLE initializer of an identifier declaration:
 *
 *   [a] = [yield 1];          // assignment with a destructuring target
 *   ({ a } = { a: yield 1 }); // ditto, object pattern
 *   x = yield 1;              // assignment with an identifier target
 *
 * #680 already had the mechanism — capture the operands evaluated BEFORE the
 * suspension into frame spills, then recompile the original statement in the
 * successor state with the yield and those operands read back from the frame —
 * but admitted only the operand-less `yield`, only as a bare expression
 * statement, and only for array/object/comma/conditional roots.
 *
 * THE PROPERTY THAT MATTERS is the one the split exists for: a yield inside a
 * literal must not re-run its siblings after the resume. `[f(), yield 1, h()]`
 * has to call `f` exactly once BEFORE the suspension and `h` exactly once
 * AFTER it, in that order — a re-evaluating lowering would call `f` twice and
 * still produce the right number.
 *
 * Everything here is asserted on the STANDALONE target with
 * `imports === []`, because the host-import leak is the whole point of #2864.
 * The last two cases pin the deliberate boundary (a member assignment target
 * and a yield nested in a yield operand stay refused) and the standalone
 * gating (the gc lane keeps its eager host buffer, unchanged).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** `.next(0)` to start, then `.next(7)`; the value of the second yield. */
const DRIVE = `export function test(): number {
  const it = g();
  it.next(0);
  return it.next(7).value as number;
}`;

describe("#2864 — yield in expression position, standalone", () => {
  it("S1: array-pattern assignment whose RHS suspends", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number, void, number> {
  let a = 0;
  [a] = [yield 1];
  yield a;
}
${DRIVE}`),
    ).toBe(7);
  });

  it("S1: object-pattern assignment whose RHS suspends", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number, void, number> {
  let a = 0;
  ({ a } = { a: yield 1 });
  yield a;
}
${DRIVE}`),
    ).toBe(7);
  });

  it("S1: identifier assignment whose RHS suspends", async () => {
    expect(
      await runStandalone(`let x = 0;
function* g(): Generator<number, void, number> {
  x = yield 1;
  yield x + 1;
}
${DRIVE}`),
    ).toBe(8);
  });

  // The reason the statement is SPLIT across the resume boundary rather than
  // re-evaluated: siblings of the yield carry observable effects.
  it("ORDER: `[f(), yield 1, h()]` calls f once before the suspension and h once after", async () => {
    expect(
      await runStandalone(`let fCalls = 0;
let hCalls = 0;
let tick = 0;
let fAt = 0;
let hAt = 0;
let arr: number[] = [];
function f(): number { fCalls = fCalls + 1; tick = tick + 1; fAt = tick; return 10; }
function h(): number { hCalls = hCalls + 1; tick = tick + 1; hAt = tick; return 20; }
function* g(): Generator<number, void, number> {
  arr = [f(), yield 1, h()];
  yield arr[0] + arr[1] + arr[2];
}
export function test(): number {
  const it = g();
  const first = it.next(0);
  const midOk = fCalls === 1 && hCalls === 0 && fAt === 1 ? 1 : 0;
  const second = it.next(7);
  const afterOk = fCalls === 1 && hCalls === 1 && fAt === 1 && hAt === 2 ? 1 : 0;
  const firstOk = (first.value as number) === 1 ? 1 : 0;
  const sumOk = (second.value as number) === 37 ? 1 : 0;
  return midOk + afterOk * 2 + firstOk * 4 + sumOk * 8;
}`),
    ).toBe(15);
  });

  it("ORDER: an object-literal prefix property is evaluated once, before the suspension", async () => {
    expect(
      await runStandalone(`let tick = 0;
let pAt = 0;
let qAt = 0;
let obj: { a: number; b: number; c: number } = { a: 0, b: 0, c: 0 };
function p(): number { tick = tick + 1; pAt = tick; return 3; }
function q(): number { tick = tick + 1; qAt = tick; return 5; }
function* g(): Generator<number, void, number> {
  obj = { a: p(), b: yield 1, c: q() };
  yield obj.a + obj.b + obj.c;
}
export function test(): number {
  const it = g();
  it.next(0);
  const mid = pAt === 1 && qAt === 0 ? 1 : 0;
  const v = it.next(7).value as number;
  const after = pAt === 1 && qAt === 2 ? 1 : 0;
  return mid + after * 2 + (v === 15 ? 4 : 0);
}`),
    ).toBe(7);
  });

  // --- deliberate boundary --------------------------------------------------
  // Both of these are REFUSALS on purpose. Widening either one is a real
  // change of semantics, not a cleanup, so it must land with its own argument.

  it("BOUNDARY: a MEMBER assignment target stays on the host path", async () => {
    // §13.15.2 evaluates the target reference BEFORE the RHS, so deferring
    // `o.p` into the successor state would move an observable Get across the
    // resume boundary.
    const r = await compile(
      `const o: { p: number } = { p: 0 };
function* g(): Generator<number, void, number> {
  o.p = yield 1;
  yield o.p;
}
${DRIVE}`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.[0]?.message ?? "").toContain("#680");
  });

  it("BOUNDARY: a yield NESTED in a yield operand stays on the host path", async () => {
    const r = await compile(
      `function* g(): Generator<number, void, number> {
  const a = [yield ((yield 1) as number)];
  yield a[0];
}
${DRIVE}`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.[0]?.message ?? "").toContain("#680");
  });

  it("BOUNDARY: a destructuring DEFAULT stays on the host path (conditional suspension)", async () => {
    // `const [a = yield 1] = vals` only evaluates the yield when the element is
    // undefined. The continuation model suspends UNCONDITIONALLY, so admitting
    // this shape would yield where the spec does not.
    const r = await compile(
      `function* g(): Generator<number, void, number> {
  const [a = yield 1] = [];
  yield a as number;
}
${DRIVE}`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.[0]?.message ?? "").toContain("#680");
  });

  it("GATING: the gc lane is untouched — a newly-admitted shape keeps its eager host buffer", async () => {
    const r = await compile(
      `function* g(): Generator<number, void, number> {
  let a = 0;
  [a] = [yield 1];
  yield a;
}
${DRIVE}`,
      { fileName: "test.ts", target: "gc" },
    );
    expect(r.success).toBe(true);
    expect(r.imports.map((i) => i.name)).toContain("__gen_create_buffer");
  });
});
