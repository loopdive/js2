// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3000-E — IR inheritance / `super` emission (single-level `extends` of a
// local user class).
//
// Builds on #3000-C's constructor substrate, now retired by #3522 into an
// AST-free `_new` allocation wrapper plus a source-owned `_init`. Before this slice a
// subclass's members (`Dog_new`, `Dog_speak`, `Dog_get_breed`) all rejected as
// `class-method`: `buildIrClassShapes` skipped ANY `extends` class, the Phase-B
// integration walk skipped it wholesale, and the selector's `hasParent` arm
// deferred every instance member. #3000-E adds the substrate:
//
//   - `buildIrClassShapes` now projects a single-level subclass of a LOCAL user
//     class, walking the ancestor chain to recover inherited (incl. string)
//     fields and setting `IrClassShape.parent`.
//   - Two new IR instrs: `class.super_init` (a derived ctor's `super(args)` →
//     the PARENT's `<parent>_init` on the already-allocated `self`, NOT a
//     second alloc) and `class.super_call` (`super.method()` → the parent's
//     method slot, bypassing a subclass override).
//   - The selector claims subclass instance members under a local parent and
//     accepts `super(...)` / `super.method()` in the Phase-1 body/expr gates.
//
// PROOF OF GENUINE EMISSION (non-vacuity): `CompileResult.irCompiledFuncs` lists
// members whose slots were ACTUALLY patched with an IR body — a selector claim
// alone doesn't imply this. We assert `Dog_new`, `Dog_speak`, `Dog_get_breed`
// appear there in BOTH string lanes (host externref + native `$AnyString`), with
// ZERO post-claim demotions, and that a `new Dog(...)` round-trips: `super(...)`
// runs the parent init EXACTLY once (inherited fields correct), `super.method()`
// dispatches to the parent slot, and both `instanceof` checks hold.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// Mirrors website/playground/examples/js/classes.ts's `Animal`/`Dog`: a string +
// numeric private field on the flat parent, a `super(...)`-chaining ctor and a
// `super.method()`-chaining override on the subclass, plus a subclass getter.
const DOG = `
  class Animal {
    #name: string;
    #age: number;
    constructor(name: string, age: number) {
      this.#name = name;
      this.#age = age;
    }
    speak(): string { return this.#name + " makes a sound"; }
    describe(): string { return this.#name + "/" + this.#age.toString(); }
  }
  class Dog extends Animal {
    #breed: string;
    constructor(name: string, age: number, breed: string) {
      super(name, age);
      this.#breed = breed;
    }
    speak(): string { return super.speak() + " woof"; }
    get breed(): string { return this.#breed; }
    breedInfo(): string { return this.#breed; }
  }
  // Driver avoids accessor call sites (d.breed) so it stays IR too; it exercises
  // the IR-emitted Dog_new (super-chain), Dog_speak (super.method) and methods.
  export function test(): string {
    const d = new Dog("Rex", 4, "Lab");
    return d.describe() + "|" + d.speak() + "|" + d.breedInfo() + "|" +
      (d instanceof Animal ? "A" : "") + (d instanceof Dog ? "D" : "");
  }
`;

const DOG_MEMBERS = ["Dog_new", "Dog_speak", "Dog_get_breed"] as const;

describe("#3000-E — IR inheritance/super emission — genuine emission (both lanes)", () => {
  for (const nativeStrings of [false, true]) {
    const lane = nativeStrings ? "native/standalone ($AnyString)" : "host (externref)";

    it(`IR-emits Dog_new / Dog_speak / Dog_get_breed — ${lane}`, async () => {
      const r = await compile(DOG, {
        fileName: "test.ts",
        experimentalIR: true,
        nativeStrings,
        trackIrOutcomes: true,
      });
      expect(r.success).toBe(true);
      const compiled = new Set(r.irCompiledFuncs ?? []);
      // THE acceptance criterion: the subclass member slots are ACTUALLY patched
      // with IR bodies (byte-inert / absent before #3000-E). This closes
      // criterion #3 — classes.ts's Dog is the last IR-uncovered class.
      for (const m of DOG_MEMBERS) {
        expect(compiled.has(m), `${m} should be IR-emitted in ${lane}`).toBe(true);
        expect(
          r.irOutcomes?.find((outcome) => outcome.displayName === m),
          `${m} should compile once in ${lane}`,
        ).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }
      // The parent flat class stays IR too (regression guard for #3000-C/1b).
      expect(compiled.has("Animal_new")).toBe(true);
      expect(compiled.has("Animal_speak")).toBe(true);
      // No post-claim build/verify/lower/parity demotion for any subclass member.
      const demoted = (r.irPostClaimErrors ?? []).filter((e) => (DOG_MEMBERS as readonly string[]).includes(e.func));
      expect(demoted).toEqual([]);
    });
  }
});

describe("#3000-E — runtime: super-chain + super.method + inherited reads", () => {
  it("legacy and IR produce identical output (super init once, super.method dispatch)", async () => {
    const legacy: any = await compileAndInstantiate(DOG, { fileName: "test.ts", experimentalIR: false });
    const ir: any = await compileAndInstantiate(DOG, { fileName: "test.ts", experimentalIR: true });
    // `Rex/4` — describe() reads Animal's inherited #name/#age (super(...) ran the
    // parent init exactly once — a double-init would corrupt the fields).
    // `Rex makes a sound woof` — Dog.speak() → super.speak() (Animal_speak, Dog
    // receiver) + " woof". `Lab` — Dog's own #breed. `AD` — instanceof both.
    const expected = "Rex/4|Rex makes a sound woof|Lab|AD";
    expect(String(ir.test())).toBe(expected);
    expect(String(legacy.test())).toBe(expected);
  });
});

describe("#3000-E — subclass of a BUILTIN parent stays on legacy (clean fallback)", () => {
  it("a `class MyErr extends Error` member is NOT IR-claimed (no local-parent shape)", async () => {
    const src = `
      class MyErr extends Error {
        code: number;
        constructor(code: number) { super("boom"); this.code = code; }
        info(): number { return this.code; }
      }
      export function test(): number { return new MyErr(7).info(); }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    const compiled = new Set(r.irCompiledFuncs ?? []);
    // `Error` is a builtin/externref-backed parent — no IR shape, so the subclass
    // members must NOT be IR-emitted (the substrate models user-class parents only).
    expect(compiled.has("MyErr_new")).toBe(false);
    expect(compiled.has("MyErr_info")).toBe(false);
    // And crucially: no post-claim demotion — the selector never claimed them
    // (the `parentIsLocalClass` gate mirrors the shape builder), so there is
    // nothing to demote.
    const demoted = (r.irPostClaimErrors ?? []).filter((e) => e.func === "MyErr_new" || e.func === "MyErr_info");
    expect(demoted).toEqual([]);
  });
});
