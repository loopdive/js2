// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3000 Phase-1b — string-field-shape projection.
//
// Before this slice, `buildIrClassShapes` (src/codegen/index.ts) projected each
// class field's IR type from the *legacy* struct ValType via `valTypeToIrField`,
// which returned `null` for a `string` field (externref / `(ref $AnyString)` is
// ambiguous in host mode — it can't tell a string from an `any`/object). A
// single string field therefore rejected the WHOLE class: it got no
// `IrClassShape`, so Phase-B integration skipped ALL its members (accessors,
// methods, ctor) and they stayed byte-inert on legacy. classes.ts's `Animal`
// (which has `#name: string`) was blocked this way, gating the entire #3000
// family for string-field classes (documented as the BLOCKER in the #3000-B
// notes + tests/issue-3000-b.test.ts's header).
//
// This slice re-derives each field's IR type from the AST/checker (keyed by the
// SAME mangled name legacy stores in `structFields`) and adopts it only when it
// is byte-compatible with the legacy struct slot (a field-level parity guard).
// A `string` field now projects to `IrType.string`, which lowers to the exact
// per-lane carrier the struct already holds (host → externref; native →
// `(ref $AnyString)`), so `class.get`/`class.set` produce the struct's own
// ValType and the #1370 method-signature parity guard sees identical typeIdx on
// both sides.
//
// PROOF OF GENUINE EMISSION (non-vacuity): a mere selector CLAIM does not imply
// emission — a claimed member whose class has no shape is skipped in Phase B and
// stays byte-inert. `CompileResult.irCompiledFuncs` (#3000) lists the members
// whose slots were ACTUALLY patched with an IR body. We assert the string-field
// class's accessors + method appear there — in BOTH the host (externref) and
// native (`$AnyString`) string lanes — with zero post-claim demotions, and that
// they round-trip strings correctly through the production runtime.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

// Mirrors website/playground/examples/js/classes.ts's flat `Animal`: a string
// private field (`#name`) alongside a numeric one (`#age`), get/set accessors
// over the string slot, a get accessor over the numeric slot, and an instance
// method that reads + concatenates the string field.
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

const STRING_MEMBERS = ["Animal_get_name", "Animal_set_name", "Animal_get_age", "Animal_speak"];

describe("#3000 Phase-1b — string-field class gets an IrClassShape (genuine emission)", () => {
  // The host (externref) string lane (`nativeStrings: false`) was removed by
  // #6979 S7; both remaining lanes carry `(ref $AnyString)`: the JS target and
  // the no-host `target: "standalone"` build.
  for (const standalone of [false, true]) {
    const lane = standalone ? "standalone ($AnyString)" : "js ($AnyString)";

    it(`emits every string-field-class member via IR — ${lane}`, async () => {
      const r = await compile(ANIMAL, {
        fileName: "test.ts",
        experimentalIR: true,
        ...(standalone ? { target: "standalone" as const } : {}),
      });
      expect(r.success).toBe(true);
      const compiled = new Set(r.irCompiledFuncs ?? []);
      // Every accessor + method genuinely IR-emitted (NOT byte-inert). Without
      // Phase-1b, `Animal` gets no shape and NONE of these appear here.
      for (const m of STRING_MEMBERS) {
        expect(compiled.has(m), `${m} should be IR-emitted in ${lane}`).toBe(true);
      }
      // The string-field members produce no post-claim build/verify/lower/parity
      // demotion — the field-level parity guard holds in both lanes.
      const demoted = (r.irPostClaimErrors ?? []).filter((e) => STRING_MEMBERS.includes(e.func));
      expect(demoted).toEqual([]);
    });
  }

  it("string round-trips correctly through the IR-emitted accessors + method", async () => {
    // Getter, setter (string slot), numeric getter, and a private-string read +
    // concat in a method — all IR-emitted — via the production runtime.
    const exports = await compileToWasm(ANIMAL);
    expect(String((exports.test as () => unknown)())).toBe("Rex Jr.|Rex Jr. makes a sound|4");
  });

  it("a purely numeric flat class still emits (no regression) and a string one now joins it", async () => {
    const r = await compile(
      `
        class NumOnly { #n: number; constructor(n: number) { this.#n = n; } get n(): number { return this.#n; } }
        class StrOnly { #s: string; constructor(s: string) { this.#s = s; } get s(): string { return this.#s; } }
        export function test(): number { return new NumOnly(1).n + new StrOnly("x").s.length; }
      `,
      { fileName: "test.ts", experimentalIR: true },
    );
    expect(r.success).toBe(true);
    const compiled = new Set(r.irCompiledFuncs ?? []);
    expect(compiled.has("NumOnly_get_n")).toBe(true); // #3000-B (numeric) — unchanged
    expect(compiled.has("StrOnly_get_s")).toBe(true); // #3000 Phase-1b (string) — this slice
  });
});
