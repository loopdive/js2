// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4137 — two standalone-lane interpreter residuals from the annexB eval-code
// family, unit-tested where they are cheap to check:
//
//  1. `catch (e)` must be its own declarative Environment Record. The emitter's
//     `names` map is flat and function-wide, so `bind()` leaked the catch
//     parameter into every name resolution emitted after the clause.
//  2. B.3.5: a SIMPLE catch parameter does not cancel B.3.3's web-compat var
//     binding, so a same-named function declared inside the catch block still
//     updates the enclosing var.
//
// Everything here runs the interpreter directly in Node against node-acorn — no
// Wasm, no runtime-eval provider — and differentials against the host's own
// `eval`, which is the authority for what these programs mean.

import { beforeAll, describe, expect, it } from "vitest";
import { differential, loadAcorn, runInterp } from "./interp/harness.js";

beforeAll(async () => {
  await loadAcorn();
});

/** The exact shape of the annexB `*-no-skip-try` generated family. */
const NO_SKIP_TRY = (declaration: string) =>
  `var before = typeof f;
   try { throw null; } catch (f) { ${declaration} }
   var after = typeof f;
   before + "/" + after + "/" + (f === null ? "leaked" : "clean");`;

describe("#4137 interpreter catch-parameter scoping", () => {
  it("does not leak the catch parameter past the clause", () => {
    const body = `
      var x = "outer";
      try { throw "caught"; } catch (x) { }
      x;
    `;
    expect(runInterp(body).value).toBe("outer");
    expect(differential(body).verdict).toBe("match");
  });

  it("reads the catch parameter inside the clause", () => {
    const body = `
      var x = "outer";
      var seen;
      try { throw "caught"; } catch (x) { seen = x; }
      seen + "|" + x;
    `;
    expect(runInterp(body).value).toBe("caught|outer");
    expect(differential(body).verdict).toBe("match");
  });

  it("restores the outer binding after a nested catch of the same name", () => {
    const body = `
      var x = 0;
      try { throw 1; } catch (x) { try { throw 2; } catch (x) { } }
      x;
    `;
    expect(runInterp(body).value).toBe(0);
    expect(differential(body).verdict).toBe("match");
  });

  it("writes to the catch parameter, not the outer binding", () => {
    const body = `
      var x = "outer";
      try { throw "caught"; } catch (x) { x = "assigned"; }
      x;
    `;
    expect(runInterp(body).value).toBe("outer");
    expect(differential(body).verdict).toBe("match");
  });

  it("keeps typeof off the stale catch register after the clause", () => {
    const body = `
      var f = 1;
      try { throw null; } catch (f) { }
      typeof f;
    `;
    expect(runInterp(body).value).toBe("number");
    expect(differential(body).verdict).toBe("match");
  });

  // B.3.5: the exemption. A simple catch parameter must NOT cancel B.3.3.
  for (const [label, declaration] of [
    ["block", "{ function f() { return 123; } }"],
    ["if-decl-no-else", "if (true) function f() { return 123; }"],
    ["if-decl-else-decl", "if (true) function f() { return 123; } else function _f() {}"],
    ["switch-case", "switch (1) { case 1: function f() { return 123; } }"],
    ["switch-dflt", "switch (1) { default: function f() { return 123; } }"],
  ] as const) {
    it(`updates the web-compat var binding through a simple catch parameter (${label})`, () => {
      const body = NO_SKIP_TRY(declaration);
      expect(runInterp(body).value).toBe("undefined/function/clean");
      expect(differential(body).verdict).toBe("match");
    });
  }

  it("still calls the function the web-compat binding received", () => {
    const body = `
      try { throw null; } catch (f) { { function f() { return 123; } } }
      f();
    `;
    expect(runInterp(body).value).toBe(123);
    expect(differential(body).verdict).toBe("match");
  });

  it("a lexical let in the catch block DOES cancel the web-compat binding", () => {
    // Not the B.3.5 exemption: an ordinary intervening lexical still cancels,
    // so `f` outside must stay undefined rather than becoming the function.
    const r = runInterp(`
      try { throw null; } catch (e) { let f = 1; { function f() { return 123; } } }
      typeof f;
    `);
    expect(r.ok).toBe(true);
    expect(r.value).toBe("undefined");
  });
});
