// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4155 Phase 2) Direct `struct.get` / `struct.set` for a DATA FIELD read or
 * written through a receiver whose COMPILED ValType is already a
 * `$__fnctor_<Name>` struct reference.
 *
 * ## What this is, and what it is not
 *
 * Phase 1 (`fnctor-typed-instances.ts`) made a fnctor instance TYPE resolve to
 * its reserved struct instead of `externref`. That changed which slot the value
 * lands in; it did NOT change how the value is READ. Every dynamic member path
 * still begins by boxing whatever the receiver compiled to:
 *
 *     const objExprType = compileExpression(ctx, fctx, expr.expression);
 *     if (objExprType.kind === "ref" || objExprType.kind === "ref_null")
 *       fctx.body.push({ op: "extern.convert_any" });     // ← the type is gone
 *     … null-check … call $__get_member_<name> … unbox …
 *
 * — `property-access-dispatch.ts` (read) and
 * `expressions/assignment.ts` (write). So a receiver the compiler had in a
 * typed register was re-erased one instruction later and the field was fetched
 * through a `ref.test` ladder. This module is the missing consumer: given the
 * receiver ValType the caller ALREADY has in hand, it answers "this is a plain
 * data slot of that exact struct" and the caller emits one `struct.get`.
 *
 * This is the #3753 S1c lesson applied to instance types — *"promoting the slot
 * alone moved nothing because the READ never consulted it."*
 *
 * ## Why no prediction, no speculation, no guard
 *
 * The admission decision is made AFTER the receiver is compiled, from the
 * ValType `compileExpression` returned. So:
 *
 *   - there is no static predictor that can be wrong (contrast #3685's
 *     receiver-flow verdict, which needs a `ref.test` because it is an
 *     inference);
 *   - the receiver is evaluated exactly once, by the caller, in the order it
 *     already was;
 *   - a decline costs nothing — the caller falls through to the byte-identical
 *     pre-#4155-Phase-2 boxing sequence.
 *
 * The emitted `struct.get` is the arm `fillMemberGetDispatch` would have
 * selected: the dispatcher tests candidates with `ref.test` and our receiver's
 * static type IS the candidate, so the same slot is loaded — minus the box, the
 * call, the ladder and the unbox.
 *
 * ## A member CALL is NEVER static off the struct type
 *
 * This is the rule that killed the #1712 attempt and it is enforced here twice:
 * only names that are DECLARED DATA FIELDS of the struct are admitted (methods
 * live on the per-fnctor prototype `$Object`, #2660 S2, and are never fields),
 * and a property access that is syntactically the callee of a call expression
 * is refused outright even if the name does resolve to a field. Method dispatch
 * keeps its existing dynamic lowering, unchanged, in every case.
 *
 * ## Carve-outs (identical to #3683 S2 / #3685 S2 — they are semantic)
 *
 *   1. **presence-tracked fields** (#2847): the dispatcher answers `undefined`
 *      for an unset slot, which a bare `struct.get` cannot express.
 *   2. **accessor names** on that struct: a getter/setter must keep winning
 *      over the slot.
 *   3. **reserved names** (`length`/`constructor`/`__proto__`/`prototype`/
 *      `name`) and call-signature-typed accesses, which the dynamic paths
 *      themselves refuse.
 *   4. **optional chaining / private identifiers** — separate lowerings.
 *
 * ## Null discipline
 *
 * A `ref_null` receiver reproduces the null behaviour of the site it replaces
 * (throw a catchable TypeError, never a raw `struct.get` trap — a Wasm trap is
 * not catchable by Wasm EH, #789). `ref` receivers cannot be null and skip it.
 *
 * ## Flag
 *
 * `JS2WASM_FNCTOR_TYPED_READS` — see {@link fnctorTypedReadsEnabled} for the
 * measured default and the evidence behind it.
 */
import { ts } from "../ts-api.js";
import { fnctorTypedReadsFlagEnabled } from "../derivation-flags.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { presenceSetInstrs, presenceSlotOf, presenceTestInstrs, type PresenceSlot } from "./fnctor-presence-bits.js";
import { undefinedExternInstrs } from "./any-helpers.js";
// `shared.js` holds the late-bound engine delegates precisely so a feature
// module can reach the expression/coercion engines without a cycle back through
// property-access.ts / index.ts.
import { coerceType, compileExpression } from "./shared.js";
import { inheritedSetAffectsKey } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate

/**
 * Names with dedicated lowerings (array length, proto walk, constructor
 * identity, function name). Mirrors `RESERVED_PROPS` in `typed-this.ts` and the
 * identical carve-out in `tryEmitPinnedStructMemberGet`, so this path never
 * claims an access the dynamic paths would have refused.
 *
 * (#2660 S3b) `name` is the ONE conditional entry: the blanket refusal exists
 * for *Function*.name, but on a fnctor INSTANCE struct a declared `name` DATA
 * FIELD is an ordinary slot (acorn's `Identifier.name` — 32 read sites, the
 * largest bucket the S3b binding retype exposed). `resolveFnctorTypedField`
 * admits `name` only when the receiver's struct declares that field — the
 * admission below the carve-out — which a function value's struct never does.
 * `length`/`constructor`/`__proto__`/`prototype` stay unconditionally refused.
 */
const RESERVED_PROPS: ReadonlySet<string> = new Set(["length", "constructor", "__proto__", "prototype"]);
const RESERVED_UNLESS_DECLARED_FIELD: ReadonlySet<string> = new Set(["name"]);

/**
 * **ON by default since 2026-08-08** (#743 derivation-defaults flip);
 * `JS2WASM_FNCTOR_TYPED_READS=0` restores the dynamic member ladder. Spelling
 * rule: `src/derivation-flags.ts`.
 *
 * The previous default was set by measurement — see the #4155 "Phase 2"
 * section for the `standaloneDynamic` A/B (a wash), the 78 candidate sites and
 * the binary sizes that chose OFF. Nothing about those numbers changed; the
 * *criterion* did (derivation ships regardless of measured payoff, 2026-08-08).
 * The switch stays either way, and now matters more: a one-variable revert has
 * to remain available without a code change.
 */
export function fnctorTypedReadsEnabled(): boolean {
  return fnctorTypedReadsFlagEnabled();
}

/**
 * `JS2WASM_FNCTOR_TYPED_READS_DEBUG=1` — per-compile tallies of what the
 * admission gates did, printed at process exit.
 *
 * Deliberately independent of {@link fnctorTypedReadsEnabled}: the census
 * counts CANDIDATES, so one compile with the flag off reports exactly how many
 * sites the flag would convert. That is the measurement this phase exists to
 * produce, and it must be obtainable without changing the artifact being
 * measured.
 */
export const fnctorTypedReadStats = {
  gets: 0,
  sets: 0,
  declines: new Map<string, number>(),
  sites: new Map<string, number>(),
};
let statsHookInstalled = false;
function censusEnabled(): boolean {
  return process.env.JS2WASM_FNCTOR_TYPED_READS_DEBUG === "1";
}
function note(bucket: Map<string, number>, key: string): void {
  if (!censusEnabled()) return;
  if (!statsHookInstalled) {
    statsHookInstalled = true;
    process.on("exit", () => {
      const top = (m: Map<string, number>, n: number): string =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
      process.stderr.write(
        `[fnctor-typed-reads] gets=${fnctorTypedReadStats.gets} sets=${fnctorTypedReadStats.sets}\n` +
          `[fnctor-typed-reads] sites: ${top(fnctorTypedReadStats.sites, 40)}\n` +
          `[fnctor-typed-reads] declines: ${top(fnctorTypedReadStats.declines, 30)}\n`,
      );
    });
  }
  bucket.set(key, (bucket.get(key) ?? 0) + 1);
}

/** A plain data slot of the receiver's own `$__fnctor_<Name>` struct. */
export interface FnctorTypedField {
  structName: string;
  structTypeIdx: number;
  fieldIdx: number;
  fieldType: ValType;
  mutable: boolean;
  /** The receiver ValType was `ref_null` — the caller must null-check. */
  nullable: boolean;
  /**
   * (#2660 S3b) Set for a #2847 presence-tracked EXTERNREF slot: the read
   * tests the bit and answers the semantic `undefined` when absent (the same
   * inline shape #3685's `tryEmitProvenReceiverFieldGet` ships); the write
   * stores the slot AND sets the bit (`presenceSetInstrs`). Non-externref
   * presence-tracked slots stay refused — `undefined` has no representation in
   * an f64/i32 lane (#3685's hard correctness condition).
   */
  presenceSlot?: PresenceSlot;
}

/**
 * Resolve `<receiver>.<propName>` against the receiver's COMPILED ValType, or
 * `undefined` to decline. Every decline leaves the caller's existing lowering
 * untouched.
 *
 * `recvType` must be what `compileExpression` returned for the receiver — this
 * function deliberately makes no inference of its own.
 */
export function resolveFnctorTypedField(
  ctx: CodegenContext,
  recvType: ValType | null | undefined,
  propName: string,
): FnctorTypedField | undefined {
  // Standalone only: the win is the host-free native slot lane, and in JS-host
  // mode a fnctor instance must keep `$Object` identity for the host MOP.
  if (!ctx.standalone) return undefined;
  if (recvType == null) return undefined;
  if (recvType.kind !== "ref" && recvType.kind !== "ref_null") return undefined;
  const typeIdx = (recvType as { typeIdx?: number }).typeIdx;
  if (typeIdx === undefined) return undefined;
  const structName = ctx.typeIdxToStructName.get(typeIdx);
  if (structName === undefined || !structName.startsWith("__fnctor_")) return undefined;
  // The name→index map is the emitter's own source of truth; require the round
  // trip to agree so a stale/aliased index can never select another struct.
  if (ctx.structMap.get(structName) !== typeIdx) {
    note(fnctorTypedReadStats.declines, `idx-mismatch:${structName}`);
    return undefined;
  }
  if (RESERVED_PROPS.has(propName)) {
    note(fnctorTypedReadStats.declines, `reserved:${propName}`);
    return undefined;
  }
  if (ctx.classAccessorSet.has(`${structName}_${propName}`)) {
    note(fnctorTypedReadStats.declines, `accessor:${structName}.${propName}`);
    return undefined;
  }
  const fields = ctx.structFields.get(structName);
  if (fields === undefined) {
    note(fnctorTypedReadStats.declines, `no-field-table:${structName}`);
    return undefined;
  }
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx < 0) {
    // Not an own slot ⇒ a prototype method, an accessor installed at runtime,
    // or a genuinely dynamic property. All three are the dynamic path's.
    note(
      fnctorTypedReadStats.declines,
      RESERVED_UNLESS_DECLARED_FIELD.has(propName) ? `reserved:${propName}` : `nofield:${structName}.${propName}`,
    );
    return undefined;
  }
  const field = fields[fieldIdx]!;
  let presenceSlot: PresenceSlot | undefined;
  if (field.presenceTracked) {
    // Externref slots only — `undefined` has no f64/i32 representation
    // (#3685's hard correctness condition, mirrored exactly).
    if (field.type.kind !== "externref") {
      note(fnctorTypedReadStats.declines, `presence-nonextern:${structName}.${propName}`);
      return undefined;
    }
    presenceSlot = presenceSlotOf(fields, propName);
    if (presenceSlot === undefined) {
      note(fnctorTypedReadStats.declines, `presence-noslot:${structName}.${propName}`);
      return undefined;
    }
  }
  return {
    structName,
    structTypeIdx: typeIdx,
    fieldIdx,
    fieldType: field.type,
    mutable: field.mutable,
    nullable: recvType.kind === "ref_null",
    presenceSlot,
  };
}

/**
 * Syntactic refusals shared by the read and write entry points. Kept separate
 * from {@link resolveFnctorTypedField} because they are about the ACCESS NODE,
 * not the slot.
 *
 * The call-callee refusal is the #1712 rule made syntactic: `p.f()` stays on
 * the dynamic method path even if `f` happens to name a field. The
 * `signatureOf` refusal is its type-level twin (a field whose value is
 * callable keeps the closure/funcref lowering rather than being boxed as a
 * value), asked through `ctx.oracle` rather than the raw checker.
 */
function accessNodeRefused(ctx: CodegenContext, expr: ts.PropertyAccessExpression): boolean {
  if (expr.questionDotToken !== undefined) return true;
  if (ts.isPrivateIdentifier(expr.name)) return true;
  const parent = expr.parent;
  if (parent !== undefined) {
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === expr) return true;
    if (ts.isTaggedTemplateExpression(parent) && parent.tag === expr) return true;
    if (ts.isDeleteExpression(parent)) return true;
  }
  return ctx.oracle.signatureOf(expr) !== undefined;
}

/**
 * The catchable-TypeError null guard, emitted for a `ref_null` receiver that is
 * already on the stack. Reproduces the guard of the sites this path replaces
 * (`property-access-dispatch.ts`'s `__nullchk_` tee, `emitNullCheckThrow`):
 * a raw `struct.get` on null would be an UNCATCHABLE Wasm trap (#789).
 *
 * Leaves the receiver back on the stack, unchanged.
 */
function emitReceiverNullGuard(fctx: FunctionContext, recvType: ValType, throwInstrs: Instr[]): void {
  const tmp = allocLocal(fctx, `__ftr_recv_${fctx.locals.length}`, recvType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] });
  // No `ref.as_non_null`: `struct.get` accepts a nullable ref (it traps on
  // null), and the guard above has already thrown the catchable TypeError on
  // that path, so the trap is unreachable.
  fctx.body.push({ op: "local.get", index: tmp });
}

/**
 * (#4155 Phase 2, read) The receiver is ON THE STACK with ValType `recvType`.
 * On admission this consumes it and leaves the field value, returning the
 * FIELD's ValType (an `f64` slot stays an unboxed f64) exactly as #3683 S2 /
 * #3685 S2 do. Returns `undefined` without emitting anything to decline, in
 * which case the caller's existing boxing sequence runs unchanged.
 */
export function tryEmitFnctorTypedFieldGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  recvType: ValType | null | undefined,
  throwInstrs: () => Instr[],
): ValType | undefined {
  const f = resolveFnctorTypedField(ctx, recvType, propName);
  if (f === undefined) return undefined;
  if (accessNodeRefused(ctx, expr)) {
    note(fnctorTypedReadStats.declines, `node-refused:${f.structName}.${propName}`);
    return undefined;
  }
  note(
    fnctorTypedReadStats.sites,
    `get:${f.structName}.${propName}:${f.fieldType.kind}${f.presenceSlot === undefined ? "" : ":presence"}`,
  );
  if (!fnctorTypedReadsEnabled()) return undefined;
  // A clear flow-presence bit means this fnctor has no own data property.
  // When inherited descriptors are observable, preserve the dynamic getter so
  // it can continue into the fnctor prototype instead of returning the slot's
  // local `undefined`.
  if (ctx.standalone && inheritedSetAffectsKey(ctx, propName) && f.presenceSlot !== undefined) {
    note(fnctorTypedReadStats.declines, `get:inherited-presence:${f.structName}.${propName}`);
    return undefined;
  }
  if (f.nullable) emitReceiverNullGuard(fctx, recvType as ValType, throwInstrs());
  if (f.presenceSlot === undefined) {
    fctx.body.push({ op: "struct.get", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  } else {
    // Presence-tracked externref slot: bit set → the slot; absent → the
    // semantic `undefined` — the exact inline shape #3685 ships
    // (`tryEmitProvenReceiverFieldGet`), minus its cast (the receiver is
    // already the struct type here).
    const recvTmp = allocLocal(fctx, `__ftr_prs_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: f.structTypeIdx,
    });
    fctx.body.push({ op: "local.tee", index: recvTmp });
    fctx.body.push(...presenceTestInstrs(f.structTypeIdx, f.presenceSlot));
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: f.fieldType },
      then: [
        { op: "local.get", index: recvTmp },
        { op: "struct.get", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx },
      ],
      // Absent ⇒ semantic `undefined`, never the slot's raw contents.
      else: undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }],
    });
  }
  fnctorTypedReadStats.gets++;
  return f.fieldType;
}

/**
 * (#4155 Phase 2, write) The receiver is ON THE STACK with ValType `recvType`
 * and the value has NOT been compiled yet. On admission this compiles the value
 * (reference-before-value, §13.15.2), stores the slot and leaves the RHS value
 * on the stack, returning the RHS's ValType — an assignment evaluates to `rval`
 * as written, not to the field-coerced value.
 *
 * Declines without emitting for an immutable slot (`struct.set` on one is a
 * hard validator error, which is exactly why `fillMemberSetDispatch` filters
 * its candidates the same way).
 */
export function tryEmitFnctorTypedFieldSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  propName: string,
  recvType: ValType | null | undefined,
  value: ts.Expression,
  throwInstrs: () => Instr[],
  /** `ensureI32Condition` — injected because it lives in `codegen/index.ts`. */
  toBoolean: (valType: ValType | null) => void,
): ValType | undefined {
  const f = resolveFnctorTypedField(ctx, recvType, propName);
  if (f === undefined || !f.mutable) return undefined;
  if (accessNodeRefused(ctx, target)) {
    note(fnctorTypedReadStats.declines, `node-refused-set:${f.structName}.${propName}`);
    return undefined;
  }
  note(
    fnctorTypedReadStats.sites,
    `set:${f.structName}.${propName}:${f.fieldType.kind}${f.presenceSlot === undefined ? "" : ":presence"}`,
  );
  if (!fnctorTypedReadsEnabled()) return undefined;
  // A flow-grown slot is physically allocated in the struct but becomes an
  // own property only when its presence bit is set. Do not let this typed
  // write shortcut materialize an absent slot ahead of an inherited setter or
  // non-writable descriptor; its caller falls through to the already-reserved
  // member dispatcher, whose absent branch delegates once to `__extern_set`.
  if (ctx.standalone && inheritedSetAffectsKey(ctx, propName) && f.presenceSlot !== undefined) {
    note(fnctorTypedReadStats.declines, `set:inherited-presence:${f.structName}.${propName}`);
    return undefined;
  }
  if (f.nullable) emitReceiverNullGuard(fctx, recvType as ValType, throwInstrs());
  // A presence-tracked write is a read-modify-write of the shared presence
  // word, so the receiver must live in a (repeatable) local.
  let presenceRecvTmp: number | undefined;
  if (f.presenceSlot !== undefined) {
    presenceRecvTmp = allocLocal(fctx, `__ftr_psr_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: f.structTypeIdx,
    });
    fctx.body.push({ op: "local.tee", index: presenceRecvTmp });
  }

  let valType = compileExpression(ctx, fctx, value);
  if (valType === null) {
    fctx.body.push({ op: "ref.null.extern" });
    valType = { kind: "externref" };
  }
  if (ctx.booleanPropertyNames.has(propName)) {
    // #2847 parity with every other write path: the whole-program property
    // analysis proved this slot is boolean, so normalize through ToBoolean and
    // carry the boolean BRAND (a bare `__box_number` would make `o.flag ===
    // true` answer false).
    toBoolean(valType);
    valType = { kind: "i32", boolean: true };
  }
  const valTmp = allocLocal(fctx, `__ftr_val_${fctx.locals.length}`, valType);
  fctx.body.push({ op: "local.set", index: valTmp });
  fctx.body.push({ op: "local.get", index: valTmp });
  // Two DIFFERENT nominal struct types cannot be bridged directly — take the
  // same externref hop the dispatcher's write arm takes (value→externref at the
  // call site, externref→field inside the arm). Everything else is one
  // coercion-engine step. Mirrors `tryEmitTypedThisFieldSet`.
  const bothRefs =
    (valType.kind === "ref" || valType.kind === "ref_null") &&
    (f.fieldType.kind === "ref" || f.fieldType.kind === "ref_null");
  if (bothRefs && (valType as { typeIdx: number }).typeIdx !== (f.fieldType as { typeIdx: number }).typeIdx) {
    coerceType(ctx, fctx, valType, { kind: "externref" });
    coerceType(ctx, fctx, { kind: "externref" }, f.fieldType);
  } else if (valType.kind !== f.fieldType.kind) {
    coerceType(ctx, fctx, valType, f.fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  if (f.presenceSlot !== undefined && presenceRecvTmp !== undefined) {
    // Mark the slot present — the typed read (above) and every dynamic
    // reader/`in`/`hasOwnProperty` path test this same bit.
    fctx.body.push(...presenceSetInstrs(f.structTypeIdx, f.presenceSlot, presenceRecvTmp));
  }
  fctx.body.push({ op: "local.get", index: valTmp });
  fnctorTypedReadStats.sets++;
  return valType;
}
