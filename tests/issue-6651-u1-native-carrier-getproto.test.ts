// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice U1 — §10.1.1 [[GetPrototypeOf]] over a DYNAMICALLY-typed native
// builtin carrier in `--target standalone`.
//
// R1 fixed the array carrier. Every other native instance representation —
// `$Error_struct`, the shared `$Map` (Map/Set/WeakMap/WeakSet), `__Date`,
// `$Promise`, `__StandaloneRegExp` — is likewise not an `$Object`, so the
// dynamic `__getPrototypeOf` fell through to `null`; the boxed-primitive
// wrapper (`new String()` …) IS an `$Object` but answered the implicit
// `%Object.prototype%` terminal instead of its own wrapper prototype. Only an
// `any`-typed receiver reaches the native (static types are folded), which is
// why the test262 rows that expose it read the result of a `Reflect.construct`
// (`built-ins/*/proto-from-ctor-realm.js`). Measured on base (no realm, no
// eval): every case below answered `null` (or, for the wrappers, "other").
//
// The fix is `src/codegen/object-model/native-carrier-get-prototype.ts`, prepended to
// `__getPrototypeOf` at finalize. No eval anywhere in this suite.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** 1 = `=== expected`, 0 = null, 3 = undefined, 2 = some other value. */
async function protoCodes(checks: string): Promise<string> {
  // Each check appends one decimal digit to \`out\` (a number: a standalone
  // string export is a native carrier the host cannot print).
  const source = `
    function id(x: any): any { return x; }
    function classify(p: any, expected: any): number {
      if (p === expected) return 1;
      if (p === null) return 0;
      if (p === undefined) return 3;
      return 2;
    }
    export function test(): number {
      let out = 0;
      ${checks}
      return out;
    }
  `;
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return String((instance.exports as { test: () => number }).test());
}

const check = (expr: string, proto: string): string =>
  `out = out * 10 + classify(Object.getPrototypeOf(${expr}), ${proto});`;

describe("#6651 U1 — Object.getPrototypeOf over dynamically-typed native carriers (standalone)", () => {
  it("answers the NativeError prototypes for any-typed Error instances", async () => {
    expect(
      await protoCodes(
        [
          check("id(new Error('x'))", "Error.prototype"),
          check("id(new TypeError('x'))", "TypeError.prototype"),
          check("id(new RangeError('x'))", "RangeError.prototype"),
          check("id(new SyntaxError('x'))", "SyntaxError.prototype"),
          check("id(new ReferenceError('x'))", "ReferenceError.prototype"),
          check("id(new EvalError('x'))", "EvalError.prototype"),
          check("id(new URIError('x'))", "URIError.prototype"),
        ].join("\n"),
      ),
    ).toBe("1111111");
  });

  it("answers the keyed-collection prototypes per collection kind", async () => {
    expect(
      await protoCodes(
        [
          check("id(new Map())", "Map.prototype"),
          check("id(new Set())", "Set.prototype"),
          check("id(new WeakMap())", "WeakMap.prototype"),
          check("id(new WeakSet())", "WeakSet.prototype"),
        ].join("\n"),
      ),
    ).toBe("1111");
  });

  it("answers Date / RegExp / Promise prototypes", async () => {
    expect(
      await protoCodes(
        [
          check("id(new Date(0))", "Date.prototype"),
          check("id(/a/)", "RegExp.prototype"),
          check("id(new Promise(function () {}))", "Promise.prototype"),
        ].join("\n"),
      ),
    ).toBe("111");
  });

  it("answers the wrapper prototype for boxed primitives, not %Object.prototype%", async () => {
    expect(
      await protoCodes(
        [
          check("id(new String('q'))", "String.prototype"),
          check("id(new Number(1))", "Number.prototype"),
          check("id(new Boolean(true))", "Boolean.prototype"),
        ].join("\n"),
      ),
    ).toBe("111");
  });

  // (Map/String targets are left out: in a .ts source this NewTarget shape still
  // hits the pre-existing #3371 compile-time refusal; the JS test262 rows do not.)
  it("serves Reflect.construct results whose NewTarget has no object prototype (§10.1.14 step 4)", async () => {
    expect(
      await protoCodes(
        `
        function NT() {}
        (NT as any).prototype = null;
        ${check("Reflect.construct(Error, [], NT)", "Error.prototype")}
        ${check("Reflect.construct(RangeError, [], NT)", "RangeError.prototype")}
        ${check("Reflect.construct(Date, [], NT)", "Date.prototype")}
      `,
      ),
    ).toBe("111");
  });

  // Guards — answers that must NOT move.
  it("keeps ordinary objects, explicit null prototypes and re-parented wrappers unchanged", async () => {
    expect(
      await protoCodes(
        `
        const p: any = { k: 1 };
        const w: any = new String("q");
        Object.setPrototypeOf(w, p);
        ${check("id({})", "Object.prototype")}
        ${check("id(Object.create(null))", "null")}
        ${check("id(w)", "p")}
        ${check("id([1])", "Array.prototype")}
      `,
      ),
    ).toBe("1111");
  });

  it("does not claim a user Error subclass instance for the builtin prototype", async () => {
    // `class E extends Error` shares `$Error_struct` but brands `$userClassId`;
    // the arm must leave it alone (its answer is the subclass prototype, which
    // this arm cannot name).
    expect(
      await protoCodes(
        `
        class E extends Error {}
        out = 5 + (Object.getPrototypeOf(id(new E())) === Error.prototype ? 1 : 0);
      `,
      ),
    ).toBe("5");
  });
});
