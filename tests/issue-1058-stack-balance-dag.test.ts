// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { stackBalance } from "../src/codegen/stack-balance.js";
import type { CodegenError } from "../src/codegen/context/types.js";
import { STABLE_FUNC_BASE } from "../src/emit/resolve-layout.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 balances a shared instruction DAG once per function", () => {
  const leaf: Instr[] = [{ op: "nop" }];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [
      { op: "block", blockType: { kind: "empty" }, body: shared },
      { op: "block", blockType: { kind: "empty" }, body: shared },
    ];
  }
  const mod = {
    types: [{ kind: "func", params: [], results: [] }],
    imports: [],
    functions: [{ name: "target", typeIdx: 0, locals: [], body: shared }],
    globals: [],
    tags: [],
    funcOrdinalToPosition: [],
  } as unknown as WasmModule;

  expect(stackBalance(mod)).toBe(0);
  expect(leaf).toEqual([{ op: "nop" }]);
});

it("#1058 refuses one shared leaf with incompatible valued and empty block contexts", () => {
  const leaf: Instr[] = [{ op: "f64.const", value: 1 }];
  const mod = {
    types: [{ kind: "func", params: [], results: [] }],
    imports: [],
    functions: [
      {
        name: "ambiguous",
        typeIdx: 0,
        locals: [],
        body: [
          { op: "block", blockType: { kind: "val", type: { kind: "i32" } }, body: leaf },
          { op: "block", blockType: { kind: "empty" }, body: leaf },
        ],
      },
    ],
    globals: [],
    tags: [],
    funcOrdinalToPosition: [],
  } as unknown as WasmModule;

  const diagnostics: CodegenError[] = [];
  expect(stackBalance(mod, diagnostics)).toBe(0);
  expect(leaf).toEqual([{ op: "f64.const", value: 1 }]);
  expect(mod.codegenErrors?.map((error) => error.message).join("\n")).toMatch(
    /incompatible control-flow or function-local contexts/,
  );
  expect(diagnostics).toEqual([
    expect.objectContaining({
      severity: "error",
      message: expect.stringMatching(/incompatible control-flow or function-local contexts/),
    }),
  ]);
});

it("#1058 distinguishes empty-block operand underflow from missing type-indexed results", () => {
  const emptyUnderflowBody: Instr[] = [{ op: "drop" }];
  const missingMultiValueBody: Instr[] = [];
  const mod = {
    types: [
      { kind: "func", params: [], results: [] },
      { kind: "func", params: [], results: [{ kind: "i32" }, { kind: "i32" }] },
    ],
    imports: [],
    functions: [
      {
        name: "operand_underflow",
        typeIdx: 0,
        locals: [],
        body: [{ op: "block", blockType: { kind: "empty" }, body: emptyUnderflowBody }],
      },
      {
        name: "missing_results",
        typeIdx: 0,
        locals: [],
        body: [
          { op: "block", blockType: { kind: "type", typeIdx: 1 }, body: missingMultiValueBody },
          { op: "drop" },
          { op: "drop" },
        ],
      },
    ],
    globals: [],
    tags: [],
    funcOrdinalToPosition: [],
  } as unknown as WasmModule;

  const diagnostics: CodegenError[] = [];
  expect(stackBalance(mod, diagnostics)).toBe(0);

  const underflow = diagnostics.find((error) => error.message.includes('function "operand_underflow"'));
  expect(underflow).toEqual(
    expect.objectContaining({
      severity: "error",
      message: expect.stringMatching(/operand stack underflow by 1 in an empty-typed block/),
    }),
  );
  expect(underflow!.message).not.toMatch(/type-indexed|multi-value/);

  const missingResults = diagnostics.find((error) => error.message.includes('function "missing_results"'));
  expect(missingResults).toEqual(
    expect.objectContaining({
      severity: "error",
      message: expect.stringMatching(/missing 2 result value\(s\) in a type-indexed \(multi-value\) block/),
    }),
  );

  // Neither unrecoverable path is "repaired" with a guessed late value. The
  // public compile sink receives severity-error diagnostics and can fail before
  // emission while the original producer bodies remain inspectable.
  expect(emptyUnderflowBody).toEqual([{ op: "drop" }]);
  expect(missingMultiValueBody).toEqual([]);
  expect(diagnostics).toHaveLength(2);
  expect(mod.codegenErrors).toEqual(diagnostics);
});

it("#1058 keeps invalid stable call handles fail-loud on a signature-cache miss", () => {
  const mod = {
    types: [{ kind: "func", params: [], results: [] }],
    imports: [],
    functions: [
      {
        name: "caller",
        typeIdx: 0,
        locals: [],
        body: [{ op: "call", funcIdx: STABLE_FUNC_BASE }],
      },
    ],
    globals: [],
    tags: [],
    // Stable ordinal 0 was minted but its function was never pushed.
    funcOrdinalToPosition: [Number.NaN],
  } as unknown as WasmModule;

  expect(() => stackBalance(mod)).toThrow(/stable handle .*ordinal 0.*no recorded position/i);
});
