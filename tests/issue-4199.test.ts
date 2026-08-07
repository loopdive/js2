// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4199 — a TOP-LEVEL expando write onto a builtin NAMESPACE singleton
 * (`Math.value = "D"`, `JSON.configurable = true`) must reach the singleton.
 *
 * Sixth instance of the module-init COLLECTION family, one level shallower
 * than #4176's `<Builtin>.prototype.<name>`: the assignment root is a builtin
 * identifier, so `collectDeclarations` found no module-global root and dropped
 * the whole statement — it compiled to NOTHING.
 *
 * ## The precondition these tests assert
 *
 * The write ARM was never broken. `Math` as a bare value already resolves to
 * the identity-stable #2907 namespace singleton and the ordinary property-write
 * arm stores into it. The `writes from inside a function body ALREADY worked`
 * case below pins that: it passes both before and after the fix, and it is what
 * makes the top-level case a *collection* bug rather than a storage bug. A
 * fixture that only exercised the in-body form would pass on unpatched main and
 * prove nothing.
 *
 * ## Why this matters beyond the shape
 *
 * It is the ES5 §8.10.5 `ToPropertyDescriptor` idiom — a descriptor built by
 * hanging fields on a builtin, then passed as the `Attributes` argument
 * (test262 `15.2.3.6-3-91`, `-253`, and 36 siblings).
 */
import { describe, expect, it } from "vitest";
import { isBuiltinNamespaceExpandoWriteTarget } from "../src/codegen/builtin-write-keeps.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

const EMPTY: ReadonlySet<string> = new Set<string>();

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(result.imports ?? [], "must stay host-free").toEqual([]);
  expect(WebAssembly.validate(result.binary!), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

describe("#4199 top-level expando writes on builtin namespace singletons (standalone)", () => {
  // PRECONDITION — passes on unpatched main too. Establishes that the write arm
  // and the singleton's identity stability are NOT the mode under test.
  it("precondition: the same write from inside a function body already worked", async () => {
    expect(
      await runStandalone(`
        function setup(): void {
          (Math as any).probe = 5;
        }
        export function main(): number {
          setup();
          const obj: any = {};
          Object.defineProperty(obj, "p", Math as any);
          return (Math as any).probe === undefined ? -1 : 5;
        }
      `),
    ).toBe(5);
  });

  // The headline shape. Measured returning 0 (the statement was dropped) before.
  it("Math.<name> = … at top level reaches the namespace singleton", async () => {
    expect(
      await runStandalone(`
        (Math as any).value = 7;
        export function main(): number {
          const obj: any = {};
          Object.defineProperty(obj, "p", Math as any);
          return obj.p === 7 ? 7 : 0;
        }
      `),
    ).toBe(7);
  });

  it("JSON.<name> = … at top level reaches the namespace singleton", async () => {
    expect(
      await runStandalone(`
        (JSON as any).value = 9;
        export function main(): number {
          const obj: any = {};
          Object.defineProperty(obj, "p", JSON as any);
          return obj.p === 9 ? 9 : 0;
        }
      `),
    ).toBe(9);
  });

  // test262 15.2.3.6-3-91 in miniature: a non-value descriptor FIELD, observed
  // through the resulting property's attributes rather than through its value.
  it("Math.configurable = true at top level is honoured by ToPropertyDescriptor", async () => {
    expect(
      await runStandalone(`
        (Math as any).configurable = true;
        export function main(): number {
          const obj: any = {};
          Object.defineProperty(obj, "p", Math as any);
          const before: boolean = obj.hasOwnProperty("p");
          delete obj.p;
          const after: boolean = obj.hasOwnProperty("p");
          return (before ? 1 : 0) + (after ? 0 : 2);
        }
      `),
    ).toBe(3);
  });

  // Element-access form with a literal key.
  it('JSON["<name>"] = … at top level is kept', async () => {
    expect(
      await runStandalone(`
        (JSON as any)["writable"] = true;
        (JSON as any)["value"] = 3;
        export function main(): number {
          const obj: any = {};
          Object.defineProperty(obj, "p", JSON as any);
          obj.p = 4;
          return obj.p === 4 ? 3 : 0;
        }
      `),
    ).toBe(3);
  });

  // SCOPE GUARD — a write to the namespace's OWN static surface must stay
  // dropped. `Math.PI` is {[[Writable]]: false} (§21.3.1), so dropping it is
  // the spec-correct outcome, and keeping it would put a bag entry behind a
  // constant-folded read that never consults the bag.
  it("Math.PI = … stays dropped (non-writable own property)", async () => {
    expect(
      await runStandalone(`
        (Math as any).PI = 3;
        export function main(): number {
          return Math.PI > 3.14 && Math.PI < 3.15 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});

/**
 * The remaining scope guards are asserted on the predicate directly rather than
 * end-to-end. A shadowed `Math` cannot be checked through compiled output today:
 * reading `Math.tag` when a user `const Math` shadows the builtin still hits the
 * #1907 builtin-static-value-read refusal, which is a SEPARATE pre-existing
 * defect (it reproduces identically without this change). Asserting the keep
 * predicate keeps this test honest about what #4199 does and does not fix.
 */
describe("#4199 keep predicate scope", () => {
  const shadow = { moduleGlobals: EMPTY, topLevelFunctionNames: EMPTY, classSet: EMPTY };

  function lhsOf(code: string): ts.Expression {
    const sf = ts.createSourceFile("t.ts", code, ts.ScriptTarget.ESNext, true);
    const stmt = sf.statements[0] as ts.ExpressionStatement;
    return (stmt.expression as ts.BinaryExpression).left;
  }

  it.each([
    ["Math.value = 1;", true],
    ["JSON.configurable = true;", true],
    ["Reflect.writable = true;", true],
    ['JSON["value"] = 1;', true],
    ["(Math as any).value = 1;", true],
  ])("keeps %s", (code, want) => {
    expect(isBuiltinNamespaceExpandoWriteTarget(lhsOf(code), shadow)).toBe(want);
  });

  it.each([
    // own static surface — must stay dropped (see the module header)
    ["Math.PI = 3;", false],
    ["Math.abs = f;", false],
    ["JSON.stringify = f;", false],
    ['Math["PI"] = 3;', false],
    // non-namespace receivers stay owned by the #4176 / #2671 / #3468 arms
    ["Object.prototype.zzz = 1;", false],
    ["Array.isArray = f;", false],
    ["TypeError.thrower = f;", false],
    ["o.value = 1;", false],
    // a computed key cannot be decided at compile time
    ["Math[k] = 1;", false],
    // the bare namespace itself is not an expando write
    ["Math = 1;", false],
  ])("declines %s", (code, want) => {
    expect(isBuiltinNamespaceExpandoWriteTarget(lhsOf(code), shadow)).toBe(want);
  });

  it("declines when a user binding shadows the namespace", () => {
    const shadowed = { moduleGlobals: new Set(["Math"]), topLevelFunctionNames: EMPTY, classSet: EMPTY };
    expect(isBuiltinNamespaceExpandoWriteTarget(lhsOf("Math.value = 1;"), shadowed)).toBe(false);
    expect(isBuiltinNamespaceExpandoWriteTarget(lhsOf("JSON.value = 1;"), shadowed)).toBe(true);
  });
});
