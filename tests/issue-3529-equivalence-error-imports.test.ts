// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type ImportDescriptor } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

const ERROR_CASES = [
  ["Error", `new Error("boom")`],
  ["TypeError", `new TypeError("boom")`],
  ["RangeError", `new RangeError("boom")`],
  ["SyntaxError", `new SyntaxError("boom")`],
  ["URIError", `new URIError("boom")`],
  ["EvalError", `new EvalError("boom")`],
  ["ReferenceError", `new ReferenceError("boom")`],
  ["AggregateError", `new AggregateError(errors, message, options)`],
] as const;

const NATIVE_ERROR_CONSTRUCTORS: Readonly<Record<(typeof ERROR_CASES)[number][0], Function>> = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  URIError,
  EvalError,
  ReferenceError,
  AggregateError,
};

describe("#3529 P5 — equivalence Error-family imports", () => {
  it.each(ERROR_CASES)("provides the production %s constructor for manual instantiation", async (name, expr) => {
    const source =
      name === "AggregateError"
        ? `export function test(errors: any, message: any, options: any): any { return ${expr}; }`
        : `export function test(flag: boolean = false, errors: any = null): number {
            if (flag) throw ${expr};
            return 1;
          }`;
    const result = await compile(source, { fileName: `equivalence-${name}.ts` });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const importName = `__new_${name}`;
    const expectedIntent =
      name === "AggregateError"
        ? { type: "builtin" as const, name: importName }
        : { type: "extern_class" as const, className: name, action: "new" as const };
    expect(result.imports).toContainEqual({ module: "env", name: importName, kind: "func", intent: expectedIntent });

    const imports = buildImports(result);
    const constructorImport = (imports.env as Record<string, Function>)[importName];
    expect(constructorImport).toBeTypeOf("function");

    const first = new Error("first");
    const second = new TypeError("second");
    const cause = { source: "third-abi-argument" };
    const errors = [first, second];
    const error = name === "AggregateError" ? constructorImport!(errors, 23, { cause }) : constructorImport!("boom");
    expect(error).toBeInstanceOf(NATIVE_ERROR_CONSTRUCTORS[name]);
    expect(error).toMatchObject({ name, message: name === "AggregateError" ? "23" : "boom" });
    if (name === "AggregateError") {
      expect(error.errors).toEqual([first, second]);
      expect(error.errors).not.toBe(errors);
      expect(error.cause).toBe(cause);
    }

    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    if (name === "AggregateError") {
      const wasmError = (instance.exports.test as (errors: unknown, message: unknown, options: unknown) => unknown)(
        errors,
        23,
        { cause },
      ) as AggregateError;
      expect(wasmError).toBeInstanceOf(AggregateError);
      expect(wasmError.errors).toEqual([first, second]);
      expect(wasmError.errors).not.toBe(errors);
      expect(wasmError.message).toBe("23");
      expect((wasmError as AggregateError & { cause?: unknown }).cause).toBe(cause);
    } else {
      expect((instance.exports.test as (flag: number, errors: unknown) => number)(0, null)).toBe(1);
    }
  });

  it("resolves only canonical Error descriptor intents and leaves unrelated imports alone", async () => {
    const result = await compile(`export function test(): number { return 1; }`, {
      fileName: "equivalence-error-filter.ts",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const nonCanonical: ImportDescriptor[] = [
      {
        module: "env",
        name: "__new_AggregateError",
        kind: "func",
        intent: { type: "extern_class", className: "AggregateError", action: "new" },
      },
      {
        module: "env",
        name: "__new_Error",
        kind: "func",
        intent: { type: "builtin", name: "__new_Error" },
      },
      {
        module: "env",
        name: "__new_CustomError",
        kind: "func",
        intent: { type: "extern_class", className: "CustomError", action: "new" },
      },
      {
        module: "env",
        name: "Math_pow",
        kind: "func",
        intent: { type: "math", method: "pow" },
      },
    ];
    const env = buildImports({ ...result, imports: nonCanonical }).env as Record<string, Function>;

    expect(env.__new_AggregateError).toBeUndefined();
    expect(env.__new_Error).toBeUndefined();
    expect(env.__new_CustomError).toBeUndefined();
    expect(env.Math_pow).toBe(Math.pow);
  });
});
