// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "./context/types.js";
import { buildResolvedCalleeGuard } from "./resolved-callee-guard.js";

/** Resolve a foreign receiver's method once in its allocation owner. Delegate
 * owner-allocated callees to that owner's [[Call]], not local shape classifiers.
 * A caller-allocated callback stored on the foreign receiver stays local. */
export function fillLinkedRealmMethodCall(ctx: CodegenContext): void {
  const linked = ctx.standaloneGlobalThisImport;
  if (!linked?.owns || !linked.get || !linked.call) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_method_call");
  if (!fn) return;
  const owns = ctx.funcMap.get(linked.owns);
  const get = ctx.funcMap.get(linked.get);
  const call = ctx.funcMap.get(linked.call);
  const apply = ctx.funcMap.get("__apply_closure");
  if (owns === undefined || get === undefined || call === undefined || apply === undefined)
    throw new Error("Linked method call imports were not reserved");
  const method = 3 + fn.locals.length;
  fn.locals.push({ name: "linkedResolvedMethod", type: { kind: "externref" } });
  const guard = buildResolvedCalleeGuard(ctx, fn.locals);
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: owns },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: get },
        { op: "local.tee", index: method },
        { op: "call", funcIdx: owns },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            { op: "local.get", index: method },
            { op: "local.get", index: 0 },
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: call },
          ],
          else: [
            { op: "local.get", index: method },
            ...guard(),
            { op: "local.get", index: 0 },
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: apply },
          ],
        },
        { op: "return" },
      ],
    },
  );
}
