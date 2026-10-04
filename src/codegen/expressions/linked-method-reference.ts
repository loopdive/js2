// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { LINKED_RESOLVED_CALL, reserveLinkedResolvedCall } from "../linked-realm-method-call.js";

/** GetValue of a foreign method precedes argument evaluation. Keep the resolved
 * callee in this call frame, never a global cache that nested calls can clobber.
 * Local receivers keep their existing method dispatch unchanged. */
export function prepareLinkedMethodReference(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: number,
  key: () => Instr[],
): ((args: number, fallback?: () => Instr[]) => void) | undefined {
  const linked = ctx.standaloneGlobalThisImport;
  if (!linked?.owns || !linked.get || !linked.call) return undefined;
  const owns = ctx.funcMap.get(linked.owns),
    get = ctx.funcMap.get(linked.get);
  if (owns === undefined || get === undefined) throw new Error("Linked method reference providers unavailable");
  reserveLinkedResolvedCall(ctx);
  const foreign = allocLocal(fctx, "linkedMethodOwner", { kind: "i32" });
  const callee = allocLocal(fctx, "linkedMethodValue", { kind: "externref" });
  fctx.body.push(
    { op: "local.get", index: receiver },
    { op: "call", funcIdx: owns },
    { op: "local.tee", index: foreign },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: receiver },
        ...key(),
        { op: "local.get", index: receiver },
        { op: "call", funcIdx: get },
        { op: "local.set", index: callee },
      ],
    },
  );
  return (args, fallback) => {
    const resolved = ctx.funcMap.get(LINKED_RESOLVED_CALL),
      method = ctx.funcMap.get("__extern_method_call");
    if (resolved === undefined || method === undefined) throw new Error("Linked method call terminals unavailable");
    fctx.body.push(
      { op: "local.get", index: foreign },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: callee },
          { op: "local.get", index: receiver },
          { op: "local.get", index: args },
          { op: "call", funcIdx: resolved },
        ],
        else: fallback
          ? fallback()
          : [
              { op: "local.get", index: receiver },
              ...key(),
              { op: "local.get", index: args },
              { op: "call", funcIdx: method },
            ],
      },
    );
  };
}

/** The closed dispatcher accepts args on the operand stack. Preserve that
 * existing evaluation code, then capture its values without re-evaluating AST. */
export function prepareLinkedClosedMethodReference(
  ctx: CodegenContext,
  fctx: FunctionContext,
  key: () => Instr[],
  arity: number,
  dispatcher: string,
): (() => void) | undefined {
  const linked = ctx.standaloneGlobalThisImport;
  if (!linked?.owns || !linked.get || !linked.call) return undefined;
  const receiver = allocLocal(fctx, "linkedClosedReceiver", { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: receiver });
  const invoke = prepareLinkedMethodReference(ctx, fctx, receiver, key)!;
  return () => {
    const locals = Array.from({ length: arity }, () => allocLocal(fctx, "linkedClosedArg", { kind: "externref" }));
    for (const index of [...locals].reverse()) fctx.body.push({ op: "local.set", index });
    fctx.body.push({ op: "drop" }); // original receiver beneath the args
    const args = allocLocal(fctx, "linkedClosedArgs", { kind: "externref" });
    const make = ctx.funcMap.get("__objvec_new"),
      push = ctx.funcMap.get("__objvec_push"),
      call = ctx.funcMap.get(dispatcher);
    if (make === undefined || push === undefined || call === undefined)
      throw new Error("Linked closed method terminals unavailable");
    fctx.body.push({ op: "call", funcIdx: make }, { op: "local.set", index: args });
    for (const index of locals)
      fctx.body.push({ op: "local.get", index: args }, { op: "local.get", index }, { op: "call", funcIdx: push });
    invoke(args, () => [
      { op: "local.get", index: receiver },
      ...locals.map((index): Instr => ({ op: "local.get", index })),
      { op: "call", funcIdx: call },
    ]);
  };
}
