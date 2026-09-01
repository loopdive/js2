// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5244 — `Temporal.Duration.from({days: 1})` answered "PT0S". TWO independent
// codegen defects, neither of them in the polyfill's field extraction and
// neither of them reproducible by the obvious one-class / one-record probe.
//
// ── 1. The dynamic-`new` ladder never published `__argc` ──────────────────
//
// `new <runtime class value>(…)` — `const t = ce("%Temporal.Duration%");
// new t(…)`, the shape a minified intrinsics registry produces — lowers to a
// `ref.test`-per-class dispatch ladder whose arms `call <Class>_new` directly.
// A constructor with parameter DEFAULTS compiles to a prologue that reads the
// module global `__argc` to tell an omitted slot from a supplied one:
//
//     argc := __argc ; __argc := -1
//     if (argc != -1 && argc <= i) param_i := <default>
//
// The STATIC `new C(…)` site publishes that count; the ladder's arms did not.
// `__argc` is a GLOBAL, so NOT writing it does not mean "no defaults" — it
// means whatever the previously compiled call site left there. A stale small
// count makes the check fire for every parameter past it, discarding the real
// arguments in favour of the initializers.
//
// HONEST LIMIT OF THE ROWS BELOW: they PASS on base. Every reduction tried —
// a shorter construct first, an argc-publishing callee with a reference-typed
// optional (whose prologue never resets the global) before the construct and
// inside the argument list, partial application — left `__argc` at its -1
// sentinel by the time the ctor ran, so the module answered correctly on both
// sides. The stale value only materialised in the polyfill, where
// `ce("%Temporal.Duration%")` publishes it one line before the construct:
//
//   single-module Temporal lane, base    →  after
//   const t = ce("%Temporal.Duration%");
//   const x0 = 0, x3 = 1;
//   String(new t(x0,x0,x0,x3,x0,…))         "PT0S"   →  "P1D"
//   String(new t(0,0,0,1,0,…))              "P1D"    →  "P1D"   (literal args)
//   Temporal.Duration.from(new Duration(0,0,0,1))
//                                           "PT0S"   →  "P1D"
//
// So these rows are PINS on the fixed behaviour, not base-failing regressions;
// the base-failing evidence for defect 1 lives in the Temporal lane (recorded
// in the issue file and in tests/dogfood/temporal-global-harness.mjs). The
// setter rows in the second describe DO fail on base — verified by reverting
// only src/codegen/struct-field-exports.ts.
//
// ── 2. `__sset_<field>` trapped instead of falling through ────────────────
//
// The exported per-field setter is a `ref.test`-per-candidate chain. For a
// collision-shaped (#2009 `$shape`) or class-tagged (#4618 `__tag`) candidate
// the arm's condition appended a refinement with `i32.and` — and `i32.and`
// evaluates BOTH operands, so the refinement's `ref.cast typeIdx` ran for
// receivers `ref.test` had just REJECTED. An unconditional trap, invisible
// because its only caller (`_safeSet`) invokes the setter inside a try/catch
// labelled "not a field of this struct's runtime type". The setter therefore
// aborted at its first guarded arm and never reached the arm that owned the
// receiver; the write landed in the JS sidecar while a compiled `struct.get`
// kept reading the untouched slot.
//
// A guard only EXISTS when two struct types share the field name, which is why
// the "one record" control below passes on base and the two-record case does
// not. `ToTemporalDuration`'s `n[st[i]] = r[st[i]]` loop is the real-world
// instance: the polyfill carries dozens of records with a `days` field.
//
// Base readings for every assertion here were taken on this branch's
// merge-base, 2026-08-31, by reverting only the two src/ changes.

import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";

async function runSingle(source: string): Promise<unknown> {
  const result = await compile(source, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName: "issue-5244.js",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = result.importObject as WebAssembly.Imports & {
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as unknown as Record<string, () => unknown>).test!();
}

const NAMES = Array.from({ length: 10 }, (_, i) => `p${i}`);

/**
 * Ten defaulted formals, mixed argument TYPES, reached through a `Map` so the
 * class is genuinely a runtime VALUE — an object-literal registry or an array
 * element is still resolved statically and would test the control twice.
 */
const DEFAULTED_CLASS = `
const registry = new Map();
// An optional REFERENCE-typed parameter, mirroring the polyfill's \`ce\`: the
// call site publishes \`__argc\` (the callee has optionals) but the prologue
// answers "missing" with \`ref.is_null\` and so never reads or RESETS the
// global. That is the shape the stale value comes from — the emitted module
// does contain the \`global.set\`, but in a reduction this small it did not
// survive to the construct. See the header note.
function intrinsic(key, fallback = null) { return registry.get(key) || fallback; }
class K {
  constructor(${NAMES.map((n) => `${n} = "D"`).join(", ")}) {
${NAMES.map((n) => `    this.${n} = ${n};`).join("\n")}
  }
  label() { return ${NAMES.map((n) => `String(this.${n})`).join(' + "|" + ')}; }
}
registry.set("%K%", K);
`;

describe("#5244 dynamic `new <class value>(…)` publishes the call-site argument count (pins)", () => {
  it("keeps all ten arguments when a SHORTER construct of the same class ran first", async () => {
    await expect(
      runSingle(`${DEFAULTED_CLASS}
function make(args) { const C = intrinsic("%K%"); return new C(...args); }
/** @returns {string} */
export function test() {
  const C = intrinsic("%K%");
  const short = new C("K", 1, 2, "s");
  const full = new C(11, 12, 13, 14, 15, 16, 17, 18, 19, 20);
  return short.label() + " / " + full.label();
}`),
    ).resolves.toBe("K|1|2|s|D|D|D|D|D|D / 11|12|13|14|15|16|17|18|19|20");
  });

  it("mixes numbers, strings and objects across ten formals", async () => {
    await expect(
      runSingle(`${DEFAULTED_CLASS}
/** @returns {string} */
export function test() {
  const C = intrinsic("%K%");
  new C(0, 0, 0, 0);
  const o = { tag: "obj" };
  const inst = new C(1, "two", o, 4, "five", 6, 7, "eight", 9, 10);
  return String(inst.p0) + "|" + String(inst.p1) + "|" + String(inst.p2.tag) + "|" +
         String(inst.p4) + "|" + String(inst.p7) + "|" + String(inst.p9);
}`),
    ).resolves.toBe("1|two|obj|five|eight|10");
  });

  it("still applies the DECLARED defaults for genuinely omitted arguments", async () => {
    // The other half of the same omission. On base this is already correct:
    // the ladder pads an omitted f64 slot with the prologue's sNaN
    // omitted-argument sentinel, which fires the default without consulting
    // `__argc` at all. Pinned so publishing the count cannot break it.
    await expect(
      runSingle(`${DEFAULTED_CLASS}
/** @returns {string} */
export function test() {
  const C = intrinsic("%K%");
  const inst = new C(1, 2);
  return String(inst.p1) + "|" + String(inst.p2) + "|" + String(inst.p9);
}`),
    ).resolves.toBe("2|D|D");
  });

  it("control: the same class constructed by its STATIC name was already correct", async () => {
    await expect(
      runSingle(`${DEFAULTED_CLASS}
/** @returns {string} */
export function test() {
  new K(0, 0, 0, 0);
  return new K(11, 12, 13, 14, 15, 16, 17, 18, 19, 20).label();
}`),
    ).resolves.toBe("11|12|13|14|15|16|17|18|19|20");
  });

  it("survives the module boundary — provider declares the class, consumer constructs it", async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": `${DEFAULTED_CLASS}
export function shortOne() { const C = intrinsic("%K%"); return new C(1, 2, 3, 4).label(); }
export function fullOne() { const C = intrinsic("%K%"); return new C(11, 12, 13, 14, 15, 16, 17, 18, 19, 20).label(); }
`,
        [entry]: `import { shortOne, fullOne } from "./provider";
/** @returns {string} */
export function test() { return shortOne() + " / " + fullOne(); }`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const imports = result.importObject as WebAssembly.Imports & {
      __setInstance?: (i: WebAssembly.Instance) => void;
    };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect((instance.exports as unknown as Record<string, () => unknown>).test!()).toBe(
      "1|2|3|4|D|D|D|D|D|D / 11|12|13|14|15|16|17|18|19|20",
    );
  });
});

describe("#5244 __sset_<field> falls through a rejected candidate instead of trapping", () => {
  const REC5 = "years: 0, months: 0, weeks: 0, days: 0, hours: 0";
  const REC4 = "years: 0, months: 0, weeks: 0, days: 0";

  it("lands a computed-key write in the struct slot when a SECOND record shares the field", async () => {
    // Base: "0" — `__sset_days` trapped on its first (shape-guarded) arm, the
    // runtime swallowed it, the value went to the sidecar and the compiled
    // `struct.get` read the untouched slot.
    await expect(
      runSingle(`
function other() { return { ${REC4} }; }
/** @returns {string} */
export function test() {
  other();
  const K = ["days"];
  const n = { ${REC5} };
  const k = K[0];
  n[k] = 7;
  return String(n.days);
}`),
    ).resolves.toBe("7");
  });

  it("control: ONE record carrying the field already worked (no guard is emitted)", async () => {
    await expect(
      runSingle(`
/** @returns {string} */
export function test() {
  const K = ["days"];
  const n = { ${REC5} };
  const k = K[0];
  n[k] = 7;
  return String(n.days);
}`),
    ).resolves.toBe("7");
  });

  it("accumulates a whole record through a key list, the ToTemporalDuration shape", async () => {
    // Base: "0,0,0" — every iteration's write was swallowed.
    await expect(
      runSingle(`
function other() { return { ${REC4} }; }
const KEYS = ["years", "months", "weeks", "days", "hours"];
/** @returns {string} */
export function test() {
  other();
  const src = { days: 1, hours: 2 };
  const acc = { ${REC5} };
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i];
    const v = src[k];
    if (v !== undefined) acc[k] = v;
  }
  return String(acc.days) + "," + String(acc.hours) + "," + String(acc.years);
}`),
    ).resolves.toBe("1,2,0");
  });

  it("does not write through a candidate the guard rejects", async () => {
    // The guard exists for a reason (#2009): same-shape canonicalization makes
    // `ref.test` match a DIFFERENT struct. Short-circuiting must not turn into
    // "no guard at all" — a write to a record that genuinely lacks the field
    // must leave every same-shaped sibling's slots alone.
    await expect(
      runSingle(`
function other() { return { ${REC4} }; }
/** @returns {string} */
export function test() {
  const victim = other();
  const K = ["hours"];
  const n = { ${REC5} };
  const k = K[0];
  n[k] = 7;
  return String(n.hours) + "," + String(victim.years) + "," + String(victim.days);
}`),
    ).resolves.toBe("7,0,0");
  });
});
