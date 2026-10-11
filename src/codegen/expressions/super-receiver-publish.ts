// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5350 r2) `C.prototype.method()` — a direct class-method call whose
 * receiver is NOT a `$C` instance.
 *
 * A class method's `this` param is typed to the instance struct, so the call
 * site coerces the receiver with a guarded cast and passes null when the cast
 * fails. `C.prototype` is exactly such a receiver (the #5195 prototype is an
 * `$Object`). Inside the method, the §12.3.5.3 `actualThis` of a `super`
 * reference falls back to the standalone call carrier `__current_this` when
 * the typed local is null (`emitTypedThisSuperReceiver`, new-super.ts) — but
 * this call path never set the carrier, so a `super.x = v` wrote on whatever
 * receiver an earlier call had left there (or on nothing: probe b2 threw its
 * strict-mode TypeError on the FIRST write, whose receiver was null).
 *
 * This publishes the pre-cast receiver into the carrier when — and only when —
 * the cast produced null, and only for a callee whose body has a `super`
 * property reference (the carrier's only consumer here), so every other call
 * keeps its bytes.
 */
import type { ValType } from "../../ir/types.js";
import { forEachChild, ts } from "../../ts-api.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureCurrentThisGlobal } from "../statements/nested-declarations.js";

/** `super.x` / `super[k]` anywhere in `root` whose `super` is the method's (arrows transparent). */
function containsSuperPropertyReference(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node)) return;
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      node.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(root, visit);
  return found;
}

/** The guarded-cast backup the receiver coercion leaves behind (#792). */
type CastBackupCarrier = { __lastGuardedCastBackup?: number };

/**
 * The marker's value BEFORE the receiver compiles. The marker is never cleared
 * (other consumers read a stale one, so this must not reset it); a cast made BY
 * the receiver is recognised as a CHANGE of the marker.
 */
export function guardedCastBackup(fctx: FunctionContext): number | undefined {
  return (fctx as CastBackupCarrier).__lastGuardedCastBackup;
}

/**
 * With the coerced receiver (`recvType`, a `$C` ref) on the stack, publish the
 * pre-cast value into `__current_this` when the cast failed. Leaves the stack
 * unchanged. A no-op outside standalone, when the receiver ran no guarded cast
 * (`backupBefore` unchanged), or when the callee `fullName` has no `super`
 * property reference.
 */
export function publishNonInstanceSuperReceiver(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fullName: string,
  recvType: ValType | null,
  backupBefore: number | undefined,
): void {
  // The externref → `$C` coercion deliberately skips `ref.as_non_null` (#792),
  // so the value is `ref null $C` even when the reported kind is `ref`; the
  // backup marker is what proves a guarded cast ran on this receiver.
  if (!ctx.standalone || recvType === null) return;
  if (recvType.kind !== "ref" && recvType.kind !== "ref_null") return;
  const backup = (fctx as CastBackupCarrier).__lastGuardedCastBackup;
  if (backup === undefined || backup === backupBefore || getLocalType(fctx, backup)?.kind !== "anyref") return;
  const decl = ctx.fnMetaMemberDecls?.get(fullName);
  if (decl === undefined || !ts.isMethodDeclaration(decl) || decl.body === undefined) return;
  if (!containsSuperPropertyReference(decl.body)) return;
  const tmp = allocLocal(fctx, `__super_pub_recv_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: recvType.typeIdx,
  });
  fctx.body.push(
    { op: "local.tee", index: tmp },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: backup },
        { op: "extern.convert_any" },
        { op: "global.set", index: ensureCurrentThisGlobal(ctx) },
      ],
      else: [],
    },
    { op: "local.get", index: tmp },
  );
}
