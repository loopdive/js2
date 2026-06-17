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
//      instructions are IrFuncRef/IrGlobalRef/IrTypeRef (no raw indices).
//
// On failure, returns a list of `IrVerifyError`s rather than throwing, so
// callers can decide whether to bail or fall back to the legacy path.

import type { IrBlock, IrFunction, IrInstr, IrType, IrValueId } from "./nodes.js";
import { asVal, forEachInstrDeep, forEachNestedBuffer } from "./nodes.js";
import type { ValType } from "./types.js";

/**
 * #1850 — successor block ids of a block, derived from its terminator.
 * `return`/`unreachable` have none; `br` has one; `br_if` has two.
 */
function successors(block: IrBlock): readonly number[] {
  const t = block.terminator;
  switch (t.kind) {
    case "br":
      return [t.branch.target as number];
    case "br_if":
      return [t.ifTrue.target as number, t.ifFalse.target as number];
    case "return":
    case "unreachable":
      return [];
  }
}

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

/**
 * #1850 — classic iterative dominator-set computation over the block CFG
 * (Cooper/Harvey/Kennedy-style fixpoint on full sets — O(blocks²) but the
 * functions the IR path claims are small). `dom[b]` is the set of blocks that
 * dominate `b` (every path from entry to `b` passes through them), with `b`
 * dominating itself. The entry block is `blocks[0]`; blocks unreachable from
 * entry keep the conservative full set, which never produces a false dominance
 * violation. Assumes block ids are the contiguous range 0..n-1 (checked by the
 * caller).
 */
function computeDominators(func: IrFunction): ReadonlySet<number>[] {
  const n = func.blocks.length;
  if (n === 0) return [];

  // Predecessor lists.
  const preds: number[][] = Array.from({ length: n }, () => []);
  for (const block of func.blocks) {
    const from = block.id as number;
    for (const s of successors(block)) {
      if (s >= 0 && s < n) preds[s].push(from);
    }
  }

  const all = new Set<number>();
  for (let i = 0; i < n; i++) all.add(i);

  // Init: entry dominated only by itself; every other block by all blocks.
  const dom: Set<number>[] = [];
  for (let i = 0; i < n; i++) dom.push(i === 0 ? new Set([0]) : new Set(all));

  let changed = true;
  while (changed) {
    changed = false;
    for (let b = 1; b < n; b++) {
      // newDom = {b} ∪ (∩ dom[p] for all preds p). Intersection over no preds
      // is the universe (full set) — keeps unreachable blocks conservative.
      let inter: Set<number> | null = null;
      for (const p of preds[b]) {
        if (inter === null) {
          inter = new Set(dom[p]);
        } else {
          for (const x of [...inter]) if (!dom[p].has(x)) inter.delete(x);
        }
      }
      const next = inter ?? new Set(all);
      next.add(b);
      if (!setsEqual(next, dom[b])) {
        dom[b] = next;
        changed = true;
      }
    }
  }
  return dom;
}

function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export interface IrVerifyError {
  readonly message: string;
  readonly func: string;
  readonly block?: number;
}

export function verifyIrFunction(func: IrFunction): IrVerifyError[] {
  const errors: IrVerifyError[] = [];
  const defs = new Set<IrValueId>();

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
  const dominators = blockIdsContiguous ? computeDominators(func) : null;

  // #1924 — build the def→IrType map once (O(n)); reused by the per-instruction
  // type rules and the branch-arg type check below.
  const typeOf = buildDefTypeMap(func);

  for (const block of func.blocks) {
    verifyBlock(func, block, defs, errors, defBlock, dominators);
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
        });
      }
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

function verifyBlock(
  func: IrFunction,
  block: IrBlock,
  defs: Set<IrValueId>,
  errors: IrVerifyError[],
  defBlock: ReadonlyMap<IrValueId, number> | null,
  dominators: readonly ReadonlySet<number>[] | null,
): void {
  const here = block.id as number;
  // #1850 — cross-block dominance: a use whose value is defined in a *different*
  // block is only valid if that defining block dominates `here` along all CFG
  // paths. Returns true if the use is satisfied by a dominating cross-block def
  // (so the local use-before-def check should not also flag it), false if it is
  // either local (let the local check decide) or a dominance violation (which we
  // report here).
  const dominatedCrossBlockDef = (u: IrValueId, atBlock: number, what: string): boolean => {
    if (!defBlock || !dominators) return false;
    const db = defBlock.get(u);
    if (db === undefined || db === atBlock) return false; // not a cross-block def
    const doms = dominators[atBlock];
    if (doms && doms.has(db)) return true; // def-block dominates use-block — OK
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
  const walkBuffer = (instrs: readonly IrInstr[]): void => {
    for (const instr of instrs) {
      // `while.loop` / `for.loop` surface `condValue` in `collectUses`, but
      // that value is *produced by the cond buffer* (which `collectUses` for
      // these kinds does not contain). Walk the cond buffer first so its def
      // is registered before we validate the `condValue` use — otherwise it
      // would spuriously read as use-before-def. (#1844)
      if (instr.kind === "while.loop" || instr.kind === "for.loop") {
        walkBuffer(instr.cond);
        // The lowerer emits an unconditional `i32.eqz` on `condValue`, so a
        // non-i32 cond produces invalid Wasm that bricks the whole module.
        // Reject it here (the lowerer's #1980 fix throws a fallback before
        // reaching this, but the verifier is the structural backstop — the
        // #1850 gap that let this through silently). (#1980)
        const condT = operandIrType(func, block, instr.condValue, localDefs);
        if (condT && asVal(condT)?.kind !== "i32") {
          errors.push({
            message: `${instr.kind} condValue must be i32, got ${asVal(condT)?.kind ?? condT.kind}`,
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

      // Structural checks for the tagged-union instructions. These are
      // type-system-level, not SSA-scope — misuse should surface here rather
      // than silently lowering to a trap.
      if (instr.kind === "box") {
        if (instr.toType.kind !== "union") {
          errors.push({
            message: `box target must be a union IrType, got ${instr.toType.kind}`,
            func: func.name,
            block: block.id as number,
          });
        } else {
          // box requires the operand's ValType to be a member of the union.
          const operandT = operandValType(func, block, instr.value, localDefs);
          if (operandT && !unionContains(instr.toType.members, operandT)) {
            errors.push({
              message: `box operand type ${operandT.kind} is not a member of union<${instr.toType.members.map((m) => m.kind).join(",")}>`,
              func: func.name,
              block: block.id as number,
            });
          }
        }
      }
      if (instr.kind === "unbox" || instr.kind === "tag.test") {
        // value's defining IrType must be a union whose members contain `tag`.
        const operandIr = operandIrType(func, block, instr.value, localDefs);
        if (operandIr && operandIr.kind !== "union") {
          errors.push({
            message: `${instr.kind} operand must be a union IrType, got ${operandIr.kind}`,
            func: func.name,
            block: block.id as number,
          });
        } else if (operandIr && !unionContains(operandIr.members, instr.tag)) {
          errors.push({
            message: `${instr.kind} tag ${instr.tag.kind} is not a member of union<${operandIr.members.map((m) => m.kind).join(",")}>`,
            func: func.name,
            block: block.id as number,
          });
        }
      }

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
      if (instr.kind === "while.loop") {
        walkBuffer(instr.body);
      } else if (instr.kind === "for.loop") {
        walkBuffer(instr.body);
        walkBuffer(instr.update);
      } else {
        // Non-loop buffer-bearing kinds (if / for-of / try). Loops are handled
        // above so their cond buffer (already walked) isn't re-walked here.
        forEachNestedBuffer(instr, walkBuffer);
      }
    }
  };
  walkBuffer(block.instrs);

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
    // (#1373 Phase B) Async / await IR nodes — type-only in this slice.
    // The verifier sees their operands as plain SSA uses; lowering
    // (Phase C, #1373b) will define the per-arm SSA scope.
    case "await":
      return [instr.operand];
    case "async.return":
      return [instr.value];
    case "async.throw":
      return [instr.reason];
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

function unionContains(members: readonly ValType[], target: ValType): boolean {
  for (const m of members) {
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
  // js.bit* — operands may be i32 or f64; no single required kind.
  return null;
}

/** The Wasm scalar kind an `IrUnop` produces, or null if not a fixed scalar. */
function unopResultKind(op: import("./nodes.js").IrUnop): ValType["kind"] | null {
  switch (op) {
    case "f64.neg":
      return "f64";
    case "i32.eqz":
    case "ref.is_null":
      return "i32";
    case "i32.trunc_sat_f64_s":
      return "i32";
    default:
      return null;
  }
}

/** Expected operand kind for an `IrUnop`, or null if unconstrained. */
function unopOperandKind(op: import("./nodes.js").IrUnop): ValType["kind"] | null {
  switch (op) {
    case "f64.neg":
    case "i32.trunc_sat_f64_s":
      return "f64";
    case "i32.eqz":
      return "i32";
    // ref.is_null takes a ref/externref/funcref — not a fixed scalar; skip.
    default:
      return null;
  }
}

/**
 * Walk every instruction (incl. nested buffers) once and apply the per-kind
 * type rules. `typeOf` is the precomputed def→IrType map.
 */
function verifyInstrTypeRules(func: IrFunction, typeOf: ReadonlyMap<IrValueId, IrType>, errors: IrVerifyError[]): void {
  const numSlots = func.slots?.length ?? 0;

  const checkInstr = (instr: IrInstr, blockId: number): void => {
    switch (instr.kind) {
      case "binary": {
        const want = binopOperandKind(instr.op);
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
      // String ops produce a known IrType kind; validate resultType when set.
      case "string.len":
      case "vec.len": {
        if (instr.result !== null && instr.resultType) {
          const got = asVal(instr.resultType)?.kind ?? null;
          if (got !== null && got !== "f64") {
            errors.push({
              message: `${instr.kind} resultType must be f64 (length), got ${got}`,
              func: func.name,
              block: blockId,
            });
          }
        }
        break;
      }
      case "string.const":
      case "string.concat": {
        if (instr.result !== null && instr.resultType && instr.resultType.kind !== "string") {
          errors.push({
            message: `${instr.kind} resultType must be string, got ${instr.resultType.kind}`,
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
    }
  };

  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (i) => checkInstr(i, block.id as number));
    }
  }
}
