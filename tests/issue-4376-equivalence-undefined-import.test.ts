// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile, type CompileResult, type ImportDescriptor } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

describe("#4376 equivalence undefined import", () => {
  let result: CompileResult;
  beforeAll(async () => {
    result = await compile(
      `export function read(index: number): any {
        const values = new Array();
        values[2] = 7;
        return values[index];
      }`,
      { fileName: "equivalence-undefined-import.ts" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  });

  it("provides the canonical import and preserves sparse reads during manual instantiation", async () => {
    expect(result.imports).toContainEqual({
      module: "env",
      name: "__get_undefined",
      kind: "func",
      intent: { type: "builtin", name: "__get_undefined" },
      paramCount: 0,
    });
    const imports = buildImports(result);
    const getUndefined = (imports.env as Record<string, Function>).__get_undefined;
    expect(getUndefined).toBeTypeOf("function");
    expect(getUndefined!()).toBeUndefined();
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const read = instance.exports.read as (index: number) => unknown;
    expect(read(0)).toBeUndefined();
    expect(read(1)).toBeUndefined();
    expect(read(2)).toBe(7);
    expect(read(3)).toBeUndefined();
  });

  it.each<ImportDescriptor>([
    { module: "other", name: "__get_undefined", kind: "func", intent: { type: "builtin", name: "__get_undefined" } },
    { module: "env", name: "__get_undefined", kind: "global", intent: { type: "builtin", name: "__get_undefined" } },
    { module: "env", name: "__get_undefined", kind: "func", intent: { type: "math", method: "pow" } },
    {
      module: "env",
      name: "__get_undefined",
      kind: "func",
      intent: { type: "builtin", name: "__extern_is_undefined" },
    },
    { module: "env", name: "__unrelated_builtin", kind: "func", intent: { type: "builtin", name: "__get_undefined" } },
  ])("does not fill an unrelated descriptor %j", (descriptor) => {
    const env = buildImports({ ...result, imports: [descriptor] }).env as Record<string, Function>;
    expect(env.__get_undefined).toBeUndefined();
    expect(env.__unrelated_builtin).toBeUndefined();
  });

  it("does not add an undeclared undefined import", () => {
    const env = buildImports({ ...result, imports: [] }).env as Record<string, Function>;
    expect(env.__get_undefined).toBeUndefined();
  });
});
