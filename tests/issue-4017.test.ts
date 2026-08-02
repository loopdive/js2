// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4017 — standalone did not throw on `new <provably-non-constructor>`.
//
// `new-super.ts` proved at compile time that the callee had no [[Construct]]
// (`resolvesToNonConstructableValue`), but gated the guard on `!noJsHost(ctx)`
// because its VEHICLE was the `__construct` host import. In standalone that
// discarded the vehicle AND the proof: control fell through to the terminal
// `__new_<name>` lookup, found no import, and emitted `ref.null.extern`. So
// `new (String.prototype.charAt)` evaluated to null instead of throwing.
//
// The negative controls below are the load-bearing half of this file: the
// narrowing that keeps `.bind()/.call()/.apply()` and USER prototype methods OFF
// the static-throw path is what stops the fix from breaking legitimate
// constructions, and only a test can hold that line.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Runs `body` in standalone and returns 1 if it threw a TypeError, 2 if it threw
 * something else, 0 if it did not throw.
 */
async function threwTypeError(body: string): Promise<number> {
  const source = `export function probe() {
    var threw = 0;
    try {
${body}
    } catch (e) {
      threw = (e instanceof TypeError) ? 1 : 2;
    }
    return threw;
  }`;
  const result = await compile(source, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  // A standalone module must not have leaked a host import to get here.
  expect(result.imports ?? []).toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports.probe!() as number;
}

describe("#4017 standalone throws where non-constructability is statically provable", () => {
  it("throws TypeError for `new <intrinsic>.prototype.<method>` held in a var", async () => {
    // test262 built-ins/String/prototype/*/S15.5.4.*_A7 — 10 files, all of which
    // the host lane already passed.
    expect(
      await threwTypeError(`
      var f = String.prototype.charAt;
      var x = new f();
    `),
    ).toBe(1);
  }, 120_000);

  it("throws TypeError for an arrow function held in a var", async () => {
    expect(
      await threwTypeError(`
      var f = () => 1;
      var x = new f();
    `),
    ).toBe(1);
  }, 120_000);

  it("throws TypeError for `new <intrinsic>.prototype` itself", async () => {
    // test262 built-ins/Object/prototype/S15.2.4_A4, Function/prototype/S15.3.4_A5.
    // Regression guard for the `externClasses` exclusion that had to be dropped:
    // that map carries `Object`, and with the exclusion in place this exact case
    // was swallowed while `Function.prototype` passed.
    expect(await threwTypeError(`var x = new Object.prototype;`)).toBe(1);
    expect(await threwTypeError(`var x = new Function.prototype;`)).toBe(1);
  }, 120_000);

  it("evaluates the argument list BEFORE throwing (EvaluateNew order)", async () => {
    // §13.3.5.1: the MemberExpression and the ArgumentList are both evaluated
    // before the IsConstructor check, so argument side effects must still happen.
    const source = `export function probe() {
      var seen = 0;
      function mark() { seen = 7; return 1; }
      var f = String.prototype.charAt;
      try { var x = new f(mark()); } catch (e) {}
      return seen;
    }`;
    const result = await compile(source, {
      fileName: "probe.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, () => unknown>;
    exports.__module_init?.();
    expect(exports.probe!()).toBe(7);
  }, 120_000);

  // ── negative controls ────────────────────────────────────────────────────
  // These are NOT statically decidable and must keep needing the runtime probe.
  // If either starts throwing, the narrowing has been lost and legitimate
  // constructions are being rejected — a worse defect than the missing throw.

  it("does NOT throw for a USER prototype method (it has [[Construct]])", async () => {
    // `Foo.prototype.bar = function(){}` is an ordinary function object, so
    // `new (Foo.prototype.bar)` is legal JavaScript and must not be intercepted.
    // This is what the `resolvesToAmbientGlobal` gate buys.
    expect(
      await threwTypeError(`
      function Foo() {}
      Foo.prototype.bar = function () { this.k = 1; };
      var f = Foo.prototype.bar;
      var x = new f();
    `),
    ).toBe(0);
  }, 120_000);

  it("does NOT statically throw for a `.bind()` result", async () => {
    // A bound function IS a constructor when its target is (§10.4.1.2), so this
    // shape may never be given an unconditional compile-time throw.
    expect(
      await threwTypeError(`
      function Foo() { this.k = 1; }
      var f = Foo.bind(null);
      var x = new f();
    `),
    ).toBe(0);
  }, 120_000);

  it("does NOT statically throw for a `.call()` result", async () => {
    // `mk.call(null)` RETURNS an arbitrary value — here, a real constructor.
    expect(
      await threwTypeError(`
      function mk() { return function () { this.k = 1; }; }
      var f = mk.call(null);
      var x = new f();
    `),
    ).toBe(0);
  }, 120_000);
});
