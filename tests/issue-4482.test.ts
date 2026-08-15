// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4482 — builtin prototype-method brand checks in `--target standalone`:
 * §15.x.4 "is not generic" rows must throw a REAL `TypeError` instance.
 *
 * ## What the measurement actually found
 *
 * The issue was written as "the reflective entries need a brand preamble". They
 * do not — measured on the base commit, every one of these rows ALREADY threw a
 * real `TypeError` when the transferred intrinsic was stored under a name the
 * receiver's own prototype does not carry:
 *
 * ```js
 * var s = new Object(); s.myValueOf = Number.prototype.valueOf;
 * s.myValueOf();            // base: TypeError  ✓ (brand preamble present)
 * s.valueOf = Number.prototype.valueOf;
 * s.valueOf();              // base: the OBJECT — no throw at all
 * ```
 *
 * The defect is SHADOWING, one layer earlier: a static arm keyed on the
 * receiver's TypeScript type answers `<recv>.<sameName>()` from the prototype
 * it knows about, so the own slot the program just wrote is never read and the
 * brand preamble never runs. That is why the two halves of each test262 row —
 * `s.valueOf = …` (block #1) and `s.myValueOf = …` (block #2) — behaved
 * differently on the same base binary.
 *
 * ## The fix, and the predicate it is built on
 *
 * `sourceOverridesMethodOnReceiver` (`src/codegen/expressions/calls.ts`): the
 * source installs `<name>` **on the same identifier** this call reads, by
 * assignment or by `Object.defineProperty`. It is deliberately
 * receiver-PRECISE, unlike the older whole-file `sourceHasMethodReassignment`:
 * a whole-file scan is safe for arms that only ADD a dynamic exit, but gating
 * a static arm OFF on an unrelated `x.valueOf = …` elsewhere would drop a
 * correct native answer for a receiver that never had an own slot — a wrong
 * answer on a maybe. Four static arms now decline on it (Date methods,
 * `toString`, `valueOf`, and the String-family arm's own/inherited-slot case),
 * and two dynamic arms were widened to see `defineProperty` installs and
 * bracket-key calls.
 *
 * The `describe` names below are the failure FAMILIES, and each case names the
 * test262 row it was measured against.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4482.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  // Standalone means standalone — no host bridge may leak in behind these arms.
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/** Wrap a statement body as the exported `f`, returning 1 on success. */
function prog(body: string): string {
  return `/** @returns {number} */\nexport function f() {\n${body}\n}`;
}

/**
 * The shape every row here shares: run `body`, expect a THROW whose value is
 * `instanceof TypeError`. `1` = real TypeError, `2` = threw something else,
 * `100` = did not throw (the base behaviour for every case below).
 */
function brand(body: string): string {
  return prog(`try {\n${body}\n  return 100;\n} catch (e) {\n  return (e instanceof TypeError) ? 1 : 2;\n}`);
}

describe("#4482 F1 — an own slot written by ASSIGNMENT shadows the static arm", () => {
  it.each([
    // S15.7.4.4_A2_T04 block #1 — an `Object` receiver. The `valueOf` fallback
    // answered `Object.prototype.valueOf` (the receiver itself).
    [
      "Number.prototype.valueOf on new Object()",
      `var s = new Object(); s.valueOf = Number.prototype.valueOf;
      var v = s.valueOf();`,
    ],
    // S15.7.4.4_A2_T05 block #1 — an object LITERAL receiver. Types as
    // `{x: number}`, not `any`, which is why the #4201 oracle gate declined.
    [
      "Number.prototype.valueOf on an object literal",
      `var s = {x: 1}; s.valueOf = Number.prototype.valueOf;
      var v = s.valueOf();`,
    ],
    // S15.7.4.2_A4_T01 block #1 — a String wrapper receiver, `toString`.
    [
      "Number.prototype.toString on new String()",
      `var s = new String(); s.toString = Number.prototype.toString;
      var v = s.toString();`,
    ],
    // S15.10.6.2_A2_T4 — a String wrapper carrying a foreign RegExp method.
    [
      "RegExp.prototype.exec on new String()",
      `var i = new String("[a-b]"); i.exec = RegExp.prototype.exec;
      var v = i.exec("message to investigate");`,
    ],
    // S15.10.6.3_A2_T4 — the `test` twin of the row above.
    [
      "RegExp.prototype.test on new String()",
      `var i = new String("[a-b]"); i.test = RegExp.prototype.test;
      var v = i.test("message to investigate");`,
    ],
  ])("%s", async (_label, body) => {
    expect(await runStandalone(brand(body))).toBe(1);
  });
});

describe("#4482 F2 — an own slot written by Object.defineProperty", () => {
  it.each([
    // S15.7.4.4_A2_T03 block #1 — a Date receiver. `compileDateMethodCall`
    // answered the [[DateValue]] timestamp.
    [
      "Number.prototype.valueOf on a Date",
      `var d = new Date(0);
      Object.defineProperty(d, "valueOf", {value: Number.prototype.valueOf});
      var v = d.valueOf();`,
    ],
    // S15.7.4.2_A4_T03 block #1 — the `toString` twin.
    [
      "Number.prototype.toString on a Date",
      `var d = new Date(0);
      Object.defineProperty(d, "toString", {value: Number.prototype.toString});
      var v = d.toString();`,
    ],
  ])("%s", async (_label, body) => {
    expect(await runStandalone(brand(body))).toBe(1);
  });

  it("makes a defineProperty-installed method CALLABLE at all", async () => {
    // The narrower defect underneath F2, isolated: the READ already worked on
    // the base (`d.zz === 7` was true), only the INVOCATION was dropped by the
    // graceful `ref.null.extern` fallback. Without this, F2 could pass for the
    // wrong reason — a call that throws because nothing was installed.
    const src = prog(`var d = new Date(0);
      Object.defineProperty(d, "zz", {value: function () { return 42; }});
      return d.zz() === 42 ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4482 F3 — a bracket-key call reads the same own slot as a dot call", () => {
  it.each([
    // S15.10.6.2_A2_T6 — `__instance["exec"](…)`. test262 writes the same row
    // both ways on purpose; only the dot half reached the dynamic arm.
    [
      'exec via o["exec"]()',
      `var i = new Number(1.0); i.exec = RegExp.prototype.exec;
      var v = i["exec"]("message to investigate");`,
    ],
    // S15.10.6.3_A2_T6 — the `test` twin.
    [
      'test via o["test"]()',
      `var i = new Number(1.0); i.test = RegExp.prototype.test;
      var v = i["test"]("message to investigate");`,
    ],
  ])("%s", async (_label, body) => {
    expect(await runStandalone(brand(body))).toBe(1);
  });

  it("leaves a NON-transferred stored closure alone (bracket spelling)", async () => {
    // The no-collateral control: the new bracket arm must not change what an
    // ordinary stored closure answers. One spelling per module on purpose —
    // see the mixed-spelling residual pinned at the bottom of this file.
    const src = prog(`var o = {x: 1}; o.g = function () { return 7; };
      return o["g"]() === 7 ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  it("leaves a NON-transferred stored closure alone (dot spelling)", async () => {
    const src = prog(`var o = {x: 1}; o.g = function () { return 7; };
      return o.g() === 7 ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4482 F4 — an INHERITED slot installed on a builtin prototype", () => {
  it.each([
    // S15.10.6.2_A2_T8 — a PRIMITIVE string receiver. It carries no own slot,
    // so the native String arm's member miss is only interesting because the
    // module wrote onto `Object.prototype` (`ctx.protoNamedDirty`).
    [
      "exec inherited through Object.prototype",
      `var i = ".";
      Object.prototype.exec = RegExp.prototype.exec;
      var v = i.exec("message to investigate");`,
    ],
    // S15.10.6.3_A2_T8 — the `test` twin.
    [
      "test inherited through Object.prototype",
      `var i = ".";
      Object.prototype.test = RegExp.prototype.test;
      var v = i.test("message to investigate");`,
    ],
  ])("%s", async (_label, body) => {
    expect(await runStandalone(brand(body))).toBe(1);
  });
});

describe("#4482 controls — the static arms still answer when nothing is overridden", () => {
  // These are the arms this issue gates OFF. Each control exercises the SAME
  // arm on a module where the override predicate is false, which is what makes
  // "byte-identical when not overridden" a claim and not an assumption.
  it("Date.prototype.valueOf / toString on an un-overridden Date", async () => {
    const src = prog(`var d = new Date(0);
      return (d.valueOf() === 0 && d.toString().length > 0) ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  it("an override on a DIFFERENT binding does not disarm this one", async () => {
    // The receiver-precise half of the predicate. A whole-file scan would
    // decline for `d` too and lose the native timestamp.
    const src = prog(`var other = {x: 1}; other.valueOf = Number.prototype.valueOf;
      var d = new Date(0);
      return d.valueOf() === 0 ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  it("a user valueOf override still wins over Object.prototype.valueOf", async () => {
    // Not a brand row — the same shadowing bug with a plain function, which is
    // what makes the fix a correctness win beyond the "is not generic" family.
    const src = prog(`var o = {x: 1}; o.valueOf = function () { return 7; };
      return o.valueOf() === 7 ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  it("wrapper toString / valueOf keep their [[PrimitiveValue]] answers", async () => {
    const src = prog(`var n = new Number(5); var s = new String("ab"); var b = new Boolean(true);
      return (n.valueOf() === 5 && s.valueOf() === "ab" && b.valueOf() === true
              && n.toString() === "5" && s.toString() === "ab") ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  it("a real RegExp receiver still runs exec/test natively", async () => {
    // The String-family decline must not touch a receiver whose brand IS RegExp.
    const src = prog(`var re = new RegExp("b");
      return (re.test("abc") === true && re.exec("abc")[0] === "b") ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4482 residuals — measured, deliberately not fixed", () => {
  // Executable pins: each FAILS the day someone fixes the cause, which closes
  // the residual. See `## Residuals` in
  // plan/issues/4482-builtin-proto-brand-check-throws.md.
  it.fails("defineProperty on a CLOSED object-literal type installs nothing", async () => {
    // `{x: 1}` lowers to a closed struct, so `Object.defineProperty(d, "zz", …)`
    // does not reach a property carrier at all — the READ answers undefined.
    // `new Object()` / `any` / `Date` receivers are all fine, which is what
    // bounds this to the closed-struct lowering.
    const src = prog(`var d = {x: 1}; Object.defineProperty(d, "zz", {value: 7});
      return d.zz === 7 ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  it.fails("typeof on a value returned through __apply_closure reads 'object'", async () => {
    // `o.valueOf()` DOES answer 7 (the F-family fix), but the boxed externref
    // it comes back as answers `typeof === "object"`. Independent of this
    // issue's arms — a boxing/`typeof` gap on the dynamic-call return path.
    const src = prog(`var o = {x: 1}; o.valueOf = function () { return 7; };
      var v = o.valueOf();
      return typeof v === "number" ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  it.fails("mixing the dot and bracket spellings in ONE module breaks the dot call", async () => {
    // Each spelling is correct on its own (both controls in F3 pass). Put both
    // in the same module and `o.g()` answers `undefined` while `o["g"]()` still
    // answers 7. Measured on the BASE commit as well — this predates #4482 and
    // is not caused by the new bracket arm; it is pinned here because F3's
    // controls are deliberately one-spelling-per-module because of it.
    const src = prog(`var o = {x: 1}; o.g = function () { return 7; };
      var a = o.g(); var b = o["g"]();
      return (a === 7 && b === 7) ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });
});
