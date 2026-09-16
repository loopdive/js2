// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6619 / #5383 S32 — the f64 twin of #6615: a DYNAMIC call/construct
// argument marshalled into an f64 formal silently unboxed a Symbol or
// BigInt to NaN instead of throwing TypeError (§7.1.4 ToNumber).
//
// Measured on BOTH trees by file-copy revert of `src/codegen/extern-arg-marshal.ts`
// + `src/codegen/index.ts` + `src/codegen/expressions/new-super.ts` +
// `src/codegen/standalone-class-construct.ts` (2026-09-16):
//   base tree:   3 fail / 2 pass    branch: 5 pass
//
// Like #6615, the construct must be DYNAMIC (`new C(...)` through a value) —
// a static `new C(x)` coerces at compile time and never reaches this
// marshal, so a witness written that way is vacuous.
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
class D {
  constructor(y = 0) {
    this.y = y;
  }
}
function mk(C, a) { return new C(a); }
function probe(v) {
  try { return "" + mk(D, v).y; }
  catch (e) { return (e instanceof TypeError) + "/" + (e && e.constructor === TypeError); }
}
`;

describe("#6619 f64 dynamic-argument marshal: Symbol/BigInt must throw, not silently unbox to NaN", () => {
  it("a dynamic construct with a Symbol argument throws TypeError (base tree: NaN, no throw)", async () => {
    expect(await runStandalone(CLASS, `probe(Symbol())`)).toBe("true/true");
  });

  it("a dynamic construct with a BigInt argument throws TypeError (base tree: NaN, no throw)", async () => {
    expect(await runStandalone(CLASS, `probe(0n)`)).toBe("true/true");
  });

  it("an ordinary number argument still unboxes normally (unchanged control)", async () => {
    expect(await runStandalone(CLASS, `mk(D, 5).y`)).toBe("5");
  });

  it("an omitted argument still runs the default, not the Symbol/BigInt throw (#5380 sentinel composition)", async () => {
    const DEFAULTED = `
class D2 {
  constructor(y = 7) { this.y = y; }
}
function mk2(C) { return new C(); }
function mk2u(C, v) { return new C(v); }
`;
    expect(await runStandalone(DEFAULTED, `mk2(D2).y`)).toBe("7");
    expect(await runStandalone(DEFAULTED, `mk2u(D2, undefined).y`)).toBe("7");
  });

  it("a static (non-dynamic) construct is unaffected either way — the marshal is never reached", async () => {
    // CONTROL: `new D(...)` written directly coerces at compile time through
    // `type-coercion.ts`'s STATIC arm, never `extern-arg-marshal.ts` — this
    // slice's fix does not touch that arm, so this must answer IDENTICALLY on
    // both trees (whatever that pre-existing, unrelated leniency answers) —
    // a witness that only passed on the branch tree would be vacuous, not a
    // fix. Not asserting the exact value: only that this fix leaves it alone.
    const base = await runStandalone(CLASS, `new D(Symbol()).y`);
    expect(base).not.toBe("true/true"); // not routed through this fix's throw
    expect(base).toMatch(/^-?\d+(\.\d+)?$/); // the pre-existing leniency: some number, not a throw
  });
});
