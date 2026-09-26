// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster G, slice G1) §13.15.5.2 ArrayAssignmentPattern driven LAZILY,
 * in spec order, with §7.4.9 IteratorClose on an abrupt completion.
 *
 * WHY this exists — the previous answer was not "unimplemented", it was
 * MIS-ORDERED. `compileExternrefArrayDestructuringAssignment` (and its for-of
 * twin) normalise the source through `__array_from_iter_n(src, n)` FIRST and
 * then read `mat[i]` per element. That materialisation is a complete drain of
 * `n` IteratorSteps before a single DestructuringAssignmentTarget reference is
 * evaluated, so for
 *
 *     0, [ {}[thrower()] ] = iterable;          // array-elem-iter-thrw-close
 *
 * the engine called `next()` once (spec: ZERO times — the target reference is
 * evaluated at §13.15.5.5 step 1, BEFORE IteratorStep at step 2) and never
 * called `return()` (spec: exactly once — the pattern's [[done]] is still
 * false when the reference throws, so §13.15.5.2 step 5 runs IteratorClose).
 * Measured on the branch base: `nextCount 1 / returnCount 0` against the
 * required `0 / 1`, identically on the host and standalone lanes.
 *
 * Hoisting the reference evaluation in front of the materialisation would fix
 * `nextCount` and still leave `returnCount` at 0 — the throw would then happen
 * before GetIterator, so there would be no iterator to close. The order the
 * spec asks for is genuinely three-phase (GetIterator, then per element:
 * reference, then step), which is why this is a lazy drive and not a
 * re-ordering.
 *
 * SCOPE — deliberately narrow. The drive is offered only for patterns that
 * contain at least one MEMBER-expression target (`obj.p` / `obj[k]`), possibly
 * under a rest element. That is precisely the class whose reference evaluation
 * is observable, it is the whole 21-row bucket, and it leaves the overwhelmingly
 * common all-identifier pattern (`[a, b] = xs`) on the existing materialise path
 * byte-for-byte. Any element kind this module does not model (defaults,
 * object patterns, nested array patterns other than a rest target) makes the
 * admission scan REFUSE before a single instruction is emitted, so the caller's
 * fall-through is always intact.
 *
 * No new host import: `__iterator` / `__iterator_next` / `__iterator_return` /
 * `__iterator_rest` / `__extern_set_strict` / `__array_from_iter_n` all route to
 * the native object/iterator runtime under `--target standalone|wasi`
 * (`late-imports.ts`). The drive is STANDALONE/WASI-gated — see the measured
 * reason at `tryEmitSpecOrderedArrayAssignDrive` — so host output cannot move.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { buildStandardTryTable } from "../ir/try-table.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  emitResolvedIdentifierWriteFromStack,
  resolveModuleAwareIdentifierWriteTarget,
} from "./expressions/identifier-assignment.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { coerceType, compileExpression } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };

type MemberTarget = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** One admitted pattern element, classified once by {@link planElements}. */
type ElemPlan =
  | { kind: "hole" }
  | { kind: "ident"; target: ts.Identifier }
  | { kind: "member"; target: MemberTarget }
  | { kind: "rest-ident"; target: ts.Identifier }
  | { kind: "rest-member"; target: MemberTarget }
  | { kind: "rest-pattern"; target: ts.ArrayLiteralExpression; inner: ElemPlan[] };

function isMemberTarget(node: ts.Node): node is MemberTarget {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

/**
 * Classify every element, or answer `undefined` for "not modelled here" — the
 * caller then keeps its existing lowering. Also requires at least one member
 * target somewhere in the pattern (see SCOPE in the module doc).
 */
function planElements(pattern: ts.ArrayLiteralExpression): ElemPlan[] | undefined {
  const plans: ElemPlan[] = [];
  let sawMember = false;
  const elements = pattern.elements;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    if (ts.isOmittedExpression(el)) {
      plans.push({ kind: "hole" });
      continue;
    }
    if (ts.isSpreadElement(el)) {
      // §13.15.5.2: AssignmentRestElement is only ever the final element.
      if (i !== elements.length - 1) return undefined;
      const restTarget = el.expression;
      if (ts.isIdentifier(restTarget)) {
        plans.push({ kind: "rest-ident", target: restTarget });
        continue;
      }
      if (isMemberTarget(restTarget)) {
        sawMember = true;
        plans.push({ kind: "rest-member", target: restTarget });
        continue;
      }
      if (ts.isArrayLiteralExpression(restTarget)) {
        // `[...[ … ]] = it` — the rest drains the OUTER iterator to an array
        // and the nested pattern then runs against that array with its own
        // GetIterator. Admit it only when the nested pattern is itself fully
        // modelled here; `array-rest-nested-array-iter-thrw-close-skip` is
        // exactly this shape.
        const inner = planElements(restTarget);
        if (!inner) return undefined;
        sawMember = true;
        plans.push({ kind: "rest-pattern", target: restTarget, inner });
        continue;
      }
      return undefined;
    }
    if (ts.isIdentifier(el)) {
      plans.push({ kind: "ident", target: el });
      continue;
    }
    if (isMemberTarget(el)) {
      sawMember = true;
      plans.push({ kind: "member", target: el });
      continue;
    }
    // Defaults (`[a = 1]`), object patterns and nested array patterns in a
    // non-rest slot are not modelled — refuse the whole pattern.
    return undefined;
  }
  return sawMember ? plans : undefined;
}

/** The four iterator ops plus the generic member write, resolved once. */
type DriveRuntime = {
  iterator: number;
  next: number;
  close: number;
  rest: number;
  externSet: number;
  /** `__array_from_iter_n(null, -1)` — the canonical empty array. */
  emptyArray: number;
};

function resolveRuntime(ctx: CodegenContext, fctx: FunctionContext): DriveRuntime | undefined {
  ensureLateImport(ctx, "__iterator", [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__iterator_next", [EXTERNREF], [{ kind: "i32" }, EXTERNREF]);
  ensureLateImport(ctx, "__iterator_return", [EXTERNREF], []);
  ensureLateImport(ctx, "__iterator_rest", [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_set_strict", [EXTERNREF, EXTERNREF, EXTERNREF], []);
  ensureLateImport(ctx, "__array_from_iter_n", [EXTERNREF, { kind: "f64" }], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const iterator = ctx.funcMap.get("__iterator");
  const next = ctx.funcMap.get("__iterator_next");
  const close = ctx.funcMap.get("__iterator_return");
  const rest = ctx.funcMap.get("__iterator_rest");
  const externSet = ctx.funcMap.get("__extern_set_strict");
  const emptyArray = ctx.funcMap.get("__array_from_iter_n");
  if (
    iterator === undefined ||
    next === undefined ||
    close === undefined ||
    rest === undefined ||
    externSet === undefined ||
    emptyArray === undefined
  ) {
    return undefined;
  }
  return { iterator, next, close, rest, externSet, emptyArray };
}

/** Locals the drive threads through its phases. */
type DriveState = {
  rt: DriveRuntime;
  iterLocal: number;
  doneLocal: number;
  valueLocal: number;
};

/**
 * §13.15.5.5 step 1 — evaluate the DestructuringAssignmentTarget's Reference
 * BEFORE the iterator is stepped, parking the base and the key in locals. The
 * key is an externref so the generic `__extern_set_strict` can consume it; a computed
 * key is coerced exactly once, here, which is also what makes the later PutValue
 * free of a second evaluation.
 */
function emitMemberReference(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: MemberTarget,
): { objLocal: number; keyLocal: number } | undefined {
  const objLocal = allocLocal(fctx, `__dstr_ref_obj_${fctx.locals.length}`, EXTERNREF);
  const keyLocal = allocLocal(fctx, `__dstr_ref_key_${fctx.locals.length}`, EXTERNREF);
  // A `null` result means the operand's TYPE is `never` — the `{}[thrower()]`
  // shape this bucket is built on, where `thrower` is declared as
  // `function () { throw … }`. The call's instructions ARE emitted (and that
  // throw is the whole point of the row); nothing is left on the stack, so the
  // slot is padded exactly the way `emitDynamicMemberSet` pads it. Refusing
  // here instead would reject the entire family.
  const objType = compileExpression(ctx, fctx, target.expression);
  if (!objType) fctx.body.push({ op: "ref.null.extern" });
  else coerceType(ctx, fctx, objType, EXTERNREF);
  fctx.body.push({ op: "local.set", index: objLocal });
  if (ts.isPropertyAccessExpression(target)) {
    if (ts.isPrivateIdentifier(target.name)) return undefined;
    addStringConstantGlobal(ctx, target.name.text);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, target.name.text));
  } else {
    const keyType = compileExpression(ctx, fctx, target.argumentExpression, EXTERNREF);
    if (!keyType) fctx.body.push({ op: "ref.null.extern" });
    else coerceType(ctx, fctx, keyType, EXTERNREF);
  }
  fctx.body.push({ op: "local.set", index: keyLocal });
  return { objLocal, keyLocal };
}

/**
 * §7.4.6 IteratorStep + §7.4.7 IteratorValue for one slot.
 *
 * `doneLocal` is raised to 1 IMMEDIATELY BEFORE the call and lowered to the
 * real flag after it returns. That is not defensive coding — §7.4.6 sets
 * [[done]] true when `next()` completes abruptly, and [[done]] true is exactly
 * what suppresses the IteratorClose in the catch arm below. Without the
 * pre-raise, a throwing `next()` would be followed by a `return()` call that
 * the spec forbids (`iterator-next-failure`-shaped rows assert `return` is
 * never reached).
 */
function emitStep(fctx: FunctionContext, st: DriveState): void {
  const stepped = pushBody(fctx);
  fctx.body.push({ op: "i32.const", value: 1 }, { op: "local.set", index: st.doneLocal });
  fctx.body.push({ op: "local.get", index: st.iterLocal }, { op: "call", funcIdx: st.rt.next });
  fctx.body.push({ op: "local.set", index: st.valueLocal }, { op: "local.set", index: st.doneLocal });
  const steppedBody = fctx.body;
  popBody(fctx, stepped);
  // An exhausted iterator yields `undefined` for every remaining slot, and is
  // never stepped again (§13.15.5.5 step 2 guards on [[done]]).
  fctx.body.push({ op: "local.get", index: st.doneLocal }, { op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: steppedBody, else: [] });
}

/** Push the slot value: the stepped value, or `undefined` once [[done]]. */
function pushSlotValue(ctx: CodegenContext, fctx: FunctionContext, st: DriveState): void {
  const undef = pushBody(fctx);
  emitUndefined(ctx, fctx);
  const undefBody = fctx.body;
  popBody(fctx, undef);
  fctx.body.push({ op: "local.get", index: st.doneLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: undefBody,
    else: [{ op: "local.get", index: st.valueLocal }],
  });
}

/** PutValue into an identifier target from a value already on the stack. */
function emitIdentifierPut(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): void {
  const { localIdx, moduleGlobalIdx } = resolveModuleAwareIdentifierWriteTarget(ctx, fctx, id, EXTERNREF);
  emitResolvedIdentifierWriteFromStack(ctx, fctx, id, EXTERNREF, localIdx, moduleGlobalIdx);
}

/**
 * Emit the whole §13.15.5.2 body for `pattern`, sourcing from `srcLocal`.
 * Returns false WITHOUT emitting anything when the shape is not modelled.
 */
export function tryEmitSpecOrderedArrayAssignDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayLiteralExpression,
  srcLocal: number,
): boolean {
  // STANDALONE/WASI ONLY, and this is a measurement, not a preference. On the
  // host lane `__iterator_rest` is the JS import at `runtime.ts:17999`, which
  // drains via `iter.next` / the string sidecar — and the iterator in every row
  // of this family is a compiled OBJECT LITERAL, i.e. a WasmGC struct whose
  // `next` neither lookup finds. It therefore answers `[]` without stepping,
  // where the eager `__array_from_iter_n` it replaces goes through the host's
  // own iteration bridge and steps correctly. Measured: with the drive ungated,
  // the 1,207-row host sweep gained 10 rows and LOST 3
  // (`for-of/dstr/array-rest-{lref,nested-array-iter-thrw-close-skip,
  // put-prop-ref-user-err-iter-close-skip}.js`, `nextCount 0` where 1 is
  // required). Gating restores host byte-identity and costs nothing measurable:
  // every row in this bucket already fails on the host lane, for the same
  // ordering reason, plus a host-only `IteratorClose` receiver defect
  // (`return()` does not see the iterator as its `this`). Lifting the gate
  // means giving the host lane a rest drain that can step a struct iterator.
  if (!(ctx.standalone || ctx.wasi)) return false;
  const plans = planElements(pattern);
  if (!plans) return false;
  const rt = resolveRuntime(ctx, fctx);
  if (!rt) return false;
  // Emit into a DETACHED buffer and splice only on success. `emitDrive` can
  // still refuse part-way (a private-name member target), and a refusal that
  // has already written a GetIterator into `fctx.body` would double-evaluate
  // the source under the caller's fall-through. Unused locals are harmless;
  // half-emitted instructions are not.
  const saved = pushBody(fctx);
  const ok = emitDrive(ctx, fctx, plans, srcLocal, rt);
  const built = fctx.body;
  popBody(fctx, saved);
  if (!ok) return false;
  for (const instr of built) fctx.body.push(instr);
  return true;
}

function emitDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  plans: ElemPlan[],
  srcLocal: number,
  rt: DriveRuntime,
): boolean {
  const st: DriveState = {
    rt,
    iterLocal: allocLocal(fctx, `__dstr_iter_${fctx.locals.length}`, EXTERNREF),
    doneLocal: allocLocal(fctx, `__dstr_done_${fctx.locals.length}`, { kind: "i32" }),
    valueLocal: allocLocal(fctx, `__dstr_val_${fctx.locals.length}`, EXTERNREF),
  };
  // §13.15.5.2 step 1 — GetIterator. A throwing `@@iterator` propagates with
  // NO close (there is no iterator yet), so this sits OUTSIDE the wrapper.
  fctx.body.push({ op: "local.get", index: srcLocal }, { op: "call", funcIdx: rt.iterator });
  fctx.body.push({ op: "local.set", index: st.iterLocal });
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: st.doneLocal });

  const saved = pushBody(fctx);
  let ok = true;
  for (const plan of plans) {
    if (!emitElement(ctx, fctx, plan, st)) {
      ok = false;
      break;
    }
  }
  const driveBody = fctx.body;
  popBody(fctx, saved);
  if (!ok) return false;

  fctx.body.push(wrapWithIteratorClose(ctx, fctx, driveBody, st));
  // §13.15.5.2 step 5 on a NORMAL completion: the pattern consumed fewer
  // values than the iterator has, so it must still be closed.
  fctx.body.push({ op: "local.get", index: st.doneLocal }, { op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: st.iterLocal },
      { op: "call", funcIdx: rt.close },
    ],
    else: [],
  });
  return true;
}

function emitElement(ctx: CodegenContext, fctx: FunctionContext, plan: ElemPlan, st: DriveState): boolean {
  switch (plan.kind) {
    case "hole":
      emitStep(fctx, st);
      return true;
    case "ident":
      emitStep(fctx, st);
      pushSlotValue(ctx, fctx, st);
      emitIdentifierPut(ctx, fctx, plan.target);
      return true;
    case "member": {
      const ref = emitMemberReference(ctx, fctx, plan.target);
      if (!ref) return false;
      emitStep(fctx, st);
      fctx.body.push({ op: "local.get", index: ref.objLocal }, { op: "local.get", index: ref.keyLocal });
      pushSlotValue(ctx, fctx, st);
      fctx.body.push({ op: "call", funcIdx: st.rt.externSet });
      return true;
    }
    case "rest-ident":
      emitRestDrain(fctx, st);
      fctx.body.push({ op: "local.get", index: st.valueLocal });
      emitIdentifierPut(ctx, fctx, plan.target);
      return true;
    case "rest-member": {
      const ref = emitMemberReference(ctx, fctx, plan.target);
      if (!ref) return false;
      emitRestDrain(fctx, st);
      fctx.body.push({ op: "local.get", index: ref.objLocal }, { op: "local.get", index: ref.keyLocal });
      fctx.body.push({ op: "local.get", index: st.valueLocal });
      fctx.body.push({ op: "call", funcIdx: st.rt.externSet });
      return true;
    }
    case "rest-pattern": {
      // The rest target is itself a pattern: drain first (§13.15.5.6 step 3),
      // then run the nested pattern over the resulting array with its OWN
      // iterator — a throw from there must not close the (already done) outer.
      emitRestDrain(fctx, st);
      const nestedSrc = allocLocal(fctx, `__dstr_rest_src_${fctx.locals.length}`, EXTERNREF);
      fctx.body.push({ op: "local.get", index: st.valueLocal }, { op: "local.set", index: nestedSrc });
      return emitDrive(ctx, fctx, plan.inner, nestedSrc, st.rt);
    }
  }
}

/**
 * §13.15.5.6 AssignmentRestElement — drain what is left into an array. The
 * drain runs the iterator to exhaustion, so [[done]] is true afterwards AND
 * while it runs (an abrupt drain also leaves [[done]] true, hence the pre-raise
 * — same argument as {@link emitStep}).
 */
function emitRestDrain(fctx: FunctionContext, st: DriveState): void {
  const drained = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: st.iterLocal }, { op: "call", funcIdx: st.rt.rest });
  fctx.body.push({ op: "local.set", index: st.valueLocal });
  const drainBody = fctx.body;
  popBody(fctx, drained);
  // An ALREADY-done iterator must not be stepped again (§13.15.5.6 step 2):
  // the rest target still receives an array, an EMPTY one. `__array_from_iter_n`
  // answers exactly that for a null source, so no second empty-vec shape is
  // introduced here.
  const empty = pushBody(fctx);
  fctx.body.push({ op: "ref.null.extern" }, { op: "f64.const", value: -1 });
  fctx.body.push({ op: "call", funcIdx: st.rt.emptyArray });
  fctx.body.push({ op: "local.set", index: st.valueLocal });
  const emptyBody = fctx.body;
  popBody(fctx, empty);
  // The flag is raised before the drain runs, not after: an abrupt drain also
  // leaves [[done]] true (same argument as `emitStep`).
  fctx.body.push({ op: "local.get", index: st.doneLocal }, { op: "i32.eqz" });
  fctx.body.push({ op: "i32.const", value: 1 }, { op: "local.set", index: st.doneLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: drainBody,
    else: emptyBody,
  });
}

/**
 * Guard `body` so any throw first runs IteratorClose — with the close's OWN
 * abrupt completion suppressed (§7.4.9 step 6: the original throw wins, which
 * is what every `*-thrw-close-err` row asserts) — and only when [[done]] is
 * still false.
 *
 * Shape mirrors `new-super.ts::wrapWithIteratorClose` (#5267 A); the instruction
 * objects are minted here rather than shared (an aliased instr array is
 * double-remapped by the DCE, #2169b).
 */
function wrapWithIteratorClose(ctx: CodegenContext, fctx: FunctionContext, body: Instr[], st: DriveState): Instr {
  const closeBody: Instr[] = [
    { op: "local.get", index: st.doneLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: st.iterLocal },
        { op: "call", funcIdx: st.rt.close },
      ],
      else: [],
    },
  ];
  if (ctx.wasi || ctx.standalone) {
    const tagIdx = ensureExnTag(ctx);
    const exnLocal = allocLocal(fctx, `__dstr_exn_${fctx.locals.length}`, EXTERNREF);
    const innerClose = buildStandardTryTable({ kind: "empty" }, closeBody, [
      { kind: "catch", tagIdx, payloadType: EXTERNREF, body: [{ op: "drop" }] },
    ]);
    return buildStandardTryTable({ kind: "empty" }, body, [
      {
        kind: "catch",
        tagIdx,
        payloadType: EXTERNREF,
        body: [
          { op: "local.set", index: exnLocal },
          innerClose,
          { op: "local.get", index: exnLocal },
          { op: "throw", tagIdx },
        ],
      },
    ]);
  }
  return {
    op: "try",
    blockType: { kind: "empty" },
    body,
    catches: [],
    catchAll: [
      { op: "try", blockType: { kind: "empty" }, body: closeBody, catches: [], catchAll: [] },
      { op: "rethrow", depth: 0 },
    ],
  };
}
