// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";
import { createCodegenContext } from "../src/codegen/index.js";
import { patchStructNewForAddedField } from "../src/codegen/expressions/late-imports.js";
import { createEmptyModule, type Instr } from "../src/ir/types.js";

it("#1058 pads a shared struct.new DAG reachable only through a nested function's parent body", () => {
  const leaf: Instr[] = [{ op: "ref.null.extern" }, { op: "struct.new", typeIdx: 1 }];
  let parentBody = leaf;
  for (let depth = 0; depth < 28; depth++) {
    parentBody = [{ op: "if", blockType: { kind: "empty" }, then: parentBody, else: parentBody }];
  }

  const nestedFctx = {
    name: "Outer_get_debug",
    body: [],
    savedBodies: [],
  } as unknown as FunctionContext;
  const ctx = createCodegenContext(createEmptyModule(), {} as CodegenContext["checker"]);
  ctx.currentFunc = nestedFctx;
  // Model a nested accessor/closure compile: the outer allocation body has
  // been swapped off the active FunctionContext and is owned only here.
  // Repeating the root plus sharing every then/else child proves the patch is
  // keyed by physical instruction-array identity rather than DAG occurrence.
  ctx.parentBodiesStack.push(parentBody, parentBody);

  patchStructNewForAddedField(ctx, nestedFctx, 1, { kind: "externref" });

  expect(leaf).toEqual([{ op: "ref.null.extern" }, { op: "ref.null.extern" }, { op: "struct.new", typeIdx: 1 }]);
});
