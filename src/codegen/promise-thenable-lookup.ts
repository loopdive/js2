// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Legacy registration adapter only; executable bodies remain canonical runtime code.
import type { WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import {
  buildPromiseThenableClassifier,
  buildPromiseThenableLookup,
  type PromiseThenableInventory,
} from "../runtime/wasmgc/promise/thenable-bodies.js";

/** Reserve in the scheduler's original order, before publishing the substrate. */
export function reservePromiseThenableValueHelpers(ctx: CodegenContext): {
  peelValueFuncIdx: number;
  lookupThenFuncIdx: number;
} {
  // __promise_peel_value(value: externref) -> externref — reserved; filled at
  // finalize (needs `$AnyValue`, whose typeIdx may not exist yet). IDENTITY
  // placeholder: raw (unboxed) values are classified/dispatched unchanged.
  const peelTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$__promise_peel_type");
  const peelValueFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, peelValueFuncIdx, {
    name: "__promise_peel_value",
    typeIdx: peelTypeIdx,
    locals: [],
    body: [{ op: "local.get", index: 0 }],
    exported: false,
  });
  ctx.funcMap.set("__promise_peel_value", peelValueFuncIdx);
  const lookupTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
    "$__promise_lookup_then_type",
  );
  const lookupThenFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, lookupThenFuncIdx, {
    name: "__promise_lookup_then",
    typeIdx: lookupTypeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set("__promise_lookup_then", lookupThenFuncIdx);
  return { peelValueFuncIdx, lookupThenFuncIdx };
}

/** Inventory collection and the original early guards remain in the driver. */
export function finalizePromiseThenableLookup(
  ctx: CodegenContext,
  predFn: WasmFunction,
  inventory: PromiseThenableInventory,
): void {
  const result = buildPromiseThenableClassifier(inventory);
  predFn.locals = result.locals;
  predFn.body = result.body;
  const lookupIdx = ctx.funcMap.get("__promise_lookup_then");
  const lookupFn = lookupIdx === undefined ? undefined : definedFuncAt(ctx, lookupIdx);
  if (lookupFn) {
    const lookup = buildPromiseThenableLookup(inventory);
    lookupFn.locals = lookup.locals;
    lookupFn.body = lookup.body;
  }
}
