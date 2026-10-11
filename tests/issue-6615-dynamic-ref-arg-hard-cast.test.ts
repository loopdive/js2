// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6615 / #5383 S28 — a DYNAMIC call/construct hard-casts every externref
// argument into the callee's declared ref formal, so a parameter typed only by
// its own default initializer (`cal = "iso8601"` ⇒ `string`) TRAPS on
// `undefined` and on every wrong-typed value.
//
// Measured on BOTH trees by file-copy revert of `src/codegen/extern-arg-marshal.ts`
// + `src/codegen/index.ts` + `src/codegen/expressions/new-super.ts` +
// `src/codegen/standalone-class-construct.ts` (2026-09-15):
//   base tree:   3 fail / 1 pass    branch: 4 pass
//
// The spelling trap is the mirror of #6613/#6614's: the construct must be
// DYNAMIC (`new C(…)` through a value). Written as a direct `new PD(1, 2, 3, x)`
// every case passes on both trees — the static call site coerces at compile
// time and never reaches this marshal — and the witness is vacuous.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

const STANDALONE = { target: "standalone", hostBridge: "off" } as const;

/** Compile ONE standalone module and read a string back through its exports. */
async function runStandalone(source: string, expr: string): Promise<string> {
  const entry = "/main.js";
  const src = `${source}
let __s = "";
export function prepare() { try { __s = "" + (${expr}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compileMulti({ [entry]: src }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...STANDALONE,
  } as never);
  if (!result.success) return `CE ${result.errors?.[0]?.message?.slice(0, 160)}`;
  const imports = (result.importObject ?? {}) as Record<string, unknown> & {
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary as Uint8Array, imports as never);
  imports.__setInstance?.(instance);
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  exports.__module_init?.();
  let out = "";
  const len = exports.prepare!();
  for (let k = 0; k < Math.min(len, 400); k++) out += String.fromCharCode(exports.at!(k));
  return out;
}

const CLASS = `
class PD {
  constructor(y, m, d, cal = "iso8601") {
    this.cal = cal;
    this.t = typeof cal;
    this.isNull = cal === null;
  }
}
function mk(C, a, b, c, d) { return new C(a, b, c, d); }
function mk3(C, a, b, c) { return new C(a, b, c); }
function probe(v) {
  try { mk(PD, 2000, 5, 2, v); return "no-throw"; }
  catch (e) { return (e instanceof TypeError) + "/" + (e && e.constructor === TypeError); }
}
`;

describe("#6615 dynamic ref-argument marshal", () => {
  it("applies the default for a PRESENT-but-undefined argument (base tree: TRAP illegal cast)", async () => {
    expect(await runStandalone(CLASS, `mk(PD, 2020, 12, 24, undefined).cal`)).toBe("iso8601");
    // The default's own TYPE must be observed too — a marshal that merely
    // stopped trapping could hand the body a null and answer "object".
    expect(await runStandalone(CLASS, `mk(PD, 2020, 12, 24, undefined).t`)).toBe("string");
  });

  it("keeps the MISSING-argument and matching-type paths exactly as they were", async () => {
    // Controls, asserted FIRST-class rather than inferred: both already passed
    // on the base tree, so a regression here is this change's fault.
    expect(await runStandalone(CLASS, `mk3(PD, 2020, 12, 24).cal`)).toBe("iso8601");
    expect(await runStandalone(CLASS, `mk(PD, 2020, 12, 24, "gregory").cal`)).toBe("gregory");
  });

  it("throws a real, catchable TypeError for a value the formal cannot hold (base tree: TRAP)", async () => {
    // `assert.throws(TypeError, …)` reads BOTH of these, which is why the arm
    // builds an error INSTANCE rather than throwing a bare string.
    for (const value of [`null`, `true`, `1`, `{}`, `Symbol()`]) {
      expect(await runStandalone(CLASS, `probe(${value})`)).toBe("true/true");
    }
  });

  it("pins what a defaulted ref formal still CANNOT express: `null` (a documented residual)", async () => {
    // Spec: the body observes `null` and the default does NOT fire. A
    // `(ref null $string)` formal cannot carry that — the callee's prologue
    // fires a ref-typed default on `ref.is_null`, so a typed null is
    // indistinguishable from "absent". The marshal therefore throws rather than
    // silently applying the default, which is also what this corpus wants
    // (`calendar-wrong-type.js` expects a TypeError for `null`). Pinned as an
    // expectation so a future widening that CAN carry null has to update it.
    expect(await runStandalone(CLASS, `mk(PD, 2000, 5, 2, null).isNull`)).toMatch(/^!/);
  });
});
