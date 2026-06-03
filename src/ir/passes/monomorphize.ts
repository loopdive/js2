// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Middle-end IR monomorphization — spec #1167c Pass 1.
//
// Clones polymorphic callees that are called with distinct argument type
// tuples across call sites, then redirects each call site to its
// type-specialised clone. This turns a single externref-boxing-through
// function into N narrow functions whose bodies can lower straight to
// ValType-typed Wasm code — avoiding the round-trip through `__box_number`
// / `__unbox_number` that the legacy path incurs on every boxed call.
//
// Why not re-run `buildTypeMap` afterwards
// ========================================
//
// `propagate.ts:buildTypeMap` walks the TypeScript AST. A clone such as
// `identity$string` has no `ts.FunctionDeclaration` — it exists only in
// the IR. So we cannot re-seed clone signatures by re-running buildTypeMap.
// Instead this pass RETURNS the clone signatures it produced; the pipeline
// integrates them into the `calleeTypes` override map (used by the
// AST→IR lowerer and subsequent passes) BEFORE downstream passes run.
//
// V1 scope — what we clone
// ========================
//
// A callee is monomorphizable iff ALL of:
//
//   - non-recursive (not part of any SCC, including self-loops)
//   - single-block body
//   - body size ≤ MAX_CALLEE_SIZE
//   - terminator is a single-value `return`
//   - there exist ≥ 2 distinct argument-type tuples across its call sites
//   - distinct tuple count ≤ MAX_VARIANTS_PER_CALLEE
//
// #1574 §2.4 — re-infer resultType in clones (relax the operand guard)
// ====================================================================
//
// The original V1 guard ALSO required that "body instructions do NOT
// consume any parameter as an operand." Rationale: if a callee's
// `f64.add(param, const)` is retyped from `param: f64` to `param:
// externref`, the operand type no longer matches the operator —
// producing invalid Wasm. That guard structurally ruled out the most
// valuable monomorphization targets — typed helpers like
// `function add(a, b) { return a + b; }` whose bodies DO consume their
// params.
//
// We now RELAX (not drop) that guard. When a clone's params are
// substituted, we walk the clone body and re-infer each instruction's
// `resultType` from the substituted operand types via `reinferCloneBody`.
// Crucially the re-inferer is SOUND, not optimistic: for every
// param-consuming instruction it verifies the operator actually accepts
// the substituted operand type (e.g. `f64.add` rejects a non-numeric
// operand). If any instruction cannot be soundly retyped — or uses an
// op-kind the re-inferer doesn't model — the whole clone is ABANDONED
// (`reinferCloneBody` returns null) and that call-site group stays on the
// original callee / legacy path. This keeps the pass strictly additive:
// it can only ever turn a boxed polymorphic call into a typed one, never
// emit invalid Wasm.
//
// The original "identity-like" helpers (return-param, return-const) still
// clone — they're the degenerate case where re-inference is a no-op.
//
// Growth guard (pass-end)
// =======================
//
// Before applying any clone, we compute the total new instructions across
// every planned clone. If `originalSize + newInstrs > 1.5 * originalSize`,
// we abandon the entire monomorphization. The guard fires pass-end, not
// per-callee, so the compositional blow-up across A→B→C each with 4
// variants (up to 64 clones of C) is detected globally.
//
// The "abandon the entire pass" fallback is coarse — a more sophisticated
// policy would drop the worst-ROI plans first. For V1 the coarse choice
// matches the spec's conservative posture: when in doubt, keep the module
// small.

import {
  asBlockId,
  irTypeEquals,
  type IrBinop,
  type IrBlock,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrParam,
  type IrType,
  type IrUnop,
  type IrValueId,
} from "../nodes.js";
import type { ValType } from "../types.js";
import type { AllocSiteRegistry } from "../alloc-registry.js";
import { forkAllocInInstr } from "./alloc-discipline.js";

/** Maximum number of distinct type tuples we'll clone a single callee for. */
const MAX_VARIANTS_PER_CALLEE = 4;
/** Callees bigger than this are never cloned. */
const MAX_CALLEE_SIZE = 20;
/** New instructions budget relative to the module's pre-pass instruction count. */
const GROWTH_BUDGET = 0.5;

/**
 * Signature of an IR-only clone. The caller integrates this into its
 * `calleeTypes` override map so downstream passes see the narrowed types.
 */
export interface MonomorphizeCloneSignature {
  readonly params: readonly IrType[];
  readonly returnType: IrType;
}

export interface MonomorphizeResult {
  readonly module: IrModule;
  /** Map from clone name → signature. Empty when the pass made no changes. */
  readonly cloneSignatures: ReadonlyMap<string, MonomorphizeCloneSignature>;
}

/**
 * Monomorphize polymorphic callees across an IR module. Returns the input
 * module unchanged (and an empty signature map) when no profitable clones
 * exist or the growth budget would be exceeded.
 */
export function monomorphize(mod: IrModule, registry?: AllocSiteRegistry): MonomorphizeResult {
  const byName = new Map<string, IrFunction>();
  for (const fn of mod.functions) byName.set(fn.name, fn);

  const recursiveSet = computeRecursiveSet(mod, byName);

  // -------------------------------------------------------------------------
  // Step 1 — collect every direct IR-local call site's (callee, argTypes).
  // -------------------------------------------------------------------------
  interface CallSite {
    /** Name of the function containing the call. */
    readonly callerName: string;
    /** Zero-based block index inside the caller. */
    readonly blockIdx: number;
    /** Zero-based instruction index inside the block. */
    readonly instrIdx: number;
    /** Name of the callee (resolved from IrFuncRef). */
    readonly calleeName: string;
    /** Tuple of argument types at this call site (in call-arg order). */
    readonly argTypes: readonly IrType[];
  }
  const callSites: CallSite[] = [];
  for (const fn of mod.functions) {
    const typeOf = buildLocalTypeOf(fn);
    fn.blocks.forEach((block, blockIdx) => {
      block.instrs.forEach((instr, instrIdx) => {
        if (instr.kind !== "call") return;
        if (!byName.has(instr.target.name)) return;
        const argTypes: IrType[] = [];
        for (const a of instr.args) {
          const t = typeOf(a);
          if (!t) return; // operand missing a resolvable type — skip the whole site
          argTypes.push(t);
        }
        if (argTypes.length !== instr.args.length) return;
        callSites.push({
          callerName: fn.name,
          blockIdx,
          instrIdx,
          calleeName: instr.target.name,
          argTypes,
        });
      });
    });
  }

  if (callSites.length === 0) {
    return { module: mod, cloneSignatures: new Map() };
  }

  // -------------------------------------------------------------------------
  // Step 2 — group call sites per callee by arg-type tuple.
  // -------------------------------------------------------------------------
  interface TupleGroup {
    readonly argTypes: readonly IrType[];
    readonly calls: CallSite[];
  }
  const grouped = new Map<string, Map<string, TupleGroup>>();
  for (const site of callSites) {
    if (recursiveSet.has(site.calleeName)) continue;
    const callee = byName.get(site.calleeName);
    if (!callee) continue;
    if (!isMonomorphizable(callee)) continue;
    let byKey = grouped.get(site.calleeName);
    if (!byKey) {
      byKey = new Map();
      grouped.set(site.calleeName, byKey);
    }
    const key = tupleKey(site.argTypes);
    let group = byKey.get(key);
    if (!group) {
      group = { argTypes: site.argTypes, calls: [] };
      byKey.set(key, group);
    }
    (group.calls as CallSite[]).push(site);
  }

  // -------------------------------------------------------------------------
  // Step 3 — plan clones.
  //
  // For each callee with > 1 distinct tuple and ≤ MAX_VARIANTS_PER_CALLEE:
  //   - Tuple 0 keeps targeting the original callee (no clone needed)
  //   - Tuples 1..N-1 each get a dedicated clone
  //
  // We only keep a plan if cloning preserves the callee's declared param
  // shape (same arity, same kind-count). A tuple whose arg count mismatches
  // the callee's param count is a bug upstream — skip the callee entirely.
  // -------------------------------------------------------------------------
  interface ClonePlan {
    readonly cloneName: string;
    readonly argTypes: readonly IrType[];
    readonly calls: readonly CallSite[];
  }
  const planByCallee = new Map<string, ClonePlan[]>();
  const usedNames = new Set<string>(byName.keys());
  for (const [calleeName, byKey] of grouped) {
    if (byKey.size < 2) continue;
    if (byKey.size > MAX_VARIANTS_PER_CALLEE) continue;
    const callee = byName.get(calleeName)!;
    const plans: ClonePlan[] = [];
    // Deterministic ordering: sort by tuple key so clone names are stable.
    const entries = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let skip = false;
    for (const [, group] of entries) {
      if (group.argTypes.length !== callee.params.length) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    // First tuple keeps the original callee. The rest get clones.
    for (let i = 1; i < entries.length; i++) {
      const [, group] = entries[i]!;
      const baseName = `${calleeName}$${nameSuffixFor(group.argTypes)}`;
      const cloneName = uniquifyName(baseName, usedNames);
      usedNames.add(cloneName);
      plans.push({ cloneName, argTypes: group.argTypes, calls: group.calls });
    }
    if (plans.length > 0) planByCallee.set(calleeName, plans);
  }

  if (planByCallee.size === 0) {
    return { module: mod, cloneSignatures: new Map() };
  }

  // -------------------------------------------------------------------------
  // Step 4 — pass-end growth guard.
  //
  // Sum new instructions across every planned clone; abandon the pass if
  // the total exceeds the budget. Evaluated AFTER all plans are collected
  // so compositional blow-ups (A→B→C each cloned N times) are visible.
  // -------------------------------------------------------------------------
  const originalSize = countModuleInstrs(mod);
  let newInstrs = 0;
  for (const [calleeName, plans] of planByCallee) {
    const calleeSize = countInstrs(byName.get(calleeName)!);
    newInstrs += plans.length * calleeSize;
  }
  if (newInstrs > originalSize * GROWTH_BUDGET) {
    return { module: mod, cloneSignatures: new Map() };
  }

  // -------------------------------------------------------------------------
  // Step 5 — build clones (fresh IrFunctions).
  //
  // #1574 §2.4 — `cloneWithParamTypes` can now return null when the clone's
  // body can't be soundly re-typed under the substituted params. Such a
  // specialization is ABANDONED: we record its name so Step 6 leaves the
  // matching call sites pointing at the original callee. The growth guard
  // (Step 4) already accounted for it pessimistically; abandoning only
  // shrinks the actual growth, so the budget stays satisfied.
  // -------------------------------------------------------------------------
  const clonedFuncs: IrFunction[] = [];
  const cloneSignatures = new Map<string, MonomorphizeCloneSignature>();
  const abandonedClones = new Set<string>();
  for (const [calleeName, plans] of planByCallee) {
    const callee = byName.get(calleeName)!;
    for (const plan of plans) {
      const result = cloneWithParamTypes(callee, plan.cloneName, plan.argTypes, registry);
      if (result === null) {
        abandonedClones.add(plan.cloneName);
        continue;
      }
      clonedFuncs.push(result.fn);
      cloneSignatures.set(plan.cloneName, {
        params: plan.argTypes,
        returnType: result.returnType,
      });
    }
  }

  // If every planned clone was abandoned, the pass made no changes.
  if (clonedFuncs.length === 0) {
    return { module: mod, cloneSignatures: new Map() };
  }

  // -------------------------------------------------------------------------
  // Step 6 — rewrite call sites in their source functions. Skip edits for
  // abandoned clones — their call sites keep targeting the original callee.
  // -------------------------------------------------------------------------
  interface Edit {
    readonly blockIdx: number;
    readonly instrIdx: number;
    readonly newTarget: string;
  }
  const edits = new Map<string, Edit[]>();
  for (const [, plans] of planByCallee) {
    for (const plan of plans) {
      if (abandonedClones.has(plan.cloneName)) continue;
      for (const call of plan.calls) {
        let arr = edits.get(call.callerName);
        if (!arr) {
          arr = [];
          edits.set(call.callerName, arr);
        }
        arr.push({
          blockIdx: call.blockIdx,
          instrIdx: call.instrIdx,
          newTarget: plan.cloneName,
        });
      }
    }
  }

  const rewrittenFuncs: IrFunction[] = [];
  for (const fn of mod.functions) {
    const fnEdits = edits.get(fn.name);
    if (!fnEdits) {
      rewrittenFuncs.push(fn);
      continue;
    }
    rewrittenFuncs.push(applyEdits(fn, fnEdits));
  }

  return {
    module: { functions: [...rewrittenFuncs, ...clonedFuncs] },
    cloneSignatures,
  };
}

// ---------------------------------------------------------------------------
// Helpers — call graph and recursion detection
// ---------------------------------------------------------------------------

/** Set of function names that participate in any call cycle (self-loops included). */
function computeRecursiveSet(mod: IrModule, byName: ReadonlyMap<string, IrFunction>): Set<string> {
  const edges = new Map<string, Set<string>>();
  for (const fn of mod.functions) {
    const set = new Set<string>();
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        if (instr.kind === "call" && byName.has(instr.target.name)) {
          set.add(instr.target.name);
        }
      }
    }
    edges.set(fn.name, set);
  }
  const recursive = new Set<string>();
  for (const fn of mod.functions) {
    if (reachesSelf(fn.name, edges)) recursive.add(fn.name);
  }
  return recursive;
}

function reachesSelf(start: string, edges: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const visited = new Set<string>();
  const stack: string[] = [];
  const seed = edges.get(start);
  if (seed) for (const n of seed) stack.push(n);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === start) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const next = edges.get(cur);
    if (next) for (const n of next) stack.push(n);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers — local type resolution
// ---------------------------------------------------------------------------

/**
 * Build a function `(valueId) → IrType | null` for a single IrFunction. Looks
 * up params first, then any instruction's `resultType`. Returns null for
 * values we can't resolve locally (shouldn't happen in verified IR; we treat
 * defensively).
 */
function buildLocalTypeOf(fn: IrFunction): (v: IrValueId) => IrType | null {
  const map = new Map<IrValueId, IrType>();
  for (const p of fn.params) map.set(p.value, p.type);
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.result !== null && instr.resultType) {
        map.set(instr.result, instr.resultType);
      }
    }
    for (let i = 0; i < block.blockArgs.length; i++) {
      const id = block.blockArgs[i]!;
      const ty = block.blockArgTypes[i];
      if (ty) map.set(id, ty);
    }
  }
  return (v) => map.get(v) ?? null;
}

// ---------------------------------------------------------------------------
// Helpers — monomorphizability gate
// ---------------------------------------------------------------------------

/**
 * A callee is structurally cloneable iff:
 *   - single-block
 *   - body ≤ MAX_CALLEE_SIZE instructions
 *   - terminator is a `return` (and single-block means that's the only
 *     terminator shape)
 *
 * #1574 §2.4 — the old "body instructions do NOT reference any parameter
 * as an operand" guard lived here. It is GONE: param-consuming bodies are
 * now eligible. Soundness moves to clone-construction time —
 * `reinferCloneBody` re-types every instruction under the substituted
 * params and abandons the clone (returns null) if any op can't be soundly
 * retyped. This gate stays purely structural so a typed helper like
 * `add(a, b) { return a + b; }` reaches the per-tuple re-inference step
 * (where it succeeds for numeric tuples and is rejected for, e.g., an
 * externref tuple). See `cloneWithParamTypes`.
 */
function isMonomorphizable(fn: IrFunction): boolean {
  if (fn.blocks.length !== 1) return false;
  const block = fn.blocks[0]!;
  if (block.instrs.length > MAX_CALLEE_SIZE) return false;
  if (block.terminator.kind !== "return") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers — size accounting
// ---------------------------------------------------------------------------

function countInstrs(fn: IrFunction): number {
  let n = 0;
  for (const b of fn.blocks) n += b.instrs.length;
  return n;
}

function countModuleInstrs(mod: IrModule): number {
  let n = 0;
  for (const fn of mod.functions) n += countInstrs(fn);
  return n;
}

// ---------------------------------------------------------------------------
// Helpers — tuple key + name suffix
// ---------------------------------------------------------------------------

function tupleKey(types: readonly IrType[]): string {
  return types.map(irTypeKey).join(",");
}

function irTypeKey(t: IrType): string {
  if (t.kind === "val") return `v:${valTypeKey(t.val)}`;
  if (t.kind === "string") return "s";
  if (t.kind === "object") {
    return `o:{${t.shape.fields.map((f) => `${f.name}:${irTypeKey(f.type)}`).join(",")}}`;
  }
  if (t.kind === "closure") {
    const ps = t.signature.params.map(irTypeKey).join(",");
    return `c:(${ps})->${irTypeKey(t.signature.returnType)}`;
  }
  // Slice 4 (#1169d): class is keyed by name — one declaration per
  // unit, so the name uniquely identifies the shape.
  if (t.kind === "class") return `cls:${t.shape.className}`;
  // Slice 10 (#1169i): extern is keyed solely on className.
  if (t.kind === "extern") return `ext:${t.className}`;
  if (t.kind === "union") {
    const parts = [...t.members].map(valTypeKey).sort();
    return `u:${parts.join("|")}`;
  }
  return `b:${valTypeKey(t.inner)}`;
}

function valTypeKey(v: ValType): string {
  if (v.kind === "ref" || v.kind === "ref_null") {
    return `${v.kind}#${(v as { typeIdx: number }).typeIdx}`;
  }
  return v.kind;
}

/** Human-friendly suffix for a specialization: `identity$f64`, `identity$externref`, etc. */
function nameSuffixFor(types: readonly IrType[]): string {
  return types.map(irTypeKey).map(simplifyForName).join("_");
}

function simplifyForName(s: string): string {
  // Strip the `v:`/`u:`/`b:` tag — the clone name is for humans; resolution
  // goes through the name→IrFunction map in ctx.
  if (s.startsWith("v:")) return s.slice(2);
  if (s.startsWith("u:")) return `union_${s.slice(2).replace(/\|/g, "_")}`;
  if (s.startsWith("b:")) return `boxed_${s.slice(2)}`;
  return s;
}

function uniquifyName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}#${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Helpers — clone construction
// ---------------------------------------------------------------------------

/**
 * Deep-copy `callee` into a new IrFunction with `cloneName`, retyping each
 * parameter to the corresponding entry in `newParamTypes`, and re-inferring
 * every body instruction's `resultType` under the substituted params
 * (#1574 §2.4). Returns the clone + its single return type, or `null` when
 * re-inference fails — see `reinferCloneBody` for the soundness contract.
 *
 * A `null` return means "this specialization is not safe to clone": the
 * caller skips the clone and the call-site group stays on the original
 * callee / legacy path. Never throws on a re-inference failure — only on
 * structural invariants (arity, terminator shape) that the gate already
 * guaranteed.
 */
function cloneWithParamTypes(
  callee: IrFunction,
  cloneName: string,
  newParamTypes: readonly IrType[],
  registry?: AllocSiteRegistry,
): { fn: IrFunction; returnType: IrType } | null {
  if (newParamTypes.length !== callee.params.length) {
    throw new Error(
      `ir/monomorphize: param-arity mismatch cloning ${callee.name}: expected ${callee.params.length}, got ${newParamTypes.length}`,
    );
  }

  // Param SSA ids are preserved verbatim. The body may now consume them as
  // operands (#1574 §2.4) — re-inference handles the retyped operands.
  const newParams: IrParam[] = callee.params.map((p, i) => ({
    value: p.value,
    type: newParamTypes[i]!,
    name: p.name,
  }));

  const oldBlock = callee.blocks[0]!;
  const term = oldBlock.terminator;
  if (term.kind !== "return") {
    throw new Error(`ir/monomorphize: clone ${cloneName} has non-return terminator`);
  }
  if (term.values.length !== 1) {
    throw new Error(`ir/monomorphize: clone ${cloneName} has ${term.values.length} return values; V1 requires 1`);
  }

  // Re-infer the body under the substituted params. A null result means an
  // instruction could not be soundly retyped — abandon this clone.
  const reinferred = reinferCloneBody(oldBlock.instrs, newParams);
  if (reinferred === null) return null;

  // Fork allocation ids per specialization — a clone is a distinct runtime
  // allocation set, so its alloc sites must not share the source's ids
  // (#1586 fork rule). `forkAllocInInstr` is a no-op for non-alloc instrs and
  // when no registry is wired, preserving the prior shallow-copy behavior.
  const newInstrs = reinferred.instrs.map((i) => forkAllocInInstr(i, registry));

  const newBlock: IrBlock = {
    id: asBlockId(0),
    blockArgs: oldBlock.blockArgs,
    blockArgTypes: oldBlock.blockArgTypes,
    instrs: newInstrs,
    terminator: oldBlock.terminator,
  };

  // Return type = type of the single returned value under the new typing.
  const returnValueId = term.values[0]!;
  const returnType = reinferred.typeOf.get(returnValueId);
  if (!returnType) {
    // The returned value has no resolvable type post-substitution (e.g. a
    // block arg, which V1 single-block clones never have). Abandon rather
    // than emit a clone whose result type we can't name.
    return null;
  }

  const fn: IrFunction = {
    name: cloneName,
    params: newParams,
    resultTypes: [returnType],
    blocks: [newBlock],
    exported: false,
    valueCount: callee.valueCount,
  };
  return { fn, returnType };
}

// ---------------------------------------------------------------------------
// #1574 §2.4 — sound clone-body re-inference
// ---------------------------------------------------------------------------

/**
 * Result of re-inferring a clone body: the rewritten instructions (with
 * fresh `resultType`s where they shifted) plus a `valueId → IrType` map
 * covering params + every instruction result, used to type the return
 * value.
 */
interface ReinferredBody {
  readonly instrs: readonly IrInstr[];
  readonly typeOf: ReadonlyMap<IrValueId, IrType>;
}

/**
 * Re-type a single-block clone body under substituted param types. Walks
 * the instruction list in order, maintaining a `valueId → IrType` map
 * seeded with the retyped params; for each value-producing instruction it
 * recomputes the result type from its (possibly retyped) operands and
 * VERIFIES the operator accepts those operand types.
 *
 * Returns null — abandoning the clone — when ANY of:
 *   - an instruction consumes a value whose type isn't in the map yet
 *     (shouldn't happen in verified SSA, defensive);
 *   - an operator's operand type became incompatible under substitution
 *     (e.g. `f64.add` on a non-numeric operand);
 *   - the instruction kind is outside the modelled set AND it consumes a
 *     retyped param (conservative: we only clone bodies we can fully
 *     re-verify).
 *
 * Instructions whose operands are all param-independent keep their original
 * `resultType` verbatim — re-inference is a no-op for them, matching the
 * pre-#1574 "identity-like helper" behaviour.
 */
function reinferCloneBody(instrs: readonly IrInstr[], params: readonly IrParam[]): ReinferredBody | null {
  const typeOf = new Map<IrValueId, IrType>();
  for (const p of params) typeOf.set(p.value, p.type);

  // Which SSA values are (transitively) derived from a substituted param.
  // Only these need operator re-verification; param-independent instrs are
  // copied verbatim (their original resultType is still valid).
  const paramTainted = new Set<IrValueId>();
  for (const p of params) paramTainted.add(p.value);

  const out: IrInstr[] = [];
  for (const instr of instrs) {
    const uses = collectUses(instr);
    const consumesTainted = uses.some((u) => paramTainted.has(u));

    if (!consumesTainted) {
      // Param-independent: result type is unchanged. Record it and copy.
      if (instr.result !== null && instr.resultType) typeOf.set(instr.result, instr.resultType);
      out.push(instr);
      continue;
    }

    // This instruction depends on a substituted param — re-infer + verify.
    const inferred = reinferInstr(instr, typeOf);
    if (inferred === null) return null; // unsound under substitution — abandon

    out.push(inferred.instr);
    if (inferred.instr.result !== null && inferred.resultType) {
      typeOf.set(inferred.instr.result, inferred.resultType);
      paramTainted.add(inferred.instr.result);
    }
  }

  return { instrs: out, typeOf };
}

// #1574 §2.4 soundness model
// ===========================
//
// A Wasm arithmetic/comparison op consumes its operands' EXACT ValType off
// the value stack — there is NO implicit numeric coercion at the IR→Wasm
// boundary. `f64.add` requires two f64s; if a clone's substituted param is
// i32, the body's `f64.add` would be invalid Wasm unless an
// `f64.convert_i32_s` is inserted (a separate operand-coercion feature, out
// of scope here). So the re-inferer requires every typed-op operand to
// EXACTLY match the storage type the op already consumed. This correctly
// ABANDONS any clone that would change an arithmetic operand's storage
// type, guaranteeing the pass never emits invalid Wasm. The sound wins it
// keeps:
//   - identity-like bodies (param flows only to return / call) — re-inference
//     is a no-op (these were already cloneable pre-#1574);
//   - reference-polymorphic ops (`ref.is_null`, `select` over a shared ref
//     supertype) where the substituted operand is still a valid operand.

function isF64Val(t: IrType): boolean {
  return t.kind === "val" && t.val.kind === "f64";
}

function isI32Val(t: IrType): boolean {
  // `bool` lattice values lower to i32 storage too — any `val` whose
  // ValType.kind is "i32" qualifies (the `signed` fact is irrelevant for
  // storage; the op tag already encoded signed-vs-unsigned).
  return t.kind === "val" && t.val.kind === "i32";
}

const IR_F64: IrType = { kind: "val", val: { kind: "f64" } };
const IR_I32: IrType = { kind: "val", val: { kind: "i32" } };

/**
 * Re-infer the result type of one param-tainted instruction and verify the
 * operator accepts its (retyped) operands. Returns the (possibly rewritten)
 * instruction plus its new result type, or null when the substitution makes
 * the op unsound. Conservatively returns null for any instruction kind not
 * explicitly modelled — those are never cloned when param-tainted.
 *
 * The modelled set is the pure value-computation subset that polymorphic
 * numeric helpers actually use: binary / unary / select / box / unbox /
 * tag.test. Everything else (calls, memory ops, control flow) is rejected
 * when param-tainted so we never silently emit an operator/operand mismatch.
 */
function reinferInstr(
  instr: IrInstr,
  typeOf: ReadonlyMap<IrValueId, IrType>,
): { instr: IrInstr; resultType: IrType } | null {
  switch (instr.kind) {
    case "binary": {
      const lt = typeOf.get(instr.lhs);
      const rt = typeOf.get(instr.rhs);
      if (!lt || !rt) return null;
      const rty = reinferBinary(instr.op, lt, rt);
      if (rty === null) return null;
      return { instr: { ...instr, resultType: rty }, resultType: rty };
    }
    case "unary": {
      const ot = typeOf.get(instr.rand);
      if (!ot) return null;
      const rty = reinferUnary(instr.op, ot);
      if (rty === null) return null;
      return { instr: { ...instr, resultType: rty }, resultType: rty };
    }
    case "select": {
      // Condition is an i32 bool; both arms must agree post-substitution.
      const ct = typeOf.get(instr.condition);
      const tt = typeOf.get(instr.whenTrue);
      const ft = typeOf.get(instr.whenFalse);
      if (!ct || !tt || !ft) return null;
      if (!isI32Val(ct)) return null; // condition must stay a bool
      if (!irTypeEquals(tt, ft)) return null; // arms must have identical Wasm type
      return { instr: { ...instr, resultType: tt }, resultType: tt };
    }
    // box / unbox / tag.test carry an explicit target/tag ValType that is
    // independent of the operand's substituted type. A substituted operand
    // changes whether the box is still VALID (the value's type must be a
    // member of the union), which we cannot re-verify here without the
    // union registry — so conservatively abandon when these consume a
    // tainted operand. (Polymorphic numeric helpers don't box internally;
    // this only forgoes an exotic case, never miscompiles one.)
    case "box":
    case "unbox":
    case "tag.test":
      return null;
    default:
      // Any other instruction kind consuming a substituted param is outside
      // the modelled set — abandon the clone rather than risk an unverified
      // operator/operand mismatch.
      return null;
  }
}

/**
 * Result type of a binary op under (possibly retyped) operand types, or
 * null when the op no longer accepts the operands. Mirrors the lowerer's
 * 1:1 op→Wasm mapping: the op tag already fixes the expected operand
 * domain, so re-inference is mostly a verification that the substituted
 * operands still inhabit that domain.
 */
function reinferBinary(op: IrBinop, lt: IrType, rt: IrType): IrType | null {
  switch (op) {
    // f64 arithmetic → f64. BOTH operands must already be exactly f64 on the
    // stack — there's no implicit widening. A substituted operand that
    // changed away from f64 (to i32, a ref, etc.) is rejected: the body
    // would emit `f64.add` on a non-f64 stack value (invalid Wasm).
    case "f64.add":
    case "f64.sub":
    case "f64.mul":
    case "f64.div":
      if (!isF64Val(lt) || !isF64Val(rt)) return null;
      return IR_F64;
    // f64 comparisons → i32 bool. Operands must be exactly f64.
    case "f64.eq":
    case "f64.ne":
    case "f64.lt":
    case "f64.le":
    case "f64.gt":
    case "f64.ge":
      if (!isF64Val(lt) || !isF64Val(rt)) return null;
      return IR_I32;
    // i32 ops: operands must be exactly i32-storage. bool lowers to i32.
    case "i32.eq":
    case "i32.ne":
    case "i32.and":
    case "i32.or":
    case "i32.lt_s":
    case "i32.le_s":
    case "i32.gt_s":
    case "i32.ge_s":
    case "i32.lt_u":
    case "i32.le_u":
    case "i32.gt_u":
    case "i32.ge_u":
      if (!isI32Val(lt) || !isI32Val(rt)) return null;
      return IR_I32;
    // js.* bitwise composite ops are lowered as a ToInt32-dance on f64
    // operands, returning f64. The lowering dispatch keys off the operand
    // IrTypes (#1126 Stage 3 emits the native i32 path when both are i32),
    // so changing an operand's storage type would silently switch the
    // emitted op sequence. Only clone when operands are exactly f64 (the
    // composite path) and keep the f64 result.
    case "js.bitand":
    case "js.bitor":
    case "js.bitxor":
    case "js.shl":
    case "js.shr_s":
    case "js.shr_u":
      if (!isF64Val(lt) || !isF64Val(rt)) return null;
      return IR_F64;
    default:
      return null;
  }
}

/** Result type of a unary op under a retyped operand, or null when unsound. */
function reinferUnary(op: IrUnop, ot: IrType): IrType | null {
  switch (op) {
    // f64 unary ops consume an f64 off the stack — operand must be exactly f64.
    case "f64.neg":
    case "f64.abs":
    case "f64.sqrt":
    case "f64.floor":
    case "f64.ceil":
    case "f64.trunc":
      if (!isF64Val(ot)) return null;
      return IR_F64;
    case "i32.eqz":
      if (!isI32Val(ot)) return null;
      return IR_I32;
    case "i32.trunc_sat_f64_s":
      if (!isF64Val(ot)) return null;
      return IR_I32;
    case "ref.is_null":
      // `ref.is_null` accepts ANY reference operand and returns i32 — this is
      // the one genuinely ref-polymorphic op, so a clone whose param was
      // retyped from one reference type to another stays sound. A numeric
      // substitution (f64/i32) is invalid (ref.is_null needs a ref).
      if (
        ot.kind === "val" &&
        (ot.val.kind === "ref" ||
          ot.val.kind === "ref_null" ||
          ot.val.kind === "externref" ||
          ot.val.kind === "funcref")
      ) {
        return IR_I32;
      }
      if (
        ot.kind === "string" ||
        ot.kind === "object" ||
        ot.kind === "class" ||
        ot.kind === "extern" ||
        ot.kind === "closure"
      ) {
        return IR_I32;
      }
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers — caller rewrites
// ---------------------------------------------------------------------------

function applyEdits(
  fn: IrFunction,
  edits: ReadonlyArray<{ readonly blockIdx: number; readonly instrIdx: number; readonly newTarget: string }>,
): IrFunction {
  const edited = new Map<string, string>(); // key = "blockIdx:instrIdx" → newTarget
  for (const e of edits) edited.set(`${e.blockIdx}:${e.instrIdx}`, e.newTarget);

  const newBlocks: IrBlock[] = fn.blocks.map((block, blockIdx) => {
    let blockChanged = false;
    const newInstrs: IrInstr[] = block.instrs.map((instr, instrIdx) => {
      const key = `${blockIdx}:${instrIdx}`;
      const newTarget = edited.get(key);
      if (!newTarget) return instr;
      if (instr.kind !== "call") return instr; // should never happen
      const newRef: IrFuncRef = { kind: "func", name: newTarget };
      blockChanged = true;
      return { ...instr, target: newRef };
    });
    if (!blockChanged) return block;
    return {
      id: block.id,
      blockArgs: block.blockArgs,
      blockArgTypes: block.blockArgTypes,
      instrs: newInstrs,
      terminator: block.terminator,
    };
  });

  // Preserve reference identity if nothing actually changed. The caller of
  // the pass uses reference inequality to detect per-function changes.
  let anyChange = false;
  for (let i = 0; i < fn.blocks.length; i++) {
    if (newBlocks[i] !== fn.blocks[i]) {
      anyChange = true;
      break;
    }
  }
  if (!anyChange) return fn;
  return { ...fn, blocks: newBlocks };
}

// ---------------------------------------------------------------------------
// Helpers — SSA use collection (kept local so pass is self-contained)
// ---------------------------------------------------------------------------

function collectUses(instr: IrInstr): readonly IrValueId[] {
  switch (instr.kind) {
    case "const":
    case "global.get":
    case "raw.wasm":
      return [];
    case "call":
      return instr.args;
    case "global.set":
      return [instr.value];
    case "binary":
      return [instr.lhs, instr.rhs];
    case "unary":
      return [instr.rand];
    case "select":
      return [instr.condition, instr.whenTrue, instr.whenFalse];
    case "if": {
      // (#1392) Surface cond + carrier values plus uses inside the arms.
      // Arm-buffer instrs may reference outer SSA values; the
      // monomorphize pass needs to see them for use-counting.
      const out: IrValueId[] = [instr.cond, instr.thenValue, instr.elseValue];
      const walk = (instrs: readonly IrInstr[]): void => {
        for (const sub of instrs) {
          for (const u of collectUses(sub)) out.push(u);
        }
      };
      walk(instr.then);
      walk(instr.else);
      return out;
    }
    case "box":
    case "unbox":
    case "tag.test":
      return [instr.value];
    case "string.const":
      return [];
    case "string.concat":
    case "string.eq":
      return [instr.lhs, instr.rhs];
    case "string.len":
      return [instr.value];
    case "object.new":
      return instr.values;
    case "object.get":
      return [instr.value];
    case "object.set":
      return [instr.value, instr.newValue];
    // Slice 3 (#1169c): closure / ref-cell ops.
    case "closure.new":
      return instr.captures;
    case "closure.cap":
      return [instr.self];
    case "closure.call":
      return [instr.callee, ...instr.args];
    case "refcell.new":
      return [instr.value];
    case "refcell.get":
      return [instr.cell];
    case "refcell.set":
      return [instr.cell, instr.value];
    // Slice 4 (#1169d): class ops.
    case "class.new":
      return instr.args;
    case "class.get":
      return [instr.value];
    case "class.set":
      return [instr.value, instr.newValue];
    case "class.call":
      return [instr.receiver, ...instr.args];
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return [];
    case "slot.write":
      return [instr.value];
    case "vec.len":
      return [instr.vec];
    case "vec.get":
      return [instr.vec, instr.index];
    case "forof.vec": {
      const result: IrValueId[] = [instr.vec];
      const walk = (instrs: readonly IrInstr[]): void => {
        for (const sub of instrs) {
          for (const u of collectUses(sub)) result.push(u);
          if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
        }
      };
      walk(instr.body);
      return result;
    }
    // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
    case "coerce.to_externref":
      return [instr.value];
    case "iter.new":
      return [instr.iterable];
    case "iter.next":
      return [instr.iter];
    case "iter.done":
      return [instr.resultObj];
    case "iter.value":
      return [instr.resultObj];
    case "iter.return":
      return [instr.iter];
    case "forof.iter": {
      const result: IrValueId[] = [instr.iterable];
      const walk = (instrs: readonly IrInstr[]): void => {
        for (const sub of instrs) {
          for (const u of collectUses(sub)) result.push(u);
          if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
        }
      };
      walk(instr.body);
      return result;
    }
    // Slice 6 part 4 (#1183) — string for-of.
    case "forof.string": {
      const result: IrValueId[] = [instr.str];
      const walk = (instrs: readonly IrInstr[]): void => {
        for (const sub of instrs) {
          for (const u of collectUses(sub)) result.push(u);
          if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
        }
      };
      walk(instr.body);
      return result;
    }
    // Slice 7a (#1169f): generator ops.
    case "gen.push":
      return [instr.value];
    case "gen.epilogue":
      return [];
    // Slice 7b (#1169f): yield* delegation.
    case "gen.yieldStar":
      return [instr.inner];
    // Slice 9 (#1169h) — exception handling.
    case "throw":
      return [instr.value];
    case "try": {
      const result: IrValueId[] = [];
      const walk = (instrs: readonly IrInstr[]): void => {
        for (const sub of instrs) {
          for (const u of collectUses(sub)) result.push(u);
          if (sub.kind === "forof.vec" || sub.kind === "forof.iter" || sub.kind === "forof.string") walk(sub.body);
          if (sub.kind === "try") {
            walk(sub.body);
            if (sub.catchClause) walk(sub.catchClause.body);
            if (sub.finallyBody) walk(sub.finallyBody);
          }
        }
      };
      walk(instr.body);
      if (instr.catchClause) walk(instr.catchClause.body);
      if (instr.finallyBody) walk(instr.finallyBody);
      return result;
    }
    // Slice 10 (#1169i): extern class ops.
    case "extern.new":
      return instr.args;
    case "extern.call":
      return [instr.receiver, ...instr.args];
    case "extern.prop":
      return [instr.receiver];
    case "extern.propSet":
      return [instr.receiver, instr.value];
    case "extern.regex":
      return [];
    // Slice 12 (#1280): while.loop / for.loop. The cond / body /
    // update buffers are walked separately by the dead-code analysis
    // walker; the instr itself only directly references condValue.
    case "while.loop":
    case "for.loop":
      return [instr.condValue];
    // (#1373 Phase B) Async / await IR nodes — single operand.
    case "await":
      return [instr.operand];
    case "async.return":
      return [instr.value];
    case "async.throw":
      return [instr.reason];
  }
}
