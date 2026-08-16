// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4513 — IR adoption of statically-foldable COMPUTED object keys
// (`{ ["a"]: v }`), measure-first.
//
// Before: every `ComputedPropertyName` in an object literal rejected the whole
// containing function at `objectlit-computed-key`, including `{ ["a"]: 1 }`,
// whose key is a string literal and is indistinguishable from `{ a: 1 }` after
// folding. Legacy already folds (`resolveComputedKeyExpression` →
// `resolveConstantExpression`, src/codegen/literals.ts) and compiles the folded
// literal to the same closed struct as a plain key.
//
// The IR object shape is STATIC (`IrObjectShape.fields` is a fixed list), so
// the adoptable set is exactly the keys that resolve to a string during
// selection. The selector is checker-free — its `scope` is a
// `ReadonlySet<string>` of NAMES, not a value environment — so the fold in
// `src/ir/property-key-fold.ts` is purely syntactic: string literal,
// no-substitution template, numeric literal, and parenthesised wrappers of
// those. `const k = "a"`, `Symbol.iterator`, template substitution and
// arithmetic keep rejecting.
//
// Two things measurement changed about this issue, both pinned below:
//
//  1. A `String(Number(text)) === text` canonicality guard on numeric keys was
//     written first, on the premise that `{ [0x10]: v }` must be rejected
//     because `.text` would be the raw `"0x10"`. It is not: TypeScript's
//     scanner already stores the canonical decimal form, so `.text` IS `"16"`
//     and the guard was dead. The `0x10 / 0.50 / 1e3` cases below were drafted
//     as NEGATIVES and are positives.
//  2. `{ a: 1, ["a"]: v }` now rejects at `objectlit-duplicate-key` rather than
//     `objectlit-computed-key` — a strictly more precise arm, because the key
//     folds far enough for the duplicate check to see it.
//
// Every positive is CLAIM-BACKED (the function must genuinely carry an IR body,
// so an "IR matches legacy" assertion can never be satisfied vacuously by the
// legacy body) and dual-run equality-checked. Every negative asserts BOTH that
// the shape is not claimed AND that it never reaches a post-claim `invariant`
// (a hard error under the IR-only policy).

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { foldComputedPropertyKey, objectLiteralDataPropertyName } from "../src/ir/property-key-fold.js";
import { buildImports } from "../src/runtime.js";

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
  const r = await compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
    "wasm:js-string": JS_STRING_STUB,
  });
  return instance.exports as Record<string, unknown>;
}

/** Bare-SourceFile selector verdict — no checker, the conservative view. */
function claims(source: string, name: string): boolean {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return new Set(planIrCompilation(sf, { experimentalIR: true }).funcs).has(name);
}

async function outcomeOf(source: string, name: string): Promise<string> {
  const r = await compile(source, { trackIrOutcomes: true });
  return (r.irOutcomes ?? []).find((o) => o.displayName === name)?.kind ?? "none";
}

/**
 * Genuine emission through the FULL pipeline, not a mere selector claim: the
 * slot must carry an IR body and no legacy body. This is the authoritative
 * claim-backing — the bare-SourceFile `claims()` above is strictly more
 * conservative (it lacks the checker-backed resolvers), so a shape can be
 * IR-emitted while `claims()` says no.
 */
async function irEmitted(source: string, name: string): Promise<boolean> {
  const r = await compile(source, { trackIrOutcomes: true });
  const outcome = (r.irOutcomes ?? []).find((o) => o.displayName === name);
  return outcome?.kind === "emitted" && outcome.irBodyEmitted === true;
}

async function expectIrLegacyParity(source: string, name: string, args: unknown[], expected: unknown): Promise<void> {
  expect(claims(source, name)).toBe(true);
  expect(await irEmitted(source, name)).toBe(true);
  const legacy = await instantiate(source, false);
  const ir = await instantiate(source, true);
  const call = (exports: Record<string, unknown>) => (exports[name] as (...a: unknown[]) => unknown)(...args);
  expect(call(legacy)).toBe(expected);
  expect(call(ir)).toBe(expected);
}

/**
 * A deferred shape must reject CLEANLY. `invariant` is the failure this issue
 * exists to avoid: the selector claimed and lowering could not deliver.
 */
async function expectCleanReject(source: string, name: string, args: unknown[], expected: unknown): Promise<void> {
  expect(claims(source, name)).toBe(false);
  expect(await outcomeOf(source, name)).not.toBe("invariant");
  const legacy = await instantiate(source, false);
  const ir = await instantiate(source, true);
  const call = (exports: Record<string, unknown>) => (exports[name] as (...a: unknown[]) => unknown)(...args);
  expect(call(legacy)).toBe(expected);
  expect(call(ir)).toBe(expected);
}

describe("#4513 — foldable computed keys are IR-claimed and lowered", () => {
  it('a string-literal key `{ ["a"]: n }` no longer drops the function to legacy', async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { ["a"]: n }; return o.a; }`,
      "f",
      [41],
      41,
    );
  });

  it("two computed keys in one literal", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { ["a"]: n, ["b"]: 1 }; return o.a + o.b; }`,
      "f",
      [41],
      42,
    );
  });

  it("a no-substitution template key", async () => {
    await expectIrLegacyParity(
      "export function f(n: number): number { const o = { [`a`]: n }; return o.a; }",
      "f",
      [41],
      41,
    );
  });

  it("a parenthesised string-literal key — parens are not an operation", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { [("a")]: n }; return o.a; }`,
      "f",
      [41],
      41,
    );
  });

  it("computed and plain keys mixed in one literal", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { a: n, ["b"]: 1 }; return o.a + o.b; }`,
      "f",
      [41],
      42,
    );
  });

  it("a computed key whose folded name sorts BEFORE an earlier plain key", async () => {
    // The shape is sorted by field name after lowering, so `a` precedes `b` in
    // the emitted `object.new` while `b` is written first in source.
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { ["b"]: 1, a: n }; return o.a + o.b; }`,
      "f",
      [41],
      42,
    );
  });

  it("a string-valued computed property", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { ["s"]: "x" }; return o.s.length + n; }`,
      "f",
      [41],
      42,
    );
  });

  it("a boolean-valued computed property", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { ["b"]: true }; return o.b ? n : 0; }`,
      "f",
      [41],
      41,
    );
  });

  it("a nested object as the computed property's value", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { ["a"]: { b: n } }; return o.a.b; }`,
      "f",
      [41],
      41,
    );
  });

  it("a computed-key literal allocated fresh per loop iteration", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { let c = 0; for (let i = 0; i < n; i++) { const o = { ["a"]: i }; c += o.a; } return c; }`,
      "f",
      [4],
      6,
    );
  });

  it("the plain-key, shorthand and string-key claims are untouched", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { a: n }; return o.a; }`,
      "f",
      [41],
      41,
    );
    await expectIrLegacyParity(
      `export function f(n: number): number { const a = n; const o = { a }; return o.a; }`,
      "f",
      [41],
      41,
    );
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { "a": n }; return o.a; }`,
      "f",
      [41],
      41,
    );
  });
});

describe("#4513 — numeric computed keys use the scanner's canonical text", () => {
  // The guard that measurement deleted. `NumericLiteral.text` is ALREADY
  // `String(Number(...))` — `0x10` → "16", `0.50` → "0.5", `1e3` → "1000" — so
  // a computed numeric key is byte-identical to the plain numeric key, and
  // there is no second spelling to keep consistent. These three were drafted as
  // negatives on the opposite premise.
  it("`.text` is canonical for every spelling the guard was written to exclude", () => {
    const sf = ts.createSourceFile(
      "t.ts",
      "const o = { [0x10]: 1, [0.50]: 2, [1e3]: 3, [0b101]: 4, [0o17]: 5, [.5]: 6, [1_000]: 7, [1e21]: 8 };",
      ts.ScriptTarget.Latest,
      true,
    );
    const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
    const literal = decl.initializer as ts.ObjectLiteralExpression;
    const folded = literal.properties.map((p) =>
      foldComputedPropertyKey((p as ts.PropertyAssignment).name as ts.ComputedPropertyName),
    );
    expect(folded).toEqual(["16", "0.5", "1000", "5", "15", "0.5", "1000", "1e+21"]);
    // Every one is its own JS-canonical key — the property the deleted guard
    // was trying (and failing) to enforce.
    for (const key of folded) expect(String(Number(key))).toBe(key);
  });

  it("`{ [0x10]: v }`, `{ 0x10: v }` and `{ 16: v }` are the same key on both paths", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { [0x10]: n }; return n + 1; }`,
      "f",
      [41],
      42,
    );
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { 0x10: n }; return n + 1; }`,
      "f",
      [41],
      42,
    );
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { 16: n }; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("a plain integer computed key", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { [0]: n }; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });
});

describe("#4513 — evaluation order is left-to-right, not shape order", () => {
  // The hazard a computed key makes visible: `lowerObjectLiteral` SORTS the
  // field list by name, and it does so only AFTER every initializer has been
  // lowered in `expr.properties` order. If the sort ever moved ahead of the
  // lowering loop, `{ ["b"]: p(1), a: p(2) }` would run p(2) first. The counter
  // encodes order as `t = t*10 + k` (the #4459 idiom), so a wrong order reads
  // as a different integer — 21 instead of 12 — rather than as an equal sum.
  //
  // These use a module-level `let`, which the bare-SourceFile selector rejects
  // (`nontail-assign-nonprop-lhs`) while the full pipeline claims and emits, so
  // they are claim-backed via `irEmitted` rather than `claims`. Expected values
  // are the ones plain V8 produces for the same source.
  const COUNTER = `let t = 0;\nfunction p(k: number): number { t = t * 10 + k; return k; }\n`;

  async function expectOrder(body: string, expected: number): Promise<void> {
    const source = `${COUNTER}export function f(): number { t = 0; ${body} }`;
    expect(await irEmitted(source, "f")).toBe(true);
    const legacy = await instantiate(source, false);
    const ir = await instantiate(source, true);
    expect((legacy.f as () => number)()).toBe(expected);
    expect((ir.f as () => number)()).toBe(expected);
  }

  it('`{ ["b"]: p(1), a: p(2) }` runs p(1) first even though field `a` sorts first', async () => {
    await expectOrder(`const o = { ["b"]: p(1), a: p(2) }; return t + o.a * 0;`, 12);
  });

  it('`{ a: p(1), ["b"]: p(2), c: p(3) }` — a computed key interleaved with plain ones', async () => {
    await expectOrder(`const o = { a: p(1), ["b"]: p(2), c: p(3) }; return t + o.a * 0;`, 123);
  });

  it('`{ ["c"]: p(1), ["a"]: p(2), ["b"]: p(3) }` — all computed, exact reverse of sort order', async () => {
    await expectOrder(`const o = { ["c"]: p(1), ["a"]: p(2), ["b"]: p(3) }; return t + o.a * 0;`, 123);
  });
});

describe("#4513 — keys that need a value environment still reject cleanly", () => {
  it('`const k = "a"` — the selector\'s scope is a name set, not a value environment', async () => {
    await expectCleanReject(
      `export function f(n: number): number { const k = "a"; const o = { [k]: n }; return (o as any).a; }`,
      "f",
      [41],
      41,
    );
  });

  it("a runtime parameter key", async () => {
    await expectCleanReject(
      `export function f(n: number, k: string): number { const o = { [k]: n }; return (o as any).a; }`,
      "f",
      [41, "a"],
      41,
    );
  });

  it("a template literal WITH a substitution", async () => {
    await expectCleanReject(
      'export function f(n: number): number { const q = "a"; const o = { [`${q}b`]: n }; return (o as any).ab; }',
      "f",
      [41],
      41,
    );
  });

  it("an arithmetic key `[1 + 1]` — folding it re-implements resolveConstantExpression", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = { [1 + 1]: n }; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("`[Symbol.iterator]` — legacy maps it to the reserved `@@iterator` field", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = { [Symbol.iterator]: n }; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });
});

describe("#4513 — property FORMS that stay rejected, each at its own arm", () => {
  it("a computed getter — accessors are unclaimed for plain keys too", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = { get ["a"]() { return 1; } }; return (o as any).a + n; }`,
      "f",
      [41],
      NaN,
    );
  });

  it("a computed method name — legacy itself THROWS on this shape, so it is not a parity target", async () => {
    // Measured: the direct backend emits an object whose `m` is not callable.
    // Adopting the shape in the IR would mean reproducing a legacy bug.
    const source = `export function f(n: number): number { const o = { ["m"]() { return 1; } }; return (o as any).m() + n; }`;
    expect(claims(source, "f")).toBe(false);
    expect(await outcomeOf(source, "f")).not.toBe("invariant");
    const legacy = await instantiate(source, false);
    const ir = await instantiate(source, true);
    expect(() => (legacy.f as (n: number) => number)(41)).toThrow();
    expect(() => (ir.f as (n: number) => number)(41)).toThrow();
  });

  it("a spread alongside a computed key", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const s = { z: 1 }; const o = { ...s, ["a"]: n }; return (o as any).a; }`,
      "f",
      [41],
      41,
    );
  });

  it("a computed key duplicating a plain one now rejects at the DUPLICATE arm", async () => {
    // The precision gain: the key folds far enough for the duplicate check to
    // see it, so this reports `objectlit-duplicate-key`, not
    // `objectlit-computed-key`.
    const source = `export function f(n: number): number { const o = { a: 1, ["a"]: n }; return (o as any).a; }`;
    const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
    const plan = planIrCompilation(sf, { experimentalIR: true, trackFallbacks: true });
    const fallback = (plan.fallbacks ?? []).find((f) => f.name === "f");
    expect(fallback?.reason).toBe("body-shape-rejected");
    await expectCleanReject(source, "f", [41], 41);
  });
});

describe("#4513 — the fold does not widen the non-data-property sites", () => {
  it("`objectLiteralDataPropertyName` agrees with the plain path on non-computed names", () => {
    const sf = ts.createSourceFile("t.ts", `const o = { a: 1, "b": 2, 3: 4 };`, ts.ScriptTarget.Latest, true);
    const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
    const literal = decl.initializer as ts.ObjectLiteralExpression;
    const names = literal.properties.map((p) => objectLiteralDataPropertyName((p as ts.PropertyAssignment).name));
    expect(names).toEqual(["a", "b", "3"]);
  });

  it("a class body's computed member name is a different gate and is unchanged", async () => {
    // `class A { [k]() {} }` rejects at `class-member-unsupported`, on a
    // different node kind, and never reaches the object-literal walker.
    const source = `const k = "m";\nclass A { [k]() { return 1; } }\nexport function f(n: number): number { const a = new A(); return (a as any).m() + n; }`;
    expect(claims(source, "f")).toBe(false);
    expect(await outcomeOf(source, "f")).not.toBe("invariant");
    const legacy = await instantiate(source, false);
    const ir = await instantiate(source, true);
    expect((legacy.f as (n: number) => number)(41)).toBe(42);
    expect((ir.f as (n: number) => number)(41)).toBe(42);
  });
});
