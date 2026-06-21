// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2119 — ES module code is always strict (§11.2.2), so strict functions get an
 * UNMAPPED arguments object (§10.4.4): a parameter write must NOT be visible
 * through `arguments[i]`. The compiler previously installed the mapped (sloppy)
 * arguments for every directive-less function, miscompiling genuine module
 * input (`a = 99; arguments[0]` returned 99 instead of the original 5).
 *
 * `isStrictFunction` now infers module strictness from the genuine module
 * signal (`externalModuleIndicator` / ESM `impliedNodeFormat`), NOT from
 * `scriptKind` — so test262 sloppy `.js` cases (compiled under a `.ts`
 * filename, no top-level import/export) stay mapped.
 */
import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./helpers.js";
import { analyzeSource } from "../../src/checker/index.js";
import { isStrictFunction } from "../../src/codegen/helpers/is-strict-function.js";
import { ts } from "../../src/ts-api.js";

describe("#2119 — module code gets an unmapped arguments object", () => {
  it("parameter write does NOT leak into arguments[i] in module code", async () => {
    // Top-level `export` ⇒ module ⇒ strict ⇒ unmapped. `a = 99` must not be
    // visible through `arguments[0]`, so this returns 5*10+1, not 99*10+1.
    await assertEquivalent(
      `function f(a: number): number { a = 99; return arguments[0] * 10 + arguments.length; }
       export function test(): number { return f(5); }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("two-parameter variant: neither write leaks", async () => {
    await assertEquivalent(
      `function f(a: number, b: number): number {
         a = 7; b = 8;
         return arguments[0] * 100 + arguments[1] * 10 + arguments.length;
       }
       export function test(): number { return f(1, 2); }`,
      [{ fn: "test", args: [] }],
    );
  });
});

// Unit-level guard on the strictness signal itself: pins the test262
// no-regression invariant (a sloppy `.js` source with no module markers must
// NOT be treated as strict, even when compiled under a `.ts` filename as the
// test262 harness does).
describe("#2119 — isStrictFunction module detection", () => {
  function firstFn(sf: ts.SourceFile): ts.FunctionLikeDeclaration {
    let found: ts.FunctionLikeDeclaration | undefined;
    const visit = (n: ts.Node): void => {
      if (!found && ts.isFunctionDeclaration(n)) found = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) throw new Error("no function declaration found");
    return found;
  }
  const strictOf = (src: string, fileName = "test.ts") =>
    isStrictFunction(firstFn(analyzeSource(src, fileName, {}).sourceFile));

  it("sloppy script (no import/export) is NOT strict — stays mapped", () => {
    expect(strictOf(`function f(a) { a = 99; return arguments[0]; } f(5);`)).toBe(false);
  });

  it("module (top-level export) IS strict — unmapped", () => {
    expect(strictOf(`function f(a){a=99;return arguments[0];} export function test(){return f(5);}`)).toBe(true);
  });

  it('"use strict" directive script IS strict (unchanged)', () => {
    expect(strictOf(`"use strict"; function f(a){a=99;return arguments[0];} f(5);`)).toBe(true);
  });
});
