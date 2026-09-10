import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureExnTag } from "./registry/imports.js";
import { buildStandardTryTable } from "../ir/try-table.js";

/** Pending ordinary-function NewTarget, consumed by the invoked function. */
export function ensureOrdinaryNewTarget(ctx: CodegenContext): number {
  if (ctx.ordinaryNewTargetGlobalIdx !== undefined) return ctx.ordinaryNewTargetGlobalIdx;
  const initial = canonicalUndefinedExternInstrs(ctx);
  const index = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__ordinary_new_target",
    type: { kind: "externref" },
    mutable: true,
    init: initial,
  });
  ctx.ordinaryNewTargetGlobalIdx = index;
  return index;
}

export function initializeOrdinaryNewTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  node: ts.ArrowFunction | ts.FunctionExpression,
): void {
  if (!ctx.standalone || !ctx.usesNewTarget || !ts.isFunctionExpression(node)) return;
  const global = ensureOrdinaryNewTarget(ctx);
  const local = allocLocal(fctx, "__new_target", { kind: "externref" });
  fctx.ordinaryNewTargetLocal = local;
  fctx.body.push(
    { op: "global.get", index: global },
    { op: "local.set", index: local },
    ...canonicalUndefinedExternInstrs(ctx),
    { op: "global.set", index: global },
  );
}

/** Restore the pending slot on normal and tagged-exception exits. */
export function ordinaryConstructCall(
  ctx: CodegenContext,
  call: Instr[],
  previous: number,
  exception: number,
  result: number,
): Instr[] {
  if (!ctx.standalone || !ctx.usesNewTarget) return call;
  const global = ensureOrdinaryNewTarget(ctx);
  const tagIdx = ensureExnTag(ctx);
  const restore: Instr[] = [
    { op: "local.get", index: previous },
    { op: "global.set", index: global },
  ];
  return [
    { op: "global.get", index: global },
    { op: "local.set", index: previous },
    { op: "local.get", index: 0 },
    { op: "global.set", index: global },
    buildStandardTryTable({ kind: "val", type: { kind: "externref" } }, call, [
      {
        kind: "catch",
        tagIdx,
        payloadType: { kind: "externref" },
        body: [
          { op: "local.set", index: exception },
          ...restore,
          { op: "local.get", index: exception },
          { op: "throw", tagIdx },
        ],
      },
    ]),
    { op: "local.set", index: result },
    ...restore,
    { op: "local.get", index: result },
  ];
}
