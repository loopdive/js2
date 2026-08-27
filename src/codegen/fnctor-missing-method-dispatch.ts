// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native method-call arms for function-constructor instances that do not have
 * a separately materialized prototype object. Kept outside object-runtime.ts
 * so the large runtime provider remains shrink-only under the LOC ratchet.
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";

export interface FnctorMissingMethodDispatch {
  missingMethodLocal: number;
  missingMethodGuard: Instr[];
  noPrototypeArms: Instr[];
}

/** Build the shared missing-call guard and its no-prototype receiver arms. */
export function buildFnctorMissingMethodDispatch(
  ctx: CodegenContext,
  fn: WasmFunction,
  externGetIdx: number,
  applyClosureIdx: number,
): FnctorMissingMethodDispatch {
  const missingMethodLocal = 3 + fn.locals.length;
  fn.locals.push({ name: "__fnctor_missing_method", type: { kind: "externref" } });
  const missingMethodGuard: Instr[] = [
    ...(ctx.funcMap.has("__nullish_to_null")
      ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
      : []),
    { op: "local.tee", index: missingMethodLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", "called value is not a function", { forceInModuleCtor: true }),
    },
  ];

  const nativeFnctorNames = [
    ...(ctx.fnctorEscapeGate?.ctorDeclByName.keys() ?? []),
    ...ctx.fnctorReservedTypeIdx.keys(),
  ];
  const noPrototypeArms: Instr[] = [];
  for (const fnctorName of nativeFnctorNames) {
    if (ctx.fnctorPrototypeObject.has(fnctorName)) continue;
    const typeIdx = ctx.structMap.get(`__fnctor_${fnctorName}`);
    if (typeIdx === undefined) continue;
    noPrototypeArms.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          ...missingMethodGuard,
          { op: "local.get", index: missingMethodLocal },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: applyClosureIdx },
          { op: "return" },
        ],
      },
    );
  }

  return { missingMethodLocal, missingMethodGuard, noPrototypeArms };
}
