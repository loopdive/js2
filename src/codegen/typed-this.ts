/**
 * #3683 S2 — typed-`this` monomorphization for fnctor prototype methods.
 *
 * ## What this is
 *
 * A fnctor prototype method (`Parser.prototype.readToken = function () {…}` /
 * the aliased `pp.readToken = …` acorn writes) is lifted to a generic closure
 * whose `this` is the DYNAMIC `__current_this` externref global. Every
 * `this.pos` read in that body therefore costs a `__get_member_pos` dispatcher
 * call (a `ref.test`/`ref.cast` ladder over the whole struct table) plus a
 * box-to-externref inside the dispatcher and an unbox back to f64 at the call
 * site (`tryEmitPinnedStructMemberGet`'s `finishPinnedRead`). #3673 measured
 * that residue as the dominant remaining cost of the compiled-acorn parse.
 *
 * S2 compiles an admitted method's body a SECOND time as a **typed twin**: one
 * `ref.cast` of `__current_this` down to `$__fnctor_F` in the prologue, parked
 * in a local, after which `this.<field>` lowers to a bare
 * `struct.get`/`struct.set` returning the field's own ValType. The GENERIC body
 * keeps its dynamic lowering and gains a 4-instruction prepend —
 * `global.get __current_this; any.convert_extern; ref.test $__fnctor_F; if →
 * return_call the twin with every param forwarded` — so detached receivers,
 * patched prototypes and foreign shapes still take the original path unchanged.
 *
 * ## Why the inline branches are semantically equivalent (the load-bearing part)
 *
 * The typed branches only ever fire where the receiver is `this` inside a twin,
 * i.e. exactly where today's lowering is the PINNED dispatcher path
 * (`tryEmitPinnedStructMemberGet` / `tryEmitPinnedStructMemberSet`, keyed off
 * `fctx.thisStructName`). They are that path's `$__fnctor_F` arm inlined:
 *
 *   - `fillMemberGetDispatch` emits, per candidate struct, `ref.test $C → (
 *     ref.cast $C; struct.get $C f; box→externref )`. Our receiver was
 *     `ref.cast $__fnctor_F`-verified at twin entry, so the arm the dispatcher
 *     would select is `$__fnctor_F`'s own — or that of a super/subtype in the
 *     same WasmGC chain, whose shared field PREFIX puts the same-named field at
 *     the same index with the same value. Either way the loaded bits are equal.
 *   - The caller then immediately unboxes back with
 *     `coerceType(externref → pinnedFieldType)`. Inlining collapses
 *     box∘unbox to the identity and hands downstream lowering the unboxed type.
 *   - `fillMemberSetDispatch` is the mirror image (`ref.cast`, coerce
 *     externref→field, `struct.set`), with the same argument.
 *
 * Three carve-outs preserve the remaining dispatcher semantics, so anything the
 * inline form could NOT reproduce declines and keeps the dispatcher call:
 *
 *   1. **presence-tracked fields** (`$has_<name>` companion): the dispatcher's
 *      read arm consults the presence bit and answers `undefined` when unset,
 *      and its write arm sets the bit. A bare `struct.get` cannot express that.
 *   2. **accessor properties** on the same struct: accessor arms run BEFORE the
 *      field arms in the dispatcher, so a getter must keep winning.
 *   3. **reserved names** (`length`/`constructor`/`__proto__`/`prototype`/
 *      `name`) and **call-signature-typed accesses**, which the pinned path
 *      itself refuses — a method read keeps its closure/funcref lowering.
 *
 * ### On `moduleUsesDelete`
 *
 * The S2 scoping note listed `!moduleUsesDelete` as an admission gate on
 * tombstone grounds. That gate is **not** what makes the inline branches safe,
 * and applying it would make S2 a measured no-op: acorn contains
 * `delete node.operator` and `delete this.undefinedExports[name]`, so the flag
 * is TRUE for the entire benchmark target. The tombstone-aware read
 * (`tryEmitDeleteAwareDynamicGet`) is a JS-HOST lowering that runs *after* the
 * pinned branch in `tryPinnedAndDeleteAwareDynamicGet` — a pinned `this`
 * receiver never reaches it today. What actually protects a deleted slot is
 * (a) the presence-bit carve-out above and (b) the standalone struct-delete
 * lowering, which WRITES a delete sentinel into the field itself
 * (`typeof-delete.ts` `clearField`), so a plain `struct.get` observes the
 * deletion exactly as the dispatcher's arm does. The gate is therefore replaced
 * by the equivalence conditions it was standing in for.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { resolveEnclosingFnctorOwner, resolveLiftedMethodThisStruct } from "./fnctor-escape-gate.js";
import { foreignReturnFunctionNames } from "./fnctor-foreign-return.js"; // (#2071)
import { allocLocal } from "./context/locals.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { analyzeReceiverFlow, receiverClassOf } from "./receiver-flow-analysis.js";
// (#3685 step 2) presence bits — reused rather than hand-rolled so the proven-
// receiver inline read tests presence exactly the way `emitNullGuardedStructGet`
// does for the same closed structs.
import { type PresenceSlot, presenceSlotOf, presenceTestInstrs } from "./fnctor-presence-bits.js";
import { undefinedExternInstrs } from "./any-helpers.js";
// (#3685 step 1) decline census — inert unless JS2WASM_PROVEN_RECEIVER_STATS=1
import { noteProvenReceiver, noteProvenReceiverPhase, provenReceiverStatsEnabled } from "./proven-receiver-stats.js";
// (#4405 Phase 0) funnel census ABOVE the proven-receiver tail — inert unless
// JS2WASM_RECEIVER_SPEC_STATS=1. Every note is a statement; see the module head.
import {
  noteReceiverDeclineDetail,
  noteReceiverNotIdentifier,
  noteReceiverNotThis,
  noteReceiverSpec,
} from "./receiver-spec-census.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
// `shared.js` holds the late-bound delegates precisely so a feature module can
// reach the expression/coercion engines without a cycle back through
// expressions.ts / index.ts.
import { VOID_RESULT, coerceType, compileExpression, flushLateImportShifts, valTypesMatch } from "./shared.js";
import { inheritedSetAffectsKey } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate

/**
 * Property names whose reads/writes have dedicated lowerings (array length,
 * proto walk, constructor identity, function name). Mirrors the identical
 * carve-out in `tryEmitPinnedStructMemberGet` / `tryEmitPinnedStructMemberSet`
 * so the typed branch never claims a read the pinned path would have refused.
 */
const RESERVED_PROPS = new Set(["length", "constructor", "__proto__", "prototype", "name"]);

/** Env kill-switch: `JS2WASM_TYPED_THIS=0` disables twin emission entirely. */
function typedThisEnabled(): boolean {
  return process.env.JS2WASM_TYPED_THIS !== "0";
}

/**
 * `JS2WASM_TYPED_THIS_DEBUG=1` — per-compile tallies of what the S2 gates
 * actually did, printed at process exit. The measurable win depends entirely on
 * how many HOT `this.<field>` sites end up inlined (a twin whose every field is
 * presence-tracked buys nothing), so this counter is the primary instrument for
 * tuning the admission set. Inert unless the env var is set.
 */
export const typedThisStats = {
  twins: 0,
  declinedTwin: 0,
  inlineGet: 0,
  inlineSet: 0,
  inlineCompound: 0,
  inlineIncDec: 0,
  declinedField: new Map<string, number>(),
};
let statsHookInstalled = false;
function noteStats(): void {
  if (statsHookInstalled || process.env.JS2WASM_TYPED_THIS_DEBUG !== "1") return;
  statsHookInstalled = true;
  process.on("exit", () => {
    const top = [...typedThisStats.declinedField.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    process.stderr.write(
      `[typed-this] twins=${typedThisStats.twins} declinedTwin=${typedThisStats.declinedTwin} ` +
        `get=${typedThisStats.inlineGet} set=${typedThisStats.inlineSet} ` +
        `compound=${typedThisStats.inlineCompound} incdec=${typedThisStats.inlineIncDec}\n` +
        `[typed-this] declined fields: ${top.map(([k, v]) => `${k}=${v}`).join(" ")}\n`,
    );
  });
}
function noteDeclinedField(reason: string): void {
  if (process.env.JS2WASM_TYPED_THIS_DEBUG !== "1") return;
  noteStats();
  typedThisStats.declinedField.set(reason, (typedThisStats.declinedField.get(reason) ?? 0) + 1);
}

/**
 * A second compilation of the same AST must not re-mint per-node artifacts. A
 * nested function-like would get a FRESH lifted closure / callback (a second
 * `__closure_N`, a second construction site) on the twin pass, so bodies
 * containing one are refused outright. `with` is refused for the same reason
 * its scope machinery is stateful.
 */
function bodyHasNestedFunctionLikeOrWith(body: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isClassLike(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isWithStatement(n)
    ) {
      found = true;
      return;
    }
    forEachChild(n, walk);
  };
  forEachChild(body, walk);
  return found;
}

/**
 * Memoized `FunctionLikeDeclaration → owning fnctor NAME` view of the S1
 * write-once verdicts (`analyzeProtoMethodWriteOnce`), so admission is an O(1)
 * node lookup instead of a scan over every class's method map per closure.
 */
function writeOnceOwnerOf(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration): string | undefined {
  let index = ctx.typedThisWriteOnceIndex;
  if (index === undefined) {
    index = new Map<ts.FunctionLikeDeclaration, string>();
    for (const [className, methods] of ctx.fnctorEscapeGate?.protoMethodWriteOnce.methods ?? []) {
      for (const [, rhs] of methods) index.set(rhs, className);
    }
    ctx.typedThisWriteOnceIndex = index;
  }
  return index.get(fn);
}

/**
 * (#3683 S2) Decide whether a lifted prototype method gets a typed twin.
 *
 * Every clause is a hard requirement, and each failure mode is "miss a
 * monomorphization candidate", never "wrong lowering":
 *
 *  - `ctx.standalone` — the twin's win is the unboxed native field lane, which
 *    only exists in the host-free representation.
 *  - S1 write-once verdict for THIS arrow node, under the SAME fnctor the
 *    `this`-struct pin resolved to (a method slot that can be reassigned could
 *    later hold a body that never saw this struct).
 *  - the fnctor struct is registered in `ctx.structMap` (the twin's prologue
 *    needs a real type index — unlike the pin, which may resolve before the
 *    `new F()` site registers the struct).
 *  - zero captures, no self-recursive binding, not a named function expression:
 *    the twin's `__self` param is never read, and re-minting capture cells /
 *    self bindings on a second pass is not idempotent.
 *  - not async / not a generator: both own the body emission through separate
 *    state-machine lanes.
 *  - a plain block body with no nested function-like (see above).
 */
export function admitTypedThisTwin(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  opts: {
    thisStructName: string | undefined;
    captureCount: number;
    selfBindingName: string | undefined;
    isGenerator: boolean;
    isAsync: boolean;
    isNamedFuncExpr: boolean;
  },
): { structName: string; structTypeIdx: number } | undefined {
  noteStats();
  if (!typedThisEnabled()) return undefined;
  if (!ctx.standalone) return undefined;
  const { thisStructName } = opts;
  if (thisStructName === undefined) return undefined;
  if (opts.captureCount !== 0) return undefined;
  if (opts.selfBindingName !== undefined) return undefined;
  if (opts.isGenerator || opts.isAsync || opts.isNamedFuncExpr) return undefined;
  if (!ts.isFunctionExpression(arrow)) return undefined;
  if (!arrow.body || !ts.isBlock(arrow.body)) return undefined;

  const structTypeIdx = ctx.structMap.get(thisStructName);
  if (structTypeIdx === undefined) return undefined;

  // The write-once verdict must be for the SAME class the `this` pin resolved
  // to. `resolveLiftedMethodThisStruct` already required a prototype (not
  // static) method of an approved fnctor; re-derive the owner name to compare.
  const owner = resolveEnclosingFnctorOwner(ctx.checker, arrow);
  if (!owner || !owner.viaPrototype) return undefined;
  if (`__fnctor_${owner.name}` !== thisStructName) return undefined;
  if (writeOnceOwnerOf(ctx, arrow) !== owner.name) return undefined;
  if (ctx.fnctorEscapeGate?.protoMethodWriteOnce.poisoned.has(owner.name)) return undefined;

  if (bodyHasNestedFunctionLikeOrWith(arrow.body)) {
    typedThisStats.declinedTwin++;
    return undefined;
  }

  typedThisStats.twins++;
  return { structName: thisStructName, structTypeIdx };
}

/**
 * (#3683 S2/S3) Twin prologue — since S3 this emits NOTHING.
 *
 * S2 opened every twin with `global.get __current_this; any.convert_extern;
 * ref.cast $__fnctor_F; local.set $tt`. S3 replaces the twin's unread `__self`
 * parameter with the RECEIVER itself, typed `(ref $__fnctor_F)`, so the typed
 * local IS param 0 and the entry cast disappears. Three things make that safe:
 *
 *   - **Nothing reads `__self` in an admitted body.** {@link admitTypedThisTwin}
 *     already requires zero captures, no self-recursive binding and no named
 *     function expression — the three (and only) consumers of param 0 in
 *     `compileLiftedClosureBody`.
 *   - **The generic shim can still tail-call it.** `return_call` constrains only
 *     the callee's RESULTS to equal the caller's; parameters are ordinary stack
 *     operands, so the shim may push a cast receiver where the generic's own
 *     param 0 is a closure struct.
 *   - **It is what makes S3 possible at all.** A devirtualized `this.m2(…)`
 *     inside another twin has the receiver in a typed register but no handle on
 *     `m2`'s closure singleton — that value is built during `__module_init` and
 *     stored straight into the prototype `$Object`, and the lifted `__self`
 *     param is non-nullable, so neither `ref.null` nor a global-free reload is
 *     available. Taking the receiver as the parameter sidesteps the whole
 *     question (the S1 design note's option (b), chosen over the per-method
 *     singleton globals of option (a) because it adds no module state and
 *     removes the per-entry cast instead of adding a per-call `global.get`).
 *
 * `__current_this` is still installed by the caller for every twin entry, since
 * a twin body's NON-field uses of `this` (a `this` passed as an argument, a
 * dispatcher fallback read, a nested legacy method call) read that global.
 */
export function emitTypedThisPrologue(
  fctx: FunctionContext,
  structName: string,
  structTypeIdx: number,
  /**
   * Only set under the `JS2WASM_DIRECT_CALLS=0` kill-switch, which keeps the S2
   * twin ABI (`__self` at param 0) so the switch bisects the WHOLE slice — the
   * receiver-parameter change included — not just the call sites.
   */
  legacyCurrentThisGlobalIdx?: number,
): void {
  fctx.typedThisStructIdx = structTypeIdx;
  fctx.typedThisStructName = structName;
  if (legacyCurrentThisGlobalIdx === undefined) {
    fctx.typedThisLocalIdx = 0;
    return;
  }
  const localIdx = allocLocal(fctx, "__typed_this", { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "global.get", index: legacyCurrentThisGlobalIdx });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: localIdx });
  fctx.typedThisLocalIdx = localIdx;
}

/** True unless the `JS2WASM_DIRECT_CALLS=0` kill-switch is set. */
export function directCallLoweringEnabled(): boolean {
  return directCallsEnabled();
}

/**
 * (#3683 S2) The guard prepended to the GENERIC lifted body:
 *
 *     global.get __current_this
 *     any.convert_extern
 *     local.tee $tmp
 *     ref.test $__fnctor_F
 *     if
 *       local.get $tmp
 *       ref.cast $__fnctor_F         ;; the twin's typed receiver param
 *       local.get 1 … local.get n    ;; every declared param, verbatim
 *       return_call $twin
 *     end
 *
 * Placed as the very FIRST instructions, before param defaults / destructuring
 * / the `arguments` vec, so a hit re-derives all of them inside the twin from
 * the untouched raw params (and the untouched `__argc` / `__extras_argv`
 * globals, which a call does not disturb).
 */
export function buildTypedThisForwardGuard(
  structTypeIdx: number,
  currentThisGlobalIdx: number,
  paramCount: number,
  twinFuncIdx: number,
  /** `undefined` under the kill-switch — the S2 twin shares this signature. */
  scratchLocalIdx: number | undefined,
  /**
   * (#3754) Instructions that lift the twin's REFINED result back up to the
   * GENERIC body's declared result, or `undefined` when the two agree.
   *
   * A numeric-return twin (see {@link refinedTwinReturnType}) yields `f64`
   * while the generic body it shims still yields `externref`, and `return_call`
   * requires the callee's results to equal the caller's — so on that path the
   * shim degrades to `call; <box>; return`. That costs one frame the tail call
   * would have elided, paid ONLY on the dynamic entry into the generic body;
   * the devirtualized callers (`__dc_*`) reach the twin without passing through
   * here at all, which is the path this refinement exists for.
   */
  boxTwinResult?: Instr[],
): Instr[] {
  const forward: Instr[] =
    scratchLocalIdx === undefined
      ? [{ op: "local.get", index: 0 }]
      : [
          { op: "local.get", index: scratchLocalIdx },
          { op: "ref.cast", typeIdx: structTypeIdx },
        ];
  // Param 0 is the generic body's `__self`; the twin takes the receiver there
  // instead, so forwarding starts at 1.
  for (let i = 1; i < paramCount; i++) forward.push({ op: "local.get", index: i });
  // `return_call`, not `call; return`: `return_call` requires only that the
  // callee's RESULTS equal the caller's, which holds by construction (the twin
  // is minted with `closureResults`), so the tail call is well-typed and the
  // shim costs no extra frame. The guard sits at function ENTRY, outside any
  // `try`, so the tail-call restriction on handler scopes cannot apply.
  //
  // The one exception is a numeric-return twin, whose results deliberately do
  // NOT equal the generic body's — there the tail call is ill-typed and the
  // shim boxes and returns instead (see `boxTwinResult`).
  if (boxTwinResult === undefined) {
    forward.push({ op: "return_call", funcIdx: twinFuncIdx });
  } else {
    forward.push({ op: "call", funcIdx: twinFuncIdx }, ...boxTwinResult, { op: "return" });
  }
  return [
    { op: "global.get", index: currentThisGlobalIdx },
    { op: "any.convert_extern" },
    ...(scratchLocalIdx === undefined ? [] : ([{ op: "local.tee", index: scratchLocalIdx }] satisfies Instr[])),
    { op: "ref.test", typeIdx: structTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: forward, else: [] },
  ];
}

/** A resolved plain field of the twin's `this` struct. */
export interface TypedThisField {
  structTypeIdx: number;
  structName: string;
  localIdx: number;
  fieldIdx: number;
  fieldType: ValType;
  mutable: boolean;
}

/**
 * (#3683 S2) Resolve `<receiver>.<propName>` to a PLAIN field of the twin's
 * `this` struct, or `undefined` to decline (every decline keeps the existing
 * dispatcher lowering). See the module header for why each carve-out exists.
 */
export function resolveTypedThisField(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  propName: string,
): TypedThisField | undefined {
  const structTypeIdx = fctx.typedThisStructIdx;
  const structName = fctx.typedThisStructName;
  const localIdx = fctx.typedThisLocalIdx;
  if (structTypeIdx === undefined || structName === undefined || localIdx === undefined) {
    // (#4405 Phase 0) The attempt came from a function that has no typed twin —
    // a constructor, or a method with no write-once verdict. Silent until now,
    // and the single largest bucket in the funnel, so it gets a name.
    noteReceiverSpec("not-in-twin");
    return undefined;
  }
  // `JS2WASM_TYPED_THIS=shim` — emit the twins + the `ref.test` forward shim but
  // NONE of the inline field lowerings. The A/B against a full build isolates
  // the shim's per-call overhead from the inline branches' win, which is the
  // only way to tell "the branches don't pay" from "the shim eats the win".
  if (process.env.JS2WASM_TYPED_THIS === "shim") return undefined;
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) {
    // (#4405 Phase 0) In a twin, but the receiver is not `this` — the exact
    // population #4405 targets, histogrammed by shape.
    noteReceiverNotThis(receiver);
    return undefined;
  }
  if (RESERVED_PROPS.has(propName)) {
    noteDeclinedField(`reserved:${propName}`);
    return undefined;
  }
  // Carve-out 2: an accessor on this struct must keep winning over the slot.
  if (ctx.classAccessorSet.has(`${structName}_${propName}`)) {
    noteDeclinedField(`accessor:${propName}`);
    return undefined;
  }
  const fields = ctx.structFields.get(structName);
  if (!fields) {
    // (#4405 Phase 0) The twin's own struct has no field table registered.
    noteReceiverSpec(`no-field-table:${structName}`);
    return undefined;
  }
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx < 0) {
    noteDeclinedField(`nofield:${propName}`);
    return undefined;
  }
  const field = fields[fieldIdx]!;
  // Carve-out 1: presence-tracked ⇒ the dispatcher's presence check is
  // semantic (absent ⇒ `undefined`), which a bare struct.get cannot express.
  if (field.presenceTracked) {
    noteDeclinedField(`presence:${propName}`);
    return undefined;
  }
  return { structTypeIdx, structName, localIdx, fieldIdx, fieldType: field.type, mutable: field.mutable };
}

/**
 * (#3683 S2 branch a) `this.X` READ inside a twin → `local.get $typed_this;
 * struct.get $__fnctor_F X`. Returns the FIELD's ValType (an `f64` field stays
 * an unboxed f64, an `externref` field stays an externref) — which is what
 * lets the rest of the expression lowering stay numeric instead of routing
 * through `__unbox_number`.
 */
export function tryEmitTypedThisFieldGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  const f = resolveTypedThisField(ctx, fctx, expr.expression, propName);
  if (!f) return undefined;
  // Mirror the pinned path: a method/function-typed access keeps its
  // closure/funcref lowering (S3 devirtualizes those; S2 must not box them).
  const accessType = ctx.checker.getTypeAtLocation(expr);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) {
    noteDeclinedField(`callsig:${propName}`);
    return undefined;
  }
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  typedThisStats.inlineGet++;
  noteDeclinedField(`ok:${propName}:${f.fieldType.kind}`);
  return f.fieldType;
}

/**
 * (#3683 S2, branches b/c) Resolve a WRITE-side typed-`this` field. Adds the
 * mutability requirement (an immutable field cannot take `struct.set` — a hard
 * validator error, which is exactly why `fillMemberSetDispatch` filters its
 * candidates the same way) and the method-typed carve-out.
 */
export function resolveTypedThisWritableField(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
): TypedThisField | undefined {
  if (ts.isPrivateIdentifier(target.name)) return undefined;
  const f = resolveTypedThisField(ctx, fctx, target.expression, target.name.text);
  if (!f) return undefined;
  if (!f.mutable) {
    // (#4405 Phase 0) An immutable slot cannot take `struct.set` — the write
    // falls back to the dispatcher. Unnamed until now, and load-bearing for
    // Phase 3: a write-side emitter inherits exactly this carve-out.
    noteReceiverSpec(`write-immutable:${target.name.text}`);
    return undefined;
  }
  const accessType = ctx.checker.getTypeAtLocation(target);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) {
    noteReceiverSpec(`write-callsig:${target.name.text}`);
    return undefined;
  }
  return f;
}

/**
 * (#3683 S2 branch b) `this.X = v` WRITE inside a twin → `local.get
 * $typed_this; <value>; coerce; struct.set`. Returns the RHS value's ValType
 * (§13.15.2 step 1.e: an assignment evaluates to `rval` as written, NOT to the
 * field-coerced value), or `undefined` to decline.
 *
 * `toBoolean` is injected rather than imported: `ensureI32Condition` lives in
 * `codegen/index.ts`, which transitively imports this module.
 */
export function tryEmitTypedThisFieldSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  toBoolean: (fctx: FunctionContext, t: ValType | null, ctx: CodegenContext) => void,
): ValType | undefined {
  const f = resolveTypedThisWritableField(ctx, fctx, target);
  if (f === undefined) return undefined;
  const propName = (target.name as ts.Identifier).text;
  // Reference before value (§13.15.2): the receiver is a materialized local, so
  // pushing it first is side-effect-free and gives `struct.set` its operand
  // order without a scratch slot for the ref.
  fctx.body.push({ op: "local.get", index: f.localIdx });
  let valType = compileExpression(ctx, fctx, value);
  if (valType === null) {
    fctx.body.push({ op: "ref.null.extern" });
    valType = { kind: "externref" };
  }
  if (ctx.booleanPropertyNames.has(propName)) {
    // #2847 parity with the pinned write: the whole-program property analysis
    // proves this slot is boolean, so normalize through ToBoolean and carry the
    // boolean BRAND (a bare `__box_number` would make `o.flag === true` false).
    toBoolean(fctx, valType, ctx);
    valType = { kind: "i32", boolean: true };
  }
  const valTmp = allocLocal(fctx, `__tt_val_${fctx.locals.length}`, valType);
  fctx.body.push({ op: "local.set", index: valTmp });
  fctx.body.push({ op: "local.get", index: valTmp });
  // Two DIFFERENT nominal struct types cannot be bridged directly; take the
  // same externref hop the dispatcher's write arm takes (value→externref at the
  // call site, externref→field inside the arm). Everything else is one
  // coercion-engine step.
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
  fctx.body.push({ op: "local.get", index: valTmp });
  typedThisStats.inlineSet++;
  return valType;
}

/**
 * (#3683 S2) Exactly the operators `operator-assignment.ts`'s private `emitCompoundOp`
 * switch lowers. That switch has no `default`, so an unlisted operator is a
 * silent no-op that would strand its operands on the stack — only a caller
 * that pre-checks against this set may enter {@link tryEmitTypedThisCompound}.
 * Kept here, with its only consumer; MUST be updated in lockstep with the
 * switch.
 */
export const EMIT_COMPOUND_OP_HANDLES: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

/**
 * (#3683 S2 branch c1) `this.X op= v` inside a twin. Structurally identical to
 * the existing struct-ref "Path A" in `compilePropertyCompoundAssignmentExternref`
 * (read slot → coerce to f64 → RHS as f64 → op → coerce back → store → yield the
 * f64 result), with the receiver being the twin's typed local. A `this` receiver
 * never reaches Path A today (it compiles to externref via `__current_this`), so
 * it lands on Path B and pays `__get_member_<p>` + unbox + box + `__set_member_<p>`;
 * both are numeric under standalone, so the arithmetic semantics are unchanged.
 *
 * `emitOp` is injected because `emitCompoundOp` is private to
 * `operator-assignment.ts`; the caller MUST have pre-checked that the operator
 * is one `emitOp` actually lowers (its switch has no `default`, so an unlisted
 * operator would silently strand the read + RHS on the stack).
 */
export function tryEmitTypedThisCompound(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  emitOp: (ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind) => void,
): ValType | null | undefined {
  const f = resolveTypedThisWritableField(ctx, fctx, target);
  if (f === undefined) return undefined;
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  if (f.fieldType.kind !== "f64") coerceType(ctx, fctx, f.fieldType, { kind: "f64" });
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (rhsType === null) return null;
  if (rhsType.kind !== "f64") coerceType(ctx, fctx, rhsType, { kind: "f64" });
  emitOp(ctx, fctx, op);
  const resTmp = allocLocal(fctx, `__tt_cmpd_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: resTmp });
  if (f.fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, f.fieldType);
  fctx.body.push({ op: "struct.set", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  fctx.body.push({ op: "local.get", index: resTmp });
  typedThisStats.inlineCompound++;
  return { kind: "f64" };
}

/**
 * (#3683 S2 branch c2) `this.X++` / `--this.X` inside a twin. Acorn's
 * `this.pos++` is the hottest update site in the tokenizer; on the generic body
 * it costs `__get_member_pos` + unbox + `f64.add` + box + `__set_member_pos`.
 * Numeric semantics (and the prefix/postfix result choice) match the externref
 * read-modify-write it replaces, `emitExternrefMemberIncDec`.
 */
export function tryEmitTypedThisIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.PropertyAccessExpression,
  f64Op: "f64.add" | "f64.sub",
  mode: "prefix" | "postfix",
): ValType | undefined {
  const f = resolveTypedThisWritableField(ctx, fctx, operand);
  if (f === undefined) return undefined;
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "local.get", index: f.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  if (f.fieldType.kind !== "f64") coerceType(ctx, fctx, f.fieldType, { kind: "f64" });
  const tmp = allocLocal(fctx, `__tt_incdec_${fctx.locals.length}`, { kind: "f64" });
  if (mode === "postfix") {
    // [ref, old] → stash old, compute new, store, yield old.
    fctx.body.push({ op: "local.tee", index: tmp });
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: f64Op });
  } else {
    // [ref, old] → compute new, stash it, store, yield new.
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: f64Op });
    fctx.body.push({ op: "local.tee", index: tmp });
  }
  if (f.fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, f.fieldType);
  fctx.body.push({ op: "struct.set", typeIdx: f.structTypeIdx, fieldIdx: f.fieldIdx });
  fctx.body.push({ op: "local.get", index: tmp });
  typedThisStats.inlineIncDec++;
  return { kind: "f64" };
}

// ===========================================================================
// #3683 S3 — direct-call devirtualization between typed twins
// ===========================================================================
//
// ## What it replaces
//
// Inside a twin, `this.parseStatement(x)` still crossed the full dynamic
// method-call bridge: `__call_m_parseStatement_1` → `__method_cache_lookup`
// (interned-name probe + per-object cache validation) → `__call_fn_method_1`
// (argc globals, `__current_this` install, an N-arm `ref.test` ladder over
// closure func types, `call_ref`) → the lifted body, with every argument boxed
// to externref on the way in and the result boxed on the way out. The #3673
// round-25 profile put that family at ≈13% of the deep-warm parse
// (`__call_fn_method_1` 4.9%, `_0` 3.6%, `__method_cache_lookup` 2.3%,
// `__extern_method_call` 1.2%, `__apply_closure` 1.1%).
//
// S3 lowers such a call to `local.get <this>; <args>; call $__dc_<F>_<m>_<n>`
// — one direct call, arguments in their NATIVE types, result in its native
// type. The trampoline is 8 instructions of `__current_this`/`__argc`
// bookkeeping around a second direct call to the twin.
//
// ## Why the trampoline exists (it is not laziness)
//
// Acorn's parser is mutually recursive: `parseMaybeAssign` calls
// `parseExprOps`, which calls `parseMaybeUnary`, which calls back into
// `parseMaybeAssign`. Whichever body compiles first references a twin that does
// not exist yet, so the call site CANNOT bake the callee's index. The project's
// established answer to that is reserve-then-fill (`reserveMemberGetDispatch` /
// `reserveClosedMethodDispatch`): mint a stable handle now, fill the body at
// finalize when every name is resolvable. Patching the call instruction later
// was rejected — it would mean holding `Instr` object identities across the
// whole compile, exactly the aliasing hazard the codebase forbids.
//
// The trampoline earns its keep twice over:
//   1. it OWNS the `__current_this` save/install/restore, so N call sites cost
//      one instruction each instead of five (and the discipline lives in ONE
//      place, mirroring `__call_fn_method_N`, closure-exports.ts);
//   2. it gives the fill a place to DEGRADE. Admission at the call site is
//      decided from the AST + the S1 verdicts; the twin's own admission
//      additionally needs capture analysis, which is only available once the
//      method's closure is compiled. When the two disagree, the fill emits the
//      byte-for-byte legacy `__call_m_<m>_<n>` sequence instead — so a call site
//      can never point at a twin that failed to materialize.
//
// ## Why the devirtualization is sound
//
// The receiver is the twin's own `this`, already proven `(ref $__fnctor_F)` by
// the shim's `ref.test`. `this.<m>` therefore resolves through exactly two
// steps, and both are pinned at compile time:
//
//   - **Own property?** In STANDALONE mode a `$__fnctor_F` instance is a CLOSED
//     WasmGC struct: `deriveFnctorFields` computes the complete field list, and
//     the expando sidecar that would let a property appear at runtime is
//     explicitly host-mode-only ("Host mode already has its fnctor sidecar for
//     expando properties… This native shape growth is the host-free standalone
//     replacement only", fnctor-escape-gate.ts). So the only own-property
//     shadow possible is a DECLARED field of that struct, which
//     {@link admitDirectCall} rejects by name — together with accessor names
//     and the reserved-name set the pinned path itself refuses. This is why S3
//     does not need `otherNameWrites` to be non-null: acorn trips that sentinel
//     with `keywordTypes[name] = …` (a plain object, not a Parser), and the
//     closed-struct argument is both stronger and receiver-shape-based, exactly
//     as the S1 design note required.
//   - **Prototype slot?** The S1 write-once verdict says `F.prototype.<m>` is
//     assigned exactly once, unconditionally, at module top level, and never
//     written again; `poisoned` excludes any class whose prototype OBJECT was
//     reassigned, computed-written, deleted from, or escaped. `inheritedFrom`
//     excludes classes whose prototype is an `Object.create` argument, so no
//     foreign receiver can inherit `m` and override it.
//
// Everything the analysis cannot prove DECLINES, and a decline is
// byte-for-byte the pre-S3 lowering (the call falls through to
// `tryCompileLateFnctorPrototypeMethodCall`'s `__call_m_*` emission). The
// failure mode is only ever "miss a devirtualization".
//
// ## Kill-switch / diagnostics
//
// `JS2WASM_DIRECT_CALLS=0` disables the whole slice (call sites decline before
// any reservation, so the module is pre-S3 byte-for-byte).
// `JS2WASM_DIRECT_CALLS_DEBUG=1` prints, at process exit, the number of
// devirtualized sites, the number of trampolines that had to degrade to the
// legacy fill, and a histogram of decline reasons.

/** Env kill-switch: `JS2WASM_DIRECT_CALLS=0` disables S3 devirtualization. */
function directCallsEnabled(): boolean {
  return process.env.JS2WASM_DIRECT_CALLS !== "0";
}

/**
 * (#3683 S3b) `JS2WASM_DIRECT_CALLS=nopad` keeps S3's exact-arity devirtualization
 * but declines every UNDER-APPLIED site, reproducing the S3-only module. This is
 * the isolation switch the S3b measurement is taken against: `0` bisects the
 * whole direct-call slice, `nopad` bisects only the arity padding, so the two
 * A/B arms attribute the delta to the right change.
 */
function arityPaddingEnabled(): boolean {
  return process.env.JS2WASM_DIRECT_CALLS !== "nopad";
}

/** (#3683 S3) Devirtualization tallies — inert unless `_DEBUG=1`. */
export const directCallStats = {
  sites: 0,
  trampolines: 0,
  twinFills: 0,
  genericFills: 0,
  legacyFills: 0,
  legacyReasons: new Map<string, number>(),
  declined: new Map<string, number>(),
};
let directStatsHookInstalled = false;
function noteDirectStats(): void {
  if (directStatsHookInstalled || process.env.JS2WASM_DIRECT_CALLS_DEBUG !== "1") return;
  directStatsHookInstalled = true;
  process.on("exit", () => {
    const top = [...directCallStats.declined.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    process.stderr.write(
      `[direct-calls] sites=${directCallStats.sites} trampolines=${directCallStats.trampolines} ` +
        `twinFills=${directCallStats.twinFills} genericFills=${directCallStats.genericFills} ` +
        `legacyFills=${directCallStats.legacyFills}\n` +
        `[direct-calls] legacy: ${[...directCallStats.legacyReasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}\n` +
        `[direct-calls] declined: ${top.map(([k, v]) => `${k}=${v}`).join(" ")}\n`,
    );
  });
}
function declineDirect(reason: string): undefined {
  if (process.env.JS2WASM_DIRECT_CALLS_DEBUG === "1") {
    noteDirectStats();
    directCallStats.declined.set(reason, (directCallStats.declined.get(reason) ?? 0) + 1);
  }
  return undefined;
}

/**
 * (#3683 S3) One reserved `__dc_<F>_<m>_<n>` trampoline, filled at finalize.
 *
 * ## ABI note: why the RECEIVER parameter is `externref`, not `(ref $__fnctor_F)`
 *
 * The natural signature is `(ref $__fnctor_F, ...params)` — the receiver is
 * already in a typed register at every call site. It cannot be used, because of
 * a latent imprecision in the `ref.null.extern` retyping fixup
 * (`fixups.ts`, the backward walk at the end of `applyRefNullFixups`): from a
 * `call`, it walks backwards mapping ONE INSTRUCTION per parameter, and skips a
 * nested `call`'s own arguments by subtracting the callee's PARAMETER COUNT —
 * i.e. it silently assumes every argument is produced by exactly one
 * instruction. Acorn's
 *
 *     this.parseExprOp(this.parseMaybeUnary(null, false, false, forInit), …)
 *
 * breaks that assumption: the two `false` arguments are `i32.const 0` +
 * `call __box_boolean`, two instructions each, so the OUTER walk under-skips by
 * two and lands the inner call's `ref.null.extern` on the outer callee's
 * PARAMETER 0. Every pre-existing callee in that position (`__call_m_*`,
 * `__extern_method_call`) has an all-`externref` signature, so the misaligned
 * landing was harmless — the fixup only rewrites when the parameter is a
 * `ref`/`ref_null`. A typed receiver made parameter 0 a struct ref for the
 * first time, and the null was rewritten to `ref.null $__fnctor_Parser`,
 * failing validation ("call[1] expected type externref").
 *
 * Rather than re-engineer a shared fixup that would need a real operand-count
 * model (and whose current approximations other lowerings may depend on), S3
 * keeps its own signature outside the hazard: the receiver travels as
 * `externref` and a call with any `ref`-typed user parameter simply declines.
 * No `__dc_*` signature then contains a `ref`/`ref_null`, so a misaligned
 * landing is a no-op exactly as it is for `__call_m_*`. The cost is one
 * `extern.convert_any` per call site and one `any.convert_extern; ref.cast`
 * per trampoline — both trivial against the bridge being removed. The fixup
 * imprecision itself is a genuine pre-existing bug and is recorded in the
 * #3683 issue notes.
 */
export interface DirectCallTrampoline {
  /** Stable defined-function handle — safe to bake into `call` immediates. */
  readonly funcIdx: number;
  readonly className: string;
  readonly methodName: string;
  /** CALL-SITE argument count. `arity <= formals`; see {@link padInstrs}. */
  readonly arity: number;
  /**
   * (#3683 S3b) The CALLEE's declared parameter count. Equal to `arity` for an
   * exact-arity site; strictly greater for an UNDER-APPLIED one, in which case
   * the trampoline materializes the `formals - arity` missing arguments itself.
   */
  readonly formals: number;
  /** The receiver's `$__fnctor_F` type index — the trampoline casts back to it. */
  readonly fnctorStructTypeIdx: number;
  /**
   * (#3685 S3) The receiver's shape is proven STATICALLY by the receiver-flow
   * analysis rather than by a `ref.cast` the call site already performed.
   *
   * This flips the fill from an unguarded `ref.cast` to a `ref.test`-guarded
   * two-arm body. It is load-bearing, not defensive: the `this`-receiver form
   * (#3683 S3) is sound because the ONLY way to reach the call site is through
   * the twin's own cast, so a mis-cast is impossible by construction. A
   * receiver-flow verdict carries no such guarantee — it is a whole-program
   * inference, and an unguarded cast would turn any imprecision in it into a
   * runtime trap with no fallback. The guard costs one `ref.test` and degrades
   * to the legacy dispatcher, so an analysis bug becomes a missed optimization
   * instead of a crash.
   */
  readonly guardedReceiver: boolean;
  /** `[externref, ...userParams]`, all non-`ref` (see the ABI note). */
  readonly params: ValType[];
  /**
   * (#3683 S3b) One instruction sequence per MISSING formal (`formals - arity`
   * entries, for callee param indices `arity .. formals-1`), each leaving one
   * value of the matching {@link padTypes} entry on the stack. Built at RESERVE
   * time — the fill is read-only over the module — and funcIdx-free, so it is
   * immune to late-import index shifts.
   */
  readonly padInstrs: Instr[][];
  /** The twin's declared param types for the padded slots (fill-time check). */
  readonly padTypes: ValType[];
  /**
   * The callee's wasm results: one entry, or EMPTY for a void-returning method
   * (acorn's `this.next()` / `this.expect(...)` — the hottest calls in the
   * tokenizer). A void trampoline yields nothing and the call site answers
   * `VOID_RESULT`, which `compileExpression` materializes into whatever the
   * consuming context actually needs.
   */
  readonly results: ValType[];
  /** `__call_m_<m>_<n>` handle — the byte-for-byte legacy degradation target. */
  readonly legacyDispatchIdx: number;
  readonly currentThisGlobalIdx: number;
  readonly argcGlobalIdx: number;
  /**
   * Parameter-default prologues consult `__argc` to distinguish an omitted
   * native slot from an explicitly supplied value. Methods with no parameter
   * initializers (and no `arguments`, already an admission requirement) do not
   * observe that global, so their direct trampoline can omit the argc frame.
   */
  readonly needsArgcFrame: boolean;
}

/**
 * (#3683 S3) The few compiler services the call-site emitter needs that live in
 * modules importing THIS one (`closures.ts`, `closed-method-dispatch.ts`).
 * Passed in as thunks rather than imported so the module graph stays acyclic
 * and so the globals are only materialized on a site that actually devirtualizes.
 */
export interface DirectCallDeps {
  /** `computeClosureWrapperSig` — the twin's exact param/return ValTypes. */
  computeSig(fn: ts.FunctionExpression): { params: ValType[]; returnType: ValType | null };
  /** `reserveClosedMethodDispatch` — the SAME dispatcher this site would
   *  otherwise have reserved, so no new dispatcher appears in the module. */
  reserveLegacyDispatch(methodName: string, arity: number): number;
  ensureCurrentThisGlobal(): number;
  ensureArgcGlobal(): number;
  /**
   * (#3683 S3b) `undefinedExternInstrs` — the canonical externref-plane
   * `undefined` (`global.get $undefined; extern.convert_any` under the #2106
   * singleton regime, `undefined` when the regime is off so the caller falls
   * back to `ref.null.extern`). This is the EXACT value `__apply_closure`'s
   * `ARG_OF(k)` hands a missing argument, so it is what a padding trampoline
   * must reproduce.
   */
  undefinedExtern(): Instr[] | undefined;
}

/** `runtimeParameters` (closures.ts), duplicated to keep this module acyclic. */
function runtimeParams(fn: ts.FunctionExpression): readonly ts.ParameterDeclaration[] {
  const ps = fn.parameters;
  const first = ps.length > 0 ? ps[0] : undefined;
  return first && ts.isIdentifier(first.name) && first.name.escapedText === "this" ? ps.slice(1) : ps;
}

/**
 * Does the body reference `arguments`? A direct call bypasses the
 * `__argc`/`__extras_argv` extras protocol the `arguments` vec is built from,
 * so such a method keeps the dynamic path. Admission already forbids nested
 * function-likes, so a plain walk cannot cross a scope boundary that would
 * rebind the name.
 */
function bodyUsesArguments(body: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === "arguments") {
      found = true;
      return;
    }
    forEachChild(n, walk);
  };
  forEachChild(body, walk);
  return found;
}

/**
 * (#3683 S3) Record the compiled twin of a write-once prototype method so
 * `fillDirectCallTrampolines` can resolve it BY NAME (never by index —
 * `ctx.funcMap` is the shift-maintained source of truth, a captured raw index
 * is not). The recorded signature is what the fill checks the trampoline's
 * against before baking a direct `call`.
 */
export function recordDirectCallTwin(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  twinName: string,
  params: ValType[],
  results: ValType[],
): void {
  const key = writeOnceMethodKeyOf(ctx, arrow);
  if (key === undefined) return;
  (ctx.directCallTwins ??= new Map()).set(key, { twinName, params: [...params], results: [...results] });
}

/**
 * (#3780) Record a direct target for an admitted write-once method whose body
 * could not be compiled as a typed-`this` twin, usually because the closure
 * captures module state. The lifted body is still statically known; it only
 * needs the exact closure instance as parameter 0. Retaining that instance in
 * a typed nullable global lets the final trampoline call the lifted body
 * directly while preserving every capture.
 *
 * Returns the global index so the closure construction site can store the
 * instance without changing the value subsequently assigned to the prototype.
 */
export function recordDirectCallGeneric(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  liftedName: string,
  selfTypeIdx: number,
  params: ValType[],
  results: ValType[],
): number | undefined {
  if (!ctx.standalone || !directCallsEnabled()) return undefined;
  if (!ts.isFunctionExpression(arrow) || arrow.name || arrow.asteriskToken) return undefined;
  if (arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
  if (!arrow.body || !ts.isBlock(arrow.body)) return undefined;
  if (bodyHasNestedFunctionLikeOrWith(arrow.body) || bodyUsesArguments(arrow.body)) return undefined;
  if (runtimeParams(arrow).some((p) => p.dotDotDotToken !== undefined)) return undefined;
  const key = writeOnceMethodKeyOf(ctx, arrow);
  if (key === undefined) return undefined;
  const existing = ctx.directCallGenerics?.get(key);
  if (existing) return existing.selfGlobalIdx;

  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  const safeName = key.replace(/[^A-Za-z0-9_$]/g, "_");
  ctx.mod.globals.push({
    name: `__dc_self_${safeName}`,
    type: { kind: "ref_null", typeIdx: selfTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: selfTypeIdx }],
  });
  (ctx.directCallGenerics ??= new Map()).set(key, {
    liftedName,
    selfGlobalIdx: globalIdx,
    selfTypeIdx,
    params: [...params],
    results: [...results],
  });
  return globalIdx;
}

/**
 * (#3754) The twin's REFINED wasm result, or `undefined` to keep the declared
 * one.
 *
 * ## The problem
 *
 * A fnctor prototype method is declared with an UNTYPED receiver
 * (`P.prototype.inc = function () { return this.n + 1; }`), so the checker
 * types `this` as `any`, so the return is `any`, so the twin's result lowers to
 * `externref`. But inside the twin `this` is a `(ref $__fnctor_P)` whose
 * numeric fields are physical `f64` slots (#3683 S4a) — the value being
 * returned IS an f64, and the twin boxes it purely to satisfy a signature
 * derived from the declaration rather than from the body.
 *
 * The caller then pays for that box on the way back in: the `method` axis
 * emitted `call $__dc_P_inc_0_g; call $__to_primitive; call $__unbox_number`
 * per iteration (#3754's profile), where the arithmetic itself is one
 * `f64.add`.
 *
 * ## Why the fixpoint's verdict is the right evidence
 *
 * `numericFunctionNames` is the whole-program fixpoint's answer to "does EVERY
 * function of this name return a number on EVERY path". It is exactly the
 * conservative rule #3753 asked for, and it is already load-bearing elsewhere
 * (`provenNumericOperand` in binary-ops.ts trusts it to unbox an `any`-typed
 * operand). Its `ownReturnExpressions` precondition also rules out the two
 * shapes that would otherwise break a refined result — a bare `return;` and a
 * body that can fall off the end — because both yield `undefined`, not a
 * number. A method with mixed returns (`return 1` / `return "x"`) fails the
 * `every` and keeps `externref`, which is the documented risk.
 *
 * ## Why this cannot produce a stack-type mismatch
 *
 * The refined type is not asserted over the body — it is IMPOSED on it. The
 * twin compiles with `fctx.returnType = f64`, so every `return` runs the normal
 * `coerceType(<whatever the expression lowered to>, f64)` path, which is total
 * for every reference kind (externref / anyref / ref / ref_null) as well as the
 * numeric ones. So a return expression the fixpoint called numeric but codegen
 * happened to lower through the dispatcher still lands as an f64 — it just pays
 * an unbox that a fully-typed lowering would not. Correctness does not depend
 * on the fixpoint being tight, only on it being sound about "is a number".
 *
 * Both consumers — the twin's own minting in closures.ts and the trampoline
 * reservation below — ask THIS function, so they cannot disagree. If they ever
 * did, `fillDirectCallTrampolines` compares `twin.results` against the
 * trampoline's and degrades to the legacy dispatcher rather than emitting a
 * module that fails validation.
 */
export function refinedTwinReturnType(
  ctx: CodegenContext,
  fn: ts.ArrowFunction | ts.FunctionExpression,
  declared: ValType | null,
): ValType | undefined {
  // `JS2WASM_NUMERIC_TWINS=0` restores the externref twin ABI byte-for-byte,
  // which is what makes the A/B differential for this slice possible.
  if (process.env.JS2WASM_NUMERIC_TWINS === "0") return undefined;
  if (!ctx.standalone || !directCallLoweringEnabled()) return undefined;
  // Only worth doing — and only SOUND to do — when the declared result is the
  // boxed one. Anything else is already a native type the body agrees with.
  if (declared === null || declared.kind !== "externref") return undefined;
  // The shim in the generic body has to box the refined result back up; without
  // the helper to do it there is no lowering, so decline before the twin is
  // minted rather than after.
  if (ctx.funcMap.get("__box_number") === undefined) return undefined;
  const key = writeOnceMethodKeyOf(ctx, fn);
  if (key === undefined) return undefined;
  const methodName = key.slice(key.indexOf("/") + 1);
  if (ctx.numericFunctionNames?.has(methodName) !== true) return undefined;
  return { kind: "f64" };
}

/**
 * Memoized `FunctionLikeDeclaration → "<F>/<m>"` view of the S1 verdicts — the
 * method-name-carrying twin of {@link writeOnceOwnerOf}.
 */
function writeOnceMethodKeyOf(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration): string | undefined {
  let index = ctx.typedThisWriteOnceKeyIndex;
  if (index === undefined) {
    index = new Map<ts.FunctionLikeDeclaration, string>();
    for (const [className, methods] of ctx.fnctorEscapeGate?.protoMethodWriteOnce.methods ?? []) {
      for (const [methodName, rhs] of methods) index.set(rhs, `${className}/${methodName}`);
    }
    ctx.typedThisWriteOnceKeyIndex = index;
  }
  return index.get(fn);
}

/**
 * (#3683 S3) Decide whether `this.<methodName>(...)` inside the twin of class
 * `className` may be devirtualized. Returns the callee's write-once RHS on a
 * hit. Every clause is documented in the module-section header above; the short
 * form is "the receiver's shape is proven, the slot is provably the single
 * write-once closure, and the twin ABI can express this call exactly".
 */
function admitDirectCall(
  ctx: CodegenContext,
  structName: string,
  className: string,
  methodName: string,
): ts.FunctionExpression | undefined {
  const gate = ctx.fnctorEscapeGate?.protoMethodWriteOnce;
  if (!gate) return declineDirect("no-gate");
  if (gate.poisoned.has(className)) return declineDirect("poisoned-class");
  // `Object.create(F.prototype)` — some foreign object inherits `m` and may
  // override it. The `ref.cast $__fnctor_F` receiver excludes such an object in
  // practice (it is a `$Object`, not this struct), but the whole point of the
  // S1 fact is to not have to rely on that.
  if (gate.inheritedFrom.has(className)) return declineDirect("inherited-from");
  const fn = gate.methods.get(className)?.get(methodName);
  if (fn === undefined) return declineDirect("no-write-once-verdict");
  if (!ts.isFunctionExpression(fn)) return declineDirect("not-fn-expr");
  if (fn.name) return declineDirect("named-fn-expr");
  if (fn.asteriskToken) return declineDirect("generator");
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return declineDirect("async");
  if (!fn.body || !ts.isBlock(fn.body)) return declineDirect("no-block-body");
  // Mirror the twin's own admission so a devirtualized site normally lands on a
  // real twin rather than the trampoline's legacy degradation.
  if (bodyHasNestedFunctionLikeOrWith(fn.body)) return declineDirect("nested-fn-like");
  if (bodyUsesArguments(fn.body)) return declineDirect("uses-arguments");
  if (runtimeParams(fn).some((p) => p.dotDotDotToken !== undefined)) return declineDirect("rest-param");

  // Own-property shadowing (see the header): the only slot that can shadow the
  // prototype on a closed standalone fnctor struct is a DECLARED field.
  if (RESERVED_PROPS.has(methodName)) return declineDirect(`reserved:${methodName}`);
  if (ctx.classAccessorSet.has(`${structName}_${methodName}`)) return declineDirect("accessor-name");
  if (ctx.structFields.get(structName)?.some((f) => f.name === methodName)) return declineDirect("own-field");

  // The callee's lifted body must pin `this` to the SAME struct the caller's
  // does — otherwise its twin (if any) is typed against a different receiver.
  //
  // "is `fn` a prototype method of `className`?" is NOT re-derived here: `fn`
  // was read out of `gate.methods.get(className)`, so S1 has already
  // established `<className>.prototype.<methodName> = fn` as the program's
  // single unconditional top-level write. Re-asking the checker
  // (`resolveEnclosingFnctorOwner`) would answer the same question from a
  // second source, and it is the one query in this admission that needs the raw
  // `ts.Type` surface the oracle ratchet (#1930/#3273) is steering code away
  // from — so the redundancy is worth avoiding on both counts.
  if (resolveLiftedMethodThisStruct(ctx, fn) !== structName) return declineDirect("this-pin-mismatch");
  return fn;
}

/**
 * (#3683 S3b) Build the value a padding trampoline passes for ONE missing
 * formal, or `undefined` to decline the whole call site.
 *
 * ## The convention this reproduces — MEASURED, not inferred
 *
 * An under-applied dynamic call reaches the callee through `__extern_method_call`
 * → `__apply_closure` → `__call_fn_method_<formals>`. Two pieces of state decide
 * what the body observes, and BOTH are reproduced here + in the trampoline
 * prologue:
 *
 *  1. **The missing argument's VALUE.** `__apply_closure`'s `ARG_OF(k)` answers
 *     `undefinedExternInstrs(ctx)` (the #2106 `$undefined` singleton, or
 *     `ref.null.extern` with the regime off) for every `k >= args.length` — the
 *     #3592 widening raises the DISPATCH SELECTOR to `declaredArity` without
 *     padding the args vector, so the out-of-bounds read is the pad. An
 *     `externref` formal therefore receives exactly that, and a defaulted
 *     `externref` formal fires its default because
 *     `emitParamDefaultCheckInline` tests `__extern_is_undefined`.
 *
 *  2. **`__argc`.** The S3 implementation note claimed the widening leaves
 *     `__argc` at `formals`. **It does not** — `fillApplyClosure` presets
 *     `__argc` to the RAW call-site count *before* widening only the selector
 *     ("Preserve the raw call-site count in `__argc`…"), and
 *     `emitClosureMethodCallExportN`'s #2745 setup then clamps it to
 *     `min(preset, closureArity)`, which for an under-applied call is the
 *     call-site count again. Measured on this branch: a 3-formal method called
 *     with one argument observes `arguments.length === 1`, and an f64 defaulted
 *     formal (whose default check is the argc-driven
 *     `emitParamDefaultArgMissingCheck`, NOT a value test) correctly takes its
 *     default. So the trampoline keeps writing `i32.const <call-site arity>` —
 *     which is what it already did, since S3's `arity` IS the call-site count.
 *
 * Given (2), a NATIVE-typed (`f64`/`i32`) padded slot splits in two:
 *
 *  - **with an initializer** — the argc check `argc != -1 && argc <= k` is TRUE
 *    for every padded index `k >= arity`, so the default unconditionally
 *    overwrites the slot and the padded bits are dead. A zero constant is then
 *    exactly as correct as the legacy `__unbox_number(undefined)` and costs one
 *    instruction instead of a call.
 *  - **without an initializer** — the body READS the raw value, whose legacy
 *    production is `__unbox_number(<undefined>)` (and, for `i32`, a
 *    `i32.trunc_f64_s` that TRAPS on the resulting NaN). Reproducing a trap is
 *    not worth a devirtualization, and guessing a different value would be a
 *    silent divergence, so the site DECLINES. Acorn has no such formal (every
 *    parser method parameter is `any` ⇒ `externref`).
 */
function buildPadValue(type: ValType, formal: ts.ParameterDeclaration, deps: DirectCallDeps): Instr[] | undefined {
  if (type.kind === "externref") {
    // Copy the instructions: the record is long-lived and shared by every call
    // site of this (method, arity), while `Instr` objects are rewritten in place
    // by the late-import shifter.
    return (deps.undefinedExtern() ?? [{ op: "ref.null.extern" }]).map((i) => ({ ...i }));
  }
  if (formal.initializer === undefined) return undefined;
  if (type.kind === "f64") return [{ op: "f64.const", value: 0 }];
  if (type.kind === "i32") return [{ op: "i32.const", value: 0 }];
  return undefined;
}

/** Idempotently reserve the `__dc_<F>_<m>_<n>` trampoline for one method. */
function reserveDirectCallTrampoline(
  ctx: CodegenContext,
  spec: {
    className: string;
    methodName: string;
    arity: number;
    formals: number;
    fnctorStructTypeIdx: number;
    params: ValType[];
    padInstrs: Instr[][];
    padTypes: ValType[];
    results: ValType[];
    guardedReceiver: boolean;
    needsArgcFrame: boolean;
    deps: DirectCallDeps;
  },
): DirectCallTrampoline {
  // The guard flag is part of the KEY: a guarded and an unguarded trampoline
  // for the same (class, method, arity) have different bodies, so they cannot
  // share a handle. Without this, whichever site reserved first would silently
  // decide the other's soundness.
  const key = `${spec.className}/${spec.methodName}/${spec.arity}${spec.guardedReceiver ? "/g" : ""}`;
  const table = (ctx.directCallTrampolines ??= new Map());
  const existing = table.get(key);
  if (existing) return existing;
  const name = `__dc_${spec.className}_${spec.methodName}_${spec.arity}${spec.guardedReceiver ? "_g" : ""}`;
  // Reserve the legacy dispatcher FIRST: it is the fill's degradation target,
  // it registers every box/unbox helper the fill needs, and it is the exact
  // dispatcher this call site would have reserved without S3 — so the set of
  // `__call_m_*` functions in the module is unchanged. Its import churn must
  // settle before this trampoline's own handle is minted (the #2681 ordering
  // trap `reserveMemberGetDispatch` documents).
  const legacyDispatchIdx = spec.deps.reserveLegacyDispatch(spec.methodName, spec.arity);
  const currentThisGlobalIdx = spec.deps.ensureCurrentThisGlobal();
  const argcGlobalIdx = spec.deps.ensureArgcGlobal();
  const typeIdx = addFuncType(ctx, spec.params, spec.results, `${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }], // filled by fillDirectCallTrampolines
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  const record: DirectCallTrampoline = {
    funcIdx,
    className: spec.className,
    methodName: spec.methodName,
    arity: spec.arity,
    formals: spec.formals,
    fnctorStructTypeIdx: spec.fnctorStructTypeIdx,
    params: spec.params,
    padInstrs: spec.padInstrs,
    padTypes: spec.padTypes,
    results: spec.results,
    guardedReceiver: spec.guardedReceiver,
    legacyDispatchIdx,
    currentThisGlobalIdx,
    argcGlobalIdx,
    needsArgcFrame: spec.needsArgcFrame,
  };
  table.set(key, record);
  directCallStats.trampolines++;
  return record;
}

/**
 * (#3683 S3) Lower `this.<m>(a, b)` inside a typed twin to a direct call.
 * Returns the call's ValType on a hit, or `undefined` to decline — in which
 * case the caller's existing `__call_m_*` emission runs unchanged.
 */
// (#3685 S2) `JS2WASM_PROVEN_FIELDS=0` disables proven-receiver field reads,
// leaving every non-`this` read on the pre-existing dynamic path. Mirrors the
// #3683 kill-switches so a suspected miscompile can be bisected to this slice
// without a rebuild.
function provenFieldsEnabled(): boolean {
  return process.env.JS2WASM_PROVEN_FIELDS !== "0";
}

const provenFieldStats = { gets: 0 };

/** `JS2WASM_PROVEN_FIELDS_DEBUG=1` prints the inlined-read count at exit. */
if (process.env.JS2WASM_PROVEN_FIELDS_DEBUG === "1") {
  process.on("exit", () => {
    if (provenFieldStats.gets > 0) console.error(`[proven-fields] inlined reads=${provenFieldStats.gets}`);
  });
}

/**
 * (#3685 S2) `recv.<field>` READ where the receiver-flow analysis proves
 * `recv`'s class — the non-`this` counterpart of {@link tryEmitTypedThisFieldGet}.
 *
 * #3683 S2 inlined `this.X` to a bare `struct.get` inside a typed twin. Every
 * OTHER receiver kept the dispatcher call: `node.start`, `state.pos`,
 * `refDestructuringErrors.shorthandAssign` — the `__extern_get` 8.8% self-time
 * bucket the #3673 round-26 profile named. This lowers those to the same
 * `struct.get`.
 *
 * Guarded, for the reason spelled out on `DirectCallTrampoline.guardedReceiver`:
 * the `this` form's proof is the twin's own `ref.cast`, but a receiver-flow
 * verdict is a whole-program inference, so an unguarded `ref.cast` would turn
 * imprecision into a trap. Shape:
 *
 *     <recv> -> tmp                       ; evaluated exactly once
 *     if (ref.test $__fnctor_F tmp)
 *       then struct.get $__fnctor_F <field>
 *       else <field type>(__extern_get(tmp, "<field>"))
 *
 * The else arm is the pre-existing dynamic read, so a wrong verdict costs a
 * slow read and never a wrong value.
 */
export function tryEmitProvenReceiverFieldGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (!provenFieldsEnabled() || !ctx.standalone) return undefined;
  // `this` is #3683 S2's, with a strictly stronger proof — never take it here.
  if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) return undefined;
  if (ts.isPrivateIdentifier(expr.name)) return undefined;
  if (expr.questionDotToken) return undefined;

  // (#3685 step 1) Every exit below this point is tallied when
  // `JS2WASM_PROVEN_RECEIVER_STATS=1`; see `proven-receiver-stats.ts` for why.
  noteProvenReceiverPhase("asked");
  const cls = provenReceiverClass(ctx, fctx, expr.expression);
  if (cls === undefined) {
    noteProvenReceiver("unproven-receiver");
    return undefined;
  }
  noteProvenReceiverPhase("proven");
  const structName = `__fnctor_${cls}`;
  const structTypeIdx = ctx.structMap.get(structName);
  if (structTypeIdx === undefined) {
    noteProvenReceiver(`no-struct:${cls}`);
    return undefined;
  }

  // Same carve-outs as the `this` form — they are semantic, not incidental.
  if (RESERVED_PROPS.has(propName)) {
    // Annotated with what the name WOULD have resolved to, so the census can
    // say whether this carve-out shadows a real declared slot or is a no-op.
    // The lookup is behind the gate so the shipping path adds no work at all.
    if (provenReceiverStatsEnabled()) {
      const slot = ctx.structFields.get(structName)?.find((f) => f.name === propName);
      const shape = slot === undefined ? "no-such-field" : slot.presenceTracked ? "presence-tracked" : "plain-field";
      noteProvenReceiver(`reserved:${cls}.${propName}:${shape}`);
    }
    return undefined;
  }
  if (ctx.classAccessorSet.has(`${structName}_${propName}`)) {
    noteProvenReceiver(`accessor:${cls}.${propName}`);
    return undefined;
  }
  const fields = ctx.structFields.get(structName);
  if (!fields) {
    noteProvenReceiver(`no-field-table:${cls}`);
    return undefined;
  }
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx < 0) {
    noteProvenReceiver(`nofield:${cls}.${propName}`);
    return undefined;
  }
  const field = fields[fieldIdx]!;
  // A method-typed access keeps its closure lowering (S3 devirtualizes calls;
  // S2 must not box the callee). Ordered BEFORE the presence decision below:
  // the presence arm answers `undefined` for an absent slot, which must never
  // shadow a name that actually resolves to a prototype method.
  const accessType = ctx.checker.getTypeAtLocation(expr);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) {
    noteProvenReceiver(`callsig:${cls}.${propName}`);
    return undefined;
  }
  // (#3685 step 2) Presence-tracked ⇒ absence is semantic (`undefined`). That
  // is true of a BARE `struct.get` and false of the compiler:
  // `emitNullGuardedStructGet` already lowers exactly this shape for closed
  // structs (`presenceTestInstrs` → `if` → `struct.get` : `undefined`), and the
  // inline read below nests it inside the existing `ref.test` then-arm.
  //
  // HARD CORRECTNESS CONDITION — **externref slots only.** `undefined` has an
  // externref-plane representation (the #2106 `$undefined` singleton, or
  // `ref.null.extern` with that regime off). It has NONE in an f64/i32/i64
  // slot, where the absent arm would have to fall back to `defaultValueInstrs`
  // and silently substitute `0` for a value whose semantics are `undefined`. A
  // non-externref presence-tracked field is therefore still refused outright.
  let presenceSlot: PresenceSlot | undefined;
  if (field.presenceTracked) {
    if (field.type.kind !== "externref") {
      noteProvenReceiver(`presence-nonextern:${cls}.${propName}:${field.type.kind}`);
      return undefined;
    }
    presenceSlot = presenceSlotOf(fields, propName);
    if (presenceSlot === undefined) {
      // Tracked but with no resolvable bit/word — no test to emit, so decline.
      noteProvenReceiver(`presence-noslot:${cls}.${propName}`);
      return undefined;
    }
  }

  // A clear flow-presence bit is a logical own-property miss. In an active
  // inherited-descriptor module, route it to the dynamic getter so a fnctor
  // prototype can supply the value rather than inlining `undefined`.
  if (ctx.standalone && inheritedSetAffectsKey(ctx, propName) && presenceSlot !== undefined) {
    noteProvenReceiver(`inherited-presence:${cls}.${propName}`);
    return undefined;
  }

  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) {
    noteProvenReceiver("no-extern-get");
    return undefined;
  }

  // Evaluate the receiver ONCE into a temp, before the branch.
  const tmp = allocLocal(fctx, `__prf_${propName}_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
  if (recvType === null) {
    noteProvenReceiver(`receiver-void:${cls}.${propName}`);
    return undefined;
  }
  if (!valTypesMatch(recvType, { kind: "externref" })) {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: tmp });

  // Build the dynamic arm with the body-swap pattern — `coerceType` emits into
  // `fctx.body`, so it has to be captured rather than returned.
  const savedBody = fctx.body;
  fctx.body = [];
  fctx.body.push({ op: "local.get", index: tmp });
  for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: externGetIdx });
  if (!valTypesMatch({ kind: "externref" }, field.type)) {
    coerceType(ctx, fctx, { kind: "externref" }, field.type);
  }
  const elseArm = fctx.body;
  fctx.body = savedBody;

  // The inlined read, shared by both the guarded and the measurement lane. For
  // an always-present slot it is the plain cast + `struct.get`; for a
  // presence-tracked externref slot the cast result is teed into a typed local
  // (so the cast is paid once) and the presence bit selects value vs
  // `undefined` — the same shape `emitNullGuardedStructGet` emits.
  const castInstrs: Instr[] = [
    { op: "local.get", index: tmp },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: structTypeIdx },
  ];
  let inlineRead: Instr[];
  if (presenceSlot === undefined) {
    inlineRead = [...castInstrs, { op: "struct.get", typeIdx: structTypeIdx, fieldIdx }];
  } else {
    const castLocal = allocLocal(fctx, `__prfs_${propName}_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: structTypeIdx,
    });
    inlineRead = [
      ...castInstrs,
      { op: "local.tee", index: castLocal },
      ...presenceTestInstrs(structTypeIdx, presenceSlot),
      {
        op: "if",
        blockType: { kind: "val", type: field.type },
        then: [
          { op: "local.get", index: castLocal },
          { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
        ],
        // Absent ⇒ semantic `undefined`, never the slot's raw contents.
        else: undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }],
      },
    ];
  }

  // (#3685 S4 measurement) `JS2WASM_PROVEN_FIELDS=unguarded` drops the
  // `ref.test` and casts directly. UNSOUND as a shipping mode — an imprecise
  // verdict traps — and refused unless explicitly asked for. It exists to price
  // the guard: S4 (hoist one test per binding) is only worth building if the
  // gap between this and the guarded form is real. Mirrors `JS2WASM_TYPED_THIS=shim`.
  if (process.env.JS2WASM_PROVEN_FIELDS === "unguarded") {
    for (const instr of inlineRead) fctx.body.push(instr);
    provenFieldStats.gets++;
    noteProvenReceiverPhase("inlined");
    noteProvenReceiver(`ok-unguarded:${cls}.${propName}`);
    return field.type;
  }

  fctx.body.push(
    { op: "local.get", index: tmp },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: structTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: field.type },
      then: inlineRead,
      else: elseArm,
    },
  );
  provenFieldStats.gets++;
  noteProvenReceiverPhase("inlined");
  noteProvenReceiver(`ok:${cls}.${propName}:${field.type.kind}${presenceSlot === undefined ? "" : ":presence"}`);
  return field.type;
}

/**
 * (#3685 S3) Resolve a call's RECEIVER expression to a single approved fnctor
 * class, using the #3685 S1 receiver-flow analysis.
 *
 * The analysis is whole-program and pure, so it is computed once per source
 * file and memoized on the context. It is only ever consulted for receivers
 * that are NOT `this` — the `this` case has a stronger, local proof (#3683 S3).
 *
 * Returns `undefined` for anything unproven, which lands the call on the
 * pre-existing dynamic path.
 */
function provenReceiverClass(ctx: CodegenContext, fctx: FunctionContext, receiver: ts.Expression): string | undefined {
  // The write-once gate is OPTIONAL here: it only supplies the `poisoned` set,
  // and a program with no prototype methods at all (a data-only class like
  // acorn's `Node`) has no gate yet is a perfectly provable receiver. Soundness
  // does not rest on it — the emitted `ref.test` does.
  const gate = ctx.fnctorEscapeGate?.protoMethodWriteOnce;
  // Only bare identifiers for this slice. A property/element receiver
  // (`this.state.pos`) needs the S2 read lowering to type the intermediate, and
  // an arbitrary call receiver would have to be spilled to a temp to keep the
  // evaluate-once contract — both are separate slices.
  if (!ts.isIdentifier(receiver)) {
    noteReceiverNotIdentifier(receiver); // (#4405 Phase 0)
    return undefined;
  }

  const sf = receiver.getSourceFile();
  if (sf === undefined) return undefined;
  let result = ctx.receiverFlowByFile?.get(sf);
  if (result === undefined) {
    // Seed from every REGISTERED fnctor struct, not just classes that own a
    // write-once prototype method. Seeding from `gate.methods` admitted zero
    // data-only classes — and acorn's `Node` (the 130-access bucket the #3685
    // S1 tally named) is exactly that: fields, no prototype methods. A class
    // with no methods is still a perfectly provable RECEIVER for a field read.
    // Poisoned classes stay out: their prototype shape is not write-once, so
    // the method-call route must not admit them either.
    const approved = new Set<string>();
    // (#2071) A constructor whose body may `return` a FOREIGN object is not a
    // provable receiver at all: `new F()` may yield an arbitrary object
    // (§10.2.1.3 step 13), so the checker's F-instance shape — and every
    // field-typed narrowing derived from it — is unsound for such bindings
    // (measured: the else-arm's coerce-to-field-type turned an overriding
    // object's "A" into ToNumber("A") = NaN). Same pure-AST predicate the
    // ctor-ABI widening reads, so proof and ABI can never disagree.
    const foreignReturn = foreignReturnFunctionNames(sf);
    for (const structName of ctx.structMap.keys()) {
      if (!structName.startsWith("__fnctor_")) continue;
      const cls = structName.slice("__fnctor_".length);
      if (!gate?.poisoned.has(cls) && !foreignReturn.has(cls)) approved.add(cls);
    }
    result = analyzeReceiverFlow(sf, approved);
    (ctx.receiverFlowByFile ??= new Map()).set(sf, result);
  }
  // `enclosingClass` is the twin's own class when we are inside one; passing it
  // keeps `this` resolvable, though this path never asks about `this`.
  const enclosing = fctx.typedThisStructName?.slice("__fnctor_".length);
  const verdict = receiverClassOf(result, receiver, enclosing);
  // (#4405 Phase 0) Attribute every refusal to the pass that produced it.
  if (verdict === undefined) noteReceiverDeclineDetail(result, receiver);
  if (process.env.JS2WASM_PROVEN_FIELDS_DEBUG === "1") {
    console.error(
      `[proven-fields] receiver ${receiver.getText()} -> ${verdict ?? "(unproven)"}` +
        ` (verdicts=${result.byDeclaration.size} tally=${JSON.stringify(result.tally)})`,
    );
  }
  return verdict;
}

export function tryEmitDirectTwinCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  deps: DirectCallDeps,
): ValType | typeof VOID_RESULT | undefined {
  if (!directCallsEnabled() || !ctx.standalone) return undefined;
  if (ts.isPrivateIdentifier(propAccess.name)) return undefined;

  // Three admission routes to the SAME trampoline machinery:
  //
  //  (a) #3683 S3 — `this.m()` inside a typed twin. The receiver-shape proof is
  //      the twin's own `ref.cast`, so the trampoline may cast unguarded.
  //  (b) #3780 — `this.m()` inside the generic lifted body of a statically
  //      pinned prototype method. The body can be invoked detached, so this
  //      route is guarded against the runtime `this` just like receiver flow.
  //  (c) #3685 S3 — `recv.m()` anywhere, where the receiver-flow analysis
  //      proves `recv` denotes exactly one approved fnctor class. The proof is
  //      an inference, so the trampoline is GUARDED (see `guardedReceiver`).
  //
  // (a) is tried first and is unchanged byte-for-byte, so no existing site
  // moves onto the guarded path.
  const isThis = propAccess.expression.kind === ts.SyntaxKind.ThisKeyword;
  let structName = fctx.typedThisStructName;
  let thisLocalIdx = fctx.typedThisLocalIdx;
  let structTypeIdx = fctx.typedThisStructIdx;
  let guardedReceiver = false;

  if (!isThis || structName === undefined || thisLocalIdx === undefined || structTypeIdx === undefined) {
    if (isThis) {
      if (process.env.JS2WASM_PINNED_THIS_DIRECT_CALLS === "0") return undefined;
      const pinned = fctx.thisStructName;
      const pinnedIdx = pinned === undefined ? undefined : ctx.structMap.get(pinned);
      if (pinned === undefined || pinnedIdx === undefined) return undefined;
      structName = pinned;
      structTypeIdx = pinnedIdx;
      thisLocalIdx = undefined; // compile `this` from `__current_this`
      guardedReceiver = true;
    } else {
      const provenClass = provenReceiverClass(ctx, fctx, propAccess.expression);
      if (provenClass === undefined) return undefined;
      const proven = `__fnctor_${provenClass}`;
      const provenIdx = ctx.structMap.get(proven);
      if (provenIdx === undefined) return declineDirect("no-struct-for-proven-class");
      structName = proven;
      structTypeIdx = provenIdx;
      thisLocalIdx = undefined; // the receiver is an expression, not a local
      guardedReceiver = true;
    }
  }
  noteDirectStats();
  // `this.m?.()` / `this?.m()` keep the dynamic path (the nullish short-circuit
  // is the dispatcher's, and a devirtualized call would skip it).
  if (propAccess.questionDotToken || expr.questionDotToken) return declineDirect("optional-chain");
  if (expr.typeArguments && expr.typeArguments.length > 0) return declineDirect("type-arguments");
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return declineDirect("spread-arg");

  const methodName = propAccess.name.text;
  const className = structName.slice("__fnctor_".length);
  const fn = admitDirectCall(ctx, structName, className, methodName);
  if (fn === undefined) return undefined;

  // (#3683 S3b) UNDER-application (`this.parseIdent()` into a 1-formal method)
  // is admitted: the trampoline materializes the missing arguments itself, per
  // the convention documented on {@link buildPadValue}. OVER-application still
  // declines — the extra arguments must be evaluated for their side effects and
  // then routed into the `__extras_argv` canonical vector, a separate protocol.
  const formals = runtimeParams(fn);
  const argc = expr.arguments.length;
  if (argc > formals.length) return declineDirect("arity-over");
  if (argc < formals.length && !arityPaddingEnabled()) return declineDirect("arity-under-nopad");

  const sig = deps.computeSig(fn);
  if (sig.params.length !== formals.length) return declineDirect("sig-arity-skew");

  // No `ref`/`ref_null` in the trampoline's own signature — see the ABI note on
  // `DirectCallTrampoline`. A struct-typed formal is rare (acorn has none) and
  // declining costs only a missed devirtualization. The check covers the PADDED
  // slots too: they are the twin's parameters, not the trampoline's, but a
  // `ref`-typed pad would be a `ref.null $T` the fixup walk could still land on.
  if (sig.params.some((p) => p.kind === "ref" || p.kind === "ref_null")) {
    return declineDirect("ref-typed-param");
  }

  // Build the pad BEFORE reserving: a slot we cannot express must decline
  // without leaving an orphan trampoline behind.
  const padTypes = sig.params.slice(argc);
  const padInstrs: Instr[][] = [];
  for (let k = argc; k < formals.length; k++) {
    const pad = buildPadValue(sig.params[k]!, formals[k]!, deps);
    if (pad === undefined) return declineDirect("pad-native-param");
    padInstrs.push(pad);
  }

  // (#3754) The trampoline's result must follow the TWIN's, not the
  // declaration's — otherwise the fill sees a signature disagreement and
  // degrades every devirtualized site to the legacy dispatcher.
  const refinedReturn = refinedTwinReturnType(ctx, fn, sig.returnType);
  const callResult = refinedReturn ?? sig.returnType;

  const tramp = reserveDirectCallTrampoline(ctx, {
    className,
    methodName,
    arity: argc,
    formals: formals.length,
    fnctorStructTypeIdx: structTypeIdx,
    // Only the SUPPLIED arguments are trampoline parameters; the rest are
    // synthesized inside it, so N call sites share one copy of the pad.
    params: [{ kind: "externref" }, ...sig.params.slice(0, argc)],
    padInstrs,
    padTypes,
    // Void callee ⇒ no wasm result. The legacy degradation target always yields
    // an externref, so the fill drops it in that arm (see below) — and when the
    // twin's result was refined to `f64`, that same arm unboxes it once through
    // `unboxFromExternref`, so both arms agree on the wasm result type.
    results: callResult === null ? [] : [callResult],
    guardedReceiver,
    needsArgcFrame:
      process.env.JS2WASM_ELIDE_UNUSED_ARGC_FRAME === "0" || formals.some((formal) => formal.initializer !== undefined),
    deps,
  });
  // The legacy-dispatcher reservation above may have added late imports; settle
  // the index shift before emitting into this body (the pre-existing
  // `tryCompileLateFnctorPrototypeMethodCall` does exactly the same).
  flushLateImportShifts(ctx, fctx);

  // Receiver first (a `local.get` — side-effect-free), then arguments strictly
  // left to right, matching the dynamic path's evaluation order. `__current_this`
  // is installed INSIDE the trampoline, i.e. after every argument has been
  // evaluated, which is also what the dynamic path does.
  if (thisLocalIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: thisLocalIdx });
    fctx.body.push({ op: "extern.convert_any" });
  } else {
    // (#3685 S3) Evaluate the receiver expression ONCE, in receiver-before-args
    // order — the same order the dynamic path uses.
    const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
    if (recvType === null) return declineDirect("receiver-compile-failed");
    if (!valTypesMatch(recvType, { kind: "externref" })) {
      coerceType(ctx, fctx, recvType, { kind: "externref" });
    }
  }
  for (let i = 0; i < argc; i++) {
    // Coerce against the TRAMPOLINE's DECLARED parameter, never the signature
    // just computed: the trampoline is shared by every call site of this
    // method, and it is its declaration the validator checks the call against.
    const want = tramp.params[i + 1] ?? { kind: "externref" as const };
    const got = compileExpression(ctx, fctx, expr.arguments[i]!, want);
    if (got === null) {
      fctx.body.push({ op: "ref.null.extern" });
      coerceType(ctx, fctx, { kind: "externref" }, want);
    } else if (!valTypesMatch(got, want)) {
      coerceType(ctx, fctx, got, want);
    }
  }
  fctx.body.push({ op: "call", funcIdx: tramp.funcIdx });
  directCallStats.sites++;
  // Report what the trampoline ACTUALLY leaves on the stack — a refined `f64`,
  // not the declaration's `externref`. Every consumer coerces from this, so a
  // stale answer here is the one way this slice could miscompile.
  return callResult ?? VOID_RESULT;
}

/** Box one native value already on the stack up to `externref`. */
function boxToExternref(ctx: CodegenContext, type: ValType, out: Instr[]): boolean {
  if (type.kind === "externref") return true;
  if (type.kind === "ref" || type.kind === "ref_null" || type.kind === "anyref") {
    out.push({ op: "extern.convert_any" });
    return true;
  }
  const boxNumIdx = ctx.funcMap.get("__box_number");
  if (boxNumIdx === undefined) return false;
  if (type.kind === "i32") {
    if (type.boolean) {
      const boxBoolIdx = ctx.funcMap.get("__box_boolean");
      if (boxBoolIdx === undefined) return false;
      out.push({ op: "call", funcIdx: boxBoolIdx });
      return true;
    }
    out.push({ op: "f64.convert_i32_s" });
  } else if (type.kind !== "f64") {
    return false;
  }
  out.push({ op: "call", funcIdx: boxNumIdx });
  return true;
}

/** Unbox one `externref` already on the stack down to `type`. */
function unboxFromExternref(ctx: CodegenContext, type: ValType, out: Instr[]): boolean {
  if (type.kind === "externref") return true;
  if (type.kind === "anyref") {
    out.push({ op: "any.convert_extern" });
    return true;
  }
  if (type.kind === "ref" || type.kind === "ref_null") {
    out.push({ op: "any.convert_extern" });
    out.push({ op: "ref.cast", typeIdx: type.typeIdx });
    return true;
  }
  if (type.kind === "i32" && type.boolean) {
    const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean");
    if (unboxBoolIdx === undefined) return false;
    out.push({ op: "call", funcIdx: unboxBoolIdx });
    return true;
  }
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  if (unboxNumIdx === undefined) return false;
  if (type.kind === "f64") {
    out.push({ op: "call", funcIdx: unboxNumIdx });
    return true;
  }
  if (type.kind === "i32") {
    out.push({ op: "call", funcIdx: unboxNumIdx });
    out.push({ op: "i32.trunc_sat_f64_s" });
    return true;
  }
  return false;
}

/**
 * (#3683 S3) Fill every reserved `__dc_<F>_<m>_<n>` at FINALIZE, when the twin
 * set is complete. Strictly read-only over `funcMap` — it mints nothing and
 * adds no imports (every dependency was registered at reserve time, mirroring
 * `fillMemberGetDispatch`). Must run AFTER `fillClosedMethodDispatch` is
 * reserved and after `addUnionImports`, so the box/unbox helpers resolve.
 *
 * Body shape (`P = 1 + arity` params, `prev`/`res` appended as locals):
 *
 *     global.get __current_this ; local.set $prev
 *     local.get 0 ; global.set __current_this
 *     i32.const <arity> ; global.set __argc
 *     <arm>                       ;; leaves the result on the stack
 *     local.set $res
 *     i32.const -1 ; global.set __argc
 *     local.get $prev ; global.set __current_this
 *     local.get $res
 *
 * where `<arm>` is either
 *
 *     local.get 0 ; any.convert_extern ; ref.cast $__fnctor_F   ;; the twin's
 *     local.get 1 … local.get n                                 ;; receiver
 *     <pad>                       ;; (#3683 S3b) one per MISSING formal
 *     call $twin
 *
 * or, when the twin did not materialize, the legacy sequence
 * (`local.get 0; <args boxed>; call __call_m_<m>_<n>; <result unboxed>`) —
 * which needs NO pad: `__call_m_<m>_<arity>` is the exact dispatcher this site
 * would have reserved without S3, and the dynamic bridge behind it does its own
 * #3592 widening.
 *
 * `__argc` carries the CALL-SITE count (`t.arity`), which is also what the
 * dynamic path leaves there for an under-applied call — see the measurement
 * recorded on {@link buildPadValue}. It is the only thing that makes an
 * argc-driven parameter default (`emitParamDefaultArgMissingCheck`, used for
 * every `f64`/`i32` formal) fire in the padded slots and NOT in the supplied
 * ones.
 *
 * `__current_this` is installed even though the twin takes its receiver as a
 * parameter, because a twin body's NON-field uses of `this` (a `this` argument,
 * a dispatcher fallback read, a nested legacy `__call_m_*`) read the global.
 * The save/restore mirrors `__call_fn_method_N` exactly — including its one
 * known limitation, that an exceptional unwind skips the restore.
 */
export function fillDirectCallTrampolines(ctx: CodegenContext): void {
  const table = ctx.directCallTrampolines;
  if (!table || table.size === 0) return;
  for (const t of table.values()) {
    const fn = definedFuncAt(ctx, t.funcIdx);
    if (!fn) continue;
    const paramCount = t.params.length;
    const resultType = t.results[0];

    // --- the arm: a direct twin/generic call, or the legacy dispatcher ---
    const arm: Instr[] = [];
    let onlyCallsTypedTwin = false;
    const twin = ctx.directCallTwins?.get(`${t.className}/${t.methodName}`);
    const twinIdx = twin ? ctx.funcMap.get(twin.twinName) : undefined;
    const generic = ctx.directCallGenerics?.get(`${t.className}/${t.methodName}`);
    const genericIdx = generic ? ctx.funcMap.get(generic.liftedName) : undefined;
    // Param 0 differs BY DESIGN (twin: `(ref $F)`, trampoline: externref), so
    // compare the user params only — plus the twin's own receiver type, which
    // must be the struct this trampoline casts to.
    //
    // (#3683 S3b) The twin always declares ALL `formals`; the trampoline
    // declares only the `arity` SUPPLIED ones. So the supplied prefix is
    // compared against the trampoline's params and the padded suffix against
    // `padTypes` — the types the reserve-time pad was built for. A twin whose
    // ABI was repaired between reserve and fill therefore fails the check and
    // degrades, exactly as in the exact-arity case.
    const twinSignatureAgrees =
      twin !== undefined &&
      twin.params.length === t.formals + 1 &&
      valTypesMatch(twin.params[0]!, { kind: "ref", typeIdx: t.fnctorStructTypeIdx }) &&
      twin.params.slice(1, 1 + t.arity).every((p, i) => valTypesMatch(p, t.params[i + 1]!)) &&
      t.padTypes.length === t.formals - t.arity &&
      t.padInstrs.length === t.padTypes.length &&
      twin.params.slice(1 + t.arity).every((p, i) => valTypesMatch(p, t.padTypes[i]!)) &&
      twin.results.length === t.results.length &&
      twin.results.every((r, i) => valTypesMatch(r, t.results[i]!));
    // (#3685 S3) Build the legacy sequence up front when the receiver is only
    // statically PROVEN — the guarded body needs both arms, not one.
    const buildLegacyArm = (): Instr[] | undefined => {
      const legacy: Instr[] = [{ op: "local.get", index: 0 }];
      let ok = true;
      for (let i = 1; i < paramCount && ok; i++) {
        legacy.push({ op: "local.get", index: i });
        ok = boxToExternref(ctx, t.params[i]!, legacy);
      }
      if (ok) {
        legacy.push({ op: "call", funcIdx: t.legacyDispatchIdx });
        if (resultType === undefined) legacy.push({ op: "drop" });
        else ok = unboxFromExternref(ctx, resultType, legacy);
      }
      return ok ? legacy : undefined;
    };
    const genericSignatureAgrees =
      generic !== undefined &&
      generic.params.length === t.formals + 1 &&
      generic.params.slice(1, 1 + t.arity).every((p, i) => valTypesMatch(p, t.params[i + 1]!)) &&
      t.padTypes.length === t.formals - t.arity &&
      generic.params.slice(1 + t.arity).every((p, i) => valTypesMatch(p, t.padTypes[i]!));
    const buildGenericArm = (): Instr[] | undefined => {
      if (generic === undefined || genericIdx === undefined || !genericSignatureAgrees) return undefined;
      const direct: Instr[] = [{ op: "global.get", index: generic.selfGlobalIdx }, { op: "ref.as_non_null" }];
      for (let i = 1; i < paramCount; i++) direct.push({ op: "local.get", index: i });
      for (const pad of t.padInstrs) direct.push(...pad.map((i) => ({ ...i })));
      direct.push({ op: "call", funcIdx: genericIdx });

      if (
        generic.results.length === t.results.length &&
        generic.results.every((r, i) => valTypesMatch(r, t.results[i]!))
      ) {
        return direct;
      }
      // Numeric-return refinement belongs to typed twins. A generic closure
      // body retains its declared externref result, so adapt it once at the
      // trampoline edge when the call-site ABI was refined independently.
      if (
        generic.results.length === 1 &&
        generic.results[0]?.kind === "externref" &&
        resultType !== undefined &&
        t.results.length === 1
      ) {
        return unboxFromExternref(ctx, resultType, direct) ? direct : undefined;
      }
      return undefined;
    };

    if (twinIdx !== undefined && twinSignatureAgrees && t.guardedReceiver) {
      // (#3685 S3) Receiver shape is an ANALYSIS verdict, not a cast the caller
      // already performed. Test it, and fall back to the dispatcher on a miss so
      // an imprecise verdict costs a slow call rather than trapping the module.
      const legacyArm = buildLegacyArm();
      if (legacyArm === undefined) continue;
      const twinArm: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: t.fnctorStructTypeIdx },
      ];
      for (let i = 1; i < paramCount; i++) twinArm.push({ op: "local.get", index: i });
      for (const pad of t.padInstrs) twinArm.push(...pad.map((i) => ({ ...i })));
      twinArm.push({ op: "call", funcIdx: twinIdx });
      arm.push(
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: t.fnctorStructTypeIdx },
        {
          op: "if",
          blockType: resultType === undefined ? { kind: "empty" } : { kind: "val", type: resultType },
          then: twinArm,
          else: legacyArm,
        },
      );
      directCallStats.twinFills++;
    } else if (twinIdx !== undefined && twinSignatureAgrees) {
      // The twin's param 0 is the TYPED receiver; the trampoline carries it as
      // externref (ABI note on `DirectCallTrampoline`), so cast it back. The
      // cast cannot fail: every call site passed its own `ref.cast`-verified
      // `this` of exactly this struct.
      arm.push({ op: "local.get", index: 0 });
      arm.push({ op: "any.convert_extern" });
      arm.push({ op: "ref.cast", typeIdx: t.fnctorStructTypeIdx });
      for (let i = 1; i < paramCount; i++) arm.push({ op: "local.get", index: i });
      for (const pad of t.padInstrs) arm.push(...pad.map((i) => ({ ...i })));
      arm.push({ op: "call", funcIdx: twinIdx });
      directCallStats.twinFills++;
      onlyCallsTypedTwin = true;
    } else if (genericIdx !== undefined && genericSignatureAgrees) {
      const genericArm = buildGenericArm();
      const legacyArm = buildLegacyArm();
      if (genericArm === undefined || legacyArm === undefined) continue;
      // The retained closure is initialized at the original prototype
      // assignment. Before that point, preserve the dynamic route rather than
      // turning an uninitialized method into a null-cast trap. A receiver-flow
      // admission additionally keeps its existing shape guard.
      const hasUsableSelf: Instr[] = [
        { op: "global.get", index: generic.selfGlobalIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
      ];
      if (t.guardedReceiver) {
        hasUsableSelf.push(
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: t.fnctorStructTypeIdx },
          { op: "i32.and" },
        );
      }
      arm.push(...hasUsableSelf, {
        op: "if",
        blockType: resultType === undefined ? { kind: "empty" } : { kind: "val", type: resultType },
        then: genericArm,
        else: legacyArm,
      });
      directCallStats.genericFills++;
    } else {
      // Degradation: the call-site admission passed but the twin did not
      // materialize (capture analysis is only available once the method's
      // closure compiles) or its ABI was repaired. Reproduce the legacy
      // sequence — receiver + arguments boxed to externref through
      // `__call_m_<m>_<n>`, result unboxed back.
      const legacy: Instr[] = [{ op: "local.get", index: 0 }];
      let ok = true;
      for (let i = 1; i < paramCount && ok; i++) {
        legacy.push({ op: "local.get", index: i });
        ok = boxToExternref(ctx, t.params[i]!, legacy);
      }
      if (ok) {
        legacy.push({ op: "call", funcIdx: t.legacyDispatchIdx });
        // The legacy dispatcher ALWAYS yields an externref. A void trampoline
        // must not leave it on the stack.
        if (resultType === undefined) legacy.push({ op: "drop" });
        else ok = unboxFromExternref(ctx, resultType, legacy);
      }
      if (!ok) {
        // No box/unbox helper for this shape. Cannot express the call; leave
        // the `unreachable` placeholder rather than emit something wrong.
        // Unreachable in practice: the closed-method dispatcher registers
        // `__box_number`/`__unbox_number` at reserve time, and every closure
        // ABI type is one of externref / f64 / i32 / ref.
        continue;
      }
      arm.push(...legacy);
      directCallStats.legacyFills++;
      if (process.env.JS2WASM_DIRECT_CALLS_DEBUG === "1") {
        const reason =
          twin === undefined
            ? "no-twin"
            : twinIdx === undefined
              ? "no-twin-index"
              : `signature-mismatch:${JSON.stringify({
                  trampolineParams: t.params,
                  trampolineResults: t.results,
                  padTypes: t.padTypes,
                  twinParams: twin.params,
                  twinResults: twin.results,
                })}`;
        const key = `${t.className}.${t.methodName}/${t.arity}:${reason}`;
        directCallStats.legacyReasons.set(key, (directCallStats.legacyReasons.get(key) ?? 0) + 1);
      }
    }

    // A twin now represents every use of `this` (including bare/non-field
    // expressions) with its typed receiver parameter. An unguarded,
    // twin-exclusive trampoline therefore needs only the argc frame used by
    // parameter-default semantics; avoid four ambient receiver-global
    // operations and one spill on every parser-method call. Guarded twins keep
    // the frame for their legacy miss arm, and generic retained-closure bodies
    // keep it because both can still read `__current_this`.
    const elideCurrentThisFrame = onlyCallsTypedTwin && process.env.JS2WASM_TWIN_RECEIVER_PARAM !== "0";
    const needsCleanup = !elideCurrentThisFrame || t.needsArgcFrame;
    const locals: LocalDef[] = [];
    let prevLocal = -1;
    if (!elideCurrentThisFrame) {
      prevLocal = paramCount + locals.length;
      locals.push({ name: "__dc_prev_this", type: { kind: "externref" } });
    }
    const resLocal = resultType === undefined || !needsCleanup ? -1 : paramCount + locals.length;
    if (resLocal >= 0) locals.push({ name: "__dc_res", type: resultType! });

    fn.locals = locals;
    fn.body = needsCleanup
      ? [
          ...(!elideCurrentThisFrame
            ? ([
                { op: "global.get", index: t.currentThisGlobalIdx },
                { op: "local.set", index: prevLocal },
                { op: "local.get", index: 0 },
                { op: "global.set", index: t.currentThisGlobalIdx },
              ] satisfies Instr[])
            : []),
          ...(t.needsArgcFrame
            ? ([
                { op: "i32.const", value: t.arity },
                { op: "global.set", index: t.argcGlobalIdx },
              ] satisfies Instr[])
            : []),
          ...arm,
          ...(resLocal < 0 ? [] : ([{ op: "local.set", index: resLocal }] satisfies Instr[])),
          ...(t.needsArgcFrame
            ? ([
                { op: "i32.const", value: -1 },
                { op: "global.set", index: t.argcGlobalIdx },
              ] satisfies Instr[])
            : []),
          ...(!elideCurrentThisFrame
            ? ([
                { op: "local.get", index: prevLocal },
                { op: "global.set", index: t.currentThisGlobalIdx },
              ] satisfies Instr[])
            : []),
          ...(resLocal < 0 ? [] : ([{ op: "local.get", index: resLocal }] satisfies Instr[])),
        ]
      : arm;
  }
}
