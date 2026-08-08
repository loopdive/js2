// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3920) Reflection over a closed compiler struct in the STANDALONE lane.
//
// The defect: every reflective operation answered correctly when the receiver
// was statically typed, and three of five silently answered "nothing" the
// moment the receiver arrived through an `any` binding or a call boundary.
// `for…in` enumerated zero of an instance's properties, `Object.keys` returned
// an empty array, and `in` said false — no throw, no refusal, just a wrong
// answer. See the issue file for the full receiver x operation matrix.
//
// ── WHY THIS FILE PINS BUILTINS TOO, AND WHY THAT IS NOT PADDING ───────────
//
// `Object.keys(new Date(0))` answers `[]` on unfixed `main` — correctly, but
// BY ACCIDENT: `__object_keys` had no closed-struct arms at all, so it
// enumerated nothing, and nothing happens to be the right answer for a Date.
// The moment enumeration starts working it would answer `["timestamp"]` unless
// the user-declared-vs-builtin predicate is in place. That is not a tuning
// slip; it is the structural reason #4071 implemented this sharing, MEASURED
// it, and reverted it.
//
// So a regression test that only checks the user-class direction passes while
// builtin internals silently start leaking. Both directions are pinned here,
// and they must stay pinned together.
//
// The `getOwnPropertyNames` cases are a live wrong answer being FIXED, not a
// guard on existing behaviour: on `main` today standalone answers 7 for
// `/ab/g` (six internal RegExp carrier fields plus one) and 1 for `new Date(0)`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
class Pt {
  x: any; y: any; z: any;
  constructor(a: any, b: any, c: any) { this.x = a; this.y = b; this.z = c; }
}
function Bag(this: any, s: any) { this.s = s; this.t = s; this.u = s; }

// Receiver laundered through a parameter: the compiler cannot see the shape.
function pKeys(o: any): number { return Object.keys(o).length; }
function pForin(o: any): number { let n = 0; for (const k in o) n++; return n; }
function pFirstKey(o: any): string { for (const k in o) return k; return ""; }
function pJoin(o: any): string { let s = ""; for (const k in o) s = s + k + ","; return s; }

// (#3920's own repro shape) A property assigned under a condition is
// PRESENCE-TRACKED: it occupies a struct slot unconditionally but carries a
// presence bit saying whether this instance actually got it. Enumeration must
// read that bit, which is the half that keeps the answer independent of where
// the value is physically stored.
function Cond(this: any, seed: any) { this.seed = seed; if (seed > 0) { this.p = 7; } }

// ---- class instance, receiver erased to \`any\` ----
export function classKeys(): number { const p: any = new Pt(1, 2, 3); return Object.keys(p).length; }
export function classForin(): number { const p: any = new Pt(1, 2, 3); return pForin(p); }
export function classIn(): number { const p: any = new Pt(1, 2, 3); return ("y" in p) ? 1 : 0; }
export function classInMissing(): number { const p: any = new Pt(1, 2, 3); return ("nope" in p) ? 1 : 0; }
export function classGopn(): number { const p: any = new Pt(1, 2, 3); return Object.getOwnPropertyNames(p).length; }
export function classHasOwn(): number { const p: any = new Pt(1, 2, 3); return p.hasOwnProperty("x") ? 1 : 0; }
export function classKeysViaParam(): number { return pKeys(new Pt(1, 2, 3)); }
// Order is compared INSIDE wasm: a native string carrier does not marshal
// across the standalone boundary (it arrives as an opaque object), so a test
// that returned the key list would compare {} against a string and fail for a
// reason that has nothing to do with enumeration.
export function classForinOrder(): number { const p: any = new Pt(1, 2, 3); return pJoin(p) === "x,y,z," ? 1 : 0; }

// ---- constructor-function ("fnctor") instance ----
export function fnctorKeys(): number { const b: any = new (Bag as any)(5); return Object.keys(b).length; }
export function fnctorForin(): number { const b: any = new (Bag as any)(5); return pForin(b); }
export function fnctorIn(): number { const b: any = new (Bag as any)(5); return ("t" in b) ? 1 : 0; }
export function fnctorForinOrder(): number { const b: any = new (Bag as any)(5); return pJoin(b) === "s,t,u," ? 1 : 0; }

// ---- statically-typed receiver: worked before, must keep working ----
export function typedForin(): number { const p = new Pt(1, 2, 3); let n = 0; for (const k in p) n++; return n; }
export function typedKeys(): number { const p = new Pt(1, 2, 3); return Object.keys(p).length; }

// ---- conditionally-assigned property: presence-bit tracked ----
export function conditionalKeys(): number { const c: any = new (Cond as any)(1); return pKeys(c); }
export function conditionalForin(): number { const c: any = new (Cond as any)(1); return pForin(c); }
export function conditionalIn(): number { const c: any = new (Cond as any)(1); return ("p" in c) ? 1 : 0; }
export function conditionalAbsentKeys(): number { const c: any = new (Cond as any)(-1); return pKeys(c); }
export function conditionalAbsentForin(): number { const c: any = new (Cond as any)(-1); return pForin(c); }
export function conditionalAbsentIn(): number { const c: any = new (Cond as any)(-1); return ("p" in c) ? 1 : 0; }

// ---- deleted property must disappear from every surface ----
export function deletedKeys(): number { const p: any = new Pt(1, 2, 3); delete p.y; return pKeys(p); }
export function deletedForin(): number { const p: any = new Pt(1, 2, 3); delete p.y; return pForin(p); }
export function deletedFirstKey(): number { const p: any = new Pt(1, 2, 3); delete p.y; return pFirstKey(p) === "x" ? 1 : 0; }

// ---- object literal control: never regressed, must stay right ----
export function literalKeys(): number { const o: any = { a: 1, b: 2, c: 3 }; return pKeys(o); }
export function literalForin(): number { const o: any = { a: 1, b: 2, c: 3 }; return pForin(o); }

// ---- builtin carriers: internals are NOT own properties ----
export function regexpKeys(): number { const r: any = /ab/g; return pKeys(r); }
export function regexpForin(): number { const r: any = /ab/g; return pForin(r); }
export function regexpGopn(): number { const r: any = /ab/g; return Object.getOwnPropertyNames(r).length; }
export function dateKeys(): number { const d: any = new Date(0); return pKeys(d); }
export function dateForin(): number { const d: any = new Date(0); return pForin(d); }
export function dateGopn(): number { const d: any = new Date(0); return Object.getOwnPropertyNames(d).length; }
export function mapKeys(): number { const m: any = new Map(); return pKeys(m); }

// ---- arrays keep their index-key enumeration (the vec arm) ----
export function arrayKeys(): number { const a: any = [10, 20, 30]; return pKeys(a); }
export function arrayForin(): number { const a: any = [10, 20, 30]; return pForin(a); }
`;

async function instantiate(standalone: boolean) {
  const result = await compile(SOURCE, {
    fileName: "reflection.ts",
    skipSemanticDiagnostics: true,
    ...(standalone ? { target: "standalone" as const } : {}),
  });
  expect(result.binary?.length, "compiled").toBeGreaterThan(0);
  const imports = standalone ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  return {
    call: (name: string) => (instance.exports[name] as () => unknown)(),
    bytes: result.binary.length,
  };
}

describe("#3920 standalone reflection over closed compiler structs", () => {
  it("has no host imports (the lane under test is genuinely standalone)", async () => {
    const result = await compile(SOURCE, {
      fileName: "reflection.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    const mod = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  });

  describe("standalone", () => {
    // Every expectation below is the answer Node gives for the same program.
    const EXPECTED: Record<string, number | string> = {
      // The three surfaces this issue is about. All were 0 before the fix.
      classKeys: 3,
      classForin: 3,
      classIn: 1,
      fnctorKeys: 3,
      fnctorForin: 3,
      fnctorIn: 1,
      classKeysViaParam: 3,

      // `in` must still say false for a name the shape does not carry — an arm
      // that answered 1 on any shape match would pass the tests above and be
      // wrong here.
      classInMissing: 0,

      // The two dynamic surfaces that already worked: guard against a fix that
      // trades one hole for another.
      classGopn: 3,
      classHasOwn: 1,

      // Statically-typed receivers never entered the dynamic runtime and so
      // never showed the bug; they must not regress now that it is wired.
      typedForin: 3,
      typedKeys: 3,

      // Enumeration order is property-creation order, not field-table order.
      classForinOrder: 1,
      fnctorForinOrder: 1,

      // Presence bits: a conditionally-assigned property enumerates only when
      // it was actually assigned. This is the half that makes enumeration
      // layout-independent — names from the field list, liveness from the
      // base presence words.
      // NOTE: the conditionally-assigned (`presence-tracked`) exports are
      // deliberately NOT pinned to absolute values here — see the cross-lane
      // test below and the issue file. A property first written OUTSIDE the
      // constructor is not stored on the closed struct at all, in EITHER lane,
      // so every surface under-reports it identically. That is a separate
      // storage gap (#3537 expando carrier bag), not this issue's enumeration
      // defect, and pinning a number here would either encode a bug as
      // expected or fail for a reason this change does not own.

      // A deleted property is gone from every surface, and does not leave a
      // hole in the order.
      deletedKeys: 2,
      deletedForin: 2,
      deletedFirstKey: 1,

      literalKeys: 3,
      literalForin: 3,

      // Builtin carriers: internal slots are not own properties. `Date` and
      // `RegExp` are the two #4071 measured breaking, and `*Gopn` are live
      // wrong answers on main (7 and 1) that this change fixes.
      regexpKeys: 0,
      regexpForin: 0,
      regexpGopn: 0,
      dateKeys: 0,
      dateForin: 0,
      dateGopn: 0,
      mapKeys: 0,

      arrayKeys: 3,
      arrayForin: 3,
    };

    for (const [name, expected] of Object.entries(EXPECTED)) {
      it(`${name} -> ${JSON.stringify(expected)}`, async () => {
        const { call } = await instantiate(true);
        expect(call(name)).toBe(expected);
      });
    }
  });

  it("agrees with the JS-host lane on every user-shape surface", async () => {
    // Cross-lane agreement is the acceptance criterion #3920 was filed on.
    // Builtin receivers are excluded: the two lanes have known pre-existing
    // divergences there (host `Object.keys(new Date(0))` answers 1) that are
    // not this issue's to fix and would mask the signal.
    const surfaces = [
      "classKeys",
      "classForin",
      "classIn",
      "classInMissing",
      "classGopn",
      "classHasOwn",
      "classKeysViaParam",
      "classForinOrder",
      "fnctorKeys",
      "fnctorForin",
      "fnctorIn",
      "fnctorForinOrder",
      "typedForin",
      "typedKeys",
      // Cross-lane agreement IS asserted for the conditional shape: #3920 was
      // filed because the two lanes DISAGREED on it (host 1007 / standalone 7
      // on the issue's own repro). They now agree. The remaining shortfall
      // against Node is the separate storage gap noted above.
      "conditionalKeys",
      "conditionalForin",
      "conditionalIn",
      "conditionalAbsentKeys",
      "conditionalAbsentForin",
      "conditionalAbsentIn",
      "deletedKeys",
      "deletedForin",
      "deletedFirstKey",
      "literalKeys",
      "literalForin",
      "arrayKeys",
      "arrayForin",
    ];
    const standalone = await instantiate(true);
    const host = await instantiate(false);
    const diffs: string[] = [];
    for (const name of surfaces) {
      const s = standalone.call(name);
      const h = host.call(name);
      if (s !== h) diffs.push(`${name}: standalone=${String(s)} host=${String(h)}`);
    }
    expect(diffs).toEqual([]);
  });
});
