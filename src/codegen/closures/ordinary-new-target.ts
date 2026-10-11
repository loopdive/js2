// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../ir/types.js";
import { buildStandardTryTable } from "../../wasm/physical/exception-control.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { ts, forEachChild } from "../../ts-api.js";

/** Private lexical binding, never a source identifier. */
export const ORDINARY_NEW_TARGET = "#new.target";
const GLOBAL_NAME = "__ordinary_construct_target";
const EXTERNREF: ValType = { kind: "externref" };

/** Descend through arrows, but not another ordinary function's activation. */
export function arrowReadsLexicalNewTarget(arrow: ts.ArrowFunction): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== arrow && ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword && node.name.text === "target") {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(arrow);
  return found;
}

function pendingTargetGlobal(ctx: CodegenContext): number {
  let index = ctx.mod.globals.findIndex((global) => global.name === GLOBAL_NAME);
  if (index < 0) {
    index = ctx.mod.globals.length;
    ctx.mod.globals.push({ name: GLOBAL_NAME, type: EXTERNREF, mutable: true, init: [{ op: "ref.null.extern" }] });
  }
  // Resolve by name each time: late global imports shift the absolute index.
  return ctx.numImportGlobals + index;
}

/** Consume before defaults/body execution; nested ordinary calls get undefined. */
export function initializeOrdinaryNewTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  undefinedExternInstrs: typeof import("../any-helpers.js").undefinedExternInstrs,
): void {
  if (!ctx.usesNewTarget || !(ctx.standalone || ctx.wasi)) return;
  const global = pendingTargetGlobal(ctx);
  const local = allocLocal(fctx, ORDINARY_NEW_TARGET, EXTERNREF);
  fctx.body.push(
    { op: "global.get", index: global },
    { op: "local.tee", index: local },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }],
      else: [{ op: "local.get", index: local }],
    },
    { op: "local.set", index: local },
    { op: "ref.null.extern" },
    { op: "global.set", index: global },
  );
}

/** Publish only around the actual [[Call]], restoring even a thrown completion. */
export function ordinaryConstructTargetFrame(
  ctx: CodegenContext,
  call: Instr[],
  locals: { name: string; type: ValType }[],
  paramCount: number,
  ensureExnTag: typeof import("../registry/imports.js").ensureExnTag,
): Instr[] {
  if (!ctx.usesNewTarget || !(ctx.standalone || ctx.wasi)) return call;
  const global = pendingTargetGlobal(ctx);
  const previous = paramCount + locals.length;
  const result = previous + 1;
  const error = previous + 2;
  locals.push(
    { name: "__previous_construct_target", type: EXTERNREF },
    { name: "__construct_target_result", type: EXTERNREF },
    { name: "__construct_target_error", type: EXTERNREF },
  );
  const restore: Instr[] = [
    { op: "local.get", index: previous },
    { op: "global.set", index: global },
  ];
  return [
    { op: "global.get", index: global },
    { op: "local.set", index: previous },
    { op: "local.get", index: 0 },
    { op: "global.set", index: global },
    buildStandardTryTable(
      { kind: "empty" },
      [...call, { op: "local.set", index: result }],
      [
        {
          kind: "catch",
          tagIdx: ensureExnTag(ctx),
          payloadType: EXTERNREF,
          body: [
            { op: "local.set", index: error },
            ...restore,
            { op: "local.get", index: error },
            { op: "throw", tagIdx: ensureExnTag(ctx) },
          ],
        },
      ],
    ),
    ...restore,
    { op: "local.get", index: result },
  ];
}
