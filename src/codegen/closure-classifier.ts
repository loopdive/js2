// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2175 V2-S1) The single, shared standalone closure-struct classifier.
 *
 * A closure/function value under `--target standalone`/`--target wasi`
 * (native strings) is a WasmGC wrapper struct produced by
 * `getOrCreateFuncRefWrapperTypes`; concrete closure subtypes (with captures)
 * share their funcref signature with the base wrapper post-V8
 * canonicalisation, so a single `ref.test` against the deduped ROOT wrappers
 * recognises every closure. Several runtime natives need to answer the
 * question "is this externref a callable?" against exactly this set:
 *
 *   - `__is_closure` export (host bridge, #1308/#1504)
 *   - `__typeof_function` / `__typeof_object` predicates (#1896)
 *   - the MATERIALIZED `__typeof` result native (#2175 V2-S1 — this file's
 *     reason for existing: a closure read back dynamically must classify as
 *     `"function"`, not fall through to `"object"`)
 *   - the `.length`-arity dynamic-read arm (dyn-read.ts, #2580)
 *   - future: the `$AnyValue` boxing classifier + #2949 slice 3's
 *     `tag.test(Function)` lowering (V1 tag fidelity — one predicate, many
 *     consumers, NEVER two divergent arm lists).
 *
 * This module is a LEAF (it imports only types), so `index.ts` and
 * `dyn-read.ts` — which participate in an import cycle — can both depend on
 * the ONE list here without re-introducing that cycle. Before this file the
 * list was duplicated: `collectClosureBaseWrapperTypeIdxs` in index.ts and a
 * private byte-identical copy `closureBaseWrapperTypeIdxs` in dyn-read.ts
 * (which existed specifically to dodge the cycle). Both now delegate here.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * The deduped set of closure base-wrapper struct type indices from
 * `ctx.closureInfoByTypeIdx`. Walks each registered closure struct up its
 * `superTypeIdx` chain to the root (superTypeIdx < 0), collecting each distinct
 * root in first-seen (Map-insertion) order. Returns `[]` when the module has no
 * closures.
 */
export function collectClosureBaseWrapperTypeIdxs(ctx: CodegenContext): number[] {
  const mod = ctx.mod;
  const baseTypeIdxs: number[] = [];
  const seenBase = new Set<number>();
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (!info) continue;
    // Checker-certified one-shot host callbacks never surface as raw values:
    // their -2 wrapper dispatches directly through __call_fn_0. Excluding a
    // root is safe only when every registered allocation under it retains the
    // one-shot bit; any ordinary allocation clears the shared base metadata.
    if (info.hostOneShotOnly === true || info.domCallbackOnly === true) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    // Walk up to the root struct in the chain.
    let root = typeIdx;
    let cur = typeDef;
    while (cur && cur.kind === "struct" && cur.superTypeIdx !== undefined && cur.superTypeIdx >= 0) {
      const superIdx: number = cur.superTypeIdx;
      const parent = mod.types[superIdx];
      if (!parent || parent.kind !== "struct") break;
      root = superIdx;
      cur = parent;
    }
    if (!seenBase.has(root)) {
      seenBase.add(root);
      baseTypeIdxs.push(root);
    }
  }
  // (#3140) The native bound-function carrier (`$__bound_fn`, minted by a
  // standalone `Function.prototype.bind` site) is callable: it must classify
  // as `"function"` (typeof / __is_closure / the `.length` arity read) exactly
  // like a closure wrapper. Registered lazily — absent (-1) in bind-free
  // modules, so those stay byte-identical.
  if (ctx.boundFnTypeIdx >= 0 && !seenBase.has(ctx.boundFnTypeIdx)) {
    baseTypeIdxs.push(ctx.boundFnTypeIdx);
  }
  // (#2928) Caller-owned AOT functions cross into the separately compiled
  // runtime-eval provider through a dedicated `(code,target)` carrier. It is a
  // callable for every shared classifier consumer; fillApplyClosure owns its
  // receiver+argument-vector-preserving invocation guard.
  const runtimeEvalCarrierIdx = ctx.runtimeEvalAotCallableCarrier?.structTypeIdx;
  if (runtimeEvalCarrierIdx !== undefined && !seenBase.has(runtimeEvalCarrierIdx)) {
    baseTypeIdxs.push(runtimeEvalCarrierIdx);
  }
  return baseTypeIdxs;
}

/**
 * Build a chain of `ref.test`-over-closure-base-wrapper arms against the value
 * held (as anyref) in local `anyLocalIdx`. On the FIRST matching closure type
 * the arm runs `onMatch` (which is responsible for producing the arm's result
 * and, typically, `return`-ing). Emits nothing when the module has no closures.
 *
 * Shape (per base type `t`):
 *   local.get anyLocalIdx ; ref.test t ; if (empty) { ...onMatch }
 *
 * This is the ONE arm-builder every closure-classifying native should use so
 * the predicate can never diverge between consumers (`__is_closure`,
 * `__typeof*`, the `$AnyValue` classifier, #2949 slice 3).
 */
export function buildClosureRefTestArms(ctx: CodegenContext, anyLocalIdx: number, onMatch: Instr[]): Instr[] {
  const arms: Instr[] = [];
  for (const t of collectClosureBaseWrapperTypeIdxs(ctx)) {
    arms.push({ op: "local.get", index: anyLocalIdx });
    arms.push({ op: "ref.test", typeIdx: t });
    arms.push({ op: "if", blockType: { kind: "empty" }, then: [...onMatch] });
  }
  return arms;
}
