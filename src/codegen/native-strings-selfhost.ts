// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted native-string helper emission (#3256 — string family Tier-1).
 *
 * Replaces the hand-emitted `Instr[]` builders for the trim family
 * (`__str_isWhitespace`/`trimStart`/`trimEnd`/`trim`), the affix scans
 * (`__str_startsWith`/`endsWith`), and the length-shaping methods
 * (`__str_repeat`/`padStart`/`padEnd`) with TS source from
 * `src/stdlib/strings.ts` compiled through the compiler's OWN IR pipeline
 * (`emitSelfHostedFunc` + the #3256 Tier-1 resolver widening).
 *
 * Called from `ensureNativeStringHelpers` at the exact position the deleted
 * builders ran (after the core kernels — flatten/concat/equals/substring —
 * are registered), so every later builder / call-time consumer finds the
 * same `__str_*` names in `ctx.nativeStrHelpers` as before.
 *
 * ABI preservation: helpers whose legacy signature carries i32 numeric
 * params keep it via a hand thunk (`f64.convert_i32_s` widen + forward —
 * the #3159 `__timsort_<k>` move); the trim family's `(str) -> str` ABI
 * needs none. All functions emitted here are appended defined functions in
 * the same `nativeStrHelperImportBase` regime as their hand siblings, so
 * `reconcileNativeStrFinalizeShift` repairs their baked call targets
 * identically.
 */
import type { Instr, ValType } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { emitSelfHostedFunc } from "./stdlib-selfhost.js";
import { SELF_HOSTED_STRING_HELPERS } from "../stdlib/strings.js";
import type { NativeStrShared } from "./native-strings-shared.js";
import { emitStrWsSpanHelpers } from "./native-strings-ws.js";

/**
 * (#3899) The leaf whose emission the whitespace-span kernels are sequenced
 * against: they bake its funcIdx, and the trim units that follow call them.
 */
const IS_WS_UNIT = "__sh_str_isWs";

/**
 * Emit the Tier-1 self-hosted string family (leaf-first), registering each
 * canonical `__str_*` name in `ctx.nativeStrHelpers` exactly like the hand
 * builders it replaces.
 */
export function emitSelfHostedStringHelpers(shared: NativeStrShared): void {
  const { ctx, strRef } = shared;

  for (const unit of SELF_HOSTED_STRING_HELPERS) {
    const shIdx = emitSelfHostedFunc(ctx, unit.def);
    if (unit.canonicalName !== undefined) {
      ctx.nativeStrHelpers.set(unit.canonicalName, shIdx);
    }
    // (#3899) Sequenced here rather than in emitStrSearchHelpers: the kernels
    // bake `__sh_str_isWs`'s funcIdx for their exotic-code-unit slow path, and
    // the trim units later in this same leaf-first list call them by name.
    if (unit.def.name === IS_WS_UNIT) emitStrWsSpanHelpers(shared);
    if (!unit.thunk) continue;

    // Legacy-ABI thunk: exact hand signature (i32 numeric params), widening
    // each i32 to f64 and forwarding to the self-hosted body. String params
    // and results are `(ref $AnyString)` on both sides; boolean results are
    // already i32 in the IR, so no result conversion exists in any thunk.
    const params: ValType[] = unit.thunk.params.map((k) => (k === "str" ? strRef : { kind: "i32" }));
    const results: ValType[] = [unit.thunk.result === "str" ? strRef : { kind: "i32" }];
    const typeIdx = addFuncType(ctx, params, results);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set(unit.thunk.name, funcIdx);

    const body: Instr[] = [];
    for (let i = 0; i < unit.thunk.params.length; i++) {
      body.push({ op: "local.get", index: i });
      if (unit.thunk.params[i] === "i32") {
        body.push({ op: "f64.convert_i32_s" });
      }
    }
    body.push({ op: "call", funcIdx: shIdx });

    pushDefinedFunc(ctx, funcIdx, {
      name: unit.thunk.name,
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }
}
