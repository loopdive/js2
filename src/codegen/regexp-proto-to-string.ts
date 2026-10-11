// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B10) The reified `RegExp.prototype.toString`
 * closure BODY — §22.2.6.17, generic over any Object receiver:
 *
 * ```
 *   1. R := this; if Type(R) is not Object, throw TypeError
 *   2. pattern := ? ToString(? Get(R, "source"))
 *   3. flags   := ? ToString(? Get(R, "flags"))
 *   4. return "/" ++ pattern ++ "/" ++ flags
 * ```
 *
 * The glue (`emitRegExpProtoMemberBody`, regexp-standalone.ts) minted this
 * member with a PLACEHOLDER body that answers `null`: measured on the B10
 * base, `RegExp.prototype.toString.call(/1/g)` read back `"null"` through the
 * value, and — once `__extern_get` answers the member for an untyped RegExp —
 * so did `r.toString()` / `String(r)` / `r + ""`, because the #4564
 * `__to_primitive` RegExp arm calls whatever `toString` the property lookup
 * finds.
 *
 * The two Gets go through `__extern_get`, so the B4 accessor prologue answers
 * `source`/`flags` for a real RegExp (and an own override or a plain object's
 * data property is honoured, which is the point of step 2-3 being Gets). Both
 * ToStrings are the spec's (`__extern_to_string_spec`: a Symbol throws).
 *
 * ## Demand gate
 *
 * Only a module whose source DEMANDS the member for an untyped RegExp
 * (`regexp-untyped-receiver.ts` decides, before any closure is minted, and
 * calls {@link demandRegExpProtoToStringBody}) gets the real body; every other
 * module keeps the placeholder bytes. The placeholder is a pre-existing gap in
 * modules that call the reified closure some other way — recorded as a
 * residual rather than widened here, because the member is minted in every
 * module that seeds the RegExp companion and the byte reach of a global body
 * change is that whole set.
 */
import type { Instr, ValType } from "../ir/types.js";
import { nativeStringRepr } from "./builtin-scaffold.js";
import { ensureSpecExternrefToStringProvider } from "./coercion-engine.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

const demanded = new WeakSet<CodegenContext>();

/** Mark `ctx` as needing the real body (call before any closure is minted). */
export function demandRegExpProtoToStringBody(ctx: CodegenContext): void {
  demanded.add(ctx);
}

/**
 * Emit the §22.2.6.17 body into the closure `fctx` (`thisParam` = the
 * externref `this`), leaving an externref string. Returns `null` — emitting
 * nothing — when the module did not demand it or a prerequisite is missing, so
 * the caller keeps its previous body.
 */
export function emitRegExpProtoToStringBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  thisParam: number,
): ValType | null {
  if (!demanded.has(ctx) || !ctx.standalone) return null;
  const repr = nativeStringRepr(ctx);
  if (!repr || ctx.anyStrTypeIdx < 0) return null;
  // Register every native BEFORE an index is read (#2043).
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  for (const key of ["source", "flags"]) addStringConstantGlobal(ctx, key);
  flushLateImportShifts(ctx, fctx);
  const throwInstrs = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "RegExp.prototype.toString requires an Object receiver",
    {
      flush: fctx,
    },
  );
  // The coercion engine's spec ToString (a Symbol throws), or its plain
  // provider where the module has no Symbol carrier.
  const toStringIdx = ensureSpecExternrefToStringProvider(ctx, fctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  if (externGetIdx === undefined || typeofObjectIdx === undefined || toStringIdx === undefined) return null;

  const anyStr = ctx.anyStrTypeIdx;
  /** `ToString(Get(this, key))` as `(ref $AnyString)`. */
  const part = (key: string): Instr[] => [
    { op: "local.get", index: thisParam },
    ...stringConstantExternrefInstrs(ctx, key),
    { op: "call", funcIdx: externGetIdx },
    { op: "call", funcIdx: toStringIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
  ];
  // Step order: `source` is read and converted before `flags` is read.
  let acc = repr.concat(repr.literal("/"), part("source"));
  acc = repr.concat(acc, repr.literal("/"));
  acc = repr.concat(acc, part("flags"));
  fctx.body.push(
    // Step 1 — `typeof null === "object"`, so null is screened first.
    { op: "local.get", index: thisParam },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: thisParam },
        { op: "call", funcIdx: typeofObjectIdx },
      ],
    },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
    ...acc,
    { op: "extern.convert_any" },
  );
  return EXTERNREF;
}
