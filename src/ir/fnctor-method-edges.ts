// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) Call-graph COMPLETENESS slice — prototype/static-method call edges and
// `new this(…)` edges, run as a self-contained companion fixpoint next to
// `src/ir/propagate.ts`.
//
// Why this exists
// ===============
//
// Two measured nulls (single-hop #4117, fixpoint `new`-edges #4131 + `.d.ts`
// seeds) both bottomed out at the same wall: on acorn, every chain from a typed
// entrypoint into `Parser`'s constructor crosses (1) a PROPERTY call
// (`Parser.parse(input, options)` — a write-once STATIC method) and then
// (2) `new this(options, input)` inside that static method. Neither is an
// identifier call, so `buildCallGraph` in propagate.ts carries no edge across
// either hop — and `var Parser = function Parser(...)` is a function
// EXPRESSION, outside `collectIndexedFunctionDeclarations`' population
// entirely. Seeded facts reach nothing.
//
// Why a SATELLITE fixpoint instead of widening `buildIrUnitTypeMap`
// =================================================================
//
// The main map's entries feed IR selection (`select.ts`) and the legacy-parity
// seams (`resolveIrOverrideParamType`, the typeIdx-parity fallback). Widening
// its population or its edge set changes which functions the IR claims and with
// what ABI, which is exactly the #1712-class demotion hazard. This module keeps
// the main map BYTE-IDENTICAL: it runs its own fixpoint over a WIDER population
// (top-level function declarations + top-level `var F = function(){}` ctors +
// write-once static/prototype methods) using the exported lattice core, and its
// output feeds exactly ONE consumer — the fnctor field-slot narrowing in
// `src/codegen/fnctor-ctor-param-types.ts` (f64-only, flag-gated with the rest
// of the `JS2WASM_FNCTOR_CTOR_PARAM_TYPES` family). Both backends (WasmGC and
// linear) read field shapes through the shared `deriveFnctorFields`, so the
// lanes cannot infer different shapes from these facts by construction.
//
// Soundness rules (widening beats guessing)
// =========================================
//
// A narrowed fact is only sound if every call site that can reach the callee
// either contributed an edge or widened the fact. Concretely:
//
//  - Method-call edges are NAME-BASED over-approximations: a site `recv.m(…)`
//    whose receiver is not provably the constructor object feeds EVERY
//    write-once method named `m` (any owner, static or prototype). Feeding a
//    method args from a site that dispatches elsewhere only widens — the
//    unsound direction is a site that reaches the method but contributes
//    nothing, which name-matching structurally prevents.
//  - A method whose name is READ in value position anywhere (`var f = pp.m`,
//    `x.m.call(…)` — the access is the base of another access) may be invoked
//    through flows we cannot see → that name publishes NO method nodes.
//  - A dynamic-key access on a TRACKED base (`pp[k]`, `F.prototype[k]`,
//    `F[k]`, or any `this[k]` — read, call, or write) can reach any of that
//    owner's methods → the owner's space is dropped (`this[k]` drops ALL
//    methods, since the receiver's owner is not localized). A dynamic-key
//    call on an UNTRACKED base (`plugins[i](cls)` — acorn's extend loop) is
//    NOT a poison: a write-once method's function value can only reach such a
//    container through a value-position read this analysis already poisons,
//    or through a dynamic-key read of an instance — which is the one
//    DOCUMENTED gap below, shared with the value-read rule.
//  - KNOWN ACCEPTED GAP (family-consistent — the legacy #4117 scan has no
//    escape analysis at all): a dynamic-key read of an INSTANCE
//    (`someParser[k]`) can escape a method value without tracing here. The
//    consumer's f64-only restriction bounds the damage to a ToNumber-class
//    coercion at a field store, never a reinterpreted reference.
//  - Write-once discipline: a method assigned twice, conditionally, at
//    non-top-level, through a computed key, `defineProperty`-installed, or on a
//    reassigned/deleted prototype contributes NO node. Its body is still walked
//    for sites, with its parameters bound DYNAMIC — conservative both ways.
//  - A constructor/function whose VALUE escapes (referenced outside callee /
//    property-base / export positions) is poisoned to all-DYNAMIC params: a
//    `var C2 = F; new C2()` alias or `arr.push(F)` flow would otherwise call it
//    with args this graph cannot see. ONE boundary-only shape is admitted:
//    the API-mirror literal (`Parser.acorn = { Parser: Parser, … }`) whose
//    holding property is used nowhere else — see {@link isApiMirrorRef}.
//  - `new this(…)` binds `this` to the constructor only in a STATIC method
//    (`F.m = function(){…}`). Inside a prototype method `this` is an instance
//    (not constructable — contributes nothing, skipped); inside a plain
//    function `this` could be rebound to anything via `.call` → ALL ctor facts
//    are dropped. Class methods are skipped (`this` is the class, never a
//    fnctor in this population).
//  - Scope modeling at a site is params-only along the enclosing function
//    chain; params of non-population functions bind DYNAMIC, unknown
//    identifiers infer DYNAMIC (propagate.ts's rule) — misses widen.
//
// External-boundary trust matches the rest of the family (#4117, `.d.ts` seeds
// #743): exported entrypoints/ctors may be called from outside with anything;
// the consumer is f64-only, and an f64-typed field slot coerces a violating
// boxed value through the numeric unbox path (NaN-class result, never a
// reinterpreted reference). That is the same accepted trust model as the
// checker-based `any - any = number` narrowing #4117 already ships.

import { forEachChild, ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import {
  type AnalysisState,
  type Edge,
  EMPTY_FACTS,
  type GraphFacts,
  type GraphNode,
  NO_FIELDS,
  enclosingThisBinder,
  isClassMemberLike,
  isFunctionLikeNode,
  isSymbolKeyed,
  mkId,
  resolveLiteralKeys,
  scopeChainOf,
  spaceOfBase,
  symOf,
  unwrap,
  writeKey,
} from "./fnctor-graph-model.js";
import { computeDefiniteCtorFields, scanFieldWrites } from "./fnctor-field-writes.js";
import {
  type FieldFacts,
  type FixpointCtx,
  type ThisContext,
  buildWriteIndex,
  collectCtorCarrierFacts,
  collectFieldVerdicts,
  evalValueExpr,
  instanceAtomFor,
  runFieldPass,
} from "./fnctor-field-lattice.js";
import { createSatelliteInferExtension } from "./fnctor-eval-extensions.js";
import { refineFieldWriteAttribution } from "./fnctor-receiver-provenance.js";
import { _propagationCore as core, type InferExtension, type LatticeType } from "./propagate.js";

const memo = new WeakMap<ts.SourceFile, GraphFacts>();

/**
 * Post-fixpoint per-parameter lattice facts for every non-poisoned top-level
 * callable (fn-decl or `var F = function(){}`), keyed by binding name.
 * Memoized per SourceFile. Pure analysis — mutates nothing.
 *
 * `host` is a minimal structural slice of CodegenContext so the codegen-side
 * consumer can pass `ctx` without a raw `ctx.checker` read (oracle-ratchet);
 * the checker access lives here, in `src/ir`, outside the gate.
 */
export function computeFnctorGraphCtorParamFacts(
  sourceFile: ts.SourceFile,
  host: { checker: ts.TypeChecker },
): ReadonlyMap<string, readonly LatticeType[]> {
  return graphFacts(sourceFile, host).paramFacts;
}

/**
 * Post-fixpoint lattice value of every `this.<y>` or `<identifier>.<y>` READ
 * that carries a constructor field write, keyed by the read's
 * `PropertyAccessExpression`.
 *
 * This is the field↔param mutual fixpoint's output for the shapes
 * `this.start = this.end = this.pos` (a field of the instance under
 * construction) and `this.start = p.start` (a field of ANOTHER owner's
 * instance, carried by a parameter's instance atom — acorn's Token pattern).
 * Neither is expressible as a parameter fact. Definiteness and statement
 * ordering are already applied — a read that could observe `undefined` never
 * appears with a numeric fact.
 */
export function computeFnctorGraphCtorThisReadFacts(
  sourceFile: ts.SourceFile,
  host: { checker: ts.TypeChecker },
): ReadonlyMap<ts.Node, LatticeType> {
  return graphFacts(sourceFile, host).thisReadFacts;
}

/**
 * (#4250) Post-fixpoint per-owner per-field WRITE-KIND VERDICTS — the join
 * over every write the analysis can enumerate as reaching `Owner.<field>`,
 * DYNAMIC on every cannot-see path (escaped owner, replaced prototype,
 * computed-key writes, `delete`, reflection — the deferred receiver-provenance
 * poisons included). A slot-narrowing consumer must refuse any narrowing this
 * map cannot positively justify: absent owner, absent field, or a non-matching
 * kind all mean NO.
 */
export function computeFnctorGraphFieldVerdicts(
  sourceFile: ts.SourceFile,
  host: { checker: ts.TypeChecker },
): ReadonlyMap<string, ReadonlyMap<string, LatticeType>> {
  return graphFacts(sourceFile, host).fieldVerdicts;
}

/**
 * (#4250) The poison-FREE per-field write joins — the VIOLATION-detection
 * companion of {@link computeFnctorGraphFieldVerdicts}: exactly what the
 * enumerated writes store, with no cannot-see widening. Positive evidence of a
 * type-changing write (the `string` member of `union[f64,string]`) survives a
 * module-wide poison here; nothing in this map ever licenses a narrowing.
 */
export function computeFnctorGraphFieldWriteJoins(
  sourceFile: ts.SourceFile,
  host: { checker: ts.TypeChecker },
): ReadonlyMap<string, ReadonlyMap<string, LatticeType>> {
  return graphFacts(sourceFile, host).fieldWriteJoins;
}

function graphFacts(sourceFile: ts.SourceFile, host: { checker: ts.TypeChecker }): GraphFacts {
  const cached = memo.get(sourceFile);
  if (cached) return cached;
  const result = analyze(sourceFile, host.checker);
  memo.set(sourceFile, result);
  return result;
}

function analyze(sourceFile: ts.SourceFile, checker: ts.TypeChecker): GraphFacts {
  const state: AnalysisState = {
    sourceFile,
    checker,
    nodes: new Map(),
    nodeIdBySymbol: new Map(),
    nodeIdByFn: new Map(),
    protoAliasOwner: new Map(),
    protoPoisoned: new Set(),
    staticPoisoned: new Set(),
    methodWrites: new Map(),
    runtimeDefinedProtoKeys: new Map(),
    valueReadNames: new Set(),
    callSites: [],
    newSites: [],
    methodNodesByName: new Map(),
    staticMethodNode: new Map(),
    edges: [],
    propertyNameUses: new Set(),
    escapeCandidates: [],
    fieldWrites: [],
    fieldNamesByOwner: new Map(),
    definiteCtorFields: new Map(),
    fieldDynamicNames: new Set(),
    fieldDynamicPerOwner: new Map(),
    fieldPoisonedOwners: new Set(),
    deferredFieldPoisons: [],
    poisonAllFields: false,
    poisonAllMethods: false,
    poisonAllCtors: false,
    nextId: 0,
  };

  collectCallables(state);
  collectProtoAliases(state);
  scanFile(state);
  adjudicateEscapes(state);
  materializeMethodNodes(state);
  scanFieldWrites(state);
  computeDefiniteCtorFields(state);
  buildEdges(state);
  if (state.poisonAllCtors) return EMPTY_FACTS;
  // (#743) Receiver-provenance attribution — re-home `"all"` writes whose
  // receiver provably holds instances of ONE tracked owner (acorn's 22
  // `state.pos = …` writes). Must run BEFORE the value fixpoint: attribution
  // is static input to it, and rewriting mid-iteration would be non-monotone.
  refineFieldWriteAttribution(state);
  const solved = runFixpoint(state);
  // Non-convergence is NOT "use what we have": the atom-mediated reads are not
  // monotone (a fact rising `unknown → f64` makes a field ENTER the instance
  // atom, which can make a dependent fact DROP), so an unconverged intermediate
  // state is unsound to consume. Empty output is strictly safe.
  if (!solved.converged) return EMPTY_FACTS;
  const entries = solved.entries;

  // Output: per-callable param facts, unique names only.
  const nameCounts = new Map<string, number>();
  for (const node of state.nodes.values()) {
    if (node.kind === "callable") nameCounts.set(node.name, (nameCounts.get(node.name) ?? 0) + 1);
  }
  const out = new Map<string, readonly LatticeType[]>();
  for (const node of state.nodes.values()) {
    if (node.kind !== "callable" || node.poisoned || nameCounts.get(node.name) !== 1) continue;
    out.set(node.name, entries.get(node.id)!.params);
  }
  const thisReadFacts = collectCtorCarrierFacts(state, solved.fx, nameCounts);
  const { guarded: fieldVerdicts, rawJoins: fieldWriteJoins } = collectFieldVerdicts(
    state,
    solved.fieldFacts,
    nameCounts,
  );

  // Inert diagnostics (JS2WASM_LOG_FNCTOR_GRAPH=1) — mirrors the escape gate's
  // JS2WASM_LOG_FNCTOR_GATE pattern; zero effect on output.
  if (process.env.JS2WASM_LOG_FNCTOR_GRAPH === "1") {
    const callables = [...state.nodes.values()].filter((n) => n.kind === "callable");
    const methods = [...state.nodes.values()].filter((n) => n.kind !== "callable");
    const poisonedNames = callables.filter((n) => n.poisoned).map((n) => n.name);
    const writeStates = [...state.methodWrites.values()];
    const lines: string[] = [
      `[#743 fnctor-graph] callables=${callables.length} (poisoned: ${poisonedNames.join(",") || "none"}) ` +
        `methods=${methods.length} edges=${state.edges.length} ` +
        `poisonAllMethods=${state.poisonAllMethods} poisonAllCtors=${state.poisonAllCtors} ` +
        `writes=${writeStates.length} (bad=${writeStates.filter((w) => w.bad).length}) ` +
        `protoPoisoned=${state.protoPoisoned.size} staticPoisoned=${state.staticPoisoned.size} ` +
        `valueReadNames=${state.valueReadNames.size}`,
      `[#743 fnctor-graph] method nodes: ${methods.map((m) => m.name).join(",") || "none"}`,
      `[#743 fnctor-graph] fieldWrites=${state.fieldWrites.length} ` +
        `owners=${state.fieldNamesByOwner.size} poisonAllFields=${state.poisonAllFields} ` +
        `fieldPoisonedOwners=${state.fieldPoisonedOwners.size} thisReads=${thisReadFacts.size} ` +
        `dynamicNames=[${[...state.fieldDynamicNames].join(",")}]`,
    ];
    for (const [owner, definite] of state.definiteCtorFields) {
      const facts = solved.fieldFacts.get(owner);
      if (facts === undefined || facts.size === 0) continue;
      const rows = [...facts].map(([n, t]) => `${n}:${t.kind}${definite.has(n) ? "" : "?"}`);
      lines.push(`[#743 fnctor-graph]   fields ${state.nodes.get(owner)?.name ?? owner}: ${rows.join(" ")}`);
    }
    for (const [name, params] of out) {
      const kinds = params.map((p) => p.kind);
      if (kinds.some((k) => k !== "unknown" && k !== "dynamic")) {
        lines.push(`[#743 fnctor-graph]   ${name}(${kinds.join(", ")})`);
      }
    }
    for (const [owner, facts] of solved.fieldFacts) {
      const named = [...facts].filter(([, t]) => t.kind !== "unknown" && t.kind !== "dynamic");
      if (named.length === 0) continue;
      const ownerName = state.nodes.get(owner)?.name ?? owner;
      lines.push(`[#743 fnctor-graph]   ${ownerName}{${named.map(([n, t]) => `${n}:${t.kind}`).join(", ")}}`);
    }
    // eslint-disable-next-line no-console
    console.error(lines.join("\n"));
  }
  return { paramFacts: out, thisReadFacts, fieldVerdicts, fieldWriteJoins };
}

// ── Phase 1: top-level callables ──────────────────────────────────────────────

function collectCallables(state: AnalysisState): void {
  const addCallable = (
    name: string,
    fn: ts.FunctionDeclaration | ts.FunctionExpression,
    symbols: readonly (ts.Symbol | undefined)[],
  ): void => {
    const id = mkId(state);
    const node: GraphNode = { id, kind: "callable", name, fn, poisoned: false };
    state.nodes.set(id, node);
    state.nodeIdByFn.set(fn, id);
    for (const sym of symbols) {
      if (!sym) continue;
      if (state.nodeIdBySymbol.has(sym)) {
        // Same binding declared twice with function initializers — ambiguous.
        const prev = state.nodes.get(state.nodeIdBySymbol.get(sym)!);
        if (prev) prev.poisoned = true;
        node.poisoned = true;
        continue;
      }
      state.nodeIdBySymbol.set(sym, id);
    }
  };

  for (const stmt of state.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      addCallable(stmt.name.text, stmt, [symOf(state, stmt.name)]);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = unwrap(d.initializer);
        if (ts.isFunctionExpression(init) && init.body) {
          addCallable(d.name.text, init, [symOf(state, d.name), init.name ? symOf(state, init.name) : undefined]);
        }
      }
    }
  }
}

// ── Phase 2: top-level prototype aliases (`var pp = F.prototype`) ─────────────

function collectProtoAliases(state: AnalysisState): void {
  for (const stmt of state.sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = unwrap(d.initializer);
      if (!ts.isPropertyAccessExpression(init) || init.name.text !== "prototype") continue;
      const base = unwrap(init.expression);
      if (!ts.isIdentifier(base)) continue;
      const ownerSym = symOf(state, base);
      const ownerId = ownerSym ? state.nodeIdBySymbol.get(ownerSym) : undefined;
      if (ownerId === undefined) continue;
      const aliasSym = symOf(state, d.name);
      if (!aliasSym) continue;
      const prev = state.protoAliasOwner.get(aliasSym);
      if (prev !== undefined && prev !== ownerId) {
        state.protoPoisoned.add(prev);
        state.protoPoisoned.add(ownerId);
        continue;
      }
      state.protoAliasOwner.set(aliasSym, ownerId);
    }
  }
}

// ── Phase 3: whole-file scan ──────────────────────────────────────────────────

function recordMethodWrite(
  state: AnalysisState,
  ownerId: IrUnitId,
  space: "static" | "proto",
  name: string,
  rhs: ts.Expression,
  topLevel: boolean,
): void {
  const key = writeKey(ownerId, space, name);
  const prev = state.methodWrites.get(key);
  const fnRhs = unwrap(rhs);
  if (prev !== undefined || !topLevel || !ts.isFunctionExpression(fnRhs) || !fnRhs.body) {
    state.methodWrites.set(key, { bad: true });
    return;
  }
  state.methodWrites.set(key, { decl: fnRhs, bad: false });
}

function objectDefineKind(call: ts.CallExpression): "many" | "one" | undefined {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const base = unwrap(callee.expression);
  if (!ts.isIdentifier(base) || base.text !== "Object") return undefined;
  if (callee.name.text === "defineProperties") return "many";
  if (callee.name.text === "defineProperty") return "one";
  return undefined;
}

function handleObjectDefine(state: AnalysisState, call: ts.CallExpression): void {
  const kind = objectDefineKind(call);
  if (kind === undefined || call.arguments.length < 2) return;
  const space = spaceOfBase(state, call.arguments[0]!);
  if (space === undefined) return;
  let demote: Set<string> | undefined;
  if (kind === "one") {
    const key = unwrap(call.arguments[1]!);
    demote = ts.isStringLiteral(key) ? new Set([key.text]) : undefined;
  } else {
    demote = resolveLiteralKeys(state.sourceFile, call.arguments[1]!);
  }
  if (demote === undefined) {
    (space.space === "proto" ? state.protoPoisoned : state.staticPoisoned).add(space.ownerId);
    return;
  }
  if (space.space === "proto") {
    let keys = state.runtimeDefinedProtoKeys.get(space.ownerId);
    if (!keys) {
      keys = new Set();
      state.runtimeDefinedProtoKeys.set(space.ownerId, keys);
    }
    for (const key of demote) {
      keys.add(key);
      state.methodWrites.set(writeKey(space.ownerId, "proto", key), { bad: true });
    }
  } else {
    for (const key of demote) state.methodWrites.set(writeKey(space.ownerId, "static", key), { bad: true });
  }
}

/** Escape check for a callable-node identifier reference. */
function isAllowedCallableRef(id: ts.Identifier): boolean {
  // Climb wrappers so `(F)(…)` / `new (F as any)(…)` count as callee uses.
  let node: ts.Node = id;
  while (
    node.parent !== undefined &&
    (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isNonNullExpression(node.parent))
  ) {
    node = node.parent;
  }
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isNewExpression(parent) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    // (#743) `F.call` / `F.apply` / `F.bind` INVOKE F — a property-base use is
    // not an inert read here. Acorn's `finishNodeAt` is reached ONLY through
    // `finishNodeAt.call(this, …)`, so treating that as a plain base use left
    // its params seeded `unknown` (lattice BOTTOM) forever, and its
    // `node.end = pos` write then contributed nothing instead of widening —
    // optimism, not conservatism. `.call`/`.apply` in direct-callee position
    // are handled as real edges in `buildEdges`; anything else (an extracted
    // `var f = F.call`, any `.bind`) is an unseen invocation alias and poisons.
    const method = ts.isPrivateIdentifier(parent.name) ? "" : parent.name.text;
    if (method === "bind") return false;
    if (method === "call" || method === "apply") {
      const grandparent = parent.parent;
      return grandparent !== undefined && ts.isCallExpression(grandparent) && grandparent.expression === parent;
    }
    return true;
  }
  if (ts.isVariableDeclaration(parent) && parent.name === id) return true;
  if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) return true; // its own name
  if (ts.isExportSpecifier(parent)) return true; // export boundary — family trust model
  if (ts.isExportAssignment(parent)) return true;
  return false;
}

function scanAssignment(state: AnalysisState, n: ts.BinaryExpression): void {
  const left = n.left;
  const isTopLevel =
    n.parent !== undefined && ts.isExpressionStatement(n.parent) && n.parent.parent === state.sourceFile;
  if (ts.isPropertyAccessExpression(left) && !ts.isPrivateIdentifier(left.name)) {
    if (left.name.text === "prototype") {
      // `F.prototype = …` — prototype object replaced.
      const inner = unwrap(left.expression);
      if (ts.isIdentifier(inner)) {
        const sym = symOf(state, inner);
        const ownerId = sym ? state.nodeIdBySymbol.get(sym) : undefined;
        if (ownerId !== undefined) state.protoPoisoned.add(ownerId);
      }
    } else {
      const space = spaceOfBase(state, left.expression);
      if (space !== undefined) {
        recordMethodWrite(state, space.ownerId, space.space, left.name.text, n.right, isTopLevel);
      }
    }
  } else if (ts.isElementAccessExpression(left) && !isSymbolKeyed(left.argumentExpression)) {
    const space = spaceOfBase(state, left.expression);
    if (space !== undefined) {
      // Computed write on a tracked space — any name could be written.
      // (Symbol-keyed writes — `pp[Symbol.iterator] = …` — are exempt.)
      (space.space === "proto" ? state.protoPoisoned : state.staticPoisoned).add(space.ownerId);
    }
  } else if (ts.isIdentifier(left)) {
    const sym = symOf(state, left);
    const aliasOwner = sym ? state.protoAliasOwner.get(sym) : undefined;
    if (aliasOwner !== undefined) state.protoPoisoned.add(aliasOwner); // alias reassigned
  }
}

/**
 * (#743) `F.prototype.constructor === F` by default, so `new x.constructor(…)`
 * — or any value-position read of `.constructor`, which can be constructed
 * later — reaches EVERY tracked constructor with arguments no edge can see.
 * That invalidates all ctor param facts, hence all field facts derived from
 * them. Comparison operands (`x.constructor === Foo`) are the common type-check
 * idiom and cannot construct anything, so they stay safe. Measured cost on the
 * acorn dist: zero occurrences.
 */
function noteConstructorUse(state: AnalysisState, access: ts.Expression, name: string): void {
  if (name !== "constructor") return;
  let node: ts.Node = access;
  while (
    node.parent !== undefined &&
    (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isNonNullExpression(node.parent))
  ) {
    node = node.parent;
  }
  const parent = node.parent;
  if (parent !== undefined && ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      return;
    }
  }
  state.poisonAllCtors = true;
}

function scanFile(state: AnalysisState): void {
  const scan = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      scanAssignment(state, n);
    }
    if (ts.isDeleteExpression(n)) {
      const t = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) {
        const space = spaceOfBase(state, t.expression);
        if (space !== undefined) {
          (space.space === "proto" ? state.protoPoisoned : state.staticPoisoned).add(space.ownerId);
        }
      }
    }
    if (ts.isCallExpression(n)) {
      handleObjectDefine(state, n);
      state.callSites.push(n);
    }
    if (ts.isElementAccessExpression(n) && !isSymbolKeyed(n.argumentExpression)) {
      const key = unwrap(n.argumentExpression);
      if (!(ts.isStringLiteral(key) || key.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)) {
        // Dynamic-key access (read, call, or write) on a TRACKED base can
        // reach any of the owner's method slots; `this[k]` cannot be
        // localized to one owner, so it drops everything. Untracked bases
        // are the documented dynamic-read gap (see module header).
        const space = spaceOfBase(state, n.expression);
        if (space !== undefined) {
          (space.space === "proto" ? state.protoPoisoned : state.staticPoisoned).add(space.ownerId);
        } else if (unwrap(n.expression).kind === ts.SyntaxKind.ThisKeyword) {
          state.poisonAllMethods = true;
        }
      } else {
        // Literal-key access is a named use: value-position reads escape the
        // name exactly like `x.m` (direct calls are edges, handled later).
        const parent = n.parent;
        const isDirectCallee = parent !== undefined && ts.isCallExpression(parent) && parent.expression === n;
        const isInstallTarget =
          parent !== undefined &&
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.left === n;
        if (!isDirectCallee && !isInstallTarget) state.valueReadNames.add((key as ts.StringLiteral).text);
        if (!isInstallTarget) state.propertyNameUses.add((key as ts.StringLiteral).text);
        if (!isInstallTarget) noteConstructorUse(state, n, (key as ts.StringLiteral).text);
      }
    }
    if (ts.isNewExpression(n)) state.newSites.push(n);
    if (ts.isPropertyAccessExpression(n) && !ts.isPrivateIdentifier(n.name)) {
      const parent = n.parent;
      const isDirectCallee = parent !== undefined && ts.isCallExpression(parent) && parent.expression === n;
      const isInstallTarget =
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === n;
      if (!isDirectCallee && !isInstallTarget) state.valueReadNames.add(n.name.text);
      if (!isInstallTarget) state.propertyNameUses.add(n.name.text);
      if (!isInstallTarget) noteConstructorUse(state, n, n.name.text);
    }
    if (ts.isIdentifier(n)) {
      const sym = symOf(state, n);
      const nodeId = sym ? state.nodeIdBySymbol.get(sym) : undefined;
      if (nodeId !== undefined && !isAllowedCallableRef(n)) {
        // Adjudicated post-scan: the API-mirror shape is boundary-only, every
        // other disallowed ref poisons the callable (see adjudicateEscapes).
        state.escapeCandidates.push({ nodeId, id: n });
      }
    }
    forEachChild(n, scan);
  };
  scan(state.sourceFile);
}

// ── Phase 3b: adjudicate value escapes ────────────────────────────────────────

/**
 * The one boundary-only escape shape admitted without poisoning: acorn's API
 * mirror, `Parser.acorn = { Parser: Parser, Position: Position, … }`. The ref
 * is a property VALUE of an object literal whose sole consumer is a top-level
 * assignment to a static property of a TRACKED callable, and that property
 * name is used nowhere else in the module — so no internal flow can reach the
 * mirror's contents, and the external reach is the same export boundary the
 * family already trusts (`export { Parser }` is equally reachable). Any other
 * use of the property name anywhere (read, call, computed literal key) makes
 * the shape internal and the ref poisons normally.
 */
function isApiMirrorRef(state: AnalysisState, id: ts.Identifier): boolean {
  const assignment = id.parent;
  if (!ts.isPropertyAssignment(assignment) || assignment.initializer !== id) return false;
  const literal = assignment.parent;
  if (!ts.isObjectLiteralExpression(literal)) return false;
  let holder: ts.Node = literal;
  while (holder.parent !== undefined && ts.isParenthesizedExpression(holder.parent)) holder = holder.parent;
  const install = holder.parent;
  if (
    install === undefined ||
    !ts.isBinaryExpression(install) ||
    install.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    unwrap(install.right) !== literal
  ) {
    return false;
  }
  if (
    install.parent === undefined ||
    !ts.isExpressionStatement(install.parent) ||
    install.parent.parent !== state.sourceFile
  ) {
    return false;
  }
  const left = install.left;
  if (!ts.isPropertyAccessExpression(left) || ts.isPrivateIdentifier(left.name)) return false;
  const space = spaceOfBase(state, left.expression);
  if (space === undefined || space.space !== "static") return false;
  return !state.propertyNameUses.has(left.name.text);
}

function adjudicateEscapes(state: AnalysisState): void {
  for (const candidate of state.escapeCandidates) {
    if (isApiMirrorRef(state, candidate.id)) continue;
    const node = state.nodes.get(candidate.nodeId);
    if (node) node.poisoned = true; // value escaped — unseen call/construct sites possible
  }
}

// ── Phase 4: materialize write-once method nodes ──────────────────────────────

function materializeMethodNodes(state: AnalysisState): void {
  if (state.poisonAllMethods) return;
  for (const [key, writeState] of state.methodWrites) {
    if (writeState.bad || !writeState.decl) continue;
    const [ownerId, space, name] = key.split(" ") as [IrUnitId, "static" | "proto", string];
    if ((space === "proto" ? state.protoPoisoned : state.staticPoisoned).has(ownerId)) continue;
    if (space === "proto" && state.runtimeDefinedProtoKeys.get(ownerId)?.has(name)) continue;
    if (state.valueReadNames.has(name)) continue; // method value may escape → unseen dispatch
    const id = mkId(state);
    const node: GraphNode = {
      id,
      kind: space === "proto" ? "proto-method" : "static-method",
      name,
      ownerId,
      fn: writeState.decl,
      poisoned: false,
    };
    state.nodes.set(id, node);
    state.nodeIdByFn.set(writeState.decl, id);
    const arr = state.methodNodesByName.get(name);
    if (arr) arr.push(node);
    else state.methodNodesByName.set(name, [node]);
    if (space === "static") state.staticMethodNode.set(`${ownerId} ${name}`, node);
  }
}

// ── Phase 5: edges ────────────────────────────────────────────────────────────

/**
 * Owner whose INSTANCE `this` is at a site — i.e. only inside a materialized
 * prototype method. A static method's `this` is the constructor object and a
 * plain function's is rebindable, so neither carries instance field facts.
 */
function instanceThisOwnerAt(state: AnalysisState, site: ts.Node): IrUnitId | undefined {
  const binder = enclosingThisBinder(site);
  if (binder === undefined || isClassMemberLike(binder)) return undefined;
  const nodeId = state.nodeIdByFn.get(binder);
  const node = nodeId !== undefined ? state.nodes.get(nodeId) : undefined;
  return node?.kind === "proto-method" ? node.ownerId : undefined;
}

function buildEdges(state: AnalysisState): void {
  const addEdge = (
    callee: IrUnitId,
    site: ts.CallExpression | ts.NewExpression,
    argExprs?: readonly ts.Expression[],
  ): void => {
    const thisOwner = instanceThisOwnerAt(state, site);
    state.edges.push({
      callee,
      argExprs: argExprs ?? (site.arguments === undefined ? [] : site.arguments.slice()),
      scopeChain: scopeChainOf(site),
      ...(thisOwner !== undefined ? { thisOwner } : {}),
    });
  };

  /**
   * (#743 §7) `F.call(this, a, b)` / `F.apply(this, args)` in direct-callee
   * position. Without this the callee lookup finds nothing (the property is
   * named `call`) and the arguments are silently dropped — the ES5 subclass
   * pattern and, on acorn, the ONLY way `finishNodeAt` is ever invoked.
   * `.apply`'s argument list is a runtime array, so its params are unknowable:
   * poison rather than guess. (Extracted `.call`/`.apply` and any `.bind`
   * already poison in `isAllowedCallableRef`.)
   */
  const forwardedTarget = (call: ts.CallExpression): boolean => {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || ts.isPrivateIdentifier(callee.name)) return false;
    const method = callee.name.text;
    if (method !== "call" && method !== "apply") return false;
    const base = unwrap(callee.expression);
    if (!ts.isIdentifier(base)) return false;
    const sym = symOf(state, base);
    const targetId = sym ? state.nodeIdBySymbol.get(sym) : undefined;
    if (targetId === undefined) return false;
    if (method === "apply") {
      const target = state.nodes.get(targetId);
      if (target) target.poisoned = true;
      return true;
    }
    addEdge(targetId, call, call.arguments.slice(1));
    return true;
  };

  const methodTargets = (name: string, receiver: ts.Expression): readonly GraphNode[] => {
    const recv = unwrap(receiver);
    if (ts.isIdentifier(recv)) {
      const sym = symOf(state, recv);
      const ctorId = sym ? state.nodeIdBySymbol.get(sym) : undefined;
      if (ctorId !== undefined) {
        // The receiver IS the constructor object — only its own static slot.
        const target = state.staticMethodNode.get(`${ctorId} ${name}`);
        return target ? [target] : [];
      }
    }
    return state.methodNodesByName.get(name) ?? [];
  };

  for (const call of state.callSites) {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) {
      const sym = symOf(state, callee);
      const target = sym ? state.nodeIdBySymbol.get(sym) : undefined;
      if (target !== undefined) addEdge(target, call);
      continue;
    }
    if (forwardedTarget(call)) continue;
    let name: string | undefined;
    let receiver: ts.Expression | undefined;
    if (ts.isPropertyAccessExpression(callee) && !ts.isPrivateIdentifier(callee.name)) {
      name = callee.name.text;
      receiver = callee.expression;
    } else if (ts.isElementAccessExpression(callee)) {
      const key = unwrap(callee.argumentExpression);
      if (ts.isStringLiteral(key) || key.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        name = (key as ts.StringLiteral).text;
        receiver = callee.expression;
      }
    }
    if (name !== undefined && receiver !== undefined) {
      for (const target of methodTargets(name, receiver)) addEdge(target.id, call);
    }
  }

  for (const site of state.newSites) {
    const callee = unwrap(site.expression);
    if (ts.isIdentifier(callee)) {
      const sym = symOf(state, callee);
      const target = sym ? state.nodeIdBySymbol.get(sym) : undefined;
      if (target !== undefined) addEdge(target, site);
      continue;
    }
    // Other callee shapes construct only escaped (already-poisoned) values.
    if (callee.kind !== ts.SyntaxKind.ThisKeyword) continue;
    const binder = enclosingThisBinder(site);
    if (binder === undefined) continue; // top-level `new this` — never a fnctor
    if (isClassMemberLike(binder)) continue; // class member — `this` is the class
    const binderNodeId = state.nodeIdByFn.get(binder);
    const binderNode = binderNodeId !== undefined ? state.nodes.get(binderNodeId) : undefined;
    if (binderNode?.kind === "static-method" && binderNode.ownerId !== undefined) {
      addEdge(binderNode.ownerId, site); // `this` === the owner constructor
      continue;
    }
    if (binderNode?.kind === "proto-method") continue; // `this` is an instance — not constructable here
    // `new this` in a plain function or a demoted method: `this` could be
    // rebound to ANY constructor via .call/.apply — no ctor fact is safe.
    state.poisonAllCtors = true;
  }
}

interface FixpointResult {
  readonly converged: boolean;
  readonly entries: Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>;
  readonly fieldFacts: FieldFacts;
  /** The solved context — final-iteration atoms + converged entries — for post-convergence evaluation. */
  readonly fx: FixpointCtx;
}

function runFixpoint(state: AnalysisState): FixpointResult {
  const entries = new Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>();
  const seeds = new Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>();
  for (const node of state.nodes.values()) {
    const params = node.fn.parameters.map((p) => (node.poisoned ? core.DYNAMIC : core.seedParamType(p, state.checker)));
    const returnType = node.poisoned ? core.DYNAMIC : core.seedReturnType(node.fn, state.checker);
    seeds.set(node.id, { params, returnType });
    entries.set(node.id, { params: [...params], returnType });
  }

  const resolver = (identifier: ts.Identifier): IrUnitId | undefined => {
    const sym = symOf(state, identifier);
    return sym ? state.nodeIdBySymbol.get(sym) : undefined;
  };

  const inbound = new Map<IrUnitId, Edge[]>();
  for (const edge of state.edges) {
    const arr = inbound.get(edge.callee);
    if (arr) arr.push(edge);
    else inbound.set(edge.callee, [edge]);
  }

  const buildScope = (chain: readonly ts.SignatureDeclaration[]): Map<string, LatticeType> => {
    const scope = new Map<string, LatticeType>();
    for (const fnLike of chain) {
      const nodeId = state.nodeIdByFn.get(fnLike);
      const entry = nodeId !== undefined ? entries.get(nodeId) : undefined;
      const params = fnLike.parameters;
      for (let i = 0; i < params.length; i++) {
        const p = params[i]!;
        if (ts.isIdentifier(p.name)) scope.set(p.name.text, entry ? (entry.params[i] ?? core.DYNAMIC) : core.DYNAMIC);
      }
    }
    return scope;
  };

  const fieldFacts: FieldFacts = new Map();
  for (const [owner, names] of state.fieldNamesByOwner) {
    const facts = new Map<string, LatticeType>();
    for (const name of names) facts.set(name, core.UNKNOWN);
    fieldFacts.set(owner, facts);
  }
  // (#743) The satellite's evaluator precision rules (bitwise/shift producers,
  // module-level numeric constants, condition-agnostic conditionals). `ext`
  // closes over itself so a nested operand gets the same rules as a top-level
  // one; the reference is only dereferenced when `tryInfer` runs, which is
  // strictly after the binding is initialised.
  const ext: InferExtension = createSatelliteInferExtension({
    sourceFile: state.sourceFile,
    checker: state.checker,
    evaluate: (expr, scope) => core.inferExpr(expr, scope, entries, resolver, ext),
  });

  const fx: FixpointCtx = { state, entries, fieldFacts, atoms: new Map(), resolver, buildScope, ext };
  const writeIndex = buildWriteIndex(state);

  const MAX_ITERS = 50;
  let converged = false;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // Instance atoms are frozen at the top of the iteration so every consumer
    // in this pass sees the same shape (an atom rebuilt mid-pass would make
    // the result depend on `nodes` iteration order).
    fx.atoms.clear();
    for (const owner of state.definiteCtorFields.keys()) fx.atoms.set(owner, instanceAtomFor(fx, owner));
    let changed = runFieldPass(fx, writeIndex);
    for (const node of state.nodes.values()) {
      if (node.poisoned) continue;
      const cur = entries.get(node.id)!;
      const seed = seeds.get(node.id)!;
      const newParams = seed.params.map((t) => t);
      for (const site of inbound.get(node.id) ?? []) {
        const scope = buildScope(site.scopeChain);
        let thisCtx: ThisContext | undefined;
        if (site.thisOwner !== undefined) {
          scope.set("<this>", fx.atoms.get(site.thisOwner) ?? core.DYNAMIC);
          thisCtx = { owner: site.thisOwner, snapshot: state.definiteCtorFields.get(site.thisOwner) ?? NO_FIELDS };
        }
        for (let i = 0; i < newParams.length && i < site.argExprs.length; i++) {
          newParams[i] = core.join(newParams[i]!, evalValueExpr(fx, site.argExprs[i]!, scope, thisCtx));
        }
      }
      const ownScope = new Map<string, LatticeType>();
      for (let i = 0; i < node.fn.parameters.length; i++) {
        const p = node.fn.parameters[i]!;
        if (ts.isIdentifier(p.name)) ownScope.set(p.name.text, newParams[i] ?? core.UNKNOWN);
      }
      let newReturn: LatticeType = seed.returnType;
      if (node.fn.body) {
        const seedConcrete =
          seed.returnType.kind === "f64" ||
          seed.returnType.kind === "i32" ||
          seed.returnType.kind === "u32" ||
          seed.returnType.kind === "bool" ||
          seed.returnType.kind === "string" ||
          seed.returnType.kind === "object";
        core.walkBodyForReturns(
          node.fn.body,
          ownScope,
          entries,
          resolver,
          (t) => {
            if (seedConcrete && t.kind === "dynamic") return;
            newReturn = core.join(newReturn, t);
          },
          ext,
        );
      }
      if (!core.paramsEqual(cur.params, newParams) || !core.typesEqual(cur.returnType, newReturn)) {
        entries.set(node.id, { params: newParams, returnType: newReturn });
        changed = true;
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  return { converged, entries, fieldFacts, fx };
}
