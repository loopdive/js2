// #4154 — `o.#x = v` on a receiver that does not carry the class's private
// brand must throw a CATCHABLE TypeError (§7.3.28 PrivateBrandCheck), not trap.
//
// Before this fix nothing in `compilePropertyAssignment`'s private-accessor
// branch narrowed an `externref` receiver to the setter's declared
// `(ref null $Class)` param, so the generic call-argument repair in
// `fixCallArgTypesInBody` (stack-balance.ts) spliced in a bare
// `any.convert_extern; ref.cast_null $Class`. On a foreign receiver that is an
// UNCATCHABLE `illegal cast` trap: the whole module dies and `assert.throws`
// never sees a value. That is why the two test262 brand-check files could not
// pass even in principle, and why #4149 had to declare a `trap-growth-allow`.
//
// These tests pin BEHAVIOUR, not the instruction sequence: what matters is
// that the throw is catchable and is a real `TypeError` instance, that the
// branded write still lands, and that a side-effecting RHS is evaluated before
// the throw (§13.15.2 evaluates the RHS, then PutValue → PrivateSet performs
// the brand check). Asserting on emitted WAT would pass just as well with a
// `ref.cast` that happened to be spelled differently.
//
// Both lanes are run because they narrow the receiver differently: the gc/host
// lane reaches the setter with a struct ref, standalone with an externref
// carrier (#3232). The trap reproduced on host and, worse, standalone silently
// performed NO write and threw nothing at all.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = { label: string; opts: Record<string, unknown> };

const LANES: readonly Lane[] = [
  { label: "gc/host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

/** Compile `source` on one lane and return its exports. */
async function instantiate(source: string, opts: Record<string, unknown>): Promise<Record<string, () => number>> {
  const r = await compile(source, { fileName: "t.ts", ...opts } as never);
  expect(r.success, r.success ? undefined : (r.errors ?? []).map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(
    true,
  );
  const imports = buildImports(r.imports!, undefined, r.stringPool) as never as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary!, imports);
  // The host lane's callable-closure bridge needs the instance wired back.
  const setInstance = (imports as never as { __setInstance?: (i: unknown) => void }).__setInstance;
  if (typeof setInstance === "function") setInstance(instance);
  return instance.exports as Record<string, () => number>;
}

// `private-setter-brand-check.js`, transcribed. The probe functions return 1
// for the spec-correct outcome and a DISTINCT non-1 value per wrong outcome, so
// a failure message says which way it went wrong rather than just "not 1".
const INSTANCE_SETTER = `
class C {
  _v: any;
  set #m(v: any) { this._v = v; }
  access(o: any, v: any): any { return (o as any).#m = v; }
}

export function brandedWriteLands(): number {
  const c = new C();
  c.access(c, 7);
  return (c as any)._v === 7 ? 1 : 0;
}

export function assignmentEvaluatesToRhs(): number {
  const c = new C();
  return c.access(c, 9) === 9 ? 1 : 0;
}

export function foreignReceiverThrowsTypeError(): number {
  const c = new C();
  const o: any = {};
  try {
    c.access(o, 2);
  } catch (e: any) {
    return e instanceof TypeError ? 1 : 2;  // 2 = threw, but not a TypeError
  }
  return 0;                                  // 0 = did not throw at all
}

export function nullReceiverThrowsTypeError(): number {
  const c = new C();
  try {
    c.access(null, 2);
  } catch (e: any) {
    return e instanceof TypeError ? 1 : 2;
  }
  return 0;
}

export function rhsRunsBeforeTheThrow(): number {
  const c = new C();
  const o: any = {};
  let seen = 0;
  const side = (): number => { seen = 1; return 5; };
  try {
    c.access(o, side());
  } catch (e: any) {
    return seen;                             // 1 = RHS ran first (correct), 0 = skipped
  }
  return -1;                                 // -1 = no throw at all
}
`;

// `static-private-setter-access-on-inner-class.js`, transcribed. The receiver
// is a static class carrier rather than an instance struct, which is the shape
// that made #3232 add the standalone-only receiver coercion in the first place.
const STATIC_SETTER = `
class C {
  static _v: any;
  static set #f(v: any) { return (this as any)._v = v; }
  static Inner = class {
    static access(o: any): void { (o as any).#f = 'Test262'; }
  };
}

export function brandedStaticWriteLands(): number {
  (C as any).Inner.access(C);
  return (C as any)._v === 'Test262' ? 1 : 0;
}

export function foreignStaticThrowsTypeError(): number {
  try {
    (C as any).Inner.access((C as any).Inner);
  } catch (e: any) {
    return e instanceof TypeError ? 1 : 2;
  }
  return 0;
}
`;

describe.each(LANES)("#4154 PrivateBrandCheck throws instead of trapping [$label]", ({ opts }) => {
  it("instance private setter: brand check, evaluation order, and the branded write", async () => {
    const ex = await instantiate(INSTANCE_SETTER, opts);
    // Guard rails: the fix must not break the cases that already worked.
    expect(ex.brandedWriteLands!(), "write through a branded receiver must still land").toBe(1);
    expect(ex.assignmentEvaluatesToRhs!(), "`=` must still evaluate to the RHS").toBe(1);
    // The defect itself. Before the fix this call did not return at all — the
    // module died on an uncatchable `illegal cast` — so `toBe(1)` here is the
    // assertion that fails without the fix.
    expect(ex.foreignReceiverThrowsTypeError!(), "foreign receiver must throw a catchable TypeError").toBe(1);
    // ToObject(null) throws TypeError before PrivateSet is ever reached, so a
    // null receiver lands on the same arm rather than on a null-deref trap.
    expect(ex.nullReceiverThrowsTypeError!(), "null receiver must throw a catchable TypeError").toBe(1);
    expect(ex.rhsRunsBeforeTheThrow!(), "the RHS must be evaluated before the brand check throws").toBe(1);
  });

  it("static private setter accessed from an inner class", async () => {
    const ex = await instantiate(STATIC_SETTER, opts);
    expect(ex.brandedStaticWriteLands!(), "static write through the declaring class must still land").toBe(1);
    expect(ex.foreignStaticThrowsTypeError!(), "unbranded class object must throw a catchable TypeError").toBe(1);
  });
});
