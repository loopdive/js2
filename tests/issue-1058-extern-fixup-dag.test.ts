// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { fixupExternConvertAny } from "../src/codegen/fixups.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

it("#1058 fixes extern conversions in a shared instruction DAG once", () => {
  const leaf: Instr[] = [{ op: "ref.null.extern" }, { op: "extern.convert_any" }];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }
  const mod = {
    types: [{ kind: "func", params: [], results: [] }],
    imports: [],
    globals: [],
    functions: [{ name: "target", typeIdx: 0, locals: [], body: shared }],
  } as unknown as WasmModule;

  const ctx = { mod, errors: [] } as unknown as CodegenContext;
  fixupExternConvertAny(ctx);

  expect(leaf).toEqual([{ op: "ref.null.extern" }]);
});

it("#1058 fails closed on extern conversion cleanup for a body shared across local spaces", () => {
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "extern.convert_any" }];
  const mod = {
    types: [
      { kind: "func", params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
      { kind: "func", params: [{ kind: "anyref" }], results: [{ kind: "externref" }] },
    ],
    imports: [],
    globals: [],
    functions: [
      { name: "external", typeIdx: 0, locals: [], body },
      { name: "internal", typeIdx: 1, locals: [], body },
    ],
  } as unknown as WasmModule;

  const ctx = { mod, errors: [] } as unknown as CodegenContext;
  fixupExternConvertAny(ctx);

  expect(body).toEqual([{ op: "local.get", index: 0 }, { op: "extern.convert_any" }]);
  expect(mod.codegenErrors).toEqual([
    expect.objectContaining({ severity: "error", message: expect.stringContaining("extern.convert_any repair") }),
  ]);
  expect(ctx.errors).toEqual(mod.codegenErrors);
});
