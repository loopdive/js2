// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157, park 6) Repair CROSS-HIERARCHY operands using the exact forward
 * stack model.
 *
 * ## The bug this exists for
 *
 * Two late repairs in `stack-balance.ts` supply the `ref → externref` coercion
 * that standalone codegen relies on, and BOTH attribute the value by POSITION,
 * so both are wrong as soon as anything sits between a producer and its
 * consumer:
 *
 * - `fixCallArgTypesInBody` walks BACKWARD from the call and stops dead at any
 *   `if` / `block` / `loop` ("Stop at control flow boundaries");
 * - `fixLocalSetCoercion` only ever looks at `body[i - 1]`.
 *
 * The shape that trips both is a devirtualized method call. Codegen emits the
 * receiver `global.get $__mod_c` — a `(ref null $C)` module slot — as an
 * `externref` operand, then a `call $C_2` that takes NO parameters (the method
 * was devirtualized), so the receiver's consumer is several instructions on:
 *
 *     global.get $__mod_c   ;; (ref null $C), needs extern.convert_any
 *     call $C_2             ;; 0 params, pushes f64
 *     …                     ;; whatever consumes the f64
 *     call $__call_m_sameValue_2 / local.set $x   ;; the REAL consumer
 *
 * Two members of the #4157 tuned set widen that window independently:
 * `smi-box-fast-path.ts` replaces a `call $__box_number` with a guard ending in
 * `if (result externref)`, and `ir-inline.ts` replaces a call with a
 * `block (result …)`. Both were latent while the set was default-OFF; the
 * default flip made them the standalone `merge_group`'s 36-test, 33
 * `wasm_compile` regression (PR #4455, park 6) —
 * `call[0] expected type externref, found global.get of type (ref null 74)`
 * and its `local.set[0]` twin. It is standalone-only because under a JS host a
 * class instance already IS an `externref`, so no coercion is ever due.
 *
 * ## Why this is byte-safe on the legacy (`=0`-everything) path
 *
 * It repairs **only** an `externref` ⇄ concrete-GC-ref mismatch, in either
 * direction. Those two hierarchies are disjoint in Wasm: such a pair can never
 * validate, in any engine, under any subtyping rule. So a site this pass
 * rewrites was already an invalid module — it cannot perturb one that was
 * valid. Everything else (numeric coercions, `ref.cast_null` between struct
 * types, `anyref` widening, which IS legal subtyping) is left to the two
 * legacy repairs untouched. Measured: the all-flags-`=0` standalone acorn
 * artifact is byte-for-byte unchanged (1,157,936 B, all four canaries), as is
 * the 172,617-byte test262 harness module this was reduced from (sha256
 * `e30ad07f…`).
 *
 * ## Placement
 *
 * Immediately BEFORE `stackBalance(mod)`. Running first is deliberate: the two
 * legacy repairs then see the coercion already in place, infer `externref`,
 * and queue nothing — same insertion, same position, same bytes.
 */

import type { Instr, TypeDef, ValType, WasmModule } from "../ir/types.js";
import { locateOperandProducers } from "./call-arg-producers.js";
import { callArgCoercionInstrs, getFullParamTypes, inferInstrType, resolveFuncType } from "./stack-balance.js";

interface Env {
  readonly types: TypeDef[];
  readonly mod: WasmModule;
  readonly numImports: number;
  readonly boxNumberIdx: number | null;
  readonly unboxNumberIdx: number | null;
}

/** Every nested instruction list a structured instruction owns. */
function nestedInstrArrays(instr: Instr): Instr[][] {
  const nested: Instr[][] = [];
  const any = instr as {
    body?: Instr[];
    then?: Instr[];
    else?: Instr[];
    catchAll?: Instr[];
    catches?: { body?: Instr[] }[];
  };
  for (const arm of [any.body, any.then, any.else, any.catchAll]) if (Array.isArray(arm)) nested.push(arm);
  if (Array.isArray(any.catches)) for (const c of any.catches) if (Array.isArray(c.body)) nested.push(c.body);
  return nested;
}

/** `externref` and `(ref extern)` — the EXTERNAL reference hierarchy. */
function isExternHierarchy(t: ValType): boolean {
  return t.kind === "externref" || t.kind === "ref_extern";
}

/** A CONCRETE internal (WasmGC) reference — `(ref $T)` / `(ref null $T)`. */
function isConcreteInternalRef(t: ValType): boolean {
  return (t.kind === "ref" || t.kind === "ref_null") && (t as { typeIdx?: number }).typeIdx !== undefined;
}

/**
 * The type each operand slot MUST have, for the consumers this repair covers.
 * `null` = not a consumer we model (or an index we cannot resolve).
 */
function requiredOperandTypes(
  instr: Instr,
  localTypes: ValType[],
  globalTypes: ValType[],
  env: Env,
): readonly (ValType | undefined)[] | null {
  const op = instr.op;
  if (op === "call" || op === "return_call") {
    const funcIdx = (instr as { funcIdx?: number }).funcIdx;
    return funcIdx === undefined ? null : getFullParamTypes(env.mod, funcIdx, env.numImports);
  }
  if (op === "local.set" || op === "local.tee") {
    const t = localTypes[(instr as { index: number }).index];
    return t ? [t] : null;
  }
  if (op === "global.set") {
    const t = globalTypes[(instr as { index: number }).index];
    return t ? [t] : null;
  }
  return null;
}

function repairBody(body: Instr[], localTypes: ValType[], globalTypes: ValType[], env: Env): number {
  let fixups = 0;
  // Nested arms are separate instruction lists with their own stack — walk each
  // on its own, exactly as the two legacy repairs do.
  for (const instr of body) {
    for (const arm of nestedInstrArrays(instr)) fixups += repairBody(arm, localTypes, globalTypes, env);
  }

  const producers = locateOperandProducers(body, env.mod);
  if (producers.size === 0) return fixups;

  // producerPos → coercion. One repair per producer slot: a producer that feeds
  // two operand slots of the same consumer is impossible (each push owns one
  // slot), and the dedup keeps a shared position from being written twice.
  const queued = new Map<number, Instr[]>();
  for (const [consumerPos, operandPositions] of producers) {
    const expected = requiredOperandTypes(body[consumerPos]!, localTypes, globalTypes, env);
    if (!expected) continue;
    // `local.set`/`global.set` pop exactly their one value; a `call` pops one
    // per parameter. Either way slot i of the popped window is operand i.
    for (let oi = 0; oi < operandPositions.length && oi < expected.length; oi++) {
      const want = expected[oi];
      const pos = operandPositions[oi]!;
      if (!want || pos >= consumerPos || queued.has(pos)) continue;
      const actual = inferInstrType(body[pos]!, localTypes, globalTypes, env.types, env.mod, env.numImports);
      if (!actual) continue;
      const crossed =
        (isConcreteInternalRef(actual) && isExternHierarchy(want)) ||
        (isExternHierarchy(actual) && isConcreteInternalRef(want));
      if (!crossed) continue;
      const coercion = callArgCoercionInstrs(actual, want, env.boxNumberIdx, env.unboxNumberIdx);
      if (coercion.length > 0) queued.set(pos, coercion);
    }
  }
  if (queued.size === 0) return fixups;

  // Highest position first — any other order shifts the not-yet-applied ones
  // (the #3910 rule, same reason).
  for (const pos of [...queued.keys()].sort((a, b) => b - a)) {
    const instrs = queued.get(pos)!;
    body.splice(pos + 1, 0, ...instrs);
    fixups += instrs.length;
  }
  return fixups;
}

/** Repair every cross-hierarchy operand in the module. Returns the fixup count. */
export function repairCrossHierarchyOperands(mod: WasmModule): number {
  const numImports = mod.imports.filter((imp) => imp.desc.kind === "func").length;
  const findFunc = (name: string): number | null => {
    const idx = mod.functions.findIndex((f) => f.name === name);
    return idx < 0 ? null : numImports + idx;
  };
  const globalTypes: ValType[] = [];
  for (const imp of mod.imports) if (imp.desc.kind === "global") globalTypes.push(imp.desc.type);
  for (const g of mod.globals) globalTypes.push(g.type);

  const env: Env = {
    types: mod.types,
    mod,
    numImports,
    boxNumberIdx: findFunc("__box_number"),
    unboxNumberIdx: findFunc("__unbox_number"),
  };

  let fixups = 0;
  for (const func of mod.functions) {
    const ft = resolveFuncType(mod.types, func.typeIdx);
    const localTypes: ValType[] = [];
    if (ft) for (const p of ft.params) localTypes.push(p);
    for (const l of func.locals) localTypes.push(l.type);
    fixups += repairBody(func.body, localTypes, globalTypes, env);
  }
  return fixups;
}
