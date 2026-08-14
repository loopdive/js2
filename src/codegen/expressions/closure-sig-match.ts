// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) Signature→ClosureInfo matching for the generic expression-call tail
 * of `compileCallExpression` (callee is itself a call expression or another
 * non-LHSE shape, e.g. the deepEqual.js harness chain `lazyResult(...)(...)`).
 *
 * The historical pick was a single linear scan over `ctx.closureInfoByTypeIdx`
 * comparing only ValType KINDS (param count + `kind` strings). With two
 * registered closures of the same arity whose ref-typed results differ only in
 * `typeIdx` — deepEqual.js registers `toString: (self) → $AnyString` and
 * `acceptMappers: (self) → { toString }` back to back — the scan returned
 * whichever registered FIRST. The call site then `ref.test`s the callee's
 * funcref against the WRONG lifted func type, the guarded cast nulls, and
 * `call_ref` traps with "dereferencing a null pointer" (the standalone
 * `deepEqual-*` harness self-test family, #4394).
 *
 * Two passes over the same registry:
 *   1. EXACT — every ref/ref_null position (params and result) must also agree
 *      on `typeIdx`. This is the only pick that can be trusted to `call_ref`
 *      without the guarded funcref cast nulling at runtime.
 *   2. LOOSE — the legacy kind-only match, kept as fallback so shapes that
 *      never had an exact registration keep their historical behavior.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { ClosureInfo, CodegenContext } from "../context/types.js";

/** Does the TS call signature's declaration end in a `...rest` parameter? */
export function tsSignatureHasRest(sig: ts.Signature): boolean {
  const d = sig.declaration;
  return d !== undefined && ts.isFunctionLike(d) && d.parameters.some((p) => p.dotDotDotToken !== undefined);
}

/** Legacy kind-level comparison (what the single-pass scan used). */
function kindMatches(a: ValType, b: ValType): boolean {
  return a.kind === b.kind;
}

/** Kind match PLUS typeIdx agreement on ref/ref_null positions. */
function exactMatches(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ref" || a.kind === "ref_null") {
    return (a as { typeIdx?: number }).typeIdx === (b as { typeIdx?: number }).typeIdx;
  }
  return true;
}

/**
 * Pick the ClosureInfo whose lifted signature matches the callee's resolved
 * wasm signature: exact (typeIdx-aware) match first, legacy kind-only match as
 * fallback. Returns `undefined` when nothing matches even loosely — the caller
 * keeps its historical no-match fallback.
 */
export function matchClosureInfoBySignature(
  ctx: CodegenContext,
  sigParamWasmTypes: readonly ValType[],
  sigRetWasm: ValType | null,
  opts?: {
    /**
     * The TS call signature's own rest-ness. When set, an exact candidate whose
     * `hasRestParam` AGREES is preferred over one that merely matches types —
     * the same lifted shape is often registered twice (memoized nested-fn
     * closure AND cached singleton), and only one record carries the flag the
     * caller needs to pack trailing args into the rest vec.
     */
    sigHasRest?: boolean;
  },
): { info: ClosureInfo; structTypeIdx: number } | undefined {
  let loose: { info: ClosureInfo; structTypeIdx: number } | undefined;
  let exactFallback: { info: ClosureInfo; structTypeIdx: number } | undefined;
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length !== sigParamWasmTypes.length) continue;
    if (sigRetWasm === null && info.returnType !== null) continue;
    if (sigRetWasm !== null && info.returnType === null) continue;
    if (sigRetWasm !== null && info.returnType !== null && !kindMatches(sigRetWasm, info.returnType)) continue;
    let kindsMatch = true;
    for (let i = 0; i < sigParamWasmTypes.length; i++) {
      if (!kindMatches(sigParamWasmTypes[i]!, info.paramTypes[i]!)) {
        kindsMatch = false;
        break;
      }
    }
    if (!kindsMatch) continue;
    // First kind-level hit — the legacy single-pass answer.
    loose ??= { info, structTypeIdx: typeIdx };
    let exact = sigRetWasm === null || exactMatches(sigRetWasm, info.returnType!);
    if (exact) {
      for (let i = 0; i < sigParamWasmTypes.length; i++) {
        if (!exactMatches(sigParamWasmTypes[i]!, info.paramTypes[i]!)) {
          exact = false;
          break;
        }
      }
    }
    if (exact) {
      if (opts?.sigHasRest === undefined || (info.hasRestParam === true) === opts.sigHasRest) {
        return { info, structTypeIdx: typeIdx };
      }
      exactFallback ??= { info, structTypeIdx: typeIdx };
    }
  }
  return exactFallback ?? loose;
}
