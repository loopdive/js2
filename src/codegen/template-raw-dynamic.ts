// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5338) `strings.raw` when the template object arrives through an ORDINARY
 * parameter.
 *
 * A tagged template's strings object is a `$__template_vec_externref` — a vec
 * struct whose third field holds the raw parts. `tryNamespaceConstantAndSymbolReads`
 * reads that field directly, but only for receivers it can type statically:
 * a vec-typed slot, or the first parameter of an INLINE tag
 * (`` ((s) => s.raw)`x` ``). A tag that is an ordinary named function —
 * `` function tag(strings) { … strings.raw … }; tag`x` `` — has an `externref`
 * parameter, so the read fell through to the generic dynamic get, and in
 * JS-host mode `__extern_get` cannot index a WasmGC struct from JS: it answered
 * `undefined`. (Standalone's native `__extern_get` already has a template-vec
 * `raw` arm — `object-runtime-template-raw.ts` — so only the host lane was
 * blind.)
 *
 * `test.each\`table\`` in the dogfood harnesses gates on exactly this
 * (`Array.isArray(cases) && cases.raw && …`), so a missing `raw` silently
 * demoted the table to "the template chunks are the cases".
 *
 * The lowering is a runtime discriminator, not a static claim: `ref.test`
 * against the template-vec type, the field read on a hit, and the ORIGINAL
 * `__extern_get` on a miss. An ordinary object that genuinely carries a `raw`
 * property (marked's tokens, for one) keeps answering through the same host
 * import it always did — the arm only adds a case that used to be lost.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { typeErrorThrowInstrs } from "./property-access.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { getOrRegisterTemplateVecType } from "./registry/types.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/**
 * Whether `expr` is `<identifier>.raw` where the identifier is a live
 * `externref` slot — the shape a tag function's strings parameter takes once
 * the template vec has been widened to the host carrier.
 */
export function isDynamicTemplateRawRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): boolean {
  if (propName !== "raw" || ctx.templateVecTypeIdx < 0) return false;
  if (!ts.isIdentifier(expr.expression)) return false;
  const localIdx = fctx.localMap.get(expr.expression.text);
  if (localIdx === undefined) return false;
  const localType =
    localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;
  return localType?.kind === "externref";
}

/**
 * Emit the discriminated `raw` read. Returns the result type, or null when the
 * dynamic fallback is unavailable (no object runtime and no host import) — in
 * which case NOTHING has been emitted and the caller must fall through.
 */
export function emitDynamicTemplateRawRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null {
  const externRef: ValType = { kind: "externref" };
  let externGetIdx: number | undefined;
  if (ctx.standalone || ctx.wasi) {
    ensureObjectRuntime(ctx);
    externGetIdx = ctx.funcMap.get("__extern_get");
  } else if (!ctx.strictNoHostImports) {
    externGetIdx = ensureLateImport(ctx, "__extern_get", [externRef, externRef], [externRef]);
  }
  if (externGetIdx === undefined) return null;
  flushLateImportShifts(ctx, fctx);

  const templateVecTypeIdx = getOrRegisterTemplateVecType(ctx);
  // Every decision that can decline is made ABOVE this line: once the receiver
  // is compiled, returning null would leave its operand on the stack for a
  // fallthrough path that expects to compile the receiver itself.
  const receiverType = compileExpression(ctx, fctx, expr.expression, externRef);
  if (receiverType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (receiverType.kind !== "externref") coerceType(ctx, fctx, receiverType, externRef);

  const recvLocal = allocLocal(fctx, `__tv_raw_recv_${fctx.locals.length}`, externRef);
  const resLocal = allocLocal(fctx, `__tv_raw_res_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.tee", index: recvLocal });
  // §7.3.2 Get on a nullish base still throws — the pre-existing generic path
  // emits this same guard, so keep it ahead of the discriminator.
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: typeErrorThrowInstrs(ctx, expr, fctx) });

  addStringConstantGlobal(ctx, "raw");
  const fallback: Instr[] = [
    { op: "local.get", index: recvLocal },
    ...stringConstantExternrefInstrs(ctx, "raw"),
    { op: "call", funcIdx: externGetIdx },
    { op: "local.set", index: resLocal },
  ];
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: templateVecTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: recvLocal },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: templateVecTypeIdx },
      { op: "struct.get", typeIdx: templateVecTypeIdx, fieldIdx: 2 },
      { op: "extern.convert_any" },
      { op: "local.set", index: resLocal },
    ],
    else: fallback,
  });
  fctx.body.push({ op: "local.get", index: resLocal });
  return externRef;
}
