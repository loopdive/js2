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
 * SCOPE — the patterns whose per-element evaluation is OBSERVABLE between two
 * steps (`isObservablyOrdered`): a MEMBER-expression target (`obj.p` /
 * `obj[k]`, G1), and since slice G2 an element Initializer (`[a = f()]`) or a
 * nested object/array pattern in any slot (`[{ p: x }, [y] = d]`). The
 * overwhelmingly common pattern of identifiers, holes and an identifier rest
 * (`[a, , ...r] = xs`) observes nothing in between, so it stays on the
 * existing materialise path byte-for-byte. A shape this module does not model
 * (a private-name member, a non-pattern non-reference target) makes the plan
 * REFUSE before a single instruction is emitted, so the caller's fall-through
 * is always intact.
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
import { buildDestructureNullThrow } from "./destructuring-params.js";
import { emitObjectDestructureFromLocal } from "./expressions/assignment.js";
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

/**
 * The DestructuringAssignmentTarget of one non-rest element. A PATTERN target
 * is not a Reference (§13.15.5.5 step 1 excludes Object/ArrayLiteral): it is
 * evaluated after the step, against the (defaulted) stepped value.
 */
type ElemTarget =
  | { kind: "ident"; target: ts.Identifier }
  | { kind: "member"; target: MemberTarget }
  | { kind: "array"; target: ts.ArrayLiteralExpression; inner: ElemPlan[] }
  | { kind: "object"; target: ts.ObjectLiteralExpression };

/** One admitted pattern element, classified once by {@link planPattern}. */
type ElemPlan =
  | { kind: "hole" }
  | { kind: "elem"; target: ElemTarget; init: ts.Expression | undefined }
  | { kind: "rest-ident"; target: ts.Identifier }
  | { kind: "rest-member"; target: MemberTarget }
  | { kind: "rest-pattern"; target: ts.ArrayLiteralExpression; inner: ElemPlan[] };

/** A member target this module can write — `obj.#x` is refused at plan time. */
function isMemberTarget(node: ts.Node): node is MemberTarget {
  if (ts.isPropertyAccessExpression(node)) return !ts.isPrivateIdentifier(node.name);
  return ts.isElementAccessExpression(node);
}

/** Classify a non-rest element's target, or `undefined` for "not modelled". */
function planTarget(node: ts.Expression): ElemTarget | undefined {
  if (ts.isIdentifier(node)) return { kind: "ident", target: node };
  if (isMemberTarget(node)) return { kind: "member", target: node };
  if (ts.isObjectLiteralExpression(node)) return { kind: "object", target: node };
  if (!ts.isArrayLiteralExpression(node)) return undefined;
  const inner = planPattern(node);
  return inner ? { kind: "array", target: node, inner } : undefined;
}

/**
 * Classify every element, or answer `undefined` for "not modelled here" — the
 * caller then keeps its existing lowering. Admission (whether the drive is
 * worth taking at all) is the separate {@link isObservablyOrdered}.
 */
function planPattern(pattern: ts.ArrayLiteralExpression): ElemPlan[] | undefined {
  const plans: ElemPlan[] = [];
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
      if (ts.isIdentifier(restTarget)) plans.push({ kind: "rest-ident", target: restTarget });
      else if (isMemberTarget(restTarget)) plans.push({ kind: "rest-member", target: restTarget });
      else if (ts.isArrayLiteralExpression(restTarget)) {
        // `[...[ … ]] = it` — the rest drains the OUTER iterator to an array
        // and the nested pattern then runs against that array with its own
        // GetIterator (`array-rest-nested-array-iter-thrw-close-skip`).
        const inner = planPattern(restTarget);
        if (!inner) return undefined;
        plans.push({ kind: "rest-pattern", target: restTarget, inner });
      } else return undefined;
      continue;
    }
    // (#6651 G2) `target = init` — an AssignmentElement with an Initializer:
    // evaluated AFTER the step, and only when the stepped value is undefined.
    const isDefault = ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const target = planTarget(isDefault ? el.left : el);
    if (!target) return undefined;
    plans.push({ kind: "elem", target, init: isDefault ? el.right : undefined });
  }
  return plans;
}

/**
 * Admission: does the pattern evaluate something user-observable BETWEEN two
 * IteratorSteps? A member Reference (§13.15.5.5 step 1 — G1), an Initializer
 * (step 4 — G2), a nested pattern (step 6 — its own GetIterator, getters and
 * RequireObjectCoercible — G2), or a rest pattern whose inner pattern is itself
 * observable. Only then does the eager `__array_from_iter_n` drain disagree
 * with the spec: in the order of `next()` against those evaluations, and in
 * whether an abrupt completion from one of them still finds an OPEN iterator
 * to close (`default-expr-throws-iterator-return-get-throws`). A pattern of
 * identifiers, holes and identifier rests has none, and keeps the existing
 * lowering byte-for-byte — as does `[...[x]]`, which G1 also left alone.
 */
function isObservablyOrdered(plans: ElemPlan[]): boolean {
  return plans.some(
    (plan) =>
      plan.kind === "rest-member" ||
      (plan.kind === "rest-pattern" && isObservablyOrdered(plan.inner)) ||
      (plan.kind === "elem" && (plan.init !== undefined || plan.target.kind !== "ident")),
  );
}

/**
 * Every runtime op the drive calls. Ensured once, up front — and then looked up
 * BY NAME at each call site, never cached as an index: an Initializer or a
 * member Reference is arbitrary code, and compiling it can add a late import
 * that shifts every function index after the lookup (the shift rewrites the
 * instructions already emitted, not a number held in a local variable).
 */
const DRIVE_OPS = [
  ["__iterator", [EXTERNREF], [EXTERNREF]],
  ["__iterator_next", [EXTERNREF], [{ kind: "i32" }, EXTERNREF]],
  ["__iterator_return", [EXTERNREF], []],
  ["__iterator_rest", [EXTERNREF], [EXTERNREF]],
  ["__extern_set_strict", [EXTERNREF, EXTERNREF, EXTERNREF], []],
  ["__array_from_iter_n", [EXTERNREF, { kind: "f64" }], [EXTERNREF]],
  ["__extern_is_undefined", [EXTERNREF], [{ kind: "i32" }]],
] as const satisfies readonly (readonly [string, readonly ValType[], readonly ValType[]])[];
type DriveOp = (typeof DRIVE_OPS)[number][0];

/**
 * Ensure the ops `plans` can reach. `__extern_is_undefined` only when a
 * default or a nested array guard can call it, so a G1-shaped pattern (member
 * targets, no defaults) keeps its exact import set.
 */
function ensureRuntime(ctx: CodegenContext, fctx: FunctionContext, plans: ElemPlan[]): boolean {
  const ops = needsUndefinedProbe(plans) ? DRIVE_OPS : DRIVE_OPS.filter(([name]) => name !== "__extern_is_undefined");
  for (const [name, params, results] of ops) ensureLateImport(ctx, name, [...params], [...results]);
  flushLateImportShifts(ctx, fctx);
  return ops.every(([name]) => ctx.funcMap.get(name) !== undefined);
}

function needsUndefinedProbe(plans: ElemPlan[]): boolean {
  return plans.some(
    (plan) =>
      (plan.kind === "rest-pattern" && needsUndefinedProbe(plan.inner)) ||
      (plan.kind === "elem" && (plan.init !== undefined || plan.target.kind === "array")),
  );
}

function call(ctx: CodegenContext, name: DriveOp): Instr {
  return { op: "call", funcIdx: ctx.funcMap.get(name)! };
}

/** Locals the drive threads through its phases. */
type DriveState = {
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
): { objLocal: number; keyLocal: number } {
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
    // Private names were refused by the plan (`planTarget`), before any emit.
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
function emitStep(ctx: CodegenContext, fctx: FunctionContext, st: DriveState): void {
  const stepped = pushBody(fctx);
  fctx.body.push({ op: "i32.const", value: 1 }, { op: "local.set", index: st.doneLocal });
  fctx.body.push({ op: "local.get", index: st.iterLocal }, call(ctx, "__iterator_next"));
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

/**
 * (#6651 G2) §13.15.5.5 step 4 — replace the externref on the stack by the
 * Initializer's value when (and only when) it is `undefined`; never for JS
 * `null`. The Initializer is evaluated here, AFTER the step and still inside
 * the IteratorClose wrapper, so a throwing default closes an iterator the
 * pattern had not finished with. Compiled to an externref: an anonymous
 * function / class still receives its binding name, because the name comes
 * from the syntactic parent (`x = function () {}`), not from the hint.
 *
 * An array-literal default of a nested PATTERN (`[[x, y] = [1, 2]] = it`) is
 * contextually typed as a tuple by the checker, and a non-empty tuple struct is
 * not a carrier the native `__iterator` can step ("value is not iterable",
 * measured). It is forced to the vec carrier instead — the flag the parameter-
 * default and `super(...)` lowerings set for the same checker artefact.
 */
function emitApplyDefault(ctx: CodegenContext, fctx: FunctionContext, init: ts.Expression, forceVec: boolean): void {
  const slot = allocLocal(fctx, `__dstr_dflt_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.tee", index: slot }, call(ctx, "__extern_is_undefined"));
  const dflt = pushBody(fctx);
  const flags = ctx as unknown as { _arrayLiteralForceVec?: boolean };
  const previousForceVec = flags._arrayLiteralForceVec;
  if (forceVec) flags._arrayLiteralForceVec = true;
  let initType: ValType | null;
  try {
    initType = compileExpression(ctx, fctx, init, EXTERNREF);
  } finally {
    flags._arrayLiteralForceVec = previousForceVec;
  }
  // `null`: a `never`/void-typed initializer left nothing on the stack.
  if (!initType) emitUndefined(ctx, fctx);
  else coerceType(ctx, fctx, initType, EXTERNREF);
  const dfltBody = fctx.body;
  popBody(fctx, dflt);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: dfltBody,
    else: [{ op: "local.get", index: slot }],
  });
}

/**
 * RequireObjectCoercible for a nested ARRAY pattern's value (§7.4.1 GetIterator
 * on `undefined`/`null` is a TypeError) — the same two probes, and the same
 * `TypeError`, as the materialise path's `emitExternrefAssignDestructureGuard`.
 */
function emitNullishGuard(ctx: CodegenContext, fctx: FunctionContext, local: number): void {
  fctx.body.push({ op: "local.get", index: local }, { op: "ref.is_null" });
  fctx.body.push({ op: "local.get", index: local }, call(ctx, "__extern_is_undefined"), { op: "i32.or" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildDestructureNullThrow(ctx, fctx), else: [] });
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
  const plans = planPattern(pattern);
  if (!plans || !isObservablyOrdered(plans)) return false;
  if (!ensureRuntime(ctx, fctx, plans)) return false;
  // The plan has already refused every shape the emitter does not model, so
  // from here on the drive always completes: nothing is emitted and then
  // abandoned (which would double-evaluate the source under the caller's
  // fall-through, and leave closures compiled for code that never ships).
  emitDrive(ctx, fctx, plans, srcLocal);
  return true;
}

function emitDrive(ctx: CodegenContext, fctx: FunctionContext, plans: ElemPlan[], srcLocal: number): void {
  const st: DriveState = {
    iterLocal: allocLocal(fctx, `__dstr_iter_${fctx.locals.length}`, EXTERNREF),
    doneLocal: allocLocal(fctx, `__dstr_done_${fctx.locals.length}`, { kind: "i32" }),
    valueLocal: allocLocal(fctx, `__dstr_val_${fctx.locals.length}`, EXTERNREF),
  };
  // §13.15.5.2 step 1 — GetIterator. A throwing `@@iterator` propagates with
  // NO close (there is no iterator yet), so this sits OUTSIDE the wrapper.
  fctx.body.push({ op: "local.get", index: srcLocal }, call(ctx, "__iterator"));
  fctx.body.push({ op: "local.set", index: st.iterLocal });
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: st.doneLocal });

  const saved = pushBody(fctx);
  for (const plan of plans) emitElement(ctx, fctx, plan, st);
  const driveBody = fctx.body;
  popBody(fctx, saved);

  fctx.body.push(wrapWithIteratorClose(ctx, fctx, driveBody, st));
  // §13.15.5.2 step 5 on a NORMAL completion: the pattern consumed fewer
  // values than the iterator has, so it must still be closed.
  fctx.body.push({ op: "local.get", index: st.doneLocal }, { op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "local.get", index: st.iterLocal }, call(ctx, "__iterator_return")],
    else: [],
  });
}

/** §13.15.5.5 AssignmentElement: reference, step, default, then PutValue / nested pattern. */
function emitAssignmentElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ElemTarget,
  init: ts.Expression | undefined,
  st: DriveState,
): void {
  const ref = target.kind === "member" ? emitMemberReference(ctx, fctx, target.target) : undefined;
  emitStep(ctx, fctx, st);
  // PutValue's (base, key) go under the value; the default's `if` leaves them be.
  if (ref) fctx.body.push({ op: "local.get", index: ref.objLocal }, { op: "local.get", index: ref.keyLocal });
  pushSlotValue(ctx, fctx, st);
  if (init) emitApplyDefault(ctx, fctx, init, target.kind === "array" && ts.isArrayLiteralExpression(init));
  switch (target.kind) {
    case "ident": {
      const { localIdx, moduleGlobalIdx } = resolveModuleAwareIdentifierWriteTarget(
        ctx,
        fctx,
        target.target,
        EXTERNREF,
      );
      emitResolvedIdentifierWriteFromStack(ctx, fctx, target.target, EXTERNREF, localIdx, moduleGlobalIdx);
      return;
    }
    case "member":
      fctx.body.push(call(ctx, "__extern_set_strict"));
      return;
    case "array": {
      // §13.15.5.5 step 6: a nested array pattern runs its OWN GetIterator /
      // steps / IteratorClose; an abrupt completion from it then closes THIS
      // iterator through the enclosing wrapper (each level closes its own).
      const nested = allocLocal(fctx, `__dstr_nested_${fctx.locals.length}`, EXTERNREF);
      fctx.body.push({ op: "local.set", index: nested });
      emitNullishGuard(ctx, fctx, nested);
      emitDrive(ctx, fctx, target.inner, nested);
      return;
    }
    case "object": {
      // The externref object-pattern lowering (RequireObjectCoercible, then the
      // property reads/writes in source order) — the same one the materialise
      // path uses for `[{ … }] = xs`, now reached AFTER this slot's step.
      const nested = allocLocal(fctx, `__dstr_nested_${fctx.locals.length}`, EXTERNREF);
      fctx.body.push({ op: "local.set", index: nested });
      emitObjectDestructureFromLocal(ctx, fctx, target.target, nested, EXTERNREF);
      return;
    }
  }
}

function emitElement(ctx: CodegenContext, fctx: FunctionContext, plan: ElemPlan, st: DriveState): void {
  switch (plan.kind) {
    case "hole":
      emitStep(ctx, fctx, st);
      return;
    case "elem":
      emitAssignmentElement(ctx, fctx, plan.target, plan.init, st);
      return;
    case "rest-ident": {
      emitRestDrain(ctx, fctx, st);
      fctx.body.push({ op: "local.get", index: st.valueLocal });
      const { localIdx, moduleGlobalIdx } = resolveModuleAwareIdentifierWriteTarget(ctx, fctx, plan.target, EXTERNREF);
      emitResolvedIdentifierWriteFromStack(ctx, fctx, plan.target, EXTERNREF, localIdx, moduleGlobalIdx);
      return;
    }
    case "rest-member": {
      const ref = emitMemberReference(ctx, fctx, plan.target);
      emitRestDrain(ctx, fctx, st);
      fctx.body.push({ op: "local.get", index: ref.objLocal }, { op: "local.get", index: ref.keyLocal });
      fctx.body.push({ op: "local.get", index: st.valueLocal }, call(ctx, "__extern_set_strict"));
      return;
    }
    case "rest-pattern": {
      // The rest target is itself a pattern: drain first (§13.15.5.6 step 3),
      // then run the nested pattern over the resulting array with its OWN
      // iterator — a throw from there must not close the (already done) outer.
      emitRestDrain(ctx, fctx, st);
      const nestedSrc = allocLocal(fctx, `__dstr_rest_src_${fctx.locals.length}`, EXTERNREF);
      fctx.body.push({ op: "local.get", index: st.valueLocal }, { op: "local.set", index: nestedSrc });
      emitDrive(ctx, fctx, plan.inner, nestedSrc);
      return;
    }
  }
}

/**
 * §13.15.5.6 AssignmentRestElement — drain what is left into an array. The
 * drain runs the iterator to exhaustion, so [[done]] is true afterwards AND
 * while it runs (an abrupt drain also leaves [[done]] true, hence the pre-raise
 * — same argument as {@link emitStep}).
 */
function emitRestDrain(ctx: CodegenContext, fctx: FunctionContext, st: DriveState): void {
  // An ALREADY-done iterator must not be stepped again (§13.15.5.6 step 2):
  // the rest target still receives an array, an EMPTY one. `__array_from_iter_n`
  // answers exactly that for a null source, so no second empty-vec shape is
  // introduced here. The flag is raised before the drain runs, not after: an
  // abrupt drain also leaves [[done]] true (same argument as `emitStep`).
  fctx.body.push({ op: "local.get", index: st.doneLocal }, { op: "i32.eqz" });
  fctx.body.push({ op: "i32.const", value: 1 }, { op: "local.set", index: st.doneLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: st.iterLocal },
      call(ctx, "__iterator_rest"),
      { op: "local.set", index: st.valueLocal },
    ],
    else: [
      { op: "ref.null.extern" },
      { op: "f64.const", value: -1 },
      call(ctx, "__array_from_iter_n"),
      { op: "local.set", index: st.valueLocal },
    ],
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
      then: [{ op: "local.get", index: st.iterLocal }, call(ctx, "__iterator_return")],
      else: [],
    },
  ];
  // The drive is standalone/WASI-only (see `tryEmitSpecOrderedArrayAssignDrive`),
  // so the exnref `try_table` shape is the only one it ever needs.
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
