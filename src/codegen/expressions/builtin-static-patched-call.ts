// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6957) `Math.<method>(…)` when the program PATCHES `Math.<method>`.
 *
 * Octane's base.js installs a seeded generator with
 * `Math.random = (function () { … })()` and every benchmark then calls
 * `Math.random()`. The write lands on the namespace carrier
 * (`emitBuiltinNamespaceObject`, #2907), but the static call arm lowered every
 * `Math.<m>(…)` straight to its kernel and never consulted that carrier — so
 * the seeded generator was silently ignored (regexp: `Wrong checksum.`).
 *
 * For a member the program writes (`isPatchedBuiltinStaticMember`, a
 * standalone-only source scan) the call becomes the ordinary one:
 * `[[Get]](Math, name)` on the carrier, then `[[Call]]` with `this = Math`
 * through `__apply_closure`. The carrier is seeded with the builtin closure for
 * every modelled method, so a call that runs BEFORE the override (or when the
 * override is conditional) still reaches the builtin. Programs that never write
 * the member keep the static kernel lowering byte-for-byte.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { emitBuiltinNamespaceObject } from "../builtin-static-globals.js";
import { isSyntheticPropertyAssignmentReceiverDeclaration } from "../builtin-write-keeps.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { coerceType, compileExpression } from "../shared.js";
import { isPatchedBuiltinStaticMember } from "../source-scan-predicates.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/**
 * Is `ident` the ambient global namespace binding (no local, capture or source
 * declaration)? Unlike `isGlobalBuiltinIdentifier` this ignores the declaration
 * TypeScript synthesizes on the receiver of a JS property write — a top-level
 * `Math.random = fn` appends the `Math` identifier to the lib symbol's
 * declarations, which is exactly the program this path exists for.
 */
function isAmbientNamespaceReceiver(ctx: CodegenContext, fctx: FunctionContext, ident: ts.Identifier): boolean {
  if (fctx.localMap.has(ident.text) || fctx.boxedCaptures?.has(ident.text)) return false;
  const declarations = ctx.oracle
    .declarationsOf(ident)
    .filter((declaration) => !isSyntheticPropertyAssignmentReceiverDeclaration(declaration));
  return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

/**
 * Emit `ns.name(...args)` as a dynamic carrier call when the program patches
 * `ns.name`. Returns `undefined` having emitted NOTHING when the member is not
 * patched, `receiver` is not the ambient global, or the call shape is not
 * handled (spread arguments) — the caller keeps its static lowering.
 *
 * Stack: `[] → [externref]`.
 */
export function tryEmitPatchedBuiltinStaticCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Identifier,
  name: string,
  expr: ts.CallExpression,
): ValType | undefined {
  const ns = receiver.text;
  if (!isPatchedBuiltinStaticMember(ctx, ns, name)) return undefined;
  if (!isAmbientNamespaceReceiver(ctx, fctx, receiver)) return undefined;
  if (expr.arguments.some((argument) => ts.isSpreadElement(argument))) return undefined;

  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  reserveApplyClosure(ctx);
  ensureObjVecBuilders(ctx);
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return undefined;

  const objLocal = allocLocal(fctx, `__patched_${ns}_obj_${fctx.locals.length}`, { kind: "externref" });
  if (emitBuiltinNamespaceObject(ctx, fctx, ns) === null) return undefined;
  fctx.body.push({ op: "local.set", index: objLocal });

  // Callee = [[Get]](carrier, name) — the user's function after the write, the
  // seeded builtin closure before it.
  const calleeLocal = allocLocal(fctx, `__patched_${ns}_callee_${fctx.locals.length}`, { kind: "externref" });
  addStringConstantGlobal(ctx, name);
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, name));
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? getIdx });
  fctx.body.push({ op: "local.set", index: calleeLocal });

  // Arguments are evaluated after the callee is read (§13.3.6.1 EvaluateCall).
  fctx.body.push({ op: "call", funcIdx: ensureObjVecBuilders(ctx).newIdx });
  const argsLocal = allocLocal(fctx, `__patched_${ns}_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const argument of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const valueType = compileExpression(ctx, fctx, argument, { kind: "externref" });
    if (valueType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, { kind: "externref" });
    fctx.body.push({ op: "call", funcIdx: ensureObjVecBuilders(ctx).pushIdx });
  }
  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: reserveApplyClosure(ctx) });
  return { kind: "externref" };
}
