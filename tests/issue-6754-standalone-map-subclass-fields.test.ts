// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6754 — a standalone `class X extends Map` (or Set/WeakMap/WeakSet) with an
// own field. Before the fix the result depended on declaration ORDER:
//
//   - with nothing earlier typed as a `Map`, the declared field hit the #2620
//     refusal ("declared property … not yet supported");
//   - once ANY earlier declaration resolved a `Map` value (tailwindcss's
//     `class p { constructor(e = new Map) { this.values = e } }`), the runtime
//     `$Map` struct was adopted as a nominal parent WITHOUT its fields, and the
//     compile died on "struct hierarchy layout became invalid before
//     finalization: subtype … (U) supertype … (Map) is no longer an exact
//     mutable-field prefix" — the tailwindcss standalone-dynamic lane's first
//     diagnostic;
//   - a constructor-only `this.n = 5` (no declaration) compiled and read back
//     NaN.
//
// Now the instance is a `$Map`-subtype carrier (standalone-collection-carrier.ts):
// every case below compiles with zero imports and computes the native answer.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** The tailwindcss 4.3.3 `lib.mjs` class, verbatim apart from whitespace. */
const TAILWIND_U = `var U = class extends Map {
  constructor(r) { super(); this.factory = r; }
  factory;
  get(r) { let t = super.get(r); return t === void 0 && (t = this.factory(r, this), this.set(r, t)), t; }
};`;

/** An earlier declaration that resolves a `Map`-typed value (tailwind's chunk class `p`). */
const EARLIER_MAP_USE = `var P = class { constructor(e = new Map()) { this.values = e; } };`;

// \`calls\` pins the cache: \`super.get\` must see the value \`this.set\` stored, so
// the factory runs once per key (it used to answer \`undefined\` every time).
const TAILWIND_PROBE = `
var calls = 0;
export function test() {
  const u = new U((k) => { calls++; return k + "!"; });
  let score = 0;
  if (u.get("x") === "x!") score += 1;
  if (u.size === 1) score += 2;
  if (u.get("x") === "x!" && u.size === 1 && calls === 1) score += 4;
  if (u instanceof Map && u instanceof U) score += 8;
  u.factory = (k) => k + "?";
  if (u.get("q") === "q?" && u.size === 2 && u.get("x") === "x!") score += 16;
  return score;
}`;

async function runStandalone(source: string, js: boolean): Promise<number> {
  const r = await compile(source, {
    target: "standalone",
    ...(js ? { allowJs: true, fileName: "input.js" } : {}),
  } as never);
  const errors = r.errors.filter((e) => e.severity === "error").map((e) => e.message);
  expect(r.success, errors.join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(mod), "standalone must stay host-free").toEqual([]);
  const instance = await WebAssembly.instantiate(mod, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6754 standalone native-collection subclass with own fields", () => {
  it("the issue's minimal class compiles and runs host-free (super.get reads the stored value)", async () => {
    const src = `class M extends Map {
      f;
      constructor() { super(); this.f = 1; }
      get(k) { return super.get(k); }
    }
    export function test() {
      const m = new M();
      m.set("a", 5);
      return (m.get("a") === 5 ? 1 : 0) + (m.f === 1 ? 2 : 0) + (m.size === 1 ? 4 : 0) + (m.get("b") === undefined ? 8 : 0);
    }`;
    expect(await runStandalone(src, true)).toBe(15);
  });

  it("the issue's minimal TS-typed class compiles host-free and keeps its field", async () => {
    const src = `class M extends Map<string, number> {
      f: number;
      constructor() { super(); this.f = 1; }
      get(k: string): number | undefined { return super.get(k); }
    }
    export function test(): number { const m = new M(); m.set("a", 5); return m.f * 10 + m.size; }`;
    expect(await runStandalone(src, false)).toBe(11);
  });

  it("the tailwindcss `U` class runs host-free when it is the first Map use", async () => {
    expect(await runStandalone(TAILWIND_U + TAILWIND_PROBE, true)).toBe(31);
  });

  it("the tailwindcss `U` class runs host-free after an earlier Map-typed declaration (was: hierarchy CE)", async () => {
    expect(await runStandalone(EARLIER_MAP_USE + TAILWIND_U + TAILWIND_PROBE, true)).toBe(31);
  });

  it("a constructor-only field reads back its value instead of NaN", async () => {
    const src = `class Counter extends Map {
      constructor() { super(); this.n = 5; }
      bump() { this.n = this.n + 1; return this.n; }
    }
    export function test() { const c = new Counter(); c.set("a", 1); return c.n * 100 + c.bump() * 10 + c.size; }`;
    expect(await runStandalone(src, true)).toBe(5 * 100 + 6 * 10 + 1);
  });

  it("field initializers run after super(iterable) and a Set carrier keeps its brand", async () => {
    const src = `class Seeded extends Map {
      tag = 7;
      constructor(it) { super(it); }
    }
    class Labeled extends Set {
      label = "s";
      describe() { return this.label + this.size; }
    }
    export function test() {
      const s = new Seeded([["a", 1], ["b", 2]]);
      const l = new Labeled();
      l.add(1); l.add(2); l.add(2);
      return s.size * 100 + s.tag * 10 + (l.describe() === "s2" ? 1 : 0);
    }`;
    expect(await runStandalone(src, true)).toBe(2 * 100 + 7 * 10 + 1);
  });

  // Anti-vacuity control: the same probe over a FIELD-LESS subclass took the
  // pre-existing externref-backed path on the parent commit too. If this
  // stopped answering, the harness (not the carrier) would be what changed.
  it("control: a field-less subclass keeps the pre-existing externref-backed answer", async () => {
    const src = `var FACT = (k) => k + "!";
    var V = class extends Map {
      get(r) { let t = super.get(r); return t === void 0 && (t = FACT(r), this.set(r, t)), t; }
    };
    export function test() { const v = new V(); v.get("x"); return v.size + (v.get("x") === "x!" ? 10 : 0); }`;
    expect(await runStandalone(src, true)).toBe(11);
  });

  it("a declared accessor is still a clean refusal", async () => {
    const r = await compile(
      `class A extends Map<string, number> { get tag(): number { return 3; } }
      export function test(): number { return new A().tag; }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/#6754/);
  });

  it("subclassing a field-bearing collection subclass is a clean refusal", async () => {
    const r = await compile(
      `class A extends Map<string, number> { tag = 1; }
       class B extends A { constructor() { super(); } }
       export function test(): number { return new B().tag; }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/stores instance fields on its native collection/);
  });

  it("the JS-host lane still compiles the tailwindcss shape (host externClass path)", async () => {
    const r = await compile(EARLIER_MAP_USE + TAILWIND_U + TAILWIND_PROBE, { allowJs: true, fileName: "input.js" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
