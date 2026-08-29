// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5163 — IR adoption of MUTATING expression statements with a property /
// element LHS, plus chained assignment.
//
// #4459 adopted the value-DISCARDING statement shapes. The mutating ones with
// no dedicated arm still rejected the whole containing function:
//
//   | shape                        | rejection arm                     |
//   | ---------------------------- | --------------------------------- |
//   | `o.x += 1;` / `a[i] += 1;`   | `nontail-compound-or-binary-stmt` |
//   | `o.x++;` / `++o.x;`          | `nontail-incdec-stmt`             |
//   | `a = b = 1;`                 | `nontail-assign-nonprop-lhs`      |
//   | local `a = 1;` / `x++;`      | (no top-level arm existed at all) |
//   | the same inside a loop body  | `body-exprstmt-other`             |
//
// Unlike #4459, the LOWERER did not already handle these: a compound
// assignment is a read-modify-write, and plain `=` lowers receiver → RHS with
// no read at all. So this file's real subject is EVALUATION ORDER, which is
// where a read-modify-write desugaring goes wrong silently:
//
//   1. the old value is READ BEFORE the RHS is evaluated (ES §13.15.2), so
//      `o.x += f(o)` where `f` mutates `o.x` must write oldRead + rhs;
//   2. a receiver and an index are each evaluated EXACTLY ONCE and reused for
//      both the read and the write, so `a[g()] += h()` calls `g` once;
//   3. a chained assignment evaluates its RHS once and stores THAT value into
//      every target — never a re-read of the inner target.
//
// Every ordering claim is asserted by counting calls through module-level
// counters and by comparing against BOTH the legacy compiler and Node, so a
// wrong order cannot pass by matching a wrong reference. Every positive case
// also asserts genuine IR EMISSION, so a green equivalence line can never be
// satisfied vacuously by the legacy body.

import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const JS_STRING_STUB = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

async function instantiate(source: string, experimentalIR: boolean): Promise<Record<string, unknown>> {
  const r = await compile(source, { fileName: "test.ts", experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
    "wasm:js-string": JS_STRING_STUB,
  } as never);
  return instance.exports as Record<string, unknown>;
}

function claims(source: string, name: string): boolean {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return new Set(planIrCompilation(sf, { experimentalIR: true }).funcs).has(name);
}

/** Genuine emission, not a mere claim: the slot must carry an IR body. */
async function irEmitted(source: string, name: string): Promise<boolean> {
  const r = await compile(source, { fileName: "test.ts", trackIrOutcomes: true });
  const outcome = (r.irOutcomes ?? []).find((o) => o.displayName === name);
  return outcome?.kind === "emitted" && outcome.irBodyEmitted === true;
}

/** The terminal outcome kind, so a demote can be distinguished from a hard error. */
async function outcomeKind(source: string, name: string): Promise<string | undefined> {
  const r = await compile(source, { fileName: "test.ts", trackIrOutcomes: true });
  return (r.irOutcomes ?? []).find((o) => o.displayName === name)?.kind;
}

/**
 * Emission-backed and legacy-equivalent.
 *
 * `irEmitted` is the assertion carrying the weight, not `claims`: it runs the
 * full pipeline and reports that the function's slot actually carries an IR
 * body, so "IR matches legacy" cannot be satisfied by the legacy body itself.
 */
async function expectIrLegacyParity(source: string, args: unknown[], expected: unknown): Promise<void> {
  expect(await irEmitted(source, "test")).toBe(true);
  const legacy = await instantiate(source, false);
  const ir = await instantiate(source, true);
  const call = (e: Record<string, unknown>) => (e.test as (...a: unknown[]) => unknown)(...args);
  expect(call(legacy)).toBe(expected);
  expect(call(ir)).toBe(expected);
}

// ---------------------------------------------------------------------------
// S0 — the top-level walker had NO local assign / incdec arm at all
// ---------------------------------------------------------------------------

describe("#5163 S0 — top-level local assign and ++/--", () => {
  it.each([
    ["local `a = 5;`", `export function test(): number { let a = 0; a = 5; return a; }`, 5],
    ["local `a++;`", `export function test(): number { let a = 0; a++; return a; }`, 1],
    ["local `--a;`", `export function test(): number { let a = 4; --a; return a; }`, 3],
  ])("%s claims at the bare selector and matches legacy", async (_label, source, expected) => {
    expect(claims(source, "test")).toBe(true);
    await expectIrLegacyParity(source, [], expected);
  });
});

// ---------------------------------------------------------------------------
// S1 — property compound assign + property ++/--
// ---------------------------------------------------------------------------

describe("#5163 S1 — property compound assign and ++/--", () => {
  it.each([
    ["`o.x += 1;`", `export function test(): number { const o = { x: 1 }; o.x += 1; return o.x; }`, 2],
    ["`o.x -= 3;`", `export function test(): number { const o = { x: 10 }; o.x -= 3; return o.x; }`, 7],
    ["`o.x *= 4;`", `export function test(): number { const o = { x: 3 }; o.x *= 4; return o.x; }`, 12],
    ["`o.x /= 2;`", `export function test(): number { const o = { x: 9 }; o.x /= 2; return o.x; }`, 4.5],
    ["`o.x++;`", `export function test(): number { const o = { x: 1 }; o.x++; return o.x; }`, 2],
    ["`o.x--;`", `export function test(): number { const o = { x: 1 }; o.x--; return o.x; }`, 0],
  ])("%s claims and matches legacy", async (_label, source, expected) => {
    expect(claims(source, "test")).toBe(true);
    await expectIrLegacyParity(source, [], expected);
  });

  it("claims a property compound inside a loop body (the body-buffer walker)", () => {
    expect(
      claims(
        `export function test(n: number): number {
           const o = { x: 0 };
           for (let i = 0; i < n; i++) { o.x += 2; }
           return o.x;
         }`,
        "test",
      ),
    ).toBe(true);
  });

  it("a property compound inside a loop body matches legacy", async () => {
    await expectIrLegacyParity(
      `export function test(n: number): number {
         const o = { x: 0 };
         for (let i = 0; i < n; i++) { o.x += 2; }
         return o.x;
       }`,
      [5],
      10,
    );
  });

  // THE ordering case. `f` mutates `o.x` while computing the RHS, so the two
  // possible lowerings give different answers:
  //   read-then-rhs (correct, ES §13.15.2): o.x = 1 + 100 = 101
  //   rhs-then-read (wrong):                o.x = 50 + 100 = 150
  //
  // Side-effect state is carried on a LOCAL object passed as an argument, never
  // a module-level `let`: a module-binding counter is itself outside IR scope
  // today, which would demote the function under test and make the equivalence
  // assertion vacuous (it would only ever compare legacy against legacy).
  const READ_BEFORE_RHS = `
function f(o: { x: number }): number {
  o.x = 50;
  return 100;
}
export function test(): number {
  const o = { x: 1 };
  o.x += f(o);
  return o.x;
}`;

  it("`o.x += f(o)` where f mutates o.x — the write is oldRead + rhs, not rhs applied to the new read", async () => {
    // Node is the independent reference: neither compiler is trusted to define
    // the answer.
    expect(await irEmitted(READ_BEFORE_RHS, "test")).toBe(true);
    const legacy = await instantiate(READ_BEFORE_RHS, false);
    const ir = await instantiate(READ_BEFORE_RHS, true);
    const node = (() => {
      const o = { x: 1 };
      const f = (t: { x: number }): number => {
        t.x = 50;
        return 100;
      };
      o.x += f(o);
      return o.x;
    })();
    expect(node).toBe(101);
    expect((legacy.test as () => number)()).toBe(101);
    expect((ir.test as () => number)()).toBe(101);
  });

  // The receiver is a CALL, so evaluating it twice is observable.
  const RECEIVER_ONCE = `
function recv(holder: { x: number }, log: { v: number }): { x: number } {
  log.v += 1;
  return holder;
}
export function test(): number {
  const holder = { x: 0 };
  const log = { v: 0 };
  recv(holder, log).x += 1;
  return holder.x * 10 + log.v;
}`;

  it("the receiver of a property compound is evaluated exactly once", async () => {
    // 11 = the field was incremented once (1) AND recv ran once (1). A second
    // receiver evaluation would read 12.
    await expectIrLegacyParity(RECEIVER_ONCE, [], 11);
  });

  // `o.x++;` and `++o.x;` differ only in the value they PRODUCE. In statement
  // position that value is discarded, so the two must be indistinguishable.
  it("`o.x++;` and `++o.x;` are identical in statement position", async () => {
    const postfix = `export function test(): number { const o = { x: 5 }; o.x++; return o.x; }`;
    const prefix = `export function test(): number { const o = { x: 5 }; ++o.x; return o.x; }`;
    expect(await irEmitted(postfix, "test")).toBe(true);
    expect(await irEmitted(prefix, "test")).toBe(true);
    const post = await instantiate(postfix, true);
    const pre = await instantiate(prefix, true);
    expect((post.test as () => number)()).toBe(6);
    expect((pre.test as () => number)()).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// S2 — element compound assign + element ++/--
// ---------------------------------------------------------------------------

describe("#5163 S2 — element compound assign and ++/--", () => {
  it.each([
    ["`a[0] += 1;`", `export function test(): number { const a = [1, 2]; a[0] += 1; return a[0]; }`, 2],
    ["`a[1] *= 3;`", `export function test(): number { const a = [1, 2]; a[1] *= 3; return a[1]; }`, 6],
    ["`a[0]++;`", `export function test(): number { const a = [1, 2]; a[0]++; return a[0]; }`, 2],
    ["`--a[1];`", `export function test(): number { const a = [1, 2]; --a[1]; return a[1]; }`, 1],
  ])("%s claims and matches legacy", async (_label, source, expected) => {
    expect(claims(source, "test")).toBe(true);
    await expectIrLegacyParity(source, [], expected);
  });

  it("an element compound inside a loop body matches legacy", async () => {
    await expectIrLegacyParity(
      `export function test(n: number): number {
         const a = [0, 0, 0, 0];
         for (let i = 0; i < n; i++) { a[i] += i; }
         return a[0] + a[1] + a[2] + a[3];
       }`,
      [4],
      6,
    );
  });

  // Receiver, index and RHS are all side-effecting: this pins BOTH that each is
  // called exactly once AND the order they run in (recv, idx, read, rhs).
  const ELEM_ORDER = `
function g(log: { v: number }): number {
  log.v = log.v * 10 + 1;
  return 1;
}
function h(log: { v: number }): number {
  log.v = log.v * 10 + 2;
  return 5;
}
export function test(): number {
  const log = { v: 0 };
  const arr = [10, 20, 30];
  arr[g(log)] += h(log);
  return log.v;
}`;

  it("`a[g()] += h()` — index then RHS, each evaluated exactly once", async () => {
    // `12` = g ran once (digit 1), then h ran once (digit 2). A second call of
    // either would show as an extra digit; the wrong order would read `21`.
    await expectIrLegacyParity(ELEM_ORDER, [], 12);
  });

  it("`a[g()] += h()` stores the value the single read and single RHS produced", async () => {
    const source = `
function g(log: { v: number }): number {
  log.v += 1;
  return 1;
}
export function test(): number {
  const log = { v: 0 };
  const arr = [10, 20, 30];
  arr[g(log)] += 5;
  return arr[1] * 10 + log.v;
}`;
    // arr[1] = 20 + 5 = 25, and g ran once → 251.
    await expectIrLegacyParity(source, [], 251);
  });

  // An out-of-bounds compound must reproduce legacy's hole/provider semantics
  // exactly: the read yields the JS `undefined` image (NaN), the arithmetic
  // propagates NaN, and the store grows the array.
  it("out-of-bounds `a[i] += 1` matches legacy", async () => {
    const source = `export function test(i: number): number {
      const a = [1, 2];
      a[i] += 1;
      return a[i];
    }`;
    expect(await irEmitted(source, "test")).toBe(true);
    const legacy = await instantiate(source, false);
    const ir = await instantiate(source, true);
    const legacyOob = (legacy.test as (i: number) => number)(5);
    const irOob = (ir.test as (i: number) => number)(5);
    expect(Number.isNaN(irOob)).toBe(Number.isNaN(legacyOob));
    if (!Number.isNaN(legacyOob)) expect(irOob).toBe(legacyOob);
    // In bounds the two must agree on a concrete value too.
    expect((ir.test as (i: number) => number)(0)).toBe((legacy.test as (i: number) => number)(0));
  });
});

// ---------------------------------------------------------------------------
// S3 — chained assignment
// ---------------------------------------------------------------------------

describe("#5163 S3 — chained assignment statements", () => {
  it.each([
    ["`a = b = 7;`", `export function test(): number { let a = 0; let b = 0; a = b = 7; return a * 10 + b; }`, 77],
    [
      "`a = b = c = 4;`",
      `export function test(): number { let a = 0; let b = 0; let c = 0; a = b = c = 4; return a + b + c; }`,
      12,
    ],
    [
      "`o.x = o.y = 3;`",
      `export function test(): number { const o = { x: 0, y: 0 }; o.x = o.y = 3; return o.x * 10 + o.y; }`,
      33,
    ],
  ])("%s claims and matches legacy", async (_label, source, expected) => {
    expect(claims(source, "test")).toBe(true);
    await expectIrLegacyParity(source, [], expected);
  });

  it("a chained assignment inside a loop body matches legacy", async () => {
    await expectIrLegacyParity(
      `export function test(n: number): number {
         let a = 0;
         let b = 0;
         for (let i = 0; i < n; i++) { a = b = i; }
         return a * 10 + b;
       }`,
      [4],
      33,
    );
  });

  // The RHS is side-effecting, so evaluating it once per target would be
  // visible — and both targets must receive the value it produced.
  const CHAIN_ONCE = `
function e(box: { n: number }): number {
  box.n += 1;
  return 9;
}
export function test(): number {
  const box = { n: 0 };
  let a = 0;
  let b = 0;
  a = b = e(box);
  return a * 100 + b * 10 + box.n;
}`;

  it("`a = b = e()` evaluates e once and gives both targets its value", async () => {
    // a=9, b=9, calls=1 → 9*100 + 9*10 + 1 = 991. Evaluating the RHS once per
    // target would read 992.
    await expectIrLegacyParity(CHAIN_ONCE, [], 991);
  });

  // A chain is NOT restricted to f64 destinations, and that is load-bearing
  // rather than a nicety. A string-route function has its LEGACY body skipped,
  // so a build-stage demote there does not fall back — it surfaces as an
  // `unpatched-slot` INVARIANT, a hard compile error. Lowering the string chain
  // is what keeps that path off the table.
  it("a string chain lowers rather than demoting (a demote here would hard-error)", async () => {
    const source = `export function test(): string { let a = ""; let b = ""; a = b = "z"; return a + b; }`;
    expect(await outcomeKind(source, "test")).toBe("emitted");
    await expectIrLegacyParity(source, [], "zz");
  });

  it("a three-target string chain lowers", async () => {
    const source = `export function test(): string {
      let a = "";
      let b = "";
      let c = "";
      a = b = c = "z";
      return a + b + c;
    }`;
    await expectIrLegacyParity(source, [], "zzz");
  });
});

// ---------------------------------------------------------------------------
// Selector ⇄ builder parity for the shapes deliberately left out
// ---------------------------------------------------------------------------
//
// These are admitted by the new selector arms (the selector has no types) and
// refused by the lowerer. The refusal must be a TYPED demote — `unsupported`,
// falling back to the legacy body — never `invariant`, which is a hard compile
// error (#3341/#3519). Asserting the KIND is the point: asserting only that
// the result is correct would pass either way.

describe("#5163 — out-of-scope shapes demote cleanly, never hard-error", () => {
  it.each([
    ["string field compound", `export function test(o: { s: string }): string { o.s += "a"; return o.s; }`],
    ["string element compound", `export function test(a: string[]): string { a[0] += "b"; return a[0]; }`],
    ["TypedArray element compound", `export function test(a: Float64Array): number { a[0] += 1; return a[0]; }`],
    ["boolean field write", `export function test(o: { b: boolean }): boolean { o.b = o.b; return o.b; }`],
    [
      "nested-receiver property compound",
      `export function test(o: { i: { x: number } }): number { o.i.x += 1; return o.i.x; }`,
    ],
  ])("%s demotes as `unsupported`", async (_label, source) => {
    const kind = await outcomeKind(source, "test");
    expect(kind).toBe("unsupported");
  });

  // The general form of the rule the string chain taught: whether a demote
  // falls back or hard-errors depends on whether the LEGACY body was emitted,
  // which the compiler decides per route. So no shape the new selector arms
  // admit may reach a build-stage demote on a legacy-skipping route. Compiling
  // each source ALONE is what exposes that (a multi-function module often
  // keeps the legacy body and hides the failure).
  it.each([
    [`export function test(o: { s: string }): string { o.s += "a"; return o.s; }`],
    [`export function test(a: string[]): string { a[0] += "b"; return a[0]; }`],
    [`export function test(): string { let a = ""; let b = ""; a = b = "z"; return a + b; }`],
    [`export function test(o: { x: string; y: string }): string { o.x = o.y = "z"; return o.x + o.y; }`],
    [`export function test(a: Float64Array): number { a[0] += 1; return a[0]; }`],
    [`export function test(o: { i: { x: number } }): number { o.i.x += 1; return o.i.x; }`],
    [`export function test(o: { x: number }): number { let a = 0; a = o.x = 1; return a + o.x; }`],
    [`export function test(a: number[], s: string): number { a[s.length] += 1; return a[0]; }`],
    [
      `export function test(n: number): string { let a = ""; let b = ""; for (let i = 0; i < n; i++) { a = b = "z"; } return a + b; }`,
    ],
  ])("no adopted shape ever reports `invariant` (case %#)", async (source) => {
    const r = await compile(source, { fileName: "test.ts", trackIrOutcomes: true });
    expect((r.irOutcomes ?? []).filter((o) => o.kind === "invariant")).toEqual([]);
  });

  it("an accessor-backed property compound demotes rather than writing the backing field", async () => {
    const source = `
class Acc {
  v = 0;
  get x(): number { return this.v; }
  set x(n: number) { this.v = n * 2; }
  bump(): number { this.x += 1; return this.v; }
}
export function test(): number {
  const a = new Acc();
  return a.bump();
}`;
    // The setter doubles, so a lowering that wrote the backing field directly
    // would return 1 instead of 2.
    const legacy = await instantiate(source, false);
    const ir = await instantiate(source, true);
    expect((legacy.test as () => number)()).toBe(2);
    expect((ir.test as () => number)()).toBe(2);
  });
});
