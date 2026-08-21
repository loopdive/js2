// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IR invariant verifier — validates an IrFunction against the invariants in
// spec #1131 §1.3. Phase 1 enforces the subset that the Phase 1 builder can
// actually produce:
//
//   1. Single static assignment: every IrValueId defined exactly once.
//   2. Use-before-def: every IrValueId referenced is either a param, a block
//      arg of the containing block, defined earlier in the same block, or
//      defined in a block that **dominates** the using block along all CFG
//      paths (#1850 — cross-block dominance, the former Phase-2 TODO). A use
//      reached by a non-dominating def is rejected as a dominance violation.
//   3. Block termination: every block has exactly one terminator.
//   4. Branch arg arity: each `br`/`br_if` passes exactly as many args as the
//      target block declares.
//   5. Symbolic refs: the only references to functions/globals/types in
//      instructions are structurally-bound IrFuncRef/IrGlobalRef/IrTypeRef
//      values (no raw indices or legacy name-only callable refs).
//
// On failure, returns a list of `IrVerifyError`s rather than throwing, so
// callers can decide whether to bail or fall back to the legacy path.

import type { IrBlock, IrFunction, IrInstr, IrLabelId, IrType, IrValueId } from "./nodes.js";
import { asVal, forEachInstrDeep, forEachNestedBuffer, irTypeEquals } from "./nodes.js";
import type { ValType } from "./types.js";
// #2949 slice 1 / #3954 phase 1 — the dynamic-operand rules (payload-kind
// consistency of unbox/tag.test) are DOMAIN questions, not ECMAScript ones:
// "does this partition have a payload, and what shape is it?". The verifier
// therefore asks a `TagDomain` rather than reading `jsTagUnboxKind`/`JsTag[…]`
// directly.
// #3954 phase 3 (W3) — WHICH domain is now a PARAMETER, threaded from
// `verifyIrFunction` down to the per-instruction rules, defaulting to
// `defaultTagDomain()` so every existing caller is unchanged. Before this slice
// the domain was reached as a global at the point of use, so there was no
// channel at all by which the verifier could be told that the IR in front of it
// belongs to another producer.
import { defaultTagDomain } from "./producer.js";
import type { TagDomain } from "./tag-domain.js";
import { verifyIrIntrinsicInstruction } from "./intrinsic-support.js";
import { verifyIrAsyncPlan } from "./async-plan.js";
// #4418 — shared, cached dominance analysis (formerly a private set-based
// computation in this file, #1850).
import { crossCheckDominance, dominanceOf, type DominanceInfo } from "./analysis/dominance.js";

/**
 * #1850 — map every SSA value (instruction result or block arg) to the id of
 * the block that defines/binds it. Recurses into nested if/try/loop buffers so
 * a value defined inside one is attributed to its enclosing top-level block
 * (its dominance scope is that block). Params are intentionally excluded — they
 * are visible everywhere and the use check handles them separately.
 */
function buildDefBlockMap(func: IrFunction): Map<IrValueId, number> {
  const m = new Map<IrValueId, number>();
  for (const block of func.blocks) {
    const id = block.id as number;
    for (const arg of block.blockArgs) m.set(arg, id);
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (i) => {
        if (i.result !== null) m.set(i.result, id);
      });
    }
  }
  return m;
}

/**
 * #1924 — build the SSA value → declared `IrType` map ONCE per function.
 *
 * Every SSA value's type is taken from the `resultType` denormalized onto its
 * defining instruction (`nodes.ts`), plus params and per-block `blockArgTypes`.
 * The instruction-level type rules consult this O(1) map instead of
 * `operandIrType`, which re-scans the whole function per query (#1924 perf
 * note: that made any per-operand check quadratic). One build keeps total
 * verify cost O(n).
 *
 * A value may be absent (def has `resultType: null`, or is a void/effect-only
 * instruction) — callers treat `undefined` as "unknown type" and skip the
 * rule, matching `operandIrType`'s conservative null contract.
 */
function buildDefTypeMap(func: IrFunction): Map<IrValueId, IrType> {
  const m = new Map<IrValueId, IrType>();
  for (const p of func.params) m.set(p.value, p.type);
  for (const block of func.blocks) {
    for (let i = 0; i < block.blockArgs.length; i++) {
      const t = block.blockArgTypes[i];
      if (t) m.set(block.blockArgs[i]!, t);
    }
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (inst) => {
        if (inst.result !== null && inst.resultType) m.set(inst.result, inst.resultType);
      });
    }
  }
  return m;
}

// #1850's private dominator-set computation moved to the shared, cached
// analysis module (#4418): `src/ir/analysis/dominance.ts`. The verifier is
// its first consumer — same check, now CHK idoms on flat arrays instead of
// O(blocks²) full sets rebuilt on every verification. One behavioural
// contract carried over exactly: an UNREACHABLE use-block never produces a
// dominance violation (the old full-set init made `doms.has(db)` true there;
// the new predicate special-cases reachability — see `dominatedCrossBlockDef`).

export interface IrVerifyError {
  readonly message: string;
  readonly func: string;
  readonly block?: number;
  /**
   * (#3565) When true, this verify error is a DESIGNED demote-to-legacy signal,
   * not a compiler invariant — the integration layer classifies it as
   * `unsupported` (warning → keep legacy body) rather than the hard `invariant`
   * that #3341/#3519 promoted. Set ONLY on the #1798 return-value gate
   * (return/early.return arity + type mismatch), whose whole purpose is to
   * demote a function that would otherwise emit invalid Wasm. Every other verify
   * error (SSA scope, dominance, branch/instr type rules, block-id shape) is a
   * genuine invalid-IR invariant and stays a hard error.
   */
  readonly demote?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function callableReferenceProblem(value: unknown): string | null {
  if (!isRecord(value)) return "must be an IrFuncRef object";
  if (value.kind !== "func") return 'must have kind "func"';
  if (!nonEmptyString(value.name)) return "must carry a non-empty compatibility name";
  if (!("binding" in value)) {
    return "is missing required callable binding; legacy name-only refs are not valid IR";
  }
  if (!isRecord(value.binding)) return "has a malformed callable binding object";

  const binding = value.binding;
  switch (binding.kind) {
    case "unit":
      return nonEmptyString(binding.unitId) && binding.unitId.startsWith("ir-unit:v1:")
        ? null
        : "has a malformed unit callable binding";
    case "import":
      return nonEmptyString(binding.module) && nonEmptyString(binding.field)
        ? null
        : "has a malformed import callable binding";
    case "runtime":
      return nonEmptyString(binding.symbol) ? null : "has a malformed runtime callable binding";
    case "intrinsic":
      return nonEmptyString(binding.symbol) ? null : "has a malformed intrinsic callable binding";
    case "support":
      return nonEmptyString(binding.bindingId) && binding.bindingId.startsWith("ir-binding:v1:")
        ? null
        : "has a malformed support callable binding";
    default:
      return "has an unknown callable binding kind";
  }
}

function structuralBindingId(value: unknown, domain: "global" | "type" | "class"): value is string {
  return nonEmptyString(value) && value.startsWith(`ir-binding:v1:${domain}:`);
}

/** Validate a serialized/in-memory global ref without trusting its TypeScript type. */
export function irGlobalReferenceProblem(value: unknown): string | null {
  if (!isRecord(value)) return "must be an IrGlobalRef object";
  if (value.kind !== "global") return 'must have kind "global"';
  if (!nonEmptyString(value.name)) return "must carry a non-empty compatibility name";
  if (!("binding" in value)) {
    return "is missing required global binding; legacy name-only refs are not valid IR";
  }
  if (!isRecord(value.binding)) return "has a malformed global binding object";
  const binding = value.binding;
  if (!structuralBindingId(binding.bindingId, "global")) return "has a malformed global-domain bindingId";
  switch (binding.kind) {
    case "source":
    case "support":
      return null;
    case "import":
      return nonEmptyString(binding.module) && typeof binding.field === "string"
        ? null
        : "has a malformed import global binding";
    case "runtime":
      return nonEmptyString(binding.symbol) ? null : "has a malformed runtime global binding";
    default:
      return "has an unknown global binding kind";
  }
}

/** Validate a symbolic type ref before a backend adapter resolves it. */
export function irTypeReferenceProblem(value: unknown): string | null {
  if (!isRecord(value)) return "must be an IrTypeRef object";
  if (value.kind !== "type") return 'must have kind "type"';
  if (!nonEmptyString(value.name)) return "must carry a non-empty compatibility name";
  if (!("binding" in value)) {
    return "is missing required type binding; legacy name-only refs are not valid IR";
  }
  if (!isRecord(value.binding)) return "has a malformed type binding object";
  const binding = value.binding;
  const expectedDomain = binding.kind === "class" ? "class" : "type";
  if (!structuralBindingId(binding.bindingId, expectedDomain)) {
    return `has a malformed ${expectedDomain}-domain bindingId`;
  }
  switch (binding.kind) {
    case "source":
    case "support":
      return null;
    case "class":
      return nonEmptyString(binding.classId) && binding.classId.startsWith("ir-class:v1:")
        ? null
        : "has a malformed class type binding";
    case "runtime":
      return nonEmptyString(binding.symbol) ? null : "has a malformed runtime type binding";
    default:
      return "has an unknown type binding kind";
  }
}

/** Verify direct symbolic refs in every nested instruction buffer. */
function verifySymbolicReferences(func: IrFunction, errors: IrVerifyError[]): void {
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => {
        let site: string;
        let ref: unknown;
        if (nested.kind === "call") {
          site = "call target";
          ref = nested.target;
        } else if (nested.kind === "closure.new") {
          site = "closure.new liftedFunc";
          ref = nested.liftedFunc;
        } else if (nested.kind === "global.get" || nested.kind === "global.set") {
          const problem = irGlobalReferenceProblem(nested.target);
          if (problem !== null) {
            errors.push({
              message: `${nested.kind} target ${problem}`,
              func: func.name,
              block: block.id as number,
            });
          }
          return;
        } else if (nested.kind === "string.const") {
          if (nested.storage && nested.materializer) {
            errors.push({
              message: "string.const cannot carry both storage and a materializer",
              func: func.name,
              block: block.id as number,
            });
          }
          if (nested.storage) {
            const problem = irGlobalReferenceProblem(nested.storage);
            if (problem !== null) {
              errors.push({
                message: `string.const storage ${problem}`,
                func: func.name,
                block: block.id as number,
              });
            }
          }
          if (nested.materializer) {
            const problem = callableReferenceProblem(nested.materializer);
            if (problem !== null) {
              errors.push({
                message: `string.const materializer ${problem}`,
                func: func.name,
                block: block.id as number,
              });
            }
          }
          return;
        } else if (nested.kind === "string.len" && nested.provider) {
          if (nested.provider.kind === "callable") {
            const problem = callableReferenceProblem(nested.provider.target);
            if (problem !== null) {
              errors.push({
                message: `string.len provider ${problem}`,
                func: func.name,
                block: block.id as number,
              });
            }
          } else {
            const problem = irTypeReferenceProblem(nested.provider.ownerType);
            if (
              problem !== null ||
              !Number.isSafeInteger(nested.provider.fieldIndex) ||
              nested.provider.fieldIndex < 0
            ) {
              errors.push({
                message:
                  problem === null
                    ? "string.len provider has an invalid struct field index"
                    : `string.len provider ${problem}`,
                func: func.name,
                block: block.id as number,
              });
            }
          }
          return;
        } else if (
          (nested.kind === "string.concat" ||
            nested.kind === "string.eq" ||
            nested.kind === "string.char_at" ||
            nested.kind === "string.char_code_at" ||
            nested.kind === "forof.string") &&
          nested.provider
        ) {
          const problem = callableReferenceProblem(nested.provider);
          if (problem !== null) {
            errors.push({
              message: `${nested.kind} provider ${problem}`,
              func: func.name,
              block: block.id as number,
            });
          }
          return;
        } else {
          return;
        }
        const problem = callableReferenceProblem(ref);
        if (problem !== null) {
          errors.push({ message: `${site} ${problem}`, func: func.name, block: block.id as number });
        }
      });
    }
  }
}

/**
 * Structurally verify one `IrFunction`.
 *
 * `domain` (#3954 phase 3, W3) is the {@link TagDomain} the function's
 * `dynamic` values are interpreted against — it decides which partitions exist,
 * which of them are payload-less singletons (rule R2) and what carrier shape
 * each payload has (the `unbox`/`tag.test` `tag` consistency rule). It defaults
 * to the producer axis's default domain, so callers that do not care are
 * unchanged; a non-JS producer passes its own and the verifier stops answering
 * from ECMAScript.
 */
export function verifyIrFunction(func: IrFunction, domain: TagDomain = defaultTagDomain()): IrVerifyError[] {
  const errors: IrVerifyError[] = [];
  const defs = new Set<IrValueId>();

  if (func.asyncPlan) {
    if (func.funcKind !== "async") {
      errors.push({ message: "asyncPlan requires funcKind=async", func: func.name });
    }
    if (func.asyncPlan.ownerUnitId !== func.unitId) {
      errors.push({ message: "asyncPlan ownerUnitId does not match its IrFunction", func: func.name });
    }
    for (const error of verifyIrAsyncPlan(func.asyncPlan)) {
      errors.push({ message: `asyncPlan ${error.code}: ${error.message}`, func: func.name });
    }
  } else if (func.asyncRuntime) {
    errors.push({ message: "asyncRuntime requires a semantic asyncPlan", func: func.name });
  }
  if (func.asyncRuntime) {
    const capabilities = new Set<string>();
    for (const adapter of func.asyncRuntime.adapters) {
      if (capabilities.has(adapter.capability)) {
        errors.push({ message: `asyncRuntime duplicates capability ${adapter.capability}`, func: func.name });
      }
      capabilities.add(adapter.capability);
      const problem = callableReferenceProblem(adapter.target);
      if (problem !== null) {
        errors.push({ message: `asyncRuntime adapter ${adapter.capability} ${problem}`, func: func.name });
      }
    }
  }

  verifySymbolicReferences(func, errors);

  for (const p of func.params) {
    if (defs.has(p.value)) {
      errors.push({ message: `duplicate SSA def for param ${p.name}`, func: func.name });
    }
    defs.add(p.value);
  }

  // Validate block IDs form a contiguous range starting at 0.
  let blockIdsContiguous = true;
  for (let i = 0; i < func.blocks.length; i++) {
    if ((func.blocks[i].id as number) !== i) {
      errors.push({ message: `block ${i} has id ${func.blocks[i].id}, expected ${i}`, func: func.name, block: i });
      blockIdsContiguous = false;
    }
  }

  // #1850 — cross-block dominance support. Map each SSA value (and block arg)
  // to the id of the block that defines/binds it, and compute the dominator
  // sets over the CFG, so `verifyBlock` can validate that a value used in a
  // *different* block than its def is dominated by that def along all paths.
  // Only meaningful when block ids are contiguous (we index by id); when they
  // aren't, skip the dominance check (the id error above already fires) so we
  // don't index out of bounds.
  const defBlock = blockIdsContiguous ? buildDefBlockMap(func) : null;
  const dominance = blockIdsContiguous ? dominanceOf(func) : null;
  // #4418 — corpus-wide audit of the fast dominance analysis against the
  // naive reachability definition. Opt-in (quadratic per function); the unit
  // tests run the same cross-check on synthetic general graphs.
  if (dominance && process.env.JS2WASM_IR_VERIFY_DOMINANCE_NAIVE === "1") {
    for (const msg of crossCheckDominance(func, dominance)) {
      errors.push({ message: `dominance self-check: ${msg}`, func: func.name });
    }
  }

  // #1924 — build the def→IrType map once (O(n)); reused by the per-instruction
  // type rules and the branch-arg type check below.
  const typeOf = buildDefTypeMap(func);

  for (const block of func.blocks) {
    verifyBlock(func, block, defs, errors, defBlock, dominance, domain);
  }

  // Check branch-arg arity AND types against target block signatures (#1924).
  for (const block of func.blocks) {
    const t = block.terminator;
    if (t.kind === "br") {
      checkBranchArity(func, block, t.branch.target as number, t.branch.args.length, errors);
      checkBranchArgTypes(func, block, t.branch.target as number, t.branch.args, typeOf, errors);
    } else if (t.kind === "br_if") {
      checkBranchArity(func, block, t.ifTrue.target as number, t.ifTrue.args.length, errors);
      checkBranchArity(func, block, t.ifFalse.target as number, t.ifFalse.args.length, errors);
      checkBranchArgTypes(func, block, t.ifTrue.target as number, t.ifTrue.args, typeOf, errors);
      checkBranchArgTypes(func, block, t.ifFalse.target as number, t.ifFalse.args, typeOf, errors);
    }
  }

  // #1924 — per-instruction operand / result / slot type rules.
  verifyInstrTypeRules(func, typeOf, errors);

  // #1798 — defense-in-depth: every `return` terminator's value types must be
  // Wasm-assignment-compatible with the function's declared `resultTypes`.
  // The from-ast layer is responsible for inserting the right coercions
  // (e.g. `extern.convert_any` for ref → externref returns); if it ever omits
  // one, the malformed body would otherwise slip past this gate and fail
  // Wasm validation only at instantiate time. Flagging it here demotes the
  // function to legacy (integration.ts skips functions with verify errors)
  // instead of emitting an invalid module.
  for (const block of func.blocks) {
    const t = block.terminator;
    if (t.kind !== "return") continue;
    if (t.values.length !== func.resultTypes.length) {
      errors.push({
        message: `return arity ${t.values.length} != declared result arity ${func.resultTypes.length}`,
        func: func.name,
        block: block.id as number,
        demote: true, // (#3565) #1798 gate — DESIGNED demote-to-legacy, not an invariant
      });
      continue;
    }
    for (let i = 0; i < t.values.length; i++) {
      const declared = func.resultTypes[i]!;
      const actual = operandIrType(func, block, t.values[i]!, new Set());
      if (!actual) continue; // not locally visible — SSA-scope check reports it
      if (!returnTypeAssignable(actual, declared)) {
        errors.push({
          message:
            `return[${i}] type ${describeKind(actual)} not assignable to declared ` +
            `result ${describeKind(declared)}`,
          func: func.name,
          block: block.id as number,
          demote: true, // (#3565) #1798 gate — DESIGNED demote-to-legacy, not an invariant
        });
      }
    }
  }

  // (#2856) Same #1798 gate for `early.return` instrs inside nested buffers —
  // a Wasm `return` carries the function's result values, so a mis-typed
  // early-return value would produce invalid Wasm at instantiate time. Flag
  // it here so the function demotes to legacy instead.
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (i) => {
        if (i.kind !== "early.return") return;
        const arity = i.value !== null ? 1 : 0;
        if (arity !== func.resultTypes.length) {
          errors.push({
            message: `early.return arity ${arity} != declared result arity ${func.resultTypes.length}`,
            func: func.name,
            block: block.id as number,
            demote: true, // (#3565) #1798 gate — DESIGNED demote-to-legacy, not an invariant
          });
          return;
        }
        if (i.value === null) return;
        const actual = operandIrType(func, block, i.value, new Set());
        if (!actual) return; // not locally visible — SSA-scope check reports it
        if (!returnTypeAssignable(actual, func.resultTypes[0]!)) {
          errors.push({
            message:
              `early.return value type ${describeKind(actual)} not assignable to declared ` +
              `result ${describeKind(func.resultTypes[0]!)}`,
            func: func.name,
            block: block.id as number,
            demote: true, // (#3565) #1798 gate — DESIGNED demote-to-legacy, not an invariant
          });
        }
      });
    }
  }

  return errors;
}

/**
 * #1798 — conservative Wasm-level assignment check for return values. Catches
 * the divergences that produce invalid Wasm (scalar ↔ reference, or two
 * different native scalars) while staying lenient on reference-shaped IrTypes
 * — those all lower to `externref`-compatible refs and may legitimately flow
 * into an `externref` (`any`) result without an SSA-visible coercion node
 * (e.g. host-strings, already-externref values). False positives here would
 * silently demote working IR functions to legacy, so the check only fires on
 * an unambiguous mismatch.
 */
function returnTypeAssignable(actual: IrType, declared: IrType): boolean {
  // #2949 slice 3 — R6 HARDENING: a `dynamic` declared result accepts ONLY a
  // dynamic value (bare or tag-refined). Before slice 3 this fell through to
  // the lenient both-reference-shaped arm below, which PASSED a bare
  // `(ref $C)` / string / closure into a dynamic result — but the lowering
  // of that flow is only valid through an explicit `box` (a raw struct ref
  // is not an `$AnyValue` subtype in fast mode, and host mode needs the
  // `extern.convert_any` re-tag the box arm emits). Slice 2's move-only
  // producers never emit the flow (dyn return args are dyn-shaped by the
  // scan), so this is zero-delta today; it exists so the FIRST producer
  // that widens returns is forced through `box{toType: dynamic}` instead of
  // silently emitting invalid Wasm (the latent trap the slice-2 handoff
  // flagged). The dual direction (dynamic value into a non-dynamic declared
  // result) keeps its existing arms: scalar results reject below via
  // `asVal(dynamic) === null`; externref results legitimately accept the
  // carrier (host: identity; fast: the return path's extern re-tag).
  if (declared.kind === "dynamic") {
    return actual.kind === "dynamic";
  }
  const a = asVal(actual);
  const d = asVal(declared);
  const isScalar = (v: ValType | null): boolean =>
    !!v && (v.kind === "f64" || v.kind === "i32" || v.kind === "i64" || v.kind === "i8" || v.kind === "i16");

  // Native scalar declared result: the value must be the same scalar kind.
  if (isScalar(d)) {
    if (!a) return false; // reference-shaped value into a scalar result — invalid
    return a.kind === d!.kind;
  }
  // Native scalar value into a non-scalar (reference / externref) result —
  // needs a box the IR doesn't emit; this is the #1798 numeric-`any` case the
  // from-ast layer defers to legacy. Flag it so a future regression demotes.
  if (isScalar(a)) {
    return false;
  }
  // Both reference-shaped (or externref): treat as assignable. The lowerer's
  // `extern.convert_any` re-tags any anyref subtype into externref, and an
  // externref result accepts every reference IrType.
  return true;
}

function describeKind(t: IrType): string {
  const v = asVal(t);
  if (v) return v.kind;
  return t.kind;
}

/**
 * Per-instruction structural (type-system) rules: loop/if condValue i32
 * contracts, switch shape rules, and the tagged-union box/unbox/dyn.*
 * operand checks. Extracted from the `walkBuffer` scope walk (#2952
 * slice 4) — these need only the instruction and its operand types
 * (`operandIrType` scans the whole function), none of the walk state
 * (label envs, buffer position), so the walk calls this once per
 * instruction and stays a pure SSA/label-scope walker.
 */
function verifyInstrStructure(
  instr: IrInstr,
  func: IrFunction,
  block: IrBlock,
  localDefs: ReadonlySet<IrValueId>,
  errors: IrVerifyError[],
  // #3954 phase 3 (W3) — see `verifyIrFunction`.
  domain: TagDomain,
): void {
  // The lowerer emits an unconditional `i32.eqz` on a loop `condValue`, so
  // a non-i32 cond produces invalid Wasm that bricks the whole module.
  // Reject it here (the lowerer's #1980 fix throws a fallback before
  // reaching this, but the verifier is the structural backstop — the
  // #1850 gap that let this through silently). (#1980)
  if (instr.kind === "while.loop" || instr.kind === "for.loop") {
    const condT = operandIrType(func, block, instr.condValue, localDefs);
    if (condT && asVal(condT)?.kind !== "i32") {
      errors.push({
        message: `${instr.kind} condValue must be i32, got ${asVal(condT)?.kind ?? condT.kind}`,
        func: func.name,
        block: block.id as number,
      });
    }
  }

  // #2952 slice 2 — if.stmt cond must be i32 (same backstop rationale).
  if (instr.kind === "if.stmt") {
    const condT = operandIrType(func, block, instr.cond, localDefs);
    if (condT && asVal(condT)?.kind !== "i32") {
      errors.push({
        message: `if.stmt cond must be i32, got ${asVal(condT)?.kind ?? condT.kind}`,
        func: func.name,
        block: block.id as number,
      });
    }
  }

  // #2952 slice 4 — switch structural rules: disc must be numeric (the
  // lowerer emits i32.eq / f64.eq against literal tests), the tests/bodies
  // arrays must be parallel, and at most one default.
  if (instr.kind === "switch") {
    const discT = operandIrType(func, block, instr.disc, localDefs);
    const discK = discT ? asVal(discT)?.kind : undefined;
    if (discT && discK !== "i32" && discK !== "f64") {
      errors.push({
        message: `switch disc must be i32/f64, got ${discK ?? discT.kind}`,
        func: func.name,
        block: block.id as number,
      });
    }
    if (instr.tests.length !== instr.bodies.length) {
      errors.push({
        message: `switch tests (${instr.tests.length}) and bodies (${instr.bodies.length}) must be parallel`,
        func: func.name,
        block: block.id as number,
      });
    }
    if (instr.tests.filter((t) => t === null).length > 1) {
      errors.push({
        message: `switch has more than one default clause`,
        func: func.name,
        block: block.id as number,
      });
    }
  }

  // Structural checks for the tagged-union instructions. These are
  // type-system-level, not SSA-scope — misuse should surface here rather
  // than silently lowering to a trap.
  if (instr.kind === "box") {
    if (instr.toType.kind === "dynamic") {
      // #2949 R1 — box-to-dynamic erases any concrete value into the
      // boxed-any carrier. Re-boxing an already-dynamic value is
      // provably redundant (the intended node is a move or an unbox) —
      // reject it so a producer bug surfaces here, not as a double-boxed
      // runtime value.
      const operandIr = operandIrType(func, block, instr.value, localDefs);
      if (operandIr && operandIr.kind === "dynamic") {
        errors.push({
          message: `box operand is already dynamic — re-boxing a dynamic value is invalid (#2949)`,
          func: func.name,
          block: block.id as number,
        });
      }
    } else if (instr.toType.kind !== "union") {
      errors.push({
        message: `box target must be a union or dynamic IrType, got ${instr.toType.kind}`,
        func: func.name,
        block: block.id as number,
      });
    } else {
      // box requires the operand's ValType to be a member of the union.
      const operandT = operandValType(func, block, instr.value, localDefs);
      if (operandT && !unionContains(instr.toType.members, operandT)) {
        errors.push({
          // #1926 — members are IrTypes; describe each member's ValType kind.
          message: `box operand type ${operandT.kind} is not a member of union<${instr.toType.members.map((m) => asVal(m)?.kind ?? m.kind).join(",")}>`,
          func: func.name,
          block: block.id as number,
        });
      }
    }
  }
  if (instr.kind === "unbox" || instr.kind === "tag.test") {
    const operandIr = operandIrType(func, block, instr.value, localDefs);
    if (operandIr && operandIr.kind === "dynamic") {
      // #2949 R2/R3 — dynamic operands discriminate on the domain partition,
      // so `tagId` is REQUIRED (the ValType `tag` cannot distinguish
      // e.g. String from Object — both are reference-shaped).
      if (instr.tagId === undefined) {
        errors.push({
          message: `${instr.kind} on a dynamic operand requires tagId (#2949)`,
          func: func.name,
          block: block.id as number,
        });
      } else {
        // #3954 phase 3 (W3) — `domain` is the caller's, not a global. Note it
        // is still an ERROR (thrown by `nameOf`) to hand a partition from one
        // domain to a verifier holding another: that is a producer bug, and
        // the loud failure is the point.
        const tagId = instr.tagId;
        const tagName = domain.nameOf(tagId);
        const payload = domain.carrierKindOf(tagId);
        // R2 — a payload-less SINGLETON partition (ECMAScript: Null /
        // Undefined) cannot be unboxed; identity is observed via tag.test.
        // Which partitions those are is the domain's answer, not ours.
        if (instr.kind === "unbox" && payload === null) {
          errors.push({
            message: `unbox with payload-less partition ${tagName} is invalid — use tag.test (#2949)`,
            func: func.name,
            block: block.id as number,
          });
        }
        // When the producer also wrote a ValType `tag`, it must be
        // consistent with the partition's payload kind: exact for the
        // scalar partitions, ref-shaped for String/Object/Function.
        if (instr.tag && payload !== null) {
          const k = instr.tag.kind;
          const refShaped =
            k === "ref" ||
            k === "ref_null" ||
            k === "externref" ||
            k === "ref_extern" ||
            k === "eqref" ||
            k === "anyref" ||
            k === "funcref";
          const consistent = payload === "ref" ? refShaped : k === payload;
          if (!consistent) {
            errors.push({
              message: `${instr.kind} tag ${k} is inconsistent with partition ${tagName} (payload kind ${payload}) (#2949)`,
              func: func.name,
              block: block.id as number,
            });
          }
        }
      }
    } else if (operandIr && operandIr.kind !== "union") {
      errors.push({
        message: `${instr.kind} operand must be a union or dynamic IrType, got ${operandIr.kind}`,
        func: func.name,
        block: block.id as number,
      });
    } else if (operandIr) {
      // Union operand (V1) — the ValType `tag` is REQUIRED (#2949 made
      // the field optional on the node because dynamic operands use
      // `tagId` instead) and must name a member of the union.
      if (!instr.tag) {
        errors.push({
          message: `${instr.kind} on a union operand requires a ValType tag`,
          func: func.name,
          block: block.id as number,
        });
      } else if (!unionContains(operandIr.members, instr.tag)) {
        errors.push({
          // #1926 — members are IrTypes; describe each member's ValType kind.
          message: `${instr.kind} tag ${instr.tag.kind} is not a member of union<${operandIr.members.map((m) => asVal(m)?.kind ?? m.kind).join(",")}>`,
          func: func.name,
          block: block.id as number,
        });
      }
    }
  }
  // #2949 S5.1 — dyn.truthy is ToBoolean on the boxed-any carrier: the
  // operand MUST be dynamic (a concrete scalar has an inline ToBoolean
  // and must not route through the carrier helper). Result is i32,
  // already enforced structurally by the loop/if condValue rules.
  if (instr.kind === "dyn.truthy") {
    const operandIr = operandIrType(func, block, instr.value, localDefs);
    if (operandIr && operandIr.kind !== "dynamic") {
      errors.push({
        message: `dyn.truthy operand must be a dynamic IrType, got ${operandIr.kind} (#2949)`,
        func: func.name,
        block: block.id as number,
      });
    }
  }
  // #2949 S5.3 — dyn.to_number is ToNumber on the boxed-any carrier → f64:
  // the operand MUST be dynamic (a concrete numeric operand converts to f64
  // inline and must not route through the carrier ToNumber helper). Result
  // is f64, consumed by the numeric-abstract relational compare.
  if (instr.kind === "dyn.to_number") {
    const operandIr = operandIrType(func, block, instr.value, localDefs);
    if (operandIr && operandIr.kind !== "dynamic") {
      errors.push({
        message: `dyn.to_number operand must be a dynamic IrType, got ${operandIr.kind} (#2949)`,
        func: func.name,
        block: block.id as number,
      });
    }
  }
  // #2949 S5.2 — dyn.eq compares TWO boxed-any carriers via the canonical
  // `__any_strict_eq`/`__any_eq` helpers (which take `(ref null $AnyValue,
  // ref null $AnyValue)`). BOTH operands MUST be dynamic — the producer
  // boxes any concrete operand into the carrier before this node, so a
  // non-dynamic operand here is a producer bug (a concrete-vs-concrete
  // `===` has an inline `i32.eq`/`f64.eq` and must never route through the
  // carrier helper). Result is i32, satisfying downstream condValue rules.
  if (instr.kind === "dyn.eq") {
    for (const operand of [instr.lhs, instr.rhs]) {
      const operandIr = operandIrType(func, block, operand, localDefs);
      if (operandIr && operandIr.kind !== "dynamic") {
        errors.push({
          message: `dyn.eq operand must be a dynamic IrType, got ${operandIr.kind} (#2949)`,
          func: func.name,
          block: block.id as number,
        });
      }
    }
  }
  // #3053 U1 / #2949 S5.4 — dyn.member_get reads a member off a boxed-any
  // receiver via `__dyn_member_get(recv, key)`, which takes and returns the
  // carrier. BOTH operands MUST be dynamic (the producer boxes the receiver
  // and the property key into the carrier first) and the RESULT must be
  // dynamic (the honest-boxed read value) — anything else is a producer bug
  // that would mis-shape the reader ABI.
  if (instr.kind === "dyn.member_get") {
    for (const [label, operand] of [
      ["recv", instr.recv],
      ["key", instr.key],
    ] as const) {
      const operandIr = operandIrType(func, block, operand, localDefs);
      if (operandIr && operandIr.kind !== "dynamic") {
        errors.push({
          message: `dyn.member_get ${label} must be a dynamic IrType, got ${operandIr.kind} (#3053 U1)`,
          func: func.name,
          block: block.id as number,
        });
      }
    }
    if (instr.resultType === null || instr.resultType.kind !== "dynamic") {
      errors.push({
        message: `dyn.member_get result must be a dynamic IrType, got ${instr.resultType?.kind ?? "null"} (#3053 U1)`,
        func: func.name,
        block: block.id as number,
      });
    }
  }
  // #3795 — the statement-position write dual consumes three canonical
  // dynamic carriers and produces no SSA result.
  if (instr.kind === "dyn.member_set") {
    for (const [label, operand] of [
      ["recv", instr.recv],
      ["key", instr.key],
      ["value", instr.value],
    ] as const) {
      const operandIr = operandIrType(func, block, operand, localDefs);
      if (operandIr && operandIr.kind !== "dynamic") {
        errors.push({
          message: `dyn.member_set ${label} must be a dynamic IrType, got ${operandIr.kind} (#3795)`,
          func: func.name,
          block: block.id as number,
        });
      }
    }
    if (instr.result !== null || instr.resultType !== null) {
      errors.push({
        message: "dyn.member_set must be void (#3795)",
        func: func.name,
        block: block.id as number,
      });
    }
  }
}

function verifyBlock(
  func: IrFunction,
  block: IrBlock,
  defs: Set<IrValueId>,
  errors: IrVerifyError[],
  defBlock: ReadonlyMap<IrValueId, number> | null,
  dominance: DominanceInfo | null,
  // #3954 phase 3 (W3) — the tag domain this IR belongs to, threaded from
  // `verifyIrFunction` rather than reached as a global at the point of use.
  domain: TagDomain,
): void {
  const here = block.id as number;
  // #1850 — cross-block dominance: a use whose value is defined in a *different*
  // block is only valid if that defining block dominates `here` along all CFG
  // paths. Returns true if the use is satisfied by a dominating cross-block def
  // (so the local use-before-def check should not also flag it), false if it is
  // either local (let the local check decide) or a dominance violation (which we
  // report here).
  const dominatedCrossBlockDef = (u: IrValueId, atBlock: number, what: string): boolean => {
    if (!defBlock || !dominance) return false;
    const db = defBlock.get(u);
    if (db === undefined || db === atBlock) return false; // not a cross-block def
    // An unreachable use-block never violates dominance — #1850's full-set
    // init answered "dominated" there, and this predicate preserves that.
    if (!dominance.reachable[atBlock]) return true;
    if (dominance.dominates(db, atBlock)) return true; // def dominates use — OK
    errors.push({
      message: `use of SSA value ${u} in ${what} (block ${atBlock}) is not dominated by its def in block ${db}`,
      func: func.name,
      block: atBlock,
    });
    return true; // handled (reported) — don't double-report as use-before-def
  };
  for (const arg of block.blockArgs) {
    if (defs.has(arg)) {
      errors.push({
        message: `duplicate SSA def for block arg ${arg}`,
        func: func.name,
        block: block.id as number,
      });
    }
    defs.add(arg);
  }

  // Walk this block's instruction buffer, threading a `localDefs` set that
  // accumulates every SSA value defined so far in straight-line order. #1844:
  // nested if/try/loop/for-of buffers are walked recursively with the same
  // accumulator so (a) their SSA single-def invariant is enforced against the
  // global `defs` set, (b) use-before-def inside a nested body sees params,
  // the enclosing block args, and outer values defined before the nesting
  // instr, and (c) box/unbox/tag.test structural checks fire inside them too.
  const localDefs = new Set<IrValueId>();
  const checkUse = (u: IrValueId): void => {
    const isParam = func.params.some((p) => p.value === u);
    const isBlockArg = block.blockArgs.includes(u);
    const isEarlier = localDefs.has(u);
    if (isParam || isBlockArg || isEarlier) return;
    // #1850 — value defined in another block: valid iff that block dominates
    // `here`. `dominatedCrossBlockDef` reports a dominance violation itself and
    // returns true so we don't also emit a spurious use-before-def.
    if (dominatedCrossBlockDef(u, here, "instruction")) return;
    errors.push({
      message: `use of SSA value ${u} before def in block ${here}`,
      func: func.name,
      block: here,
    });
  };
  // #2952 slice 2 — the label environment: the set of loop labels bound by
  // enclosing loops IN THE SAME BUFFER-NESTING CHAIN. A `br.label` is valid
  // iff its label is in scope here; this walk mirrors the lowering-time
  // ctrlStack, so verifier acceptance implies the depth resolver finds a
  // frame. Loop BODY buffers extend the environment with the loop's label;
  // cond/update buffers do NOT (no statement can occur there), and try/if
  // buffers inherit unchanged (break out of a try is legal — the lowerer
  // inlines crossed finallys).
  // (#2952 slice 4) `breakOnlyInScope` — labels bound by enclosing
  // `labeled.block` / `switch` frames: valid targets for mode "break"
  // ONLY (JS grammar — `continue` must target a loop; the from-ast layer
  // never emits a continue against these, this is the structural backstop).
  const walkBuffer = (
    instrs: readonly IrInstr[],
    labelsInScope: ReadonlySet<IrLabelId>,
    breakOnlyInScope: ReadonlySet<IrLabelId> = new Set(),
  ): void => {
    const withLabel = (l: IrLabelId | undefined): ReadonlySet<IrLabelId> => {
      if (l === undefined) return labelsInScope;
      const next = new Set(labelsInScope);
      next.add(l);
      return next;
    };
    const withBreakOnly = (l: IrLabelId): ReadonlySet<IrLabelId> => {
      const next = new Set(breakOnlyInScope);
      next.add(l);
      return next;
    };
    for (let instrIdx = 0; instrIdx < instrs.length; instrIdx++) {
      const instr = instrs[instrIdx]!;
      // `while.loop` / `for.loop` surface `condValue` in `collectUses`, but
      // that value is *produced by the cond buffer* (which `collectUses` for
      // these kinds does not contain). Walk the cond buffer first so its def
      // is registered before we validate the `condValue` use — otherwise it
      // would spuriously read as use-before-def. (#1844)
      if (instr.kind === "while.loop" || instr.kind === "for.loop") {
        walkBuffer(instr.cond, labelsInScope);
      }

      // #2952 slice 2 — br.label rules: (a) the label must be bound by an
      // enclosing loop in this buffer-nesting chain, (b) the instr must
      // terminate its buffer (control cannot fall through; from-ast stops
      // emitting after a break/continue, so trailing instrs are a producer
      // bug, not dead code to tolerate).
      if (instr.kind === "br.label") {
        // (slice 4) break may additionally target a labeled.block / switch
        // frame; continue must target a loop label.
        const bound = labelsInScope.has(instr.label) || (instr.mode === "break" && breakOnlyInScope.has(instr.label));
        if (!bound) {
          errors.push({
            message: `br.label(${instr.label as number}, ${instr.mode}) targets no enclosing ${
              instr.mode === "break" ? "loop/block/switch" : "loop"
            } label`,
            func: func.name,
            block: block.id as number,
          });
        }
        if (instrIdx !== instrs.length - 1) {
          errors.push({
            message: `br.label must be the last instruction in its buffer (found at ${instrIdx} of ${instrs.length})`,
            func: func.name,
            block: block.id as number,
          });
        }
      }

      // Use-before-def check (params + block args always count). Nested-body
      // uses additionally see anything registered in `localDefs` so far,
      // which by construction includes the outer values defined before the
      // enclosing nesting instr.
      for (const u of collectUses(instr)) checkUse(u);

      // Per-instruction structural (type-system) rules — extracted so the
      // scope walk stays readable (#2952 slice 4; the checks need only the
      // instr + operand types, none of the walk state).
      verifyInstrStructure(instr, func, block, localDefs, errors, domain);

      if (instr.result !== null) {
        if (defs.has(instr.result)) {
          errors.push({
            message: `duplicate SSA def for value ${instr.result}`,
            func: func.name,
            block: block.id as number,
          });
        }
        defs.add(instr.result);
        localDefs.add(instr.result);
      }

      // Descend into the remaining nested buffers (if-arms, loop body/update,
      // for-of bodies, try/catch/finally). The nesting instr's own result is
      // registered before we descend so an arm body may reference it. The
      // loop `cond` buffer was already walked above, so skip it here.
      // (#2952 slice 2) Loop BODY buffers extend the label environment with
      // the loop's label; every other buffer inherits it unchanged.
      if (instr.kind === "while.loop") {
        walkBuffer(instr.body, withLabel(instr.loopLabel), breakOnlyInScope);
      } else if (instr.kind === "for.loop") {
        walkBuffer(instr.body, withLabel(instr.loopLabel), breakOnlyInScope);
        walkBuffer(instr.update, labelsInScope, breakOnlyInScope);
      } else if (instr.kind === "forof.vec" || instr.kind === "forof.iter" || instr.kind === "forof.string") {
        walkBuffer(instr.body, withLabel(instr.loopLabel), breakOnlyInScope);
      } else if (instr.kind === "labeled.block") {
        // (#2952 slice 4) break-only label frames.
        walkBuffer(instr.body, labelsInScope, withBreakOnly(instr.label));
      } else if (instr.kind === "switch") {
        for (const body of instr.bodies) walkBuffer(body, labelsInScope, withBreakOnly(instr.breakLabel));
      } else {
        // Non-loop buffer-bearing kinds (if / if.stmt / try). Loops are
        // handled above so their cond buffer (already walked) isn't
        // re-walked here.
        forEachNestedBuffer(instr, (buffer) => walkBuffer(buffer, labelsInScope, breakOnlyInScope));
      }
    }
  };
  walkBuffer(block.instrs, new Set());

  // Terminator uses must resolve to params/blockargs/local defs, or to a value
  // defined in a block that dominates this one (#1850).
  const termUses = collectTerminatorUses(block);
  for (const u of termUses) {
    const isParam = func.params.some((p) => p.value === u);
    const isBlockArg = block.blockArgs.includes(u);
    const isLocal = localDefs.has(u);
    if (isParam || isBlockArg || isLocal) continue;
    if (dominatedCrossBlockDef(u, here, "terminator")) continue;
    errors.push({
      message: `terminator uses undefined SSA value ${u} in block ${here}`,
      func: func.name,
      block: here,
    });
  }
}

function collectUses(instr: IrBlock["instrs"][number]): readonly IrValueId[] {
  switch (instr.kind) {
    case "const":
      return [];
    case "call":
      return instr.args;
    case "intrinsic":
      return instr.args;
    case "global.get":
      return [];
    case "global.set":
      return [instr.value];
    case "binary":
      return [instr.lhs, instr.rhs];
    case "unary":
      return [instr.rand];
    case "select":
      return [instr.condition, instr.whenTrue, instr.whenFalse];
    case "if":
      // (#1392) The arm buffers are emission-internal — their SSA defs
      // and uses live within their own scope (analogous to forof.vec /
      // try). Surface only the `cond` for the straight-line walk;
      // `thenValue` / `elseValue` are arm-internal too. The lowerer
      // walks the arms separately when emitting Wasm if/else.
      return [instr.cond];
    case "raw.wasm":
      return [];
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number":
      return [instr.value];
    case "dyn.eq":
      return [instr.lhs, instr.rhs];
    case "dyn.member_get":
      return [instr.recv, instr.key];
    case "dyn.member_set":
      return [instr.recv, instr.key, instr.value];
    case "string.const":
      return [];
    case "string.concat":
    case "string.eq":
      return [instr.lhs, instr.rhs];
    case "string.len":
      return [instr.value];
    case "string.char_at":
    case "string.char_code_at":
      return [instr.value, instr.index];
    case "object.new":
      return instr.values;
    case "object.get":
      return [instr.value];
    case "object.set":
      return [instr.value, instr.newValue];
    // Slice 3 (#1169c): closure / ref-cell ops. The verifier counts
    // `callee` once for closure.call (SSA def→use accounting) — the
    // lowerer adds the second count to force a Wasm local for the
    // double-emission pattern.
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
    case "class.super_init":
      return [...instr.args, instr.self];
    case "class.super_call":
      return [instr.receiver, ...instr.args];
    case "class.get":
      return [instr.value];
    case "class.set":
      return [instr.value, instr.newValue];
    case "class.call":
      return [instr.receiver, ...instr.args];
    case "class.instanceof":
      return [instr.value];
    case "class.static_call":
      return instr.args;
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return [];
    case "slot.write":
      return [instr.value];
    case "vec.len":
      return [instr.vec];
    case "vec.get":
      return [instr.vec, instr.index];
    case "vec.set":
      return [instr.vec, instr.index, instr.newValue];
    case "vec.set_length":
      return [instr.vec, instr.length];
    case "vec.new_fixed":
      // #1804 — every element is an SSA use (like object.new's values).
      return instr.elements;
    case "forof.vec":
      // The body executes inside a Wasm loop and is not part of the
      // straight-line use-before-def walk. We only surface `vec` here so
      // its def→use relation is tracked by the verifier and by the
      // cross-block use counter in the lowerer.
      return [instr.vec];
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
    case "forof.iter":
      // Same rationale as forof.vec: body is loop-internal, only the
      // iterable surfaces in the straight-line walk.
      return [instr.iterable];
    // Slice 7a (#1169f): generator ops.
    case "gen.push":
      return [instr.value];
    case "gen.epilogue":
      // No SSA operand uses — buffer + pendingThrow are read from Wasm
      // locals (slot indices stored on the IrFunction).
      return [];
    // Slice 7b (#1169f): yield* delegation.
    case "gen.yieldStar":
      return [instr.inner];
    // #2951 — generator `return <value>` stash.
    case "gen.setReturn":
      return [instr.value];
    // Slice 6 part 4 (#1183) — string for-of.
    case "forof.string":
      return [instr.str];
    // Slice 9 (#1169h) — exception handling. Body / catch / finally uses
    // are loop-internal (analogous to forof.vec) and are not surfaced
    // in the straight-line use-before-def walk.
    case "throw":
      return [instr.value];
    case "try":
      return [];
    // Slice 10 (#1169i) — extern class ops.
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
    // Slice 12 (#1280): while.loop / for.loop. Buffer-internal uses
    // are not surfaced here (mirrors forof.* convention) — the verify
    // pass walks them via its own buffer recursion if any.
    case "while.loop":
    case "for.loop":
      return [instr.condValue];
    // #2952 slice 2 — br.label has no SSA operands; if.stmt surfaces only
    // its cond (arm-buffer uses are walked via the buffer recursion).
    case "br.label":
      return [];
    case "if.stmt":
      return [instr.cond];
    // #2952 slice 4 — labeled.block has no operands; switch surfaces only
    // its disc (clause buffers are walked via the buffer recursion).
    case "labeled.block":
      return [];
    case "switch":
      return [instr.disc];
    // (#1373 Phase B) Async / await IR nodes — type-only in this slice.
    // The verifier sees their operands as plain SSA uses; lowering
    // (Phase C, #1373b) will define the per-arm SSA scope.
    case "await":
      return [instr.operand];
    case "async.return":
      return [instr.value];
    case "async.throw":
      return [instr.reason];
    // (#2856) early.return — the optional return value is a direct use.
    case "early.return":
      return instr.value !== null ? [instr.value] : [];
    // (#4070) Exhaustiveness gate. A new IR instruction kind added without a
    // case here is a COMPILE error at this line, not a runtime surprise at
    // claim time. The runtime arm is deliberately a throw rather than `[]`:
    // under-reporting an instruction's uses makes the verifier silently pass
    // an instruction it cannot see, which is the unsound direction for a
    // detector (it would report "nothing wrong" precisely when it cannot look).
    default: {
      const _exhaustive: never = instr;
      void _exhaustive;
      // invariant (producer-promise): the IrInstr union and this switch are
      // kept in agreement by the `never` assignment above, so reaching here
      // means a caller fabricated an instruction outside the union. Per #4035
      // /#4502 a bare `Error` classifies as `unexpected-internal-throw` (a hard
      // error), which is correct — this is not a capability gap to demote.
      throw new Error(
        `ir/verify: collectUses has no case for IR instruction kind ${(instr as { readonly kind: string }).kind}`,
      );
    }
  }
}

/**
 * Return the IrType of an SSA value within the given block context.
 * Scans params + earlier instructions (in any earlier block). Returns `null`
 * if the value isn't locally visible — the SSA-scope check reports that
 * separately, so we skip the type check silently.
 */
function operandIrType(
  func: IrFunction,
  block: IrBlock,
  v: IrValueId,
  _localDefs: ReadonlySet<IrValueId>,
): import("./nodes.js").IrType | null {
  for (const p of func.params) {
    if (p.value === v) return p.type;
  }
  // Scan all blocks — the SSA invariant allows earlier-defined values from
  // predecessor blocks to be used here. A full dominator check is Phase-3.
  // #1844: descend into nested if/try/loop/for-of buffers so a value defined
  // inside one of them (e.g. an `if`-arm result feeding a `return`) is found
  // here instead of returning `null` and silently bypassing the #1798
  // return-type assignability gate.
  let found: import("./nodes.js").IrType | null = null;
  for (const b of func.blocks) {
    for (const inst of b.instrs) {
      forEachInstrDeep(inst, (i) => {
        if (found === null && i.result === v && i.resultType) found = i.resultType;
      });
      if (found !== null) return found;
    }
  }
  // Block args of the containing block carry types in `blockArgTypes`.
  for (let i = 0; i < block.blockArgs.length; i++) {
    if (block.blockArgs[i] === v) return block.blockArgTypes[i] ?? null;
  }
  return null;
}

function operandValType(
  func: IrFunction,
  block: IrBlock,
  v: IrValueId,
  localDefs: ReadonlySet<IrValueId>,
): ValType | null {
  const t = operandIrType(func, block, v, localDefs);
  if (!t) return null;
  if (t.kind === "val") return t.val;
  return null;
}

// #1926 — `members` are IrTypes now; unwrap each `val`-kind member to its
// ValType and compare against the (scalar) `target` ValType. A non-`val`
// member can never match a scalar target, so it's skipped.
function unionContains(members: readonly IrType[], target: ValType): boolean {
  for (const irMember of members) {
    const m = asVal(irMember);
    if (!m) continue;
    if (m.kind !== target.kind) continue;
    if (m.kind === "ref" || m.kind === "ref_null") {
      if ((m as { typeIdx: number }).typeIdx !== (target as { typeIdx: number }).typeIdx) continue;
    }
    return true;
  }
  return false;
}

function collectTerminatorUses(block: IrBlock): readonly IrValueId[] {
  const t = block.terminator;
  switch (t.kind) {
    case "return":
      return t.values;
    case "br":
      return t.branch.args;
    case "br_if":
      return [t.condition, ...t.ifTrue.args, ...t.ifFalse.args];
    case "unreachable":
      return [];
  }
}

function checkBranchArity(
  func: IrFunction,
  from: IrBlock,
  toIdx: number,
  argCount: number,
  errors: IrVerifyError[],
): void {
  const target = func.blocks[toIdx];
  if (!target) {
    errors.push({
      message: `branch from block ${from.id as number} to nonexistent block ${toIdx}`,
      func: func.name,
      block: from.id as number,
    });
    return;
  }
  if (target.blockArgs.length !== argCount) {
    errors.push({
      message: `branch arity mismatch: block ${from.id as number} passes ${argCount} args to block ${toIdx} (expects ${target.blockArgs.length})`,
      func: func.name,
      block: from.id as number,
    });
  }
}

/**
 * #1924 — branch-arg type matching. `checkBranchArity` only compared lengths;
 * the passed values' types were never matched against the target block's
 * `blockArgTypes`, so a `br` that passes an f64 where the target expects an i32
 * block arg slipped through (the lowerer then emits a Wasm br with a mismatched
 * stack type). Fire only on a *definite* scalar-kind mismatch where both the
 * passed value's kind and the declared block-arg kind are known — unknown
 * types are skipped (conservative, mirrors the operand rules).
 */
function checkBranchArgTypes(
  func: IrFunction,
  from: IrBlock,
  toIdx: number,
  args: readonly IrValueId[],
  typeOf: ReadonlyMap<IrValueId, IrType>,
  errors: IrVerifyError[],
): void {
  const target = func.blocks[toIdx];
  if (!target) return; // arity check already reported the bad target
  const n = Math.min(args.length, target.blockArgTypes.length);
  for (let i = 0; i < n; i++) {
    const declared = target.blockArgTypes[i];
    if (!declared) continue;
    const declaredKind = asVal(declared)?.kind ?? null;
    if (declaredKind === null) continue; // non-scalar target arg — skip
    const passedKind = valKindOf(typeOf, args[i]!);
    if (passedKind === null) continue; // unknown passed type — skip
    if (passedKind !== declaredKind) {
      errors.push({
        message: `branch arg ${i} type mismatch: block ${from.id as number} passes ${passedKind} to block ${toIdx} arg (expects ${declaredKind})`,
        func: func.name,
        block: from.id as number,
      });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// #1924 — Instruction-level type rules.
//
// The verifier historically checked SSA scope, dominance, branch *arity*, the
// union trio, and return assignability — but NO per-instruction operand typing.
// `f64.add` over two i32 values, a `binary` whose denormalized `resultType`
// disagrees with the op's actual result, or a `slot.read` out of bounds all
// passed verification and only failed (or silently miscompiled) at the engine.
//
// These rules consult the per-function def→IrType map (`buildDefTypeMap`, built
// once — keeps verify O(n)) and fire ONLY on a *definite* mismatch: the operand
// (or result) type is KNOWN and its `ValType.kind` contradicts the op's
// contract. Unknown / null types are skipped (a value whose def carries no
// `resultType`), exactly like `operandIrType`'s conservative contract — so a
// real program never demotes on a missing annotation, only on a genuine type
// error. A fired rule pushes a verify error, which demotes the function to the
// legacy path (integration.ts), so the bar for firing is "provably wrong".
// ───────────────────────────────────────────────────────────────────────────

/** ValType.kind of a value, or null if unknown / not a single `val` IrType. */
function valKindOf(typeOf: ReadonlyMap<IrValueId, IrType>, v: IrValueId): ValType["kind"] | null {
  const t = typeOf.get(v);
  if (!t) return null;
  const av = asVal(t);
  return av ? av.kind : null;
}

/** The Wasm scalar kind an `IrBinop` produces, or null if not a fixed scalar. */
function binopResultKind(op: import("./nodes.js").IrBinop): ValType["kind"] | null {
  // f64 arithmetic → f64; every comparison / logical / i32 op → i32.
  switch (op) {
    case "f64.add":
    case "f64.sub":
    case "f64.mul":
    case "f64.div":
    case "f64.copysign":
      return "f64";
    // js.bit* result is f64 by default but may be narrowed to i32 (Stage 3) —
    // both are valid, so it has no single fixed result kind. Return null to
    // skip result-kind validation for these (operand rule still applies).
    case "js.bitand":
    case "js.bitor":
    case "js.bitxor":
    case "js.shl":
    case "js.shr_s":
    case "js.shr_u":
      return null;
    // (#3758) native i32 arithmetic — genuine i32 values (not bool), but the
    // `ValType.kind` is still "i32" like every other i32-domain binop below.
    case "i32.add":
    case "i32.sub":
    case "i32.mul":
    case "i64.rem_s":
      return op === "i64.rem_s" ? "i64" : "i32";
    default:
      // All remaining binops are comparisons / i32 logical → i32 (bool).
      return "i32";
  }
}

/**
 * Expected operand `ValType.kind`s for an `IrBinop`, or null if the op accepts
 * mixed/!either domains (js.bit* takes i32 OR f64 per the lowerer's Stage-3
 * fast path, so we don't constrain it).
 */
function binopOperandKind(op: import("./nodes.js").IrBinop): ValType["kind"] | null {
  if (op.startsWith("f64.")) return "f64";
  if (op.startsWith("i32.")) return "i32";
  if (op.startsWith("i64.")) return "i64";
  // js.bit* — operands may be i32 or f64; no single required kind.
  return null;
}

/** The Wasm scalar kind an `IrUnop` produces, or null if not a fixed scalar. */
function unopResultKind(op: import("./nodes.js").IrUnop): ValType["kind"] | null {
  switch (op) {
    case "f64.neg":
    case "f64.reinterpret_i64":
    // (#3168) boolean → f64 ToNumber for unary `+`/`-`.
    case "f64.convert_i32_s":
    case "f64.convert_i64_s":
      return "f64";
    case "i32.eqz":
    case "ref.is_null":
      return "i32";
    case "i32.trunc_sat_f64_s":
      return "i32";
    case "i64.trunc_f64_s":
      return "i64";
    default:
      return op === "i64.reinterpret_f64" ? "i64" : null;
  }
}

/** Expected operand kind for an `IrUnop`, or null if unconstrained. */
function unopOperandKind(op: import("./nodes.js").IrUnop): ValType["kind"] | null {
  switch (op) {
    case "f64.neg":
    case "i32.trunc_sat_f64_s":
    case "i64.trunc_f64_s":
      return "f64";
    case "f64.reinterpret_i64":
      return "i64";
    case "i32.eqz":
    // (#3168) the boolean-ToNumber conversion consumes the i32 0/1.
    case "f64.convert_i32_s":
      return "i32";
    case "f64.convert_i64_s":
      return "i64";
    // ref.is_null takes a ref/externref/funcref — not a fixed scalar; skip.
    default:
      return op === "i64.reinterpret_f64" ? "f64" : null;
  }
}

/**
 * (#4603) The Wasm scalar kind a `const` literal materializes, or `null` when
 * the literal is reference-shaped and carries its own IrType.
 *
 * Derived from `emitConstInstr` in `lower.ts`, the single const-lowering
 * implementation: `bool` pushes `i32.const 0/1`, so its carrier is `i32`, not
 * a distinct Wasm type. `null` carries an explicit `ty` and `undefined` is
 * never materialized as a value by Phase 1 lowering, so neither constrains a
 * scalar `resultType`.
 */
function constResultKind(v: import("./nodes.js").IrConst): ValType["kind"] | null {
  switch (v.kind) {
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f32":
      return "f32";
    case "f64":
      return "f64";
    case "bool":
      // `emitConstInstr` lowers bool to `i32.const` — the boolean brand is a
      // value-domain fact on top of the same i32 carrier (`boolean-brand.ts`).
      return "i32";
    default:
      return null;
  }
}

/**
 * (#4603) A stable structural key for an `IrGlobalRef` / `IrFuncRef` binding.
 *
 * The IR resolves globals and callables LAZILY through symbolic refs — neither
 * `IrModule` nor `IrFunction` carries a declared-type table (see `IrModule`,
 * which holds only `functions`). So the verifier cannot compare a `global.get`
 * against "the global's declared IrType": no such record is in scope. What IS
 * in scope is every OTHER reference to the same binding in the same function,
 * which must agree — that intra-function coherence rule is what `global.get` /
 * `global.set` get here. `name` is explicitly a debug label and never the
 * identity, so the key is built from the binding discriminant alone.
 */
function bindingKey(binding: unknown): string | null {
  if (!isRecord(binding)) return null;
  const kind = binding.kind;
  if (typeof kind !== "string") return null;
  const id = binding.bindingId ?? binding.unitId ?? binding.symbol;
  if (typeof id === "string") return `${kind}:${id}`;
  if (kind === "import" && typeof binding.module === "string" && typeof binding.field === "string") {
    return `import:${binding.module}:${binding.field}`;
  }
  return null;
}

/**
 * Per-kind type-rule coverage status (#4523). `"checked"` means `checkInstr`
 * below has a `case` arm implementing a real type rule for that kind; a
 * `{ skip }` entry records WHY the kind has no rule *in `checkInstr`*, using
 * one of five categories (see `TYPE_RULE_CATEGORIES`).
 *
 * This is a `Record` over the `IrInstr["kind"]` union ON PURPOSE — it is the
 * compile-time half of the hybrid policy decided in #4523:
 *
 *   - a NEW `IrInstr` kind fails `pnpm run typecheck` until its author
 *     classifies it here (opt-out for new kinds), and
 *   - DELETING an existing `checkInstr` case makes the instr fall through to
 *     the `default:` arm, which sees `"checked"` and pushes a verifier error
 *     (loud failure for rule removal), and
 *   - the 62 non-`"checked"` kinds stay an explicit, reasoned baseline rather
 *     than 62 empty `case` arms (opt-in stays for the legacy set).
 *
 * `rule-worth-adding:` IS the roadmap denominator — those are the kinds with
 * NO type rule anywhere in this file today and a real, derivable one available
 * from data already on the instruction.
 *
 * Keep this map adjacent to `checkInstr`: they are two halves of one contract.
 */
export type TypeRuleStatus = "checked" | { readonly skip: string };

/**
 * The five triage categories (#4523). A skip reason MUST start with one of
 * these followed by `": "` — `typeRuleCategoryOf` parses the prefix and the
 * coverage test pins the per-category counts.
 *
 *   - `structural`        — no typed value operands at all (labels, buffers,
 *                           literals); the def-use/scope walk is already total.
 *   - `checked-elsewhere` — a real type rule for this kind already runs in
 *                           this file, just not inside `checkInstr`.
 *   - `resolver-typed`    — the operand/result carrier is chosen at lowering
 *                           from data NOT on the instruction; nothing for the
 *                           mid-end to check.
 *   - `dynamic-by-design` — operates on boxed/host values that carry no
 *                           static type constraint.
 *   - `rule-worth-adding` — no rule today, a real one is derivable. Roadmap.
 */
export const TYPE_RULE_CATEGORIES = [
  "structural",
  "checked-elsewhere",
  "resolver-typed",
  "dynamic-by-design",
  "rule-worth-adding",
] as const;

export type TypeRuleCategory = (typeof TYPE_RULE_CATEGORIES)[number];

/** Parse the category prefix off a `{ skip }` reason. `"checked"` → null. */
export function typeRuleCategoryOf(status: TypeRuleStatus): TypeRuleCategory | null {
  if (status === "checked") return null;
  const head = status.skip.slice(0, status.skip.indexOf(":"));
  return (TYPE_RULE_CATEGORIES as readonly string[]).includes(head) ? (head as TypeRuleCategory) : null;
}

export const TYPE_RULE_STATUS: Record<IrInstr["kind"], TypeRuleStatus> = {
  // --- checked here (32 — 16 from #4523, +16 from #4603) -----------------
  binary: "checked",
  intrinsic: "checked",
  "slot.read": "checked",
  "slot.write": "checked",
  "string.char_at": "checked",
  "string.char_code_at": "checked",
  "string.concat": "checked",
  "string.const": "checked",
  "string.eq": "checked",
  "string.len": "checked",
  unary: "checked",
  "vec.get": "checked",
  "vec.len": "checked",
  "vec.new_fixed": "checked",
  "vec.set": "checked",
  "vec.set_length": "checked",

  // --- checked-elsewhere (13) --------------------------------------------
  // `verifyInstrStructure` owns these: it needs `operandIrType` (a whole-
  // function scan) plus the block/localDefs walk state, which `checkInstr`
  // does not have. Re-implementing them here would duplicate, not add.
  box: { skip: "checked-elsewhere: union-membership + no-re-box rules in verifyInstrStructure (#2949 R1)" },
  unbox: {
    skip: "checked-elsewhere: dynamic-operand tagId + payload-kind rules in verifyInstrStructure (#2949 R2/R3)",
  },
  "tag.test": { skip: "checked-elsewhere: shares unbox's dynamic-operand tagId rules in verifyInstrStructure (#2949)" },
  "dyn.truthy": { skip: "checked-elsewhere: operand-must-be-dynamic rule in verifyInstrStructure (#2949 S5.1)" },
  "dyn.to_number": { skip: "checked-elsewhere: operand-must-be-dynamic rule in verifyInstrStructure (#2949 S5.3)" },
  "dyn.eq": { skip: "checked-elsewhere: both-operands-dynamic rule in verifyInstrStructure (#2949 S5.2)" },
  "dyn.member_get": { skip: "checked-elsewhere: recv/key/result all-dynamic rules in verifyInstrStructure (#3053 U1)" },
  "dyn.member_set": {
    skip: "checked-elsewhere: recv/key/value dynamic + void-result rules in verifyInstrStructure (#3795)",
  },
  "while.loop": { skip: "checked-elsewhere: condValue-must-be-i32 rule in verifyInstrStructure (#1980)" },
  "for.loop": { skip: "checked-elsewhere: condValue-must-be-i32 rule in verifyInstrStructure (#1980)" },
  "if.stmt": { skip: "checked-elsewhere: cond-must-be-i32 rule in verifyInstrStructure (#2952 slice 2)" },
  switch: {
    skip: "checked-elsewhere: disc i32/f64 + parallel-arrays + single-default in verifyInstrStructure; discSlot bound is a residual gap",
  },

  // --- structural (5) ----------------------------------------------------
  // No typed value operands whatsoever — the def-use walk and the label-scope
  // walk are already total over these, so a type rule has nothing to bind to.
  try: { skip: "structural: buffers only; payloadSlot bound is a residual gap" },
  "br.label": {
    skip: "structural: label + mode literals, no value operands; label binding enforced in the scope walk (#2952 slice 2)",
  },
  "labeled.block": { skip: "structural: label + body buffer, no value operands" },
  "gen.epilogue": { skip: "structural: no value operands; only an optional provider ref" },
  "extern.regex": { skip: "structural: pattern/flags are string literals, no value operands" },

  // --- resolver-typed (23) -----------------------------------------------
  // The operand/result carrier is decided at lowering from data that is NOT
  // on the instruction (a shape, a signature, an iterator protocol, the CPS
  // transform). The mid-end cannot derive the expected type to compare against.
  "raw.wasm": { skip: "resolver-typed: opaque backend op sequence; only stackDelta is mid-end-visible" },
  "object.get": { skip: "resolver-typed: field type comes from the receiver's shape at lowering, not from the instr" },
  "object.set": { skip: "resolver-typed: field type comes from the receiver's shape at lowering, not from the instr" },
  "closure.cap": { skip: "resolver-typed: capture slot type comes from the closure signature at lowering" },
  "closure.call": { skip: "resolver-typed: callee signature is resolved from the closure value at lowering" },
  "refcell.new": { skip: "resolver-typed: cell struct type is allocated by the resolver at lowering" },
  "refcell.get": { skip: "resolver-typed: payload type comes from the cell's resolver-allocated struct" },
  "refcell.set": { skip: "resolver-typed: payload type comes from the cell's resolver-allocated struct" },
  "class.super_call": { skip: "resolver-typed: method signature resolved from parentShape + methodName at lowering" },
  "class.get": { skip: "resolver-typed: field type comes from the receiver's class shape at lowering" },
  "class.set": { skip: "resolver-typed: field type comes from the receiver's class shape at lowering" },
  "class.call": { skip: "resolver-typed: method signature resolved from the receiver's shape at lowering" },
  "class.static_call": { skip: "resolver-typed: static method signature resolved from shape + methodName at lowering" },
  "iter.new": { skip: "resolver-typed: iterator carrier chosen by the iteration-protocol lowering" },
  "iter.next": { skip: "resolver-typed: result object carrier chosen by the iteration-protocol lowering" },
  "iter.value": { skip: "resolver-typed: yielded value type is whatever the iterator produces (boxed at lowering)" },
  "iter.return": { skip: "resolver-typed: early-exit protocol call, carrier chosen at lowering" },
  "gen.push": { skip: "resolver-typed: queue element carrier chosen by the generator lowering" },
  "gen.yieldStar": { skip: "resolver-typed: delegation carrier chosen by the generator lowering" },
  "gen.setReturn": { skip: "resolver-typed: return-slot carrier chosen by the generator lowering" },
  await: { skip: "resolver-typed: #1373 Phase B is type-only; the CPS transform picks the carrier" },
  "async.return": { skip: "resolver-typed: #1373 Phase B is type-only; the CPS transform picks the carrier" },
  "async.throw": { skip: "resolver-typed: #1373 Phase B is type-only; the CPS transform picks the carrier" },

  // --- dynamic-by-design (5) ---------------------------------------------
  // Boxed / host values that carry no static type constraint to check.
  throw: { skip: "dynamic-by-design: the thrown value is any JS value on the boxed carrier" },
  "extern.new": {
    skip: "dynamic-by-design: host constructor args are externref-boxed, no static arity/type available",
  },
  "extern.call": { skip: "dynamic-by-design: host method args are externref-boxed, no static signature available" },
  "extern.prop": { skip: "dynamic-by-design: host property read, result is externref by construction" },
  "extern.propSet": { skip: "dynamic-by-design: host property write, value is externref-boxed" },

  // --- #4523's rule-worth-adding roadmap, retired by #4603 ---------------
  // 16 of the 17 kinds now carry a real rule in `checkInstr`. The 17th
  // (`early.return`) turned out to be checked already — see below.
  const: "checked",
  call: "checked",
  "global.get": "checked",
  "global.set": "checked",
  select: "checked",
  if: "checked",
  "object.new": "checked",
  "closure.new": "checked",
  "class.new": "checked",
  "class.super_init": "checked",
  "class.instanceof": "checked",
  "coerce.to_externref": "checked",
  "iter.done": "checked",
  "forof.vec": "checked",
  "forof.iter": "checked",
  "forof.string": "checked",
  // (#4603) NOT a rule-worth-adding gap — a MISCLASSIFICATION in #4523's
  // triage. `verifyIrFunction` has walked every `early.return` since #2856
  // and applied exactly the rule the old skip reason described (arity vs
  // `func.resultTypes`, then `returnTypeAssignable`), carrying the `demote`
  // flag that marks it a designed demote-to-legacy signal. Re-implementing it
  // in `checkInstr` would double-report every violation and would lose the
  // `demote` flag, promoting a demotion into a hard invariant.
  "early.return": {
    skip: "checked-elsewhere: arity + returnTypeAssignable vs func.resultTypes in verifyIrFunction, with the #1798/#2856 demote flag",
  },
};

/**
 * The `default:` arm's decision (#4523), factored out so a test can exercise
 * every branch without a synthetic `IrInstr` and without weakening the
 * production wiring — `checkInstr` calls exactly this function.
 *
 * Returns the verifier-error message, or `null` when reaching `default:` is
 * legitimate (the kind carries a `{ skip }` reason).
 *
 * @param kind   the instruction kind that fell through to `default:`
 * @param status that kind's entry in `TYPE_RULE_STATUS`
 */
export function typeRuleCoverageProblem(kind: IrInstr["kind"], status: TypeRuleStatus | undefined): string | null {
  if (status === undefined) {
    return `type-rule status missing for '${kind}' — TYPE_RULE_STATUS is out of sync with the IrInstr union (#4523)`;
  }
  if (status === "checked") {
    return `type-rule missing for '${kind}' — TYPE_RULE_STATUS says checked, but no checkInstr case handled it (#4523)`;
  }
  return null;
}

/**
 * Walk every instruction (incl. nested buffers) once and apply the per-kind
 * type rules. `typeOf` is the precomputed def→IrType map.
 *
 * Coverage policy and the map that pins it: see `TYPE_RULE_STATUS` above.
 */
/**
 * (#4603) Shared state for the rules that retired #4523's `rule-worth-adding`
 * bucket. Most are pure per-instruction checks, but the three symbolic-ref
 * kinds (`call`, `global.get`, `global.set`) compare each reference against
 * the others in the SAME function, so the walk carries their state here.
 */
interface RoadmapRuleCtx {
  readonly func: IrFunction;
  readonly typeOf: ReadonlyMap<IrValueId, IrType>;
  readonly errors: IrVerifyError[];
  /** `func.slots.length` — the bound every `forof.*` slot index must respect. */
  readonly numSlots: number;
  readonly callSignatures: Map<string, { arity: number; resultKind: ValType["kind"] | null }>;
  readonly globalKinds: Map<string, { kind: ValType["kind"]; via: "global.get" | "global.set" }>;
}

/** Kinds whose rule is a fixed or self-declared carrier on the instr itself. */
type RoadmapCarrierInstr = Extract<
  IrInstr,
  { kind: "const" | "select" | "if" | "class.instanceof" | "iter.done" | "coerce.to_externref" }
>;

/** Kinds whose rule compares a value LIST against a declaration on the instr. */
type RoadmapAggregateInstr = Extract<
  IrInstr,
  {
    kind: "object.new" | "closure.new" | "class.new" | "class.super_init" | "forof.vec" | "forof.iter" | "forof.string";
  }
>;

/** Kinds that resolve through a symbolic ref with no declared type in scope. */
type RoadmapSymbolicInstr = Extract<IrInstr, { kind: "call" | "global.get" | "global.set" }>;

function roadmapError(ctx: RoadmapRuleCtx, blockId: number, message: string): void {
  ctx.errors.push({ message, func: ctx.func.name, block: blockId });
}

/**
 * (#4603) Dispatch for the 16 kinds this issue moved out of
 * `rule-worth-adding`. Returns `true` when a rule owned the kind, so
 * `checkInstr` can skip its own switch.
 *
 * These live outside `checkInstr` only to keep both functions inside the
 * per-function LOC budget (#3399); the coverage contract is unchanged. Delete
 * an arm below and the kind falls through to `checkInstr`'s `default:`, which
 * still sees `"checked"` in `TYPE_RULE_STATUS` and reports the desync — the
 * same loud failure #4523 wired up.
 */
function checkRoadmapRule(instr: IrInstr, blockId: number, ctx: RoadmapRuleCtx): boolean {
  switch (instr.kind) {
    case "const":
    case "select":
    case "if":
    case "class.instanceof":
    case "iter.done":
    case "coerce.to_externref":
      checkRoadmapCarrierRule(instr, blockId, ctx);
      return true;
    case "object.new":
    case "closure.new":
    case "class.new":
    case "class.super_init":
    case "forof.vec":
    case "forof.iter":
    case "forof.string":
      checkRoadmapAggregateRule(instr, blockId, ctx);
      return true;
    case "call":
    case "global.get":
    case "global.set":
      checkSymbolicRefCoherence(instr, blockId, ctx);
      return true;
    default:
      return false;
  }
}

/** #4603 — fixed / self-declared result carriers, and the two cond rules. */
function checkRoadmapCarrierRule(instr: RoadmapCarrierInstr, blockId: number, ctx: RoadmapRuleCtx): void {
  const { typeOf } = ctx;
  switch (instr.kind) {
    case "const": {
      // The literal decides the carrier; `resultType` only annotates it.
      const want = constResultKind(instr.value);
      if (want === null || instr.result === null || !instr.resultType) return;
      const got = asVal(instr.resultType)?.kind ?? null;
      if (got !== null && got !== want) {
        roadmapError(ctx, blockId, `const ${instr.value.kind} resultType must be ${want}, got ${got}`);
      }
      return;
    }
    case "select": {
      // Wasm `select` pops [whenTrue, whenFalse, cond] — cond is i32, and both
      // arms must carry the same type as the pushed result.
      const condKind = valKindOf(typeOf, instr.condition);
      if (condKind !== null && condKind !== "i32") {
        roadmapError(ctx, blockId, `select condition must be i32, got ${condKind}`);
      }
      checkArmsAgainstResult(
        "select",
        [
          ["whenTrue", instr.whenTrue],
          ["whenFalse", instr.whenFalse],
        ],
        instr.resultType,
        blockId,
        ctx,
      );
      return;
    }
    case "if": {
      // (#1392) Short-circuiting value-producing if/else. `if.stmt` already has
      // the cond rule in `verifyInstrStructure`; this is its value dual. Each
      // arm carrier leaves the Wasm `if (result T)` block's value, so each must
      // match `resultType`.
      const condKind = valKindOf(typeOf, instr.cond);
      if (condKind !== null && condKind !== "i32") {
        roadmapError(ctx, blockId, `if cond must be i32, got ${condKind}`);
      }
      checkArmsAgainstResult(
        "if",
        [
          ["thenValue", instr.thenValue],
          ["elseValue", instr.elseValue],
        ],
        instr.resultType,
        blockId,
        ctx,
      );
      return;
    }
    case "class.instanceof":
    case "iter.done": {
      // Both produce a JS boolean on the i32 carrier — fixed, no lookup.
      if (instr.result === null || !instr.resultType) return;
      const got = asVal(instr.resultType)?.kind ?? null;
      if (got !== null && got !== "i32") {
        roadmapError(ctx, blockId, `${instr.kind} resultType must be i32 (bool), got ${got}`);
      }
      return;
    }
    default: {
      // `coerce.to_externref` — normally externref. The explicit
      // closure-boundary pack reuses this representation op with a `callable`
      // resultType, which also lowers to externref, so both spellings are
      // valid and nothing else is.
      const rt = instr.resultType;
      if (instr.result === null || rt === null || rt.kind === "callable") return;
      const got = asVal(rt)?.kind ?? null;
      if (got !== null && got !== "externref") {
        roadmapError(ctx, blockId, `coerce.to_externref resultType must be externref or a callable, got ${got}`);
      }
    }
  }
}

/** Shared by `select` / `if`: each arm carrier must match `resultType`. */
function checkArmsAgainstResult(
  kind: "select" | "if",
  arms: readonly (readonly [string, IrValueId])[],
  resultType: IrType | null,
  blockId: number,
  ctx: RoadmapRuleCtx,
): void {
  const want = resultType ? (asVal(resultType)?.kind ?? null) : null;
  if (want === null) return;
  for (const [label, v] of arms) {
    const k = valKindOf(ctx.typeOf, v);
    if (k !== null && k !== want) {
      roadmapError(ctx, blockId, `${kind} ${label} must be ${want} (the resultType), got ${k} (value ${v})`);
    }
  }
}

/**
 * #4603 — a value LIST checked against a declaration carried by the same
 * instruction (a shape's fields / constructor params, a closure's capture
 * field types), plus the `forof.*` loop-state slot bounds.
 */
function checkRoadmapAggregateRule(instr: RoadmapAggregateInstr, blockId: number, ctx: RoadmapRuleCtx): void {
  switch (instr.kind) {
    case "object.new": {
      // `values` is parallel to `shape.fields` — both are ON the instr, so the
      // arity and the per-field carrier are fully derivable here.
      if (instr.values.length !== instr.shape.fields.length) {
        roadmapError(
          ctx,
          blockId,
          `object.new value count ${instr.values.length} != shape field count ${instr.shape.fields.length}`,
        );
        return;
      }
      for (let i = 0; i < instr.values.length; i++) {
        const field = instr.shape.fields[i]!;
        checkDeclaredCarrier(field.type, instr.values[i]!, `object.new value for field '${field.name}'`, blockId, ctx);
      }
      return;
    }
    case "closure.new": {
      if (instr.captures.length !== instr.captureFieldTypes.length) {
        roadmapError(
          ctx,
          blockId,
          `closure.new capture count ${instr.captures.length} != captureFieldTypes count ${instr.captureFieldTypes.length}`,
        );
        return;
      }
      for (let i = 0; i < instr.captures.length; i++) {
        checkDeclaredCarrier(instr.captureFieldTypes[i]!, instr.captures[i]!, `closure.new capture ${i}`, blockId, ctx);
      }
      return;
    }
    case "class.new":
    case "class.super_init": {
      // The constructor signature lives on the shape carried BY the instr
      // (`shape` for a `new`, `parentShape` for a derived `super(...)`).
      const shape = instr.kind === "class.new" ? instr.shape : instr.parentShape;
      const declared = shape.constructorParams;
      if (instr.args.length !== declared.length) {
        roadmapError(
          ctx,
          blockId,
          `${instr.kind} arg count ${instr.args.length} != constructor arity ${declared.length} (class ${shape.className})`,
        );
        return;
      }
      for (let i = 0; i < instr.args.length; i++) {
        checkDeclaredCarrier(
          declared[i]!,
          instr.args[i]!,
          `${instr.kind} arg ${i}`,
          blockId,
          ctx,
          ` (class ${shape.className})`,
        );
      }
      return;
    }
    default:
      checkForOfSlots(instr, blockId, ctx);
  }
}

/** One declared-vs-actual carrier comparison, skipped unless both are known. */
function checkDeclaredCarrier(
  declared: IrType,
  value: IrValueId,
  label: string,
  blockId: number,
  ctx: RoadmapRuleCtx,
  suffix = "",
): void {
  const want = asVal(declared)?.kind ?? null;
  const got = valKindOf(ctx.typeOf, value);
  if (want !== null && got !== null && got !== want) {
    roadmapError(ctx, blockId, `${label} must be ${want}, got ${got}${suffix}`);
  }
}

/**
 * #4603 — every `forof.*` pre-allocates its loop state in `func.slots`, and the
 * lowerer emits a bare `local.get`/`local.set` per index, so an out-of-range
 * index is invalid Wasm exactly like a bad `slot.read`.
 */
function checkForOfSlots(
  instr: Extract<IrInstr, { kind: "forof.vec" | "forof.iter" | "forof.string" }>,
  blockId: number,
  ctx: RoadmapRuleCtx,
): void {
  const slots: readonly (readonly [string, number])[] =
    instr.kind === "forof.vec"
      ? [
          ["counterSlot", instr.counterSlot],
          ["lengthSlot", instr.lengthSlot],
          ["vecSlot", instr.vecSlot],
          ["dataSlot", instr.dataSlot],
          ["elementSlot", instr.elementSlot],
        ]
      : instr.kind === "forof.string"
        ? [
            ["counterSlot", instr.counterSlot],
            ["lengthSlot", instr.lengthSlot],
            ["strSlot", instr.strSlot],
            ["elementSlot", instr.elementSlot],
          ]
        : [
            ["iterSlot", instr.iterSlot],
            ["resultSlot", instr.resultSlot],
            ["elementSlot", instr.elementSlot],
          ];
  for (const [label, idx] of slots) {
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= ctx.numSlots) {
      roadmapError(ctx, blockId, `${instr.kind} ${label} ${idx} out of bounds (function has ${ctx.numSlots} slots)`);
    }
  }
  if (instr.kind !== "forof.vec") return;
  // The element carrier is read straight out of the vec's backing array, so a
  // divergent `elementType` mis-types every body use.
  const vecType = ctx.typeOf.get(instr.vec);
  if (vecType?.kind === "vec" && !irTypeEquals(instr.elementType, vecType.elementType)) {
    roadmapError(
      ctx,
      blockId,
      `forof.vec elementType ${describeKind(instr.elementType)} does not match the vec's element type ${describeKind(vecType.elementType)}`,
    );
  }
}

/**
 * #4603 — coherence, NOT declaration-matching, for the three symbolic-ref
 * kinds.
 *
 * The IR resolves globals and callables lazily through symbolic refs, and
 * neither `IrModule` (which holds only `functions`) nor `IrFunction` carries a
 * declared-type table — so "must match the global's declared IrType" has
 * nothing in scope to match against. What IS in scope is every other reference
 * to the same binding in the same function: those must agree, and a
 * disagreement is a producer bug.
 */
function checkSymbolicRefCoherence(instr: RoadmapSymbolicInstr, blockId: number, ctx: RoadmapRuleCtx): void {
  const key = bindingKey(instr.target.binding);
  if (key === null) return; // malformed ref — `verifySymbolicReferences` owns it
  if (instr.kind === "call") {
    const resultKind = instr.resultType ? (asVal(instr.resultType)?.kind ?? null) : null;
    const seen = ctx.callSignatures.get(key);
    if (seen === undefined) {
      ctx.callSignatures.set(key, { arity: instr.args.length, resultKind });
      return;
    }
    if (seen.arity !== instr.args.length) {
      roadmapError(
        ctx,
        blockId,
        `call ${instr.target.name} arity ${instr.args.length} disagrees with ${seen.arity} used elsewhere in this function`,
      );
    }
    if (seen.resultKind !== null && resultKind !== null && seen.resultKind !== resultKind) {
      roadmapError(
        ctx,
        blockId,
        `call ${instr.target.name} resultType ${resultKind} disagrees with ${seen.resultKind} used elsewhere in this function`,
      );
    }
    return;
  }
  const observed =
    instr.kind === "global.get"
      ? instr.resultType
        ? (asVal(instr.resultType)?.kind ?? null)
        : null
      : valKindOf(ctx.typeOf, instr.value);
  if (observed === null) return;
  const seen = ctx.globalKinds.get(key);
  if (seen === undefined) {
    ctx.globalKinds.set(key, { kind: observed, via: instr.kind });
    return;
  }
  if (seen.kind !== observed) {
    roadmapError(
      ctx,
      blockId,
      `${instr.kind} ${instr.target.name} carrier ${observed} disagrees with ${seen.kind} used by ${seen.via} elsewhere in this function`,
    );
  }
}

function verifyInstrTypeRules(func: IrFunction, typeOf: ReadonlyMap<IrValueId, IrType>, errors: IrVerifyError[]): void {
  const numSlots = func.slots?.length ?? 0;

  // #2949 R4 — a dynamic-typed value may only feed box/unbox/tag.test, moves
  // (locals/params/block args/branch args/slots), calls/returns with dynamic
  // signatures, and dynamic-aware ops added by later slices. Every scalar
  // binary/unary op requires an explicit `unbox` first — feeding the boxed
  // carrier to e.g. `f64.add` is provably invalid Wasm. `valKindOf` returns
  // null for dynamic (it is not a `val` kind), which would silently SKIP the
  // kind rule below, so the dynamic case needs this explicit check.
  const isDynamicValue = (v: IrValueId): boolean => typeOf.get(v)?.kind === "dynamic";

  // (#4603) The 16 kinds this issue moved out of `rule-worth-adding` are ruled
  // by `checkRoadmapRule`. The context also carries the intra-function
  // coherence state for the lazily-resolved symbolic refs: the first reference
  // to a binding records its shape and every later one must agree (see
  // `bindingKey` for why that — and not declaration-matching — is the
  // derivable rule for `call` / `global.get` / `global.set`).
  const roadmap: RoadmapRuleCtx = {
    func,
    typeOf,
    errors,
    numSlots,
    callSignatures: new Map(),
    globalKinds: new Map(),
  };

  const checkInstr = (instr: IrInstr, blockId: number): void => {
    if (checkRoadmapRule(instr, blockId, roadmap)) return;
    switch (instr.kind) {
      case "intrinsic": {
        for (const message of verifyIrIntrinsicInstruction(instr, typeOf)) {
          errors.push({ message, func: func.name, block: blockId });
        }
        break;
      }
      case "binary": {
        const want = binopOperandKind(instr.op);
        for (const [label, v] of [
          ["lhs", instr.lhs],
          ["rhs", instr.rhs],
        ] as const) {
          if (isDynamicValue(v)) {
            errors.push({
              message: `${instr.op} ${label} is dynamic — scalar ops require an explicit unbox (#2949) (value ${v})`,
              func: func.name,
              block: blockId,
            });
          }
        }
        if (want) {
          for (const [label, v] of [
            ["lhs", instr.lhs],
            ["rhs", instr.rhs],
          ] as const) {
            const k = valKindOf(typeOf, v);
            if (k !== null && k !== want) {
              errors.push({
                message: `${instr.op} ${label} must be ${want}, got ${k} (value ${v})`,
                func: func.name,
                block: blockId,
              });
            }
          }
        }
        // resultType must match the op's fixed result kind, when both known.
        const rk = binopResultKind(instr.op);
        if (rk !== null && instr.result !== null && instr.resultType) {
          const got = asVal(instr.resultType)?.kind ?? null;
          if (got !== null && got !== rk) {
            errors.push({
              message: `${instr.op} resultType must be ${rk}, got ${got}`,
              func: func.name,
              block: blockId,
            });
          }
        }
        break;
      }
      case "unary": {
        // #2949 R4 — see the binary case; unary scalar ops (and ref.is_null,
        // conservatively, until a slice needs it) reject dynamic operands.
        if (isDynamicValue(instr.rand)) {
          errors.push({
            message: `${instr.op} operand is dynamic — requires an explicit unbox (#2949) (value ${instr.rand})`,
            func: func.name,
            block: blockId,
          });
        }
        const want = unopOperandKind(instr.op);
        if (want) {
          const k = valKindOf(typeOf, instr.rand);
          if (k !== null && k !== want) {
            errors.push({
              message: `${instr.op} operand must be ${want}, got ${k} (value ${instr.rand})`,
              func: func.name,
              block: blockId,
            });
          }
        }
        const rk = unopResultKind(instr.op);
        if (rk !== null && instr.result !== null && instr.resultType) {
          const got = asVal(instr.resultType)?.kind ?? null;
          if (got !== null && got !== rk) {
            errors.push({
              message: `${instr.op} resultType must be ${rk}, got ${got}`,
              func: func.name,
              block: blockId,
            });
          }
        }
        break;
      }
      case "string.len":
      case "vec.len": {
        if (instr.result !== null && instr.resultType) {
          const got = asVal(instr.resultType)?.kind ?? null;
          const want = instr.kind === "vec.len" && instr.integer === true ? "i32" : "f64";
          if (got !== null && got !== want) {
            errors.push({
              message: `${instr.kind} resultType must be ${want} (length), got ${got}`,
              func: func.name,
              block: blockId,
            });
          }
        }
        break;
      }
      case "string.const":
      case "string.concat":
      case "string.char_at": {
        if (instr.result !== null && instr.resultType && instr.resultType.kind !== "string") {
          errors.push({
            message: `${instr.kind} resultType must be string, got ${instr.resultType.kind}`,
            func: func.name,
            block: blockId,
          });
        }
        if (instr.kind === "string.char_at") {
          const indexKind = valKindOf(typeOf, instr.index);
          if (indexKind !== null && indexKind !== "i32") {
            errors.push({
              message: `${instr.kind} index must be i32, got ${indexKind}`,
              func: func.name,
              block: blockId,
            });
          }
        }
        break;
      }
      case "string.char_code_at": {
        if (instr.result !== null && instr.resultType) {
          const got = asVal(instr.resultType)?.kind ?? null;
          if (got !== null && got !== "f64") {
            errors.push({
              message: `${instr.kind} resultType must be f64, got ${got}`,
              func: func.name,
              block: blockId,
            });
          }
        }
        const indexKind = valKindOf(typeOf, instr.index);
        if (indexKind !== null && indexKind !== "i32") {
          errors.push({
            message: `${instr.kind} index must be i32, got ${indexKind}`,
            func: func.name,
            block: blockId,
          });
        }
        break;
      }
      case "string.eq": {
        if (instr.result !== null && instr.resultType) {
          const got = asVal(instr.resultType)?.kind ?? null;
          if (got !== null && got !== "i32") {
            errors.push({
              message: `string.eq resultType must be i32 (bool), got ${got}`,
              func: func.name,
              block: blockId,
            });
          }
        }
        break;
      }
      case "vec.get":
      case "vec.set": {
        const indexKind = valKindOf(typeOf, instr.index);
        if (indexKind !== null && indexKind !== "i32") {
          errors.push({
            message: `${instr.kind} index must be i32, got ${indexKind}`,
            func: func.name,
            block: blockId,
          });
        }
        const vecType = typeOf.get(instr.vec);
        if (vecType?.kind === "vec") {
          if (instr.kind === "vec.get" && instr.resultType && !irTypeEquals(instr.resultType, vecType.elementType)) {
            errors.push({
              message: `vec.get result type ${describeKind(instr.resultType)} does not match element type ${describeKind(vecType.elementType)}`,
              func: func.name,
              block: blockId,
            });
          }
          if (instr.kind === "vec.set") {
            const valueType = typeOf.get(instr.newValue);
            if (valueType && !irTypeEquals(valueType, vecType.elementType)) {
              errors.push({
                message: `vec.set value type ${describeKind(valueType)} does not match element type ${describeKind(vecType.elementType)}`,
                func: func.name,
                block: blockId,
              });
            }
          }
        }
        break;
      }
      case "vec.set_length": {
        const lengthKind = valKindOf(typeOf, instr.length);
        if (lengthKind !== null && lengthKind !== "i32") {
          errors.push({
            message: `vec.set_length length must be i32, got ${lengthKind}`,
            func: func.name,
            block: blockId,
          });
        }
        break;
      }
      case "vec.new_fixed": {
        const capacity = instr.capacity ?? instr.elements.length;
        if (!Number.isSafeInteger(capacity) || capacity < instr.elements.length) {
          errors.push({
            message: `vec.new_fixed capacity ${capacity} is smaller than logical length ${instr.elements.length}`,
            func: func.name,
            block: blockId,
          });
        }
        if (instr.resultType?.kind === "vec" && !irTypeEquals(instr.resultType.elementType, instr.elementType)) {
          errors.push({
            message: `vec.new_fixed result element type ${describeKind(instr.resultType.elementType)} does not match instruction element type ${describeKind(instr.elementType)}`,
            func: func.name,
            block: blockId,
          });
        }
        for (const element of instr.elements) {
          const elementType = typeOf.get(element);
          if (elementType && !irTypeEquals(elementType, instr.elementType)) {
            errors.push({
              message: `vec.new_fixed element type ${describeKind(elementType)} does not match ${describeKind(instr.elementType)}`,
              func: func.name,
              block: blockId,
            });
          }
        }
        break;
      }
      // Slot discipline: read/write indices must be within `func.slots` bounds.
      case "slot.read":
      case "slot.write": {
        const idx = instr.slotIndex;
        if (idx < 0 || idx >= numSlots) {
          errors.push({
            message: `${instr.kind} slot index ${idx} out of bounds (function has ${numSlots} slots)`,
            func: func.name,
            block: blockId,
          });
        }
        break;
      }
      // (#4523) Coverage backstop. `default:` fires exactly when NO case arm
      // above matched, so a kind whose rule was deleted lands here while
      // `TYPE_RULE_STATUS` still calls it "checked" — a desync the map alone
      // cannot catch (the map stays type-correct). Valid IR never reaches an
      // error here: every non-"checked" kind carries a `{ skip }` reason.
      default: {
        const message = typeRuleCoverageProblem(instr.kind, TYPE_RULE_STATUS[instr.kind]);
        if (message !== null) errors.push({ message, func: func.name, block: blockId });
        break;
      }
    }
  };

  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (i) => checkInstr(i, block.id as number));
    }
  }
}
