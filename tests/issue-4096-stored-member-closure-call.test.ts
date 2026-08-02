// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4096 — a direct call on a function-valued member that an ASSIGNMENT stored
 * (`o.f = function(){…}; o.f()`) silently answered `undefined` on the host-free
 * lanes, with the callee never running.
 *
 * ## What these tests are actually pinning
 *
 * The defect is NOT "a member absent from a closed type", which is how it was
 * first characterised. Measured (see the issue file): the member IS present —
 * the read `var g = o.f` yields the right function, `typeof o.f === "function"`
 * is true, and two successive assignments last-write-win, so the value really
 * is stored. Only the DIRECT call form was broken, and it was broken for a
 * plain user function just as much as for a transferred `String.prototype`
 * method. That is a much more ordinary shape than the original framing, which
 * is why the first case below is `o.f = function () { return 7; }` and not the
 * `String.prototype` transfer that surfaced it.
 *
 * ## Why each case is here
 *
 * - `returns` cases: the value the call must produce. Before the fix every one
 *   of them was `undefined`.
 * - The `this`-threading case: `__apply_closure` must install the receiver, or
 *   the call would run but read the wrong `this` — a subtler wrong answer than
 *   the one being fixed.
 * - The **throwing-`toString`** case is the load-bearing one. It does not check
 *   a value at all; it checks that the callee RAN. Under the old lowering the
 *   arguments were evaluated and dropped and the callee was skipped entirely,
 *   so a spec-required `catch` never fired and the test observed *nothing
 *   happening* rather than a wrong string. A fix that returned a plausible
 *   value without invoking the callee would pass every other case here.
 * - The control cases (`arr.push`, `re.test`, a declared method, a wrapper
 *   receiver) are the anti-regression half: this arm sits at the very end of
 *   the call-dispatch chain and must not have pulled any of them off their
 *   static fast paths.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile as the test262 lane does: `allowJs`, a `.js` fileName, host-free
 * target, deferred top-level init (so a top-level throw is observable from the
 * exported `__module_init` rather than from instantiate).
 */
async function runStandalone(source: string): Promise<unknown> {
  const r = await compile(source, {
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    hostBridge: "always",
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports.test?.();
}

describe("#4096 direct call on an assignment-stored member (standalone)", () => {
  it("calls a plain user function stored on a top-level object literal", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        o.f = function () { return 7; };
        export function test() { return o.f(); }
      `),
    ).toBe(7);
  });

  it("threads the receiver as `this` into the stored function", async () => {
    expect(
      await runStandalone(`
        var o = { a: 5 };
        o.f = function () { return this.a; };
        export function test() { return o.f(); }
      `),
    ).toBe(5);
  });

  it("passes arguments through to the stored function", async () => {
    expect(
      await runStandalone(`
        var o = { a: 1 };
        o.f = function (x, y) { return x * 10 + y; };
        export function test() { return o.f(3, 4); }
      `),
    ).toBe(34);
  });

  it("runs a transferred String.prototype method with the object as `this`", async () => {
    expect(
      await runStandalone(`
        var o = { toString: function () { return "AB"; } };
        o.toLowerCase = String.prototype.toLowerCase;
        export function test() { return o.toLowerCase() === "ab" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("runs a transferred String.prototype method on an Array receiver", async () => {
    expect(
      await runStandalone(`
        export function test() {
          var a = new Array(1, 2, 3, 4, 5);
          a.m = String.prototype.substring;
          return a.m(0, 200) === "1,2,3,4,5" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("calls a plain user function stored on an array", async () => {
    expect(
      await runStandalone(`
        export function test() {
          var a = [1, 2, 3];
          a.f = function () { return 7; };
          return a.f();
        }
      `),
    ).toBe(7);
  });

  // THE load-bearing case: the callee must actually RUN. Before the fix the
  // receiver's `toString` was never invoked, so this `catch` never fired and
  // the test observed nothing happening at all — the worst form of the bug,
  // because it is invisible to any assertion about the returned value.
  it("actually invokes the callee — a throwing toString propagates", async () => {
    expect(
      await runStandalone(`
        var o = { toString: function () { throw new Error("boom"); } };
        o.toLowerCase = String.prototype.toLowerCase;
        export function test() {
          try { o.toLowerCase(); return 0; } catch (e) { return 1; }
        }
      `),
    ).toBe(1);
  });

  describe("controls — the static fast paths must be untouched", () => {
    it("a declared object-literal method still dispatches statically", async () => {
      expect(
        await runStandalone(`
          var o = { f: function (x) { return x + 1; } };
          export function test() { return o.f(1); }
        `),
      ).toBe(2);
    });

    it("arr.push still takes the native vec path", async () => {
      expect(
        await runStandalone(`
          export function test() {
            var a = [1, 2];
            a.push(3);
            return a.length === 3 && a[2] === 3 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("re.test still takes the native RegExp path", async () => {
      expect(
        await runStandalone(`
          export function test() { var re = /ab/; return re.test("xaby") ? 1 : 0; }
        `),
      ).toBe(1);
    });

    it("a wrapper receiver with a transferred toString still throws (#1397 path)", async () => {
      expect(
        await runStandalone(`
          var s = new String("AB");
          s.toString = Number.prototype.toString;
          export function test() { try { s.toString(); return 0; } catch (e) { return 1; } }
        `),
      ).toBe(1);
    });

    it("new Number(x).valueOf() still folds to the primitive", async () => {
      expect(
        await runStandalone(`
          var n = new Number(1234);
          export function test() { return n.valueOf(); }
        `),
      ).toBe(1234);
    });
  });

  /**
   * POSITIVE CONTROLS for the gate's cost.
   *
   * The admission scan `sourceHasMethodReassignment` is per-MODULE and
   * per-method-NAME, not per call site and not per receiver type: one
   * `x.push = …` anywhere in the file turns it on for every `.push` in that
   * file. Stated that way it sounds like the #942 "always dynamic was rejected
   * on perf grounds" hazard.
   *
   * It is not, because the arm runs only at the TAIL of `compileTailDispatch`
   * — after every static arm has already declined — so an intrinsic call never
   * reaches it no matter what the scan says. The cases below turn the scan ON
   * for `push` and for `test` in the same module that makes the hot call, which
   * is the exact shape that would expose the problem if the gate were
   * load-bearing for dispatch.
   *
   * What the assertions prove, precisely: the intrinsic still has its EFFECT,
   * and the reassigned same-named member still runs. That discriminates,
   * because a `push` re-routed through `__apply_closure` would read `a.push` as
   * a member value on a native vec, get a non-callable, receive the undefined
   * sentinel and mutate nothing — so `a.length === 3` would fail. It is a
   * behavioural control, not an instruction-sequence one; it does not claim
   * byte-identical output.
   *
   * Anything the arm CAN claim was, by construction, returning `undefined`
   * without running — so the marginal cost is one dynamic dispatch on a call
   * that previously did nothing at all.
   */
  describe("gate cost — the scan being ON must not pull an intrinsic off its fast path", () => {
    it("arr.push stays native even with `x.push = …` in the same module", async () => {
      expect(
        await runStandalone(`
          var x = { a: 1 };
          x.push = function () { return 99; };
          export function test() {
            var a = [1, 2];
            a.push(3);
            return a.length === 3 && a[2] === 3 && x.push() === 99 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });

    it("re.test stays native even with `x.test = …` in the same module", async () => {
      expect(
        await runStandalone(`
          var x = { a: 1 };
          x.test = function () { return 99; };
          export function test() {
            var re = /ab/;
            return re.test("xaby") && x.test() === 99 ? 1 : 0;
          }
        `),
      ).toBe(1);
    });
  });
});
