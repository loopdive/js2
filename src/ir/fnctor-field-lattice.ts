// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) Field slots AS lattice variables - the half of the mutual fixpoint that
// answers "what does `this.<x>` evaluate to". See `fnctor-graph-model.ts` for
// the satellite's module map; the driver loop lives in `fnctor-method-edges.ts`.

import { ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import {
  fieldFactTraceEnabled,
  recordFieldFactContribution,
  recordFieldFactFinal,
  recordFieldFactPlusRhs,
} from "./fnctor-field-fact-trace.js";
import { type AnalysisState, F64, type FieldWrite, NO_FIELDS, STRING, unwrap } from "./fnctor-graph-model.js";
import {
  _propagationCore as core,
  type InferExtension,
  LATTICE_OBJECT_SHAPE_MAX_DEPTH,
  type LatticeAtom,
  type LatticeType,
} from "./propagate.js";

// ── Phase 6: mutual fixpoint (propagate.ts lattice core) ──────────────────────
//
// Field slots are lattice VARIABLES here, solved together with params: a param
// fact seeds a field (`this.pos = startPos`) and a field read feeds a param
// (`this.startNodeAt(this.start, …)`). Every fact is recomputed from its seeds
// each iteration, which is load-bearing — see the monotonicity note on
// `runFixpoint`.

export type FieldFacts = Map<IrUnitId, Map<string, LatticeType>>;

export interface ThisContext {
  readonly owner: IrUnitId;
  readonly snapshot: ReadonlySet<string>;
}

export interface FixpointCtx {
  readonly state: AnalysisState;
  readonly entries: Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>;
  readonly fieldFacts: FieldFacts;
  /** Per-iteration instance atoms, rebuilt from the facts at iteration start. */
  readonly atoms: Map<IrUnitId, LatticeType>;
  readonly resolver: (identifier: ts.Identifier) => IrUnitId | undefined;
  readonly buildScope: (chain: readonly ts.SignatureDeclaration[]) => Map<string, LatticeType>;
  /**
   * (#743) Satellite-only evaluator precision, passed to every `core.inferExpr`
   * call this module makes. Absent for the post-convergence read-back context
   * (`collectThisReadFacts`), which never evaluates an expression.
   */
  readonly ext?: InferExtension;
}

function isAtom(t: LatticeType): t is LatticeAtom {
  return (
    t.kind === "f64" ||
    t.kind === "i32" ||
    t.kind === "u32" ||
    t.kind === "bool" ||
    t.kind === "string" ||
    t.kind === "object"
  );
}

function atomDepth(a: LatticeAtom): number {
  if (a.kind !== "object") return 0;
  let max = 0;
  for (const f of a.fields) {
    const d = atomDepth(f.type);
    if (d > max) max = d;
  }
  return max + 1;
}

/**
 * The value of `this.<name>` for an instance of `owner`, given what is provably
 * assigned at the read.
 *
 * DYNAMIC whenever the slot could be intercepted, renamed or absent. Otherwise
 * the CURRENT fact — including raw `unknown`. Returning `unknown` (lattice
 * bottom) rather than DYNAMIC for a written-but-not-yet-resolved field is what
 * lets a ctor-param↔field cycle start optimistic and converge upward instead of
 * freezing at DYNAMIC on the first iteration.
 */
export function readFieldFact(
  fx: FixpointCtx,
  owner: IrUnitId,
  name: string,
  snapshot: ReadonlySet<string>,
): LatticeType {
  const state = fx.state;
  if (state.poisonAllFields) return core.DYNAMIC;
  const node = state.nodes.get(owner);
  // A value-escaped callable is constructed through flows we cannot see, so a
  // literal like `this.type = ""` in its body proves nothing about the slot.
  if (node === undefined || node.poisoned) return core.DYNAMIC;
  if (state.fieldPoisonedOwners.has(owner)) return core.DYNAMIC;
  // A replaced / runtime-defined prototype can carry ACCESSORS that intercept
  // both `this.x =` and `this.x`.
  if (state.protoPoisoned.has(owner)) return core.DYNAMIC;
  if (state.runtimeDefinedProtoKeys.get(owner)?.has(name) === true) return core.DYNAMIC;
  if (state.fieldDynamicNames.has(name)) return core.DYNAMIC;
  if (state.fieldDynamicPerOwner.get(owner)?.has(name) === true) return core.DYNAMIC;
  if (state.fieldNamesByOwner.get(owner)?.has(name) !== true) return core.DYNAMIC;
  // The undefined-read guard: an unassigned read yields `undefined`, and an
  // f64 fact would silently turn that into NaN at a coercing store.
  if (!snapshot.has(name)) return core.DYNAMIC;
  return fx.fieldFacts.get(owner)?.get(name) ?? core.UNKNOWN;
}

/** The instance shape of `owner` as a lattice object atom, or DYNAMIC. */
export function instanceAtomFor(fx: FixpointCtx, owner: IrUnitId): LatticeType {
  const snapshot = fx.state.definiteCtorFields.get(owner) ?? NO_FIELDS;
  const fields: { name: string; type: LatticeAtom }[] = [];
  for (const name of [...snapshot].sort()) {
    const t = readFieldFact(fx, owner, name, snapshot);
    if (!isAtom(t)) continue;
    if (atomDepth(t) >= LATTICE_OBJECT_SHAPE_MAX_DEPTH) continue;
    fields.push({ name, type: t });
  }
  // Name-sorted is the atom invariant `atomsEqual` relies on; an empty literal
  // is DYNAMIC in the shared lattice, so mirror that.
  return fields.length === 0 ? core.DYNAMIC : { kind: "object", fields };
}

/** Chain carrier, byte-identical to `deriveFnctorFields`' loop (no unwrapping). */
function chainCarrier(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    cur = cur.right;
  }
  return cur;
}

/** A `this.<name>` read, or `undefined`. */
function thisPropertyRead(expr: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(expr) || ts.isPrivateIdentifier(expr.name)) return undefined;
  return unwrap(expr.expression).kind === ts.SyntaxKind.ThisKeyword ? expr.name.text : undefined;
}

/**
 * The single evaluator used for every edge argument and every field-write RHS.
 *
 * A DIRECT `this.<x>` read is answered from the field facts rather than through
 * the instance atom: the atom cannot represent an `unknown` field at all, so
 * routing direct reads through it would answer DYNAMIC for exactly the
 * unresolved fields whose cycles this fixpoint exists to close.
 */
export function evalValueExpr(
  fx: FixpointCtx,
  expr: ts.Expression,
  scope: ReadonlyMap<string, LatticeType>,
  thisCtx: ThisContext | undefined,
): LatticeType {
  let e = unwrap(expr);
  while (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    e = unwrap(e.right);
  }
  if (thisCtx !== undefined) {
    const name = thisPropertyRead(e);
    if (name !== undefined) return readFieldFact(fx, thisCtx.owner, name, thisCtx.snapshot);
  }
  return core.inferExpr(e, scope, fx.entries, fx.resolver, fx.ext);
}

/**
 * `a += b` on a field: `+` is the one operator that is string-OR-number.
 * `undefined + 1` is NaN (still a number) and `undefined + "s"` is a string, so
 * both are covered by the operand classes rather than by definiteness.
 */
function plusJoin(current: LatticeType, rhs: LatticeType): LatticeType {
  if (current.kind === "string" || rhs.kind === "string") return STRING;
  const numeric = (t: LatticeType): boolean =>
    t.kind === "f64" || t.kind === "i32" || t.kind === "u32" || t.kind === "unknown";
  return numeric(current) && numeric(rhs) ? F64 : core.DYNAMIC;
}

/** Scope + `this` context in force at a field write. */
function writeContext(fx: FixpointCtx, w: FieldWrite): { scope: Map<string, LatticeType>; thisCtx?: ThisContext } {
  const scope = fx.buildScope(w.scopeChain);
  if (w.thisOwner === undefined) return { scope };
  scope.set("<this>", fx.atoms.get(w.thisOwner) ?? core.DYNAMIC);
  return { scope, thisCtx: { owner: w.thisOwner, snapshot: w.readSnapshot } };
}

function fieldContribution(fx: FixpointCtx, w: FieldWrite, owner: IrUnitId, name: string): LatticeType {
  if (w.kind === "numeric-op") return F64;
  if (w.carrier === undefined) return core.DYNAMIC;
  const { scope, thisCtx } = writeContext(fx, w);
  const rhs = evalValueExpr(fx, w.carrier, scope, thisCtx);
  if (w.kind !== "plus-assign") return rhs;
  if (fieldFactTraceEnabled()) recordFieldFactPlusRhs(fx.state, owner, name, w, rhs);
  return rhs;
}

/**
 * Solve `X = join(base, plusJoin(X, rhs_i) ∀i)` WITHIN the pass.
 *
 * `+=` folds the field's own value in, and the obvious implementation — read
 * the PREVIOUS iteration's fact — is a ratchet, not a fixpoint variable: the
 * atom-mediated reads make facts transiently DYNAMIC (a field is not in the
 * instance atom until its fact resolves), and `plusJoin(dynamic, …)` is
 * DYNAMIC, so one transient pollutes every later iteration through its own
 * feedback edge and the "recompute from seeds each iteration" discipline the
 * monotonicity note demands is silently violated. Measured on acorn: with the
 * cross-iteration read, `Parser.pos` stays `dynamic` with every single
 * contribution evaluating `f64`. Solving the self-reference locally (the
 * lattice height bounds the inner loop) removes the only cross-iteration
 * self-dependency a field fact had.
 */
function solvePlusFeedback(base: LatticeType, plusRhs: readonly LatticeType[]): LatticeType {
  let next = base;
  for (let step = 0; step < 4; step++) {
    let candidate = next;
    for (const rhs of plusRhs) candidate = core.join(candidate, plusJoin(next, rhs));
    if (core.typesEqual(candidate, next)) return next;
    next = candidate;
  }
  return core.DYNAMIC; // lattice height makes this unreachable; refuse rather than under-join
}

/** Writes that can reach `owner.<name>` — its own plus every name-based one. */
export function buildWriteIndex(state: AnalysisState): Map<IrUnitId, Map<string, FieldWrite[]>> {
  const byName = new Map<string, FieldWrite[]>();
  for (const w of state.fieldWrites) {
    if (w.owner !== "all") continue;
    const arr = byName.get(w.name);
    if (arr) arr.push(w);
    else byName.set(w.name, [w]);
  }
  const index = new Map<IrUnitId, Map<string, FieldWrite[]>>();
  for (const [owner, names] of state.fieldNamesByOwner) {
    const perName = new Map<string, FieldWrite[]>();
    for (const name of names) perName.set(name, [...(byName.get(name) ?? [])]);
    index.set(owner, perName);
  }
  for (const w of state.fieldWrites) {
    if (w.owner === "all") continue;
    index.get(w.owner)?.get(w.name)?.push(w);
  }
  return index;
}

export function runFieldPass(fx: FixpointCtx, writeIndex: Map<IrUnitId, Map<string, FieldWrite[]>>): boolean {
  const tracing = fieldFactTraceEnabled();
  let changed = false;
  for (const [owner, perName] of writeIndex) {
    const node = fx.state.nodes.get(owner);
    if (node === undefined || node.poisoned) continue;
    const facts = fx.fieldFacts.get(owner)!;
    for (const [name, writes] of perName) {
      let base: LatticeType = core.UNKNOWN;
      const plusRhs: LatticeType[] = [];
      for (const w of writes) {
        const contribution = fieldContribution(fx, w, owner, name);
        if (tracing) recordFieldFactContribution(fx.state, owner, name, w, contribution);
        if (w.kind === "plus-assign") {
          plusRhs.push(contribution); // the RHS value; the feedback is solved below
          continue;
        }
        base = core.join(base, contribution);
        // Tracing keeps evaluating past the first DYNAMIC so every pin is
        // visible; the join is already at top, so the result is identical.
        if (base.kind === "dynamic" && !tracing) break;
      }
      const next = base.kind === "dynamic" ? base : solvePlusFeedback(base, plusRhs);
      if (tracing) recordFieldFactFinal(fx.state, owner, name, next);
      if (!core.typesEqual(facts.get(name) ?? core.UNKNOWN, next)) {
        facts.set(name, next);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * (#4250) The per-owner, per-field WRITE-KIND VERDICT: the converged join over
 * every write the analysis can enumerate as reaching `owner.<name>`, with every
 * cannot-see path answered DYNAMIC — the poison guards of `readFieldFact`,
 * minus its definiteness snapshot (the verdict is about which VALUES writes
 * store, not about whether a read can observe `undefined`; presence tracking
 * owns the latter).
 *
 * This is the fact a slot-narrowing consumer must consult before giving a
 * field a machine slot: a slot must hold every value every reaching write can
 * store. Name-keyed like `paramFacts` (unique callable names only) so codegen
 * never touches an `IrUnitId`.
 */
export function collectFieldVerdicts(
  state: AnalysisState,
  fieldFacts: FieldFacts,
  nameCounts: ReadonlyMap<string, number>,
): {
  readonly guarded: ReadonlyMap<string, ReadonlyMap<string, LatticeType>>;
  readonly rawJoins: ReadonlyMap<string, ReadonlyMap<string, LatticeType>>;
} {
  const guarded = new Map<string, ReadonlyMap<string, LatticeType>>();
  const rawJoins = new Map<string, ReadonlyMap<string, LatticeType>>();
  const fx: FixpointCtx = {
    state,
    entries: new Map(),
    fieldFacts,
    atoms: new Map(),
    resolver: () => undefined,
    buildScope: () => new Map(),
  };
  for (const [owner, names] of state.fieldNamesByOwner) {
    const node = state.nodes.get(owner);
    if (node === undefined || node.kind !== "callable" || nameCounts.get(node.name) !== 1) continue;
    const perFieldGuarded = new Map<string, LatticeType>();
    const perFieldRaw = new Map<string, LatticeType>();
    for (const name of names) {
      // `readFieldFact` with the name itself as the snapshot: every guard
      // applies, the definiteness check is vacuously satisfied.
      perFieldGuarded.set(name, readFieldFact(fx, owner, name, new Set([name])));
      // The RAW join is the poison-FREE view. A poison means "writes we cannot
      // see may also reach this field" — it can never ERASE the writes we DID
      // enumerate, so positive violation evidence (the string member of
      // `union[f64,string]`) must survive a module-wide poison. Without this
      // split, one dictionary-object computed write anywhere in a module
      // (acorn has ~20) would blank the very evidence that fixes the
      // `this.tag = 1; a.tag = "s"` miscompile.
      perFieldRaw.set(name, fieldFacts.get(owner)?.get(name) ?? core.UNKNOWN);
    }
    guarded.set(node.name, perFieldGuarded);
    rawJoins.set(node.name, perFieldRaw);
  }
  return { guarded, rawJoins };
}

/**
 * Post-convergence: the resolved value of every non-identifier carrier of a
 * CONSTRUCTOR field write, keyed by the carrier node the consumer will compute.
 *
 * Only ctor-direct plain assignments are recorded, because that is exactly what
 * `deriveFnctorFields` hands the consumer. The chain unwrap matches the escape
 * gate's carrier loop so `this.start = this.end = this.pos` keys on `this.pos`
 * for BOTH slots.
 *
 * Two carrier shapes are recorded:
 *  - `this.<y>` reads — answered by `readFieldFact` through `evalValueExpr`,
 *    with the write's own definiteness snapshot (a read that could observe
 *    `undefined` never carries a numeric fact);
 *  - `<param>.<y>` reads (`this.start = p.start` — acorn's Token pattern) and
 *    any other property access on an identifier — answered by the converged
 *    evaluator: the parameter's instance ATOM carries the source owner's
 *    definite atom-typed fields, so the read resolves iff the source field's
 *    own fact did. Bare-identifier carriers are deliberately ABSENT: the
 *    consumer's parameter path has its own legacy-first semantics (#4117
 *    agreement before graph fallback) that a node-keyed answer must not bypass.
 *
 * `fx` is the SOLVED fixpoint context (final-iteration atoms, converged
 * entries), so evaluation here answers exactly what the fixpoint proved.
 */
export function collectCtorCarrierFacts(
  state: AnalysisState,
  fx: FixpointCtx,
  nameCounts: ReadonlyMap<string, number>,
): ReadonlyMap<ts.Node, LatticeType> {
  const out = new Map<ts.Node, LatticeType>();
  for (const w of state.fieldWrites) {
    if (w.attribution !== "ctor-direct" || w.kind !== "assign" || w.carrier === undefined) continue;
    const owner = w.owner;
    if (owner === "all") continue;
    const node = state.nodes.get(owner);
    if (node === undefined || node.poisoned || nameCounts.get(node.name) !== 1) continue;
    const carrier = chainCarrier(w.carrier);
    if (!ts.isPropertyAccessExpression(carrier) || ts.isPrivateIdentifier(carrier.name)) continue;
    const base = unwrap(carrier.expression);
    if (base.kind !== ts.SyntaxKind.ThisKeyword && !ts.isIdentifier(base)) continue;
    const { scope, thisCtx } = writeContext(fx, w);
    out.set(carrier, evalValueExpr(fx, carrier, scope, thisCtx));
  }
  return out;
}
