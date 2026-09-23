// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import ts from "typescript";

const source = `
function inferred(): number { function inner() { return 42; } return inner(); }
function union(): number { function inner(): number | undefined { return 42; } return 42; }
function optional(): number { function inner(value?: number): number { return 42; } return 42; }
function missingParam(): number { function inner(value): number { return 42; } return 42; }
function badBody(): number { function inner(): number { return absent; } return inner(); }
function accepted(): number { function inner(): number { return 42; } return inner(); }
`;

async function selection(diagnostics: boolean) {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  if (diagnostics) process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  else Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
  vi.resetModules();
  try {
    const { planIrCompilation } = await import("../src/ir/select.js");
    return planIrCompilation(ts.createSourceFile("nested-diagnostics.ts", source, ts.ScriptTarget.Latest, true), {
      experimentalIR: true,
      trackFallbacks: true,
    });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
    else process.env.JS2WASM_IR_SHAPE_DIAG = previous;
    vi.resetModules();
  }
}

it("attributes nested helper failures while preserving the first deeper failure", async () => {
  const result = await selection(true);
  const details = new Map(result.fallbacks?.map((row) => [row.name, row.detail]));
  expect(details.get("inferred")).toBe("nested-function-return-type-missing:FunctionDeclaration");
  expect(details.get("union")).toBe("nested-function-return-type:UnionType");
  expect(details.get("optional")).toBe("nested-function-param-shape:Parameter");
  expect(details.get("missingParam")).toBe("nested-function-param-type:Parameter");
  expect(details.get("badBody")).toBe("expr-ident-not-in-scope:Identifier");
  expect(result.funcs.has("accepted")).toBe(true);
});

it("does not change claims or fallback reasons when diagnostics are disabled", async () => {
  const enabled = await selection(true);
  const disabled = await selection(false);
  expect([...disabled.funcs]).toEqual([...enabled.funcs]);
  expect(disabled.fallbacks?.map(({ name, reason }) => ({ name, reason }))).toEqual(
    enabled.fallbacks?.map(({ name, reason }) => ({ name, reason })),
  );
  expect(disabled.fallbacks?.length).toBe(5);
  for (const fallback of disabled.fallbacks ?? []) expect(fallback.detail).toBeUndefined();
});
