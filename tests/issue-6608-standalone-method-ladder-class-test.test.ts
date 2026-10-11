// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6608 — a method call by NAME on a statically-unknown receiver, standalone.
//
// WHY THIS REDUCTION EXISTS. Walked down into the compiled
// `@js-temporal/polyfill` provider (#5383 S21). `Duration.from("P1Y").toJSON()`
// threw *invalid receiver: method called with the wrong type of this-object*
// with a receiver that was demonstrably correct — `this === r`, slots present,
// its own brand check passing. The method being FOUND was another class's.
//
// `ref.test $C` is a STRUCTURAL test and WasmGC canonicalizes struct types by
// shape (field names do not exist in wasm), so several same-shaped classes are
// ONE runtime type and every arm of a per-name ladder claims every instance.
// Which body runs is then decided by the ladder's assembly order:
//
//   * `__call_m_<name>_<arity>` wraps later arms outermost  → LAST declarer wins
//   * `__call_toString`/`__call_valueOf` matches the first  → FIRST declarer wins
//
// Both are fixed by testing the compiler's per-class `__tag` field as well —
// the guard #4618 added for the JS-host bridge ladders and only for those.
//
// Every `resolves.toBe` below is annotated with the value the BASE tree
// produced, measured on this tree by file-copy revert of the three changed
// files (`.tmp/s21base/*`, probes `.tmp/s21/c9-base.out`, `c10-base.out`,
// `c11-base.out`).
//
// NOTE ON SHAPES. The `SLOTTED` classes keep their state in a `WeakMap`, so
// they have NO instance fields — the strongest form of the collision, and the
// shape the Temporal polyfill actually uses. The "DIFFERENT field names" `it`
// covers the other one: one field each, different names, identical layout.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const STANDALONE = {
  target: "standalone" as const,
  hostBridge: "off" as const,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

async function runStandaloneString(expression: string): Promise<string> {
  const source = `let __s = "";
    export function prepare() { try { __s = "" + (${expression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
    export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compile(source, STANDALONE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const module = await WebAssembly.compile(result.binary as Uint8Array);
  // An empty import object: a leaked host import fails the test outright
  // rather than being papered over by a JS shim.
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

// The provider's own shape: per-instance state in a WeakMap, a brand check at
// the top of every method, several classes declaring the same member names.
const SLOTTED = `
  const slots = new WeakMap();
  class A {
    constructor(a) { slots.set(this, { k: "A", v: a }); }
    toJSON() { const s = slots.get(this); if (!s || s.k !== "A") throw new TypeError("invalid receiver A"); return "AJ" + s.v; }
    uniqA() { return "UA"; }
  }
  class B {
    constructor(a) { slots.set(this, { k: "B", v: a }); }
    toJSON() { const s = slots.get(this); if (!s || s.k !== "B") throw new TypeError("invalid receiver B"); return "BJ" + s.v; }
    uniqB() { return "UB"; }
  }
  class E {
    constructor(a) { slots.set(this, { k: "E", v: a }); }
    toJSON() { const s = slots.get(this); if (!s || s.k !== "E") throw new TypeError("invalid receiver E"); return "EJ" + s.v; }
  }
  const ie = {};
  ie["%A%"] = A; ie["%B%"] = B; ie["%E%"] = E;
  function ce(k) { return ie[k]; }`;

describe("#6608 — per-name method dispatch on an unknown receiver, standalone", () => {
  it("runs the receiver's OWN method when three fieldless classes declare the name", async () => {
    // Base tree: "!invalid receiver E" — the FIRST `f(new A(1))` already ran
    // E's body (E is the LAST declarer) and threw E's brand error, so the
    // whole expression is that one message. This is the reduction of the
    // provider's `Duration.from("P1Y").toJSON()` failure.
    await expect(
      runStandaloneString(`(() => {${SLOTTED}
      function f(o) { return o.toJSON(); }
      return f(new A(1)) + "/" + f(new B(2)) + "/" + f(new E(3)); })()`),
    ).resolves.toBe("AJ1/BJ2/EJ3");
  });

  it("does the same for a receiver that came out of a registry by dynamic `new`", async () => {
    // Base tree: "!invalid receiver E" — same throw, on the first call. The
    // #6607 arm made the INSTANCE correct; this is the call on it.
    await expect(
      runStandaloneString(`(() => {${SLOTTED}
      const x = new (ce("%A%"))(1), y = new (ce("%B%"))(2);
      return x.toJSON() + "/" + y.toJSON(); })()`),
    ).resolves.toBe("AJ1/BJ2");
  });

  it("no longer invents a method the receiver does not have", async () => {
    // Base tree: "UB" — an `A` answered B's `uniqB()`, a member A does not
    // declare at all. Now the ladder declines and the call throws, which is the
    // right KIND of answer (a real engine says `x.uniqB is not a function`).
    await expect(
      runStandaloneString(`(() => {${SLOTTED}
      const x = new (ce("%A%"))(1);
      return x.uniqB(); })()`),
    ).resolves.toBe("!called value is not a function");
  });

  it("fixes the ToPrimitive ladder too, which picks the FIRST declarer", async () => {
    // Base tree: "!invalid receiver A" — `f(new A(1))` answered "AS1", then
    // `f(new B(2))` ran A's body and threw. `o.toString()` routes through
    // `__extern_toString` → `__call_toString`, a FIRST-match ladder, so B ran
    // A's body. In the provider this surfaced as *toString() radix argument
    // must be between 2 and 36* (Number.prototype.toString answering for a
    // Temporal object).
    await expect(
      runStandaloneString(`(() => {
      const slots = new WeakMap();
      class A { constructor(a) { slots.set(this, { k: "A", v: a }); }
        toString() { const s = slots.get(this); if (!s || s.k !== "A") throw new TypeError("invalid receiver A"); return "AS" + s.v; } }
      class B { constructor(a) { slots.set(this, { k: "B", v: a }); }
        toString() { const s = slots.get(this); if (!s || s.k !== "B") throw new TypeError("invalid receiver B"); return "BS" + s.v; } }
      function f(o) { return o.toString(); }
      return f(new A(1)) + "/" + f(new B(2)); })()`),
    ).resolves.toBe("AS1/BS2");
  });

  it("same-shape classes with DIFFERENT field names also dispatch correctly", async () => {
    // Base tree: "!Cannot access property on null or undefined at …" — one
    // f64 field each, same layout, so GC's body ran on a GA and read a field
    // that is not there. Field NAMES do not exist in wasm; only the layout
    // does, which is why distinct names do not save this.
    await expect(
      runStandaloneString(`(() => {
      class GA { constructor(a) { this.p = a; } tag() { return "GA" + this.p; } }
      class GB { constructor(a) { this.q = a; } tag() { return "GB" + this.q; } }
      class GC { constructor(a) { this.r = a; } tag() { return "GC" + this.r; } }
      function f(o) { return o.tag(); }
      return f(new GA(1)) + "/" + f(new GB(2)) + "/" + f(new GC(3)); })()`),
    ).resolves.toBe("GA1/GB2/GC3");
  });

  it("control: a subclass still inherits its parent's method through the ladder", async () => {
    // Base tree: identical ("PM/PM"). The guard admits the OWN tag plus every
    // DESCENDANT tag precisely so this keeps working — a parent's arm is the
    // only arm a non-overriding subclass instance can match.
    await expect(
      runStandaloneString(`(() => {
      class P { constructor(a) { this.p = a; } m() { return "PM"; } }
      class Q extends P {}
      class R { constructor(a) { this.z = a; } }
      const r = new R(0);
      function f(o) { return o.m(); }
      return f(new P(1)) + "/" + f(new Q(2)) + (r ? "" : ""); })()`),
    ).resolves.toBe("PM/PM");
  });

  it("control: an overriding subclass wins over its parent", async () => {
    // Base tree: identical ("PM/QM").
    await expect(
      runStandaloneString(`(() => {
      class P { constructor(a) { this.p = a; } m() { return "PM"; } }
      class Q extends P { m() { return "QM"; } }
      function f(o) { return o.m(); }
      return f(new P(1)) + "/" + f(new Q(2)); })()`),
    ).resolves.toBe("PM/QM");
  });

  it("control: the builtin receivers on the same ladder are untouched", async () => {
    // Base tree: identical ("255/AB/1-2-3/5"). The guard only ever narrows a
    // USER-CLASS arm (an arm whose struct has no `__tag` is left alone), so
    // number/string/array/Map receivers keep their existing arms.
    await expect(
      runStandaloneString(`(() => {
      class A { constructor(a) { this.p = a; } toString() { return "AS"; } }
      const keep = new A(1);
      const m = new Map(); m.set("a", 5);
      function f(o) { return o.toString(); }
      function g(o) { return o.toUpperCase(); }
      function h(o) { return o.join("-"); }
      function k(o) { return o.get("a"); }
      return f(255) + "/" + g("ab") + "/" + h([1,2,3]) + "/" + k(m) + (keep ? "" : ""); })()`),
    ).resolves.toBe("255/AB/1-2-3/5");
  });
});
