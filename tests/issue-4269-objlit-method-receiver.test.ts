// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4269 — an object-literal method call did not bind its receiver.
 *
 * ```js
 * var obj = { x: 42, m: function () { return this.x; } };
 * obj.m();          // undefined  ← the defect
 * obj.m.call(obj);  // 42         ← already correct
 * ```
 *
 * ## What these cases are actually pinning
 *
 * The defect is a **missing writer**, not a broken callee. The lifted body of
 * `m` already reads `__current_this` and falls back to `undefined` when nothing
 * was installed (measured on the emitted WAT); `obj.m.call(obj)` works today
 * only because `__apply_closure` installs that global. So every case below is
 * about whether the CALL SITE installs the receiver — and, just as importantly,
 * whether it installs it at the right moment and takes it back down again.
 *
 * Why each case is here:
 *
 * - `returns this.x` is the headline shape; before the fix it was `undefined`
 *   on both lanes, for every arity.
 * - **The write-through-`this` case is the load-bearing one.** A read that
 *   answers `undefined` is visible; a WRITE that silently lands nowhere is not.
 *   `this.x = 99` mutating the receiver is the assertion that the callee ran
 *   against the real object rather than against something plausible.
 * - The **argument reading the caller's `this`** case pins the ORDER. The
 *   install has to happen after the arguments are evaluated: an argument
 *   expression reads the enclosing frame's `this` through the same global, so
 *   installing first would corrupt it. This case fails on an
 *   otherwise-correct fix that installs too early.
 * - The **restoration** case pins the other half: after an inner method call
 *   returns, the outer frame's `this` must be the outer receiver again.
 * - The **arrow-valued property** is the anti-regression case with teeth. An
 *   arrow's `this` is lexical; a fix that bound receivers indiscriminately
 *   would turn a correct answer into a wrong one.
 * - The **method-shorthand**, **`arr.push`/`re.test`** and
 *   **`this`-ignoring method** cases are the rest of the anti-regression half:
 *   this arm sits on the hottest call path in the compiler and must leave every
 *   shape it does not own byte-identical (verified separately by sha256 A/B).
 * - The **strict callee** case records that strictness does not change the
 *   answer here: the receiver is an object either way, so no §10.2.1.2
 *   `ToObject` question arises (that is #4246's territory).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

/**
 * Compile as the test262 standalone lane does: `allowJs`, a `.js` fileName,
 * host-free target, deferred top-level init.
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

/**
 * The gc/host lane — the same call path, and it was wrong there too. Uses the
 * equivalence suite's harness so the host imports (iterator protocol, string
 * constants, boxing) are wired exactly as that suite wires them.
 */
async function runHost(source: string): Promise<unknown> {
  const exports = await compileToWasm(source);
  exports.__module_init?.();
  return exports.test?.();
}

/** Assert the same answer on both lanes — the defect and the fix are shared. */
async function bothLanes(source: string, expected: unknown): Promise<void> {
  expect(await runStandalone(source), "standalone").toStrictEqual(expected);
  expect(await runHost(source), "gc/host").toStrictEqual(expected);
}

describe("#4269 object-literal method call binds its receiver", () => {
  it("reads this.x through a plain property call", async () => {
    await bothLanes(
      `var obj = { x: 42, m: function () { return this.x; } };
       export function test() { return obj.m(); }`,
      42,
    );
  });

  it("reads this.x through an element access with a literal key", async () => {
    await bothLanes(
      `var obj = { x: 42, m: function () { return this.x; } };
       export function test() { return obj["m"](); }`,
      42,
    );
  });

  it("reads this.x through an element access with a RUNTIME key", async () => {
    // Reachable only since #4252 made this shape invoke the callee at all; it
    // then ran with `this` unbound, which is the same defect one layer down.
    await bothLanes(
      `var obj = { x: 42, m: function () { return this.x; } };
       var k = "m";
       export function test() { return obj[k](); }`,
      42,
    );
  });

  it("binds the innermost receiver of a nested/chained receiver", async () => {
    await bothLanes(
      `var outer = { inner: { x: 7, m: function () { return this.x; } } };
       export function test() { return outer.inner.m(); }`,
      7,
    );
  });

  it("threads arguments alongside the receiver", async () => {
    await bothLanes(
      `var obj = { x: 40, m: function (a, b) { return this.x + a + b; } };
       export function test() { return obj.m(1, 2); }`,
      43,
    );
  });

  // THE load-bearing case: a wrong read is visible, a lost WRITE is not.
  it("writes through this onto the real receiver", async () => {
    await bothLanes(
      `var obj = { x: 1, m: function () { this.x = 99; return this.x; } };
       export function test() { obj.m(); return obj.x; }`,
      99,
    );
  });

  it("keeps this stable across a self-recursive method call", async () => {
    await bothLanes(
      `var obj = { n: 4, fact: function (k) { return k <= 1 ? 1 : k * this.fact(k - 1); } };
       export function test() { return obj.fact(4); }`,
      24,
    );
  });

  // ORDER: the argument reads the CALLER's `this`, through the same global the
  // install writes. Installing before the arguments are evaluated corrupts it.
  it("evaluates arguments before installing the receiver", async () => {
    await bothLanes(
      `var inner = { y: 5, n: function (v) { return this.y * 100 + v; } };
       var outer = { y: 9, m: function () { return inner.n(this.y); } };
       export function test() { return outer.m(); }`,
      509,
    );
  });

  // RESTORE: after the inner call returns, the outer frame's `this` is its own
  // receiver again.
  it("restores this after an inner method call returns", async () => {
    await bothLanes(
      `var inner = { y: 5, n: function () { return this.y; } };
       var outer = { y: 9, m: function () { var a = inner.n(); return a * 100 + this.y; } };
       export function test() { return outer.m(); }`,
      509,
    );
  });

  it("binds this for a strict-mode callee", async () => {
    await bothLanes(
      `var obj = { x: 42, m: function () { "use strict"; return this.x; } };
       export function test() { return obj.m(); }`,
      42,
    );
  });

  it("binds this on an object literal produced by a factory", async () => {
    await bothLanes(
      `function mk() { return { x: 13, m: function () { return this.x; } }; }
       var o = mk();
       export function test() { return o.m(); }`,
      13,
    );
  });

  // ── anti-regression ──

  it("does NOT bind a receiver for an arrow-valued property", async () => {
    // §14.2: an arrow has no `this` binding. `this` inside it is the enclosing
    // one, so a receiver install here would be a NEW wrong answer.
    await bothLanes(
      `var obj = { x: 42, m: () => 5 };
       export function test() { return obj.m(); }`,
      5,
    );
  });

  it("leaves a method-shorthand call alone (already correct)", async () => {
    await bothLanes(
      `var obj = { x: 42, m() { return this.x; } };
       export function test() { return obj.m(); }`,
      42,
    );
  });

  it("leaves a this-ignoring function property alone", async () => {
    await bothLanes(
      `var obj = { x: 42, m: function () { return 7; } };
       export function test() { return obj.m(); }`,
      7,
    );
  });

  it("keeps arr.push / re.test on their native fast paths", async () => {
    await bothLanes(
      `var a = [1, 2];
       var re = /ab/;
       export function test() { a.push(3); return re.test("ab") ? a.length : 0; }`,
      3,
    );
  });

  it("keeps an expando-stored member call correct (#4096)", async () => {
    await bothLanes(
      `var o = { x: 42 };
       o.m = function () { return this.x; };
       export function test() { return o.m(); }`,
      42,
    );
  });

  it("refuses the runtime-key bind when an argument reads the caller's this", async () => {
    // The dynamic dispatch evaluates its own arguments, so the install cannot be
    // deferred past them. Rather than hand `this.y` the receiver, the bind is
    // refused outright and the callee keeps today's unbound `this` — a known
    // wrong answer, not a NEW one. `outer.y` is 9; the argument must be 9.
    await bothLanes(
      `var inner = { y: 5, n: function (v) { return v; } };
       var k = "n";
       var outer = { y: 9, m: function () { return inner[k](this.y); } };
       export function test() { return outer.m(); }`,
      9,
    );
  });

  it("keeps .call on the same member correct", async () => {
    await bothLanes(
      `var obj = { x: 42, m: function () { return this.x; } };
       export function test() { return obj.m.call(obj); }`,
      42,
    );
  });
});
