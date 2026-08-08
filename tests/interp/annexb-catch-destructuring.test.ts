// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2200 / E1 — Annex B.3.3 cancellation by a DESTRUCTURING catch parameter,
// and the B.3.5 exemption that keeps a SIMPLE catch parameter from cancelling.
//
// B.3.5 ("VariableStatements in Catch Blocks") exempts only
// `CatchParameter : BindingIdentifier`. An ObjectPattern parameter is NOT
// exempt, so the synthetic var binding B.3.3 would create for a block-level
// function declaration inside the catch body "would produce an Early Error"
// and must be cancelled — the name stays unbound in the enclosing var scope.
//
// This is the node-lane (E1) acceptance for the interpreter's catch
// ObjectPattern slice. It is testable NOW, before #4194: node-acorn parses the
// shorthand fine, whereas standalone instances still raise at parse time
// because compiled-acorn's `copyNode` needs the expando substrate (#4194).
// The standalone lane therefore cannot yet observe these verdicts; that is a
// known, documented gap, not a hole in this test.

import { beforeAll, describe, expect, it } from "vitest";
import { differential, loadAcorn, runInterp } from "./harness.js";

beforeAll(async () => {
  await loadAcorn();
});

/** `typeof f` before and after the try, joined — avoids comparing closures. */
function beforeAfter(catchParam: string): string {
  return [
    "var before = typeof f;",
    `try { throw {}; } catch (${catchParam}) {{ function f() {} }}`,
    "var after = typeof f;",
    'before + "," + after;',
  ].join("\n");
}

describe("#2200 annexB cancellation by a destructuring catch parameter", () => {
  it("shorthand ObjectPattern param cancels the synthetic var binding", () => {
    const result = runInterp(beforeAfter("{ f }"));
    expect(result.ok).toBe(true);
    // Not "undefined,function": the catch parameter binds `f` lexically, so
    // B.3.3's outer var binding is never created.
    expect(result.value).toBe("undefined,undefined");
  });

  it("a bare read of the cancelled name still throws ReferenceError", () => {
    const result = runInterp("try { throw {}; } catch ({ f }) {{ function f() {} }}\nf;");
    expect(result.ok).toBe(false);
    expect(result.errName).toBe("ReferenceError");
  });

  it("keyed ObjectPattern param (`{ a: f }`) cancels on the BOUND name", () => {
    const result = runInterp(beforeAfter("{ a: f }"));
    expect(result.ok).toBe(true);
    expect(result.value).toBe("undefined,undefined");
  });

  it("keyed ObjectPattern param does NOT cancel on the KEY name", () => {
    // `{ f: a }` binds `a`, not `f` — the B.3.3 var binding for `f` survives.
    const result = runInterp(beforeAfter("{ f: a }"));
    expect(result.ok).toBe(true);
    expect(result.value).toBe("undefined,function");
  });

  it("SIMPLE Identifier param stays B.3.5-exempt (regression control)", () => {
    const result = runInterp(beforeAfter("f"));
    expect(result.ok).toBe(true);
    // B.3.5 exempts `catch (f)`, so B.3.3 still publishes the outer binding.
    expect(result.value).toBe("undefined,function");
  });

  it("agrees with the host on every catch-parameter shape", () => {
    for (const param of ["{ f }", "{ a: f }", "{ f: a }", "f"]) {
      const diff = differential(beforeAfter(param));
      expect(`${param}: ${diff.verdict} ${diff.detail}`).toBe(`${param}: match ${diff.detail}`);
    }
  });

  it("binds the destructured value, not the thrown object", () => {
    const result = runInterp("try { throw { f: 7 }; } catch ({ f }) { var seen = f; }\nString(seen);");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("7");
  });

  it("still refuses catch-parameter shapes outside the minimal slice", () => {
    for (const param of ["{ f = 1 }", "{ ...rest }", "{ a: { b } }", "[a]"]) {
      const result = runInterp(`try { throw {}; } catch (${param}) { }`);
      expect(`${param}: ${result.ok}`).toBe(`${param}: false`);
    }
  });
});
