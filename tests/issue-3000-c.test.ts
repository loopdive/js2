// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3000-C — IR constructor emission (flat classes).
//
// BEFORE this slice the selector CLAIMED a flat class's constructor
// (`${Class}_new`) — removing it from the `class-method`/`body-shape-rejected`
// telemetry — but Phase-B integration never BUILT a `ConstructorDeclaration`
// (`integration.ts` iterated only methods + accessors) and `from-ast`'s ctor
// arm THREW ("constructor body lowering is Phase C, not B"). So the ctor claim
// was BYTE-INERT: the legacy `${Class}_new` body still emitted. The re-grounding
// measured exactly this — `Animal_new` ABSENT from `irCompiledFuncs`.
//
// #3000-C made the claim honest; #3522 retired its original allocation-owning
// IR shape. `from-ast` now lowers the source body into `${Class}_init`, whose
// final parameter is the already allocated `this`, and synthesises the
// implicit `return this` epilogue. An AST-free `${Class}_new` support wrapper
// owns the one allocation and tail-calls that exact init source unit.
//
// PROOF OF GENUINE EMISSION (non-vacuity): `CompileResult.irCompiledFuncs` lists
// the members whose slots were ACTUALLY patched with an IR body — a selector
// claim alone does not imply this (a claimed member whose class has no shape, or
// that fails Phase-B build, is skipped and stays byte-inert). We assert
// `${Class}_new` appears there — in BOTH the host (externref) and native
// (`$AnyString`) string lanes — with zero post-claim demotions, and that
// `new Class(...)` round-trips field reads correctly through the production
// runtime.
//
// SCOPE: FLAT classes only. `extends`/`super` ctor chaining is #3000-E (builds
// on this). The IR ctor path runs ONLY the ctor body — parameter properties
// (`constructor(private x)`) and PropertyDeclaration initialisers (`x = 5`) run
// at construction but are NOT lowered here, so the selector rejects those
// classes to legacy (correct construction preserved). See the guard tests.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// Mirrors website/playground/examples/js/classes.ts's flat `Animal`: a string
// private field (`#name`) + a numeric one (`#age`), both set in the ctor body.
const ANIMAL = `
  class Animal {
    #name: string;
    #age: number;
    constructor(name: string, age: number) {
      this.#name = name;
      this.#age = age;
    }
    get name(): string { return this.#name; }
    set name(value: string) { this.#name = value; }
    get age(): number { return this.#age; }
    speak(): string { return this.#name + " makes a sound"; }
  }
  export function test(): string {
    const a = new Animal("Rex", 4);
    a.name = "Rex Jr.";
    return a.name + "|" + a.speak() + "|" + a.age.toString();
  }
`;

describe("#3000-C — IR constructor emission (flat classes) — genuine emission", () => {
  for (const nativeStrings of [false, true]) {
    const lane = nativeStrings ? "native/standalone ($AnyString)" : "host (externref)";

    it(`emits ${"Animal_new"} via IR (not byte-inert) — ${lane}`, async () => {
      const r = await compile(ANIMAL, { fileName: "test.ts", experimentalIR: true, nativeStrings });
      expect(r.success).toBe(true);
      const compiled = new Set(r.irCompiledFuncs ?? []);
      // THE acceptance criterion: the constructor slot is ACTUALLY patched with
      // an IR body. Before #3000-C this was absent (byte-inert selector claim).
      expect(compiled.has("Animal_new"), `Animal_new should be IR-emitted in ${lane}`).toBe(true);
      // No post-claim build/verify/lower/parity demotion for the ctor.
      const demoted = (r.irPostClaimErrors ?? []).filter((e) => e.func === "Animal_new");
      expect(demoted).toEqual([]);
    });
  }

  it("new Animal(...) round-trips field reads correctly through the production runtime", async () => {
    const exports = await compileAndInstantiate(ANIMAL);
    expect(String((exports.test as () => unknown)())).toBe("Rex Jr.|Rex Jr. makes a sound|4");
  });

  it("a purely numeric flat class ctor emits + constructs correctly", async () => {
    const src = `
      class Point { x: number; y: number;
        constructor(x: number, y: number) { this.x = x; this.y = y; }
      }
      export function test(): number { const p = new Point(3, 4); return p.x + p.y; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(new Set(r.irCompiledFuncs ?? []).has("Point_new")).toBe(true);
    const exports = await compileAndInstantiate(src);
    expect(Number((exports.test as () => unknown)())).toBe(7);
  });

  it("an empty constructor init emits and its AST-free wrapper constructs", async () => {
    const src = `
      class E { constructor() {} }
      export function test(): number { const e = new E(); e; return 42; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(new Set(r.irCompiledFuncs ?? []).has("E_new")).toBe(true);
    const exports = await compileAndInstantiate(src);
    expect(Number((exports.test as () => unknown)())).toBe(42);
  });
});

describe("#3000-C — construction-effect guards (reject to legacy, stay correct)", () => {
  // A PropertyDeclaration initialiser runs at construction; the current IR
  // init path lowers only the explicit ctor body, so this remains direct.
  it("class with a field initialiser is NOT IR-claimed but still constructs correctly", async () => {
    const src = `
      class C { x: number = 5; constructor(y: number) { this.x = this.x + y; } }
      export function test(): number { return new C(10).x; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(new Set(r.irCompiledFuncs ?? []).has("C_new")).toBe(false); // deferred to legacy
    const exports = await compileAndInstantiate(src);
    expect(Number((exports.test as () => unknown)())).toBe(15); // 5 + 10 — initialiser ran
  });

  // A parameter property declares and assigns a field outside the explicit
  // body, so it remains direct until that source effect is represented in IR.
  it("class with a parameter property is NOT IR-claimed", async () => {
    const src = `
      class D { constructor(private v: number) {} getV(): number { return this.v; } }
      export function test(): number { return new D(7).getV(); }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(new Set(r.irCompiledFuncs ?? []).has("D_new")).toBe(false); // deferred to legacy
  });
});
