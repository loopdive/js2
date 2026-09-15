// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6607 — `new (<call expression>)(…)` under `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. Found by walking down into the compiled
// `@js-temporal/polyfill` provider (#5383 S20). S19 ended at the polyfill's
// intrinsic registry: provider-internal, one module, no link,
// `new (ce("%Temporal.Duration%"))(1).toJSON()` threw *invalid receiver: method
// called with the wrong type of this-object* while `new Duration(1).toJSON()`
// answered `P1Y`. The natural reading — an instance failing its own class's
// brand check — is wrong. **No instance was created at all.**
//
// `compileNewExpression` reached the dynamic-`new` dispatch for a bare
// IDENTIFIER callee, and (JS-host lane only, #4616) for a MEMBER-ACCESS callee.
// A CALL-expression callee matched neither, so it fell through to the
// `__new___unknown` host import — which does not exist in any lane and cannot
// exist in standalone — and the emitted body was a bare `ref.null.extern`.
//
// Two consequences, and the second is the one that makes this look like a
// brand-check bug: the `new` evaluates to null, AND, because the legacy arm
// returns before the argument loop, the argument expressions are never
// evaluated. Downstream the polyfill calls a prototype method on that null and
// its internal-slot lookup reports the wrong-receiver message, several layers
// away from the defect.
//
// Every `resolves.toBe` below is annotated with the value the BASE tree
// produced, measured on this tree by file-copy revert of
// `src/codegen/expressions/new-super.ts` (`.tmp/s20/c6-base.out`,
// `c7-base.out`, `c8-base.out` vs their `-new` twins). This whole FILE was run
// against base that way (`.tmp/s20/test-base.out`): 4 failed, 4 passed — the
// four that fail are the four the change moves, and the four that pass are the
// controls and the two pinned residuals, which must not move.
//
// NOT covered here, on purpose — two residuals this change deliberately did
// NOT touch. Both were PINNED by the last two `it`s so that fixing them would
// fail this file loudly instead of leaving a stale expectation. That is exactly
// what happened to the first of them:
//
//   - a method call by NAME on a statically-unknown receiver resolved through a
//     per-name ladder with no runtime class test, and picked the LAST-declared
//     class that declares the name. It was why the real provider still threw on
//     `Duration.from("P1Y").toJSON()` even though the instance was correct.
//     FIXED by #6608 (S21); the `it` below asserts the fixed answer instead.
//   - `Object.getPrototypeOf(x) === C.prototype` is false for a dynamic-`new`
//     instance (true for a static one), on base and on this branch alike.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STANDALONE = {
  target: "standalone" as const,
  hostBridge: "off" as const,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/**
 * Compile `source` standalone, instantiate with an EMPTY import object (so a
 * leaked host import fails the test rather than being papered over), and read
 * the string the exported `prepare` left behind, one char code at a time.
 */
async function runStandaloneString(expression: string): Promise<string> {
  const source = `let __s = "";
    export function prepare() { try { __s = "" + (${expression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
    export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compile(source, STANDALONE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const module = await WebAssembly.compile(result.binary as Uint8Array);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as {
    prepare: () => number;
    at: (i: number) => number;
  };
  const length = exports.prepare();
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(exports.at(i));
  return out;
}

// The registry shape the polyfill actually has: a bare object literal, so the
// value `ce` hands back is `any`. A `Map` or a typed record would give the
// callee a concrete static type and take one of the static `new` paths.
const REGISTRY = `
  class C { constructor(a) { this.tag = "T" + a; } }
  class D { constructor(a, b) { this.tag = "D" + a + b; } }
  const ie = {};
  ie["%C%"] = C; ie["%D%"] = D; ie["%N%"] = null; ie["%X%"] = 7;
  function ce(k) { return ie[k]; }`;

describe("#6607 — `new (<call>)(…)`, standalone", () => {
  it("constructs from a value fetched out of a registry by a call", async () => {
    // Base tree: "undefined" — the `new` evaluated to null.
    await expect(
      runStandaloneString(`(() => {${REGISTRY}
      return new (ce("%C%"))(1).tag; })()`),
    ).resolves.toBe("T1");
  });

  it("evaluates the constructor arguments (base dropped them entirely)", async () => {
    // Base tree: "/undefined" — the legacy arm returned BEFORE the argument
    // loop, so the side effects of the argument expressions never ran. This is
    // the clause of the defect that no reading of the downstream symptom would
    // predict, and the one a future refactor is most likely to reintroduce.
    await expect(
      runStandaloneString(`(() => {${REGISTRY}
      let effects = "";
      function mark(x) { effects += x; return x; }
      const o = new (ce("%D%"))(mark("a"), mark("b"));
      return effects + "/" + o.tag; })()`),
    ).resolves.toBe("ab/Dab");
  });

  it("evaluates the callee expression exactly once", async () => {
    // Base tree: "" — same cause. The tag dispatch compiles the callee once
    // into an anyref descriptor, so a side-effecting callee must not be
    // duplicated when the arm was added.
    await expect(
      runStandaloneString(`(() => {${REGISTRY}
      let effects = "";
      function mark(x) { effects += x; return x; }
      new (ce(mark("k") ? "%C%" : "%C%"))(1);
      return effects; })()`),
    ).resolves.toBe("k");
  });

  it("handles zero arguments, a loop, nesting and a spread", async () => {
    // Base tree: "undefined|undefinedundefinedundefined|undefined|undefined".
    await expect(
      runStandaloneString(`(() => {${REGISTRY}
      const zero = new (ce("%C%"))().tag;
      let loop = "";
      for (let i = 0; i < 3; i++) loop += new (ce("%C%"))(i).tag;
      const nested = new (ce("%C%"))(new (ce("%C%"))(1).tag).tag;
      const a = [1, 2];
      const spread = new (ce("%D%"))(...a).tag;
      return zero + "|" + loop + "|" + nested + "|" + spread; })()`),
    ).resolves.toBe("Tundefined|T0T1T2|TT1|D12");
  });

  it("leaves a NON-constructor callee exactly as it was", async () => {
    // Base tree: "null|null" — and it must stay that way. The new arm
    // pins its no-match outcome to the pre-existing `ref.null.extern`
    // (`plainNullNoMatchBase`) precisely so that a null or a number in the
    // registry produces no NEW outcome to regress against. A reader who
    // "simplifies" that parameter away changes the answer here.
    await expect(
      runStandaloneString(`(() => {${REGISTRY}
      const n = new (ce("%N%"))(1);
      const x = new (ce("%X%"))(1);
      return (n === null ? "null" : "" + n) + "|" + (x === null ? "null" : "" + x); })()`),
    ).resolves.toBe("null|null");
  });

  it("does not disturb the IDENTIFIER-callee arm", async () => {
    // Control. Base tree: "T1" — a const binding holding the registry value
    // already reached the dynamic-`new` identifier arm and already worked.
    await expect(
      runStandaloneString(`(() => {${REGISTRY}
      const t = ce("%C%");
      return new t(1).tag; })()`),
    ).resolves.toBe("T1");
  });

  it("residual 1 is FIXED (#6608): a name-collided method resolves by class", async () => {
    // Was pinned here at "EJ/EJ" by S20 — the per-name ladder had no runtime
    // CLASS test, only `ref.test`, which is STRUCTURAL, so every same-shaped
    // class matched and the LAST declarer won. #6608 (S21) adds the nominal
    // `__tag` guard; measured on the S20 base this line still answered
    // "EJ/EJ". Full coverage lives in
    // `tests/issue-6608-standalone-method-ladder-class-test.test.ts`.
    await expect(
      runStandaloneString(`(() => {
      class A { toJSON() { return "AJ"; } }
      class B { toJSON() { return "BJ"; } }
      class E { toJSON() { return "EJ"; } }
      function f(o) { return o.toJSON(); }
      return f(new A()) + "/" + f(new B()); })()`),
    ).resolves.toBe("AJ/BJ");
  });

  it("PINS residual 2: a dynamic-`new` instance does not share its class's prototype identity", async () => {
    // Base tree: "true|false" — identical. `instanceof` and `.constructor` are
    // both correct; it is `Object.getPrototypeOf` that hands back a distinct
    // carrier. Unchanged by this slice, and recorded so it is not rediscovered.
    await expect(
      runStandaloneString(`(() => {${REGISTRY}
      const t = ce("%C%");
      const dyn = new t(1);
      return "" + (Object.getPrototypeOf(new C(1)) === C.prototype) + "|"
        + (Object.getPrototypeOf(dyn) === C.prototype); })()`),
    ).resolves.toBe("true|false");
  });
});
