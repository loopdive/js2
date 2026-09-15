// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { Instr } from "../ir/types.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext, NativeGeneratorInfo } from "./context/types.js";
import { MODE_THROW, setStateInstrs, storeSpills } from "./frame-core.js";
import { ensureNativeIteratorRuntime } from "./iterator-native.js";
import { ensureExnTag } from "./registry/imports.js";
import { coerceType, compileExpression } from "./shared.js";

export type NativeForOfTerminator =
  | { kind: "iterator-init"; subject: ts.Expression; iterator: string; next: number }
  | { kind: "iterator-step"; iterator: string; binding: string; bodyState: number; doneState: number }
  | { kind: "iterator-close"; iterator: string; next: number };

/** A frame slot cannot yet model per-iteration captured lexical environments. */
export function forOfBindingIsFrameSafe(body: ts.Node, binding: ts.Identifier): boolean {
  let safe = true;
  const visit = (node: ts.Node, inFunction: boolean): void => {
    const nested = inFunction || ts.isFunctionLike(node);
    if (ts.isIdentifier(node) && node.text === binding.text && node !== binding) {
      const parent = node.parent;
      if (nested || (parent && (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node)) {
        safe = false;
      }
    }
    ts.forEachChild(node, (child) => visit(child, nested));
  };
  visit(body, false);
  return safe;
}

/** Emit one non-suspending edge; only the source body's yield suspends. */
export function emitNativeForOfTerminator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  term: NativeForOfTerminator,
  selfLocal: number,
  loopDepth: number,
): void {
  ensureNativeIteratorRuntime(ctx);
  const iteratorLocal = fctx.localMap.get(term.iterator);
  if (iteratorLocal === undefined) throw new Error("Missing native for-of iterator spill");
  const runtime = (name: string): number => {
    const index = ctx.funcMap.get(name);
    if (index === undefined) throw new Error(`Missing native iterator runtime: ${name}`);
    return index;
  };
  if (term.kind === "iterator-init") {
    const type = compileExpression(ctx, fctx, term.subject, { kind: "externref" });
    if (!type) throw new Error("Cannot compile native for-of iterable");
    coerceType(ctx, fctx, type, { kind: "externref" });
    fctx.body.push({ op: "call", funcIdx: runtime("__iterator") }, { op: "local.set", index: iteratorLocal });
  } else if (term.kind === "iterator-step") {
    const bindingLocal = fctx.localMap.get(term.binding);
    const bindingType = bindingLocal === undefined ? undefined : getLocalType(fctx, bindingLocal);
    if (bindingLocal === undefined || !bindingType) throw new Error("Missing native for-of binding spill");
    const valueLocal = allocLocal(fctx, `__gen_forof_value_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push(
      { op: "local.get", index: iteratorLocal },
      { op: "call", funcIdx: runtime("__iterator_next") },
      { op: "local.set", index: valueLocal },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...setStateInstrs(info, selfLocal, term.doneState), { op: "br", depth: loopDepth + 1 }],
        else: [],
      },
      { op: "local.get", index: valueLocal },
    );
    coerceType(ctx, fctx, { kind: "externref" }, bindingType);
    fctx.body.push({ op: "local.set", index: bindingLocal });
  } else {
    // IteratorClose gives an existing throw precedence over a close failure.
    // For a pending return, the close error propagates through the outer route.
    const close = (): Instr[] => [
      { op: "local.get", index: iteratorLocal },
      { op: "call", funcIdx: runtime("__iterator_return") },
    ];
    if (info.pendingFieldIdx === undefined) throw new Error("Missing native for-of completion slot");
    fctx.body.push(
      { op: "local.get", index: selfLocal },
      { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.pendingFieldIdx },
      { op: "i32.const", value: MODE_THROW },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          buildTargetTaggedTry(ctx, { kind: "empty" }, close(), [
            { tagIdx: ensureExnTag(ctx), body: [{ op: "drop" }] },
          ]),
        ],
        else: close(),
      },
    );
  }
  fctx.body.push(
    ...storeSpills(info, fctx, selfLocal),
    ...setStateInstrs(info, selfLocal, term.kind === "iterator-step" ? term.bodyState : term.next),
    { op: "br", depth: loopDepth },
  );
}
