// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) Shared model for the fnctor-graph satellite: the working state every
// phase threads, plus the small AST predicates all of them need. Split out of
// `fnctor-method-edges.ts` when the field-slot lattice (the field/param mutual
// fixpoint) pushed that one file past the god-file ceiling. The satellite's
// concerns now sit side by side:
//
//   fnctor-graph-model.ts    - state + shared predicates (this file)
//   fnctor-field-writes.ts   - the field WRITE taxonomy and the definiteness walk
//   fnctor-field-lattice.ts  - field slots as lattice variables
//   fnctor-method-edges.ts   - graph construction, edges, and the fixpoint driver
//
// The rationale for the satellite as a whole (why not widen
// `buildIrUnitTypeMap`) is in `fnctor-method-edges.ts`; this module carries no
// policy of its own.

import { ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import type { LatticeType } from "./propagate.js";

export const F64: LatticeType = { kind: "f64" };
export const STRING: LatticeType = { kind: "string" };
export const NO_FIELDS: ReadonlySet<string> = new Set();

export interface GraphNode {
  readonly id: IrUnitId;
  /** "callable" = top-level fn decl or `var F = function(){}` ctor. */
  readonly kind: "callable" | "static-method" | "proto-method";
  /** callable: binding name; methods: the method (property) name. */
  readonly name: string;
  /** methods: owning callable's node id. */
  readonly ownerId?: IrUnitId;
  readonly fn: ts.FunctionDeclaration | ts.FunctionExpression;
  poisoned: boolean;
}

export interface Edge {
  readonly callee: IrUnitId;
  readonly argExprs: readonly ts.Expression[];
  /** Enclosing function-like chain, outermost first (empty at top level). */
  readonly scopeChain: readonly ts.SignatureDeclaration[];
  /**
   * Owner whose INSTANCE `this` is bound to at the site, when provable — set
   * only for sites inside a materialized prototype method (a static method's
   * `this` is the ctor object; a plain function's is rebindable).
   */
  readonly thisOwner?: IrUnitId;
}

export interface MethodWriteState {
  decl?: ts.FunctionExpression;
  bad: boolean;
}

/** `"all"` = name-based over-approximation across every tracked owner. */
export type FieldOwner = IrUnitId | "all";

/**
 * How a field write was attributed, which fixes its `this`-read snapshot:
 *  - `ctor-direct`   — a statement of the ctor body, reachable without crossing
 *                      a function-like; snapshot comes from the ordered walk.
 *  - `ctor-nested`   — inside an arrow/callback in the ctor: may run at any time
 *                      or never, so nothing is provably assigned before it.
 *  - `proto-method`  — inside a materialized prototype method: the constructor
 *                      has completed, so its definite field set is the snapshot.
 *  - `all`           — untracked receiver; no `this` context at all.
 */
export type FieldAttribution = "ctor-direct" | "ctor-nested" | "proto-method" | "all";

export interface FieldWrite {
  /**
   * Mutable for exactly one writer: the receiver-provenance pass
   * (`fnctor-receiver-provenance.ts`) may re-attribute an `"all"` write to the
   * single tracked owner whose instances provably reach its receiver, BEFORE
   * the value fixpoint runs (attribution must be static input to it).
   */
  owner: FieldOwner;
  readonly name: string;
  /**
   * `numeric-op` covers `-= *= /= %= **= <<= >>= >>>= &= |= ^=` and `++`/`--`:
   * JS guarantees a NUMBER result regardless of the old value. `plus-assign`
   * is separate because `+` is string-or-number. `logical-assign` (`&&= ||=
   * ??=`) contributes only its RHS — the old value is already in the fact.
   */
  readonly kind: "assign" | "numeric-op" | "plus-assign" | "logical-assign";
  /** RHS as written (chain-unwrapping happens at eval time); absent for `numeric-op`. */
  readonly carrier?: ts.Expression;
  /** The assignment / update expression itself — the ordered walk keys on it. */
  readonly site: ts.Node;
  readonly scopeChain: readonly ts.SignatureDeclaration[];
  readonly attribution: FieldAttribution;
  /** Owner whose instance `this` is bound to, when tracked. */
  readonly thisOwner?: IrUnitId;
  /** Names provably assigned before this write can execute. */
  readSnapshot: ReadonlySet<string>;
  /** The write target's receiver expression (for `"all"` re-attribution). */
  readonly receiver?: ts.Expression;
}

/**
 * (#4250) A field-poison whose OWNER cannot be named at scan time: the write
 * (or reflection call, or dynamic-key delete) targets a non-`this` receiver,
 * so which owner's fields it can reach is a provenance question. Resolved by
 * `fnctor-receiver-provenance.ts` AFTER its parameter-provenance fixpoint:
 * receiver ⇒ R → poison R's `name` (or all of R's fields when `name` is
 * absent); receiver ⇒ ⊤ → poison the name for every owner (or every field of
 * every owner); receiver ⇒ ⊥ (null/undefined/builtin instance) → reaches no
 * tracked slot, nothing to poison.
 */
export interface DeferredFieldPoison {
  readonly receiver: ts.Expression;
  /** Literal property name; absent = any field of the receiver's owner. */
  readonly name?: string;
}

/** Mutable working state threaded through the analysis phases. */
export interface AnalysisState {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly nodes: Map<IrUnitId, GraphNode>;
  readonly nodeIdBySymbol: Map<ts.Symbol, IrUnitId>;
  readonly nodeIdByFn: Map<ts.Node, IrUnitId>;
  readonly protoAliasOwner: Map<ts.Symbol, IrUnitId>;
  readonly protoPoisoned: Set<IrUnitId>;
  readonly staticPoisoned: Set<IrUnitId>;
  /** "<ownerId> <space> <name>" → write-once state. */
  readonly methodWrites: Map<string, MethodWriteState>;
  readonly runtimeDefinedProtoKeys: Map<IrUnitId, Set<string>>;
  readonly valueReadNames: Set<string>;
  /** Every property NAME used anywhere except as an install (write) target. */
  readonly propertyNameUses: Set<string>;
  /** Callable identifier refs in disallowed positions, adjudicated post-scan. */
  readonly escapeCandidates: { nodeId: IrUnitId; id: ts.Identifier }[];
  readonly callSites: ts.CallExpression[];
  readonly newSites: ts.NewExpression[];
  readonly methodNodesByName: Map<string, GraphNode[]>;
  /** "<ownerId> <name>" → static method node. */
  readonly staticMethodNode: Map<string, GraphNode>;
  readonly edges: Edge[];
  // ── field-slot lattice variables (#743 mutual fixpoint) ────────────────────
  readonly fieldWrites: FieldWrite[];
  /** Names with at least one write attributed to this owner directly. */
  readonly fieldNamesByOwner: Map<IrUnitId, Set<string>>;
  /** Names definitely assigned by the END of the owner's constructor. */
  readonly definiteCtorFields: Map<IrUnitId, Set<string>>;
  /** Name poisoned for EVERY owner (untracked `delete`, destructuring, …). */
  readonly fieldDynamicNames: Set<string>;
  readonly fieldDynamicPerOwner: Map<IrUnitId, Set<string>>;
  /** Owners whose entire field set is unknowable (`this[k] = v`, …). */
  readonly fieldPoisonedOwners: Set<IrUnitId>;
  /** (#4250) Poisons awaiting receiver provenance — see {@link DeferredFieldPoison}. */
  readonly deferredFieldPoisons: DeferredFieldPoison[];
  poisonAllFields: boolean;
  poisonAllMethods: boolean;
  poisonAllCtors: boolean;
  nextId: number;
}

/**
 * Post-fixpoint facts. `paramFacts` is name-keyed (unique names only);
 * `thisReadFacts` is NODE-keyed so the codegen consumer never has to re-derive
 * definiteness or statement ordering — and therefore cannot drift from what the
 * satellite actually proved.
 */
export interface GraphFacts {
  readonly paramFacts: ReadonlyMap<string, readonly LatticeType[]>;
  readonly thisReadFacts: ReadonlyMap<ts.Node, LatticeType>;
  /**
   * (#4250) Per-owner per-field write-kind verdicts, POISON-GUARDED: DYNAMIC
   * wherever any cannot-see path exists. The fail-closed side — what a
   * narrowing must positively pass.
   */
  readonly fieldVerdicts: ReadonlyMap<string, ReadonlyMap<string, LatticeType>>;
  /**
   * (#4250) The raw per-field write JOINS, poison-free: exactly what the
   * enumerated writes store. The violation-detection side — a poison can add
   * unseen writes but never erases seen evidence, so a proven type-changing
   * write stays provable in a module that also trips a poison.
   */
  readonly fieldWriteJoins: ReadonlyMap<string, ReadonlyMap<string, LatticeType>>;
}

export const EMPTY_FACTS: GraphFacts = {
  paramFacts: new Map(),
  thisReadFacts: new Map(),
  fieldVerdicts: new Map(),
  fieldWriteJoins: new Map(),
};

/** Keys of an object literal, or a top-level once-declared var holding one. */
export function resolveLiteralKeys(sourceFile: ts.SourceFile, arg: ts.Expression): Set<string> | undefined {
  const a = unwrap(arg);
  let lit: ts.ObjectLiteralExpression | undefined;
  if (ts.isObjectLiteralExpression(a)) lit = a;
  else if (ts.isIdentifier(a)) {
    let count = 0;
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== a.text) continue;
        count++;
        const i = d.initializer !== undefined ? unwrap(d.initializer) : undefined;
        lit = i !== undefined && ts.isObjectLiteralExpression(i) ? i : undefined;
      }
    }
    if (count !== 1) return undefined;
  }
  if (lit === undefined) return undefined;
  const keys = new Set<string>();
  for (const prop of lit.properties) {
    const name = prop.name;
    if (name === undefined || !(ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) {
      return undefined;
    }
    keys.add(name.text);
  }
  return keys;
}

export function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * `Symbol.<wellKnown>` computed-key test — symbol keys cannot collide with the
 * string-keyed method slots this analysis reasons about (same allowance as the
 * escape gate's write-once pass).
 */
export function isSymbolKeyed(idx: ts.Expression | undefined): boolean {
  if (idx === undefined) return false;
  const e = unwrap(idx);
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Symbol";
}

export function isFunctionLikeNode(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

export function isClassMemberLike(node: ts.Node): boolean {
  return (
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

export function symOf(state: AnalysisState, node: ts.Node): ts.Symbol | undefined {
  return state.checker.getSymbolAtLocation(node);
}

export function mkId(state: AnalysisState): IrUnitId {
  return `__fnctor_graph_${state.nextId++}` as IrUnitId;
}

export function writeKey(ownerId: IrUnitId, space: "static" | "proto", name: string): string {
  return `${ownerId} ${space} ${name}`;
}

/** Resolve a member-access BASE to the method space it addresses, if any. */
export function spaceOfBase(
  state: AnalysisState,
  baseExpr: ts.Expression,
): { ownerId: IrUnitId; space: "static" | "proto" } | undefined {
  const base = unwrap(baseExpr);
  if (ts.isPropertyAccessExpression(base) && base.name.text === "prototype") {
    const inner = unwrap(base.expression);
    if (ts.isIdentifier(inner)) {
      const sym = symOf(state, inner);
      const ownerId = sym ? state.nodeIdBySymbol.get(sym) : undefined;
      if (ownerId !== undefined) return { ownerId, space: "proto" };
    }
    return undefined;
  }
  if (ts.isIdentifier(base)) {
    const sym = symOf(state, base);
    if (sym) {
      const aliasOwner = state.protoAliasOwner.get(sym);
      if (aliasOwner !== undefined) return { ownerId: aliasOwner, space: "proto" };
      const ownerId = state.nodeIdBySymbol.get(sym);
      if (ownerId !== undefined) return { ownerId, space: "static" };
    }
  }
  return undefined;
}

/** True when no function-like sits between `site` and `binder`. */
export function isDirectlyInside(site: ts.Node, binder: ts.Node): boolean {
  for (let cur: ts.Node | undefined = site.parent; cur !== undefined && cur !== binder; cur = cur.parent) {
    if (isFunctionLikeNode(cur)) return false;
  }
  return true;
}

export function scopeChainOf(site: ts.Node): ts.SignatureDeclaration[] {
  const chain: ts.SignatureDeclaration[] = [];
  for (let cur: ts.Node | undefined = site.parent; cur !== undefined; cur = cur.parent) {
    if (isFunctionLikeNode(cur)) chain.unshift(cur);
  }
  return chain;
}

/** Nearest `this`-binding enclosing function (arrows are transparent). */
export function enclosingThisBinder(site: ts.Node): ts.Node | undefined {
  for (let cur: ts.Node | undefined = site.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur)) return cur;
    if (isClassMemberLike(cur)) return cur; // class semantics — `this` is never a fnctor here
  }
  return undefined;
}
