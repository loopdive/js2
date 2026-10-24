// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal } from "../src/ir/nodes.js";
import { coerceIrNumeric } from "../src/ir/numeric-slot-coercion.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

async function runNative(source: string, target: "standalone" | "wasi", expected: number) {
  const result = await compile(source, {
    target,
    fileName: "native-field.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  expect((instance.exports.run as () => number)()).toBe(expected);
  const owners =
    result.irOutcomes?.filter((row) => row.unitKind === "function" || row.unitKind === "class-member") ?? [];
  expect(owners.length).toBeGreaterThanOrEqual(2);
  for (const owner of owners) {
    expect(owner, JSON.stringify(result.irOutcomes)).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
  }
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

for (const target of ["standalone", "wasi"] as const) {
  describe(`#7137 native class numeric domains (${target})`, () => {
    for (const [name, type, initializer, expected] of [
      ["uint32 maximum", "u32", "4294967295", 4294967295],
      ["uint32 high bit", "u32", "2147483648", 2147483648],
      ["negative uint32 wraps", "u32", "-1", 4294967295],
      ["large uint32 wraps", "u32", "4294967297", 1],
      ["fractional uint32 truncates", "u32", "4294967294.9", 4294967294],
      ["NaN uint32", "u32", "NaN", 0],
      ["infinite uint32", "u32", "Infinity", 0],
      ["int32 maximum wraps", "i32", "4294967295", -1],
      ["int32 high bit wraps", "i32", "2147483648", -2147483648],
      ["negative int32 fraction", "i32", "-7.9", -7],
      ["NaN int32", "i32", "NaN", 0],
    ] as const) {
      it(`${name}: preserves initialized value and number return in IR`, async () => {
        await runNative(
          `type ${type} = number;
          class C { value: ${type} = ${initializer}; }
          export function run(): number { return (new C()).value; }`,
          target,
          expected,
        );
      });
    }
    for (const [name, declaration, body, expected] of [
      [
        "explicit constructor store",
        "class C { value: u32; constructor() { this.value = -1; } }",
        "return (new C()).value;",
        4294967295,
      ],
      [
        "subsequent field store",
        "class C { value: u32 = 0; }",
        "const c = new C(); c.value = -1; return c.value;",
        4294967295,
      ],
      ["uint32 compound wraps", "class C { value: u32 = -1; }", "const c = new C(); c.value += 2; return c.value;", 1],
      ["uint32 increment wraps", "class C { value: u32 = -1; }", "const c = new C(); c.value++; return c.value;", 0],
      [
        "int32 compound wraps",
        "class C { value: i32 = 2147483647; }",
        "const c = new C(); c.value += 1; return c.value;",
        -2147483648,
      ],
      [
        "compound reads before RHS mutation",
        "class C { value: u32 = -1; rhs(): number { this.value = 7; return 2; } }",
        "const c = new C(); c.value += c.rhs(); return c.value;",
        1,
      ],
      [
        "compound evaluates receiver once",
        "class C { value: u32 = -1; calls: number = 0; self(): C { this.calls++; return this; } }",
        "const c = new C(); c.self().value += 2; return c.calls * 10 + c.value;",
        11,
      ],
      [
        "early return",
        "class C { value: u32 = -1; }",
        "const c = new C(); if (c.value > 0) return c.value; return 0;",
        4294967295,
      ],
      ["unsigned addition", "class C { value: u32 = -1; }", "return (new C()).value + 1;", 4294967296],
      ["unsigned division", "class C { value: u32 = -1; }", "return (new C()).value / 2;", 2147483647.5],
      ["unsigned comparison", "class C { value: u32 = -1; }", "return (new C()).value > 0 ? 1 : 0;", 1],
      ["destructured field", "class C { value: u32 = -1; }", "const { value } = new C(); return value;", 4294967295],
      [
        "inherited field",
        "class Parent { value: u32 = -1; constructor() {} } class C extends Parent { constructor() { super(); } }",
        "return (new C()).value;",
        4294967295,
      ],
      [
        "implicit grandparent chain",
        "class A { value: u32 = -1; } class B extends A {} class C extends B {}",
        "return (new C()).value;",
        4294967295,
      ],
      [
        "derived own field initializer",
        "class Parent { first: u32 = -1; } class C extends Parent { value: u32 = this.first; }",
        "return (new C()).value;",
        4294967295,
      ],
      [
        "implicit constructor forwards a number argument",
        "class Parent { value: u32; constructor(n: number) { this.value = n; } } class C extends Parent {}",
        "return (new C(-1)).value;",
        4294967295,
      ],
      [
        "initializer effect once",
        "class C { count: number = 0; value: u32 = this.take(); take(): number { this.count = this.count + 1; return -1; } }",
        "const c = new C(); return c.value + c.count;",
        4294967296,
      ],
    ] as const) {
      it(name, async () => {
        await runNative(
          `type u32 = number; type i32 = number; ${declaration}
          export function run(): number { ${body} }`,
          target,
          expected,
        );
      });
    }
    it("keeps an unannotated number outside the 32-bit domain", async () => {
      await runNative(
        `class C { value: number = 4294967297.5; }
        export function run(): number { return (new C()).value; }`,
        target,
        4294967297.5,
      );
    });
    it("does not reinterpret a string alias named u32", async () => {
      await runNative(
        `type u32 = string; class C { value: u32 = "safe"; }
        export function run(): number { return (new C()).value.length; }`,
        target,
        4,
      );
    });
    it("does not reinterpret a generic alias named u32", async () => {
      await runNative(
        `type u32<T> = number; class C { value: u32<string> = 4294967297.5; }
        export function run(): number { return (new C()).value; }`,
        target,
        4294967297.5,
      );
    });
    it("prepares an implicit derived constructor whose parent owns field initializers", async () => {
      await runNative(
        `type u32 = number;
        class Parent { value: u32 = -1; } class C extends Parent {}
        export function run(): number { return (new C()).value; }`,
        target,
        4294967295,
      );
    });
    it("retains fallback when the parent's global storage owner is unprepared", async () => {
      const result = await compile(
        `var count = 0;
        function take(): number { count = count + 1; return 4; }
        class Parent { value: number = take(); } class C extends Parent {}
        export function run(): number { return (new C()).value + count; }`,
        {
          target,
          experimentalIR: true,
          trackIrOutcomes: true,
          skipSemanticDiagnostics: true,
        },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = new WebAssembly.Instance(module, {});
      (instance.exports.__module_init as (() => void) | undefined)?.();
      expect((instance.exports.run as () => number)()).toBe(5);
      for (const name of ["Parent_new", "run"]) {
        expect(
          result.irOutcomes?.find((row) => row.displayName === name),
          JSON.stringify(result.irOutcomes),
        ).toMatchObject({ legacyBodyEmitted: true });
      }
    });
    it("preserves the boolean field brand", async () => {
      await runNative(
        `class C { value: boolean = true; }
        export function run(): number { return (new C()).value ? 7 : 3; }`,
        target,
        7,
      );
    });
  });
}

const identities = createTestIrFunctionIdentityFactory("issue-7137-brands");
for (const brand of ["boolean", "symbol"] as const) {
  it(`#7137 refuses numeric slot coercion across the ${brand} brand`, () => {
    const branded = irVal({ kind: "i32", [brand]: true });
    const number = irVal({ kind: "f64" });
    const builder = new IrFunctionBuilder(identities.next(brand), []);
    const source = builder.addParam("source", branded);
    const numeric = builder.addParam("numeric", number);
    builder.openBlock();
    expect(coerceIrNumeric(builder, source, number)).toBeNull();
    expect(coerceIrNumeric(builder, numeric, branded)).toBeNull();
  });
}
