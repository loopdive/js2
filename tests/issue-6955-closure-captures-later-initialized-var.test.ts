// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6955 — a closure that captures a hoisted `var` whose initializer runs AFTER
 * the closure is created must observe the initialized value (Octane
 * navier-stokes: `this.update = function () { … dt … }` precedes `var dt = 0.1`).
 *
 * Before: `planClosureCaptures` captured such a binding BY VALUE (no assignment,
 * no TDZ flag, closure not inside the declarator), so the closure snapshotted
 * the slot's uninitialized default (`NaN` / `null`) forever.
 *
 * The `new F()` constructor shape additionally needs the fnctor twin to hoist
 * its `var` slots (#6942); the cases here use plain-call frames so they isolate
 * the capture decision itself.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    runtimeEvalProvider: false,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const instance = await WebAssembly.instantiate(mod, {});
  return (instance.exports as { main: () => unknown }).main();
}

const main = (body: string): string => `${body}\n/** @returns {number} */\nexport function main() { return g(); }\n`;

describe("#6955 closure captures a var initialized after the closure", () => {
  it("function expression assigned to a member before `var dt = 0.1`", async () => {
    expect(
      await runStandalone(
        main(`function g() {
  var o = {};
  o.get = function () { return dt * 2; };
  var dt = 0.1;
  return o.get();
}`),
      ),
    ).toBe(0.2);
  });

  it("arrow before a `var` declared in a nested block of the same frame", async () => {
    expect(
      await runStandalone(
        main(`function g() {
  var f = () => dt * 2;
  if (true) { var dt = 0.25; }
  return f();
}`),
      ),
    ).toBe(0.5);
  });

  it("closures before and after the declarator share one binding, including a later assignment", async () => {
    expect(
      await runStandalone(
        main(`function g() {
  var o = {};
  o.a = function () { return dt + 1; };
  var dt = 0.5;
  o.b = function () { return dt * 4; };
  var r = o.a() + o.b();
  dt = 2;
  return r * 100 + o.a() + o.b();
}`),
      ),
    ).toBe(350 + 3 + 8);
  });

  it("sibling function-expression var declared after its caller", async () => {
    expect(
      await runStandalone(
        main(`function g() {
  var a = function () { return b() + 1; };
  var b = function () { return 7; };
  return a();
}`),
      ),
    ).toBe(8);
  });

  it("control: var initialized before the closure (by-value fast path) is unchanged", async () => {
    expect(
      await runStandalone(
        main(`function g() {
  var dt = 0.1;
  var f = function () { return dt * 2; };
  return f();
}`),
      ),
    ).toBe(0.2);
  });

  it("control: a same-named var in a nested function frame does not alias the outer capture", async () => {
    expect(
      await runStandalone(
        main(`function g() {
  var dt = 3;
  var f = function () { return dt * 2; };
  function inner() { var dt = 100; return dt; }
  return f() + inner();
}`),
      ),
    ).toBe(106);
  });
});
