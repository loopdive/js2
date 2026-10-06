// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V5 — TDZ for closure-captured block `let`/`const` (standalone).
//
// §9.1.1.1.4 GetBindingValue step 2 / §9.1.1.1.5 SetMutableBinding step 2: a
// hoisted block function that reads or writes a block binding before its
// declaration has run must throw ReferenceError. Measured on base, every case
// below either returned silently (the script-scope block function captured
// nothing and read its own `undefined` local) or, for writes, stored through
// the ref cell with no TDZ check. The leave-block case read a stale slot of a
// block that had already been exited (test262
// `block-scope/leave/outermost-binding-updated-in-catch-block-…`).
//
// The script-goal cases are compiled as sloppy `.js` (Annex B B.3.3.2 module
// bindings) exactly as the test262 original-harness lane does.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRELUDE = `
function Fail(message) { this.message = message; }
function check(c, m) { if (!c) throw new Fail(m); }
function throwsRef(fn) {
  try { fn(); } catch (thrown) { return thrown instanceof ReferenceError; }
  return false;
}
`;

/** Compile a sloppy script standalone and run its top level; true = no throw. */
async function runsClean(body: string): Promise<boolean> {
  const result = await compile(PRELUDE + body, {
    allowJs: true,
    fileName: "v5.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  try {
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    return true;
  } catch {
    return false;
  }
}

describe("#6651 V5 — TDZ for closure-captured block bindings (standalone)", () => {
  it("throws on a [[Get]] through a hoisted block function, then reads the live value", async () => {
    expect(
      await runsClean(`{
        function f() { return x + 1; }
        check(throwsRef(function () { f(); }), "get before init");
        let x = 1;
        check(f() === 2, "after init");
        x = 5;
        check(f() === 6, "after write");
      }`),
    ).toBe(true);
  });

  it("throws on a [[Set]] through a hoisted block function, then writes the binding", async () => {
    expect(
      await runsClean(`{
        function g() { y = 1; }
        check(throwsRef(function () { g(); }), "set before init");
        let y;
        g();
        check(y === 1, "write visible");
      }`),
    ).toBe(true);
  });

  it("throws on a const read before initialisation", async () => {
    expect(
      await runsClean(`{
        function h() { return z + 1; }
        check(throwsRef(function () { h(); }), "const get before init");
        const z = 1;
        check(h() === 2, "const after init");
      }`),
    ).toBe(true);
  });

  it("a block function observes the block binding, including through its value", async () => {
    expect(
      await runsClean(`{
        function k() { return w; }
        let w = 5;
        check(k() === 5, "plain");
        var kk = k;
        w = 9;
        check(kk() === 9, "via value");
      }`),
    ).toBe(true);
  });

  it("a left block's binding is not visible to a later closure (even with eval)", async () => {
    expect(
      await runsClean(`
      var caught = false;
      try {
        { let xx = 18; throw 25; }
      } catch (e) {
        caught = true;
        check(e === 25, "caught value");
        (function () {
          try {
            check(xx === undefined, "unreachable");
            eval("xx");
            check(false, "should not reach");
          } catch (e2) {
            check(e2 instanceof ReferenceError, "ReferenceError");
          }
        })();
      }
      check(caught, "caught");`),
    ).toBe(true);
  });

  it("function-scope: a direct call before the declaration throws ReferenceError", async () => {
    const result = await compile(
      `export function test(): number {
        let r = 0;
        {
          function f() { return x + 1; }
          try { f(); r = 1; } catch (e) { r = e instanceof ReferenceError ? 2 : 3; }
          let x = 1;
          r = r * 10 + (f() === 2 ? 2 : 1);
        }
        return r;
      }`,
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(22);
  });
});
