// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitNativeNumberFormat, ensureIrNativeNumberToString } from "../src/codegen/number-format-native.js";

describe("retained real legacy formatter callers", () => {
  it.each(["0", "1"])("emits each formatter family once and reuses it with integer switch %s", (switchValue) => {
    vi.stubEnv("JS2WASM_NUMBER_TO_STRING_INTEGER_FASTPATH", switchValue);
    try {
      const checker = ts.createProgram([], {}).getTypeChecker();
      const ctx = createCodegenContext(createEmptyModule(), checker, { standalone: true });
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
      const functions = [...ctx.mod.functions];
      const types = [...ctx.mod.types];
      const globals = [...ctx.mod.globals];
      const names = [...ctx.funcMap];
      expect(ctx.funcMap.has("number_toString")).toBe(true);
      expect(ctx.funcMap.has("number_toString_radix")).toBe(true);
      expect(ctx.funcMap.has("number_toFixed")).toBe(false);
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
      expect(ctx.mod.functions).toEqual(functions);
      expect(ctx.mod.types).toEqual(types);
      expect(ctx.mod.globals).toEqual(globals);
      expect([...ctx.funcMap]).toEqual(names);
      functions.forEach((fn, index) => expect(ctx.mod.functions[index]).toBe(fn));
      emitNativeNumberFormat(ctx, new Set(["number_toPrecision"]));
      expect(ctx.funcMap.has("number_toFixed")).toBe(true);
      expect(ctx.funcMap.has("number_toExponential")).toBe(true);
      expect(ctx.funcMap.has("number_toPrecision")).toBe(true);
      functions.forEach((fn, index) => expect(ctx.mod.functions[index]).toBe(fn));
      for (const [name, handle] of names) expect(ctx.funcMap.get(name)).toBe(handle);
      expect(ensureIrNativeNumberToString(ctx, true)).toBe(ctx.funcMap.get("number_toString"));
      const native = ensureIrNativeNumberToString(ctx);
      expect(native).not.toBeNull();
      expect(ensureIrNativeNumberToString(ctx)).toBe(native);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
