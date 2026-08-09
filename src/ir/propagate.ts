// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Interprocedural type propagation for the middle-end IR — Phase 2 of
// spec #1131.
//
// What it does
// ============
//
// The Phase 1 selector claims functions whose every param and return has an
// explicit TypeScript `: number` / `: boolean` annotation. That leaves
// recursive numeric kernels like
//
//     function fib(n) {              // no annotation
//       if (n <= 1) return n;
//       return fib(n - 1) + fib(n - 2);
//     }
//     export function run(n: number): number { return fib(n); }
//
// on the legacy path even though `fib` is provably `(number) -> number`:
// the TS checker infers `any` for `n` absent an annotation, and the legacy
// path ends up boxing every recursive call through `__box_number` /
// `__unbox_number`.
//
// This module runs a context-insensitive forward-propagation pass over one
// indexed source population before the selector decides which functions to
// route through the IR. The structural result is an `IrUnitTypeMap`; a
// one-to-one `TypeMap` name projection remains only for legacy consumers.
//
// Lattice
// =======
//
//   unknown  ← bottom. No constraint gathered yet; optimistically treated
//              as compatible with any primitive at operator sites.
//   f64      ← number-typed.
//   bool     ← i32 boolean.
//   string   ← string-typed (externref in current backend representation).
//   object   ← a referenced object shape. Carries a `shape` string
//              discriminator (e.g. "Array", "plain") so distinct shapes
//              don't silently collapse at join sites.
//   union    ← a set of atoms (non-union members), formed when atoms of
//              different concrete kinds join. Member order is canonicalised
//              and the set is size-capped — see the join rules below.
//   dynamic  ← top. Definitely not representable as a narrow primitive;
//              rules out IR selection when no tag-dispatch is available.
//
// Join:   unknown ⊔ X = X                             (growth)
//         X ⊔ X = X                                   (atoms, same kind)
//         atom₁ ⊔ atom₂ (different concrete kinds)   = union{atom₁, atom₂}
//         union ⊔ atom = union ∪ {atom}               (extend)
//         union ⊔ union = union of both member sets
//         anything ⊔ dynamic = dynamic                (top is absorbing)
//         union.members.length > 4 = dynamic          (size cap)
//
// The size cap prevents runaway widening on programs with many distinct
// call-site return types feeding a single identifier. 4 covers the common
// cases (`f64|bool`, `f64|null`, `bool|null`, `f64|bool|null`) without
// letting pathological test262 code explode the member set.
//
// Optimism
// ========
//
// Recursive fixpoint over a lattice that starts at `unknown` would otherwise
// stay at `unknown` forever (`fib(n-1)` calls `fib`, whose return is
// `unknown`, so `fib(n-1) + fib(n-2)` stays `unknown`). We break that
// stalemate by treating `unknown` at arithmetic operator sites as
// f64-compatible: `unknown + unknown → f64`, `unknown - f64 → f64`. This
// is the classic optimistic-start-and-refine pattern — the first iteration
// claims fib returns `f64`, and on the next iteration the call-site
// propagation confirms the claim because the operator evidence is
// transitively stable. If a call site ever produces incompatible operand
// types (e.g. `boolean + number`), the result falls to `dynamic`,
// disqualifying the function from IR selection.
//
// What this file does NOT do
// ==========================
//
// - It does not rewrite the IR. `select.ts` consumes the result.
// - It resolves identifier calls only to exact checker declarations in the
//   supplied source population. Imports outside that population, properties,
//   and globals fall to `dynamic`; checker-free calls require a unique label.
// - Local flow is limited to parameters and simple `let`/`const` initializers;
//   it is not a full CFG analysis.

import type { DtsEntrypointSeeds } from "../checker/dts-entrypoint-seeds.js";
import { fnctorCtorParamTypesFlagEnabled } from "../derivation-flags.js";
import { ts, forEachChild } from "../ts-api.js";
import { buildIrUnitInventory, type IrUnitId } from "./identity.js";
import {
  buildIrLegacyUnitProjection,
  buildIrPlanningIdentityContext,
  type IrLegacyUnitProjection,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
} from "./planning-identity.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * Atoms are the non-composite lattice elements. `LatticeAtom` excludes
 * `unknown`, `union`, and `dynamic`; those can never be members of a union.
 *
 * #1231 — the `object` atom now carries a recursive structural shape
 * (a name-sorted list of `(name, atom)` field bindings) instead of an
 * opaque `shape: string` discriminator. This lets propagation flow
 * concrete field types end-to-end (e.g. `{x: f64, y: f64}`) so the IR
 * can emit typed structs and skip box/unbox round-trips on property
 * access. The lattice height is bounded via a depth cap of
 * `LATTICE_OBJECT_SHAPE_MAX_DEPTH` (set to 3, matching the legacy
 * `resolveWasmType` depth guard); shapes deeper than the cap widen to
 * `dynamic` so the fixpoint always terminates.
 */
export type LatticeAtom =
  | { readonly kind: "f64" }
  // #1126 Stage 1 — integer-domain atoms. Both lower to the same Wasm
  // `i32` storage, but are distinguished as separate lattice elements so
  // op selection (signed vs unsigned shifts, comparisons, conversions)
  // can be made structurally rather than via ad-hoc heuristics.
  //   `i32` — signed two's-complement, range [-2^31, 2^31)
  //   `u32` — unsigned, range [0, 2^32)
  // Producer rules (Stage 2) determine when expressions enter these
  // domains; preserve/widen rules (also Stage 2) determine when they
  // collapse back to `f64`. Notably, arithmetic (+,-,*,%) on two `i32`s
  // widens to `f64` because JS `+` semantics don't wrap on overflow —
  // see #1236 for the bug this rule structurally prevents.
  | { readonly kind: "i32" }
  | { readonly kind: "u32" }
  | { readonly kind: "bool" }
  | { readonly kind: "string" }
  | {
      readonly kind: "object";
      readonly fields: readonly { readonly name: string; readonly type: LatticeAtom }[];
    };

export type LatticeType =
  | { readonly kind: "unknown" }
  | LatticeAtom
  | { readonly kind: "union"; readonly members: readonly LatticeAtom[] }
  | { readonly kind: "dynamic" };

/** Maximum union-member count before we widen to `dynamic`. */
export const LATTICE_UNION_MAX_MEMBERS = 4;

/**
 * Maximum recursive depth of `LatticeAtom.object` shapes. Object shapes
 * deeper than the cap widen to `dynamic` so the propagation lattice has
 * bounded height and the worklist fixpoint terminates. Matches the
 * legacy `resolveWasmType` depth guard at `codegen/index.ts:5255`.
 */
export const LATTICE_OBJECT_SHAPE_MAX_DEPTH = 3;

/**
 * #1231 Phase 2 — object-shape inference is **enabled by default** as of
 * this graduation. The env var stays as an emergency opt-out: setting
 * `JS2WASM_IR_OBJECT_SHAPES=0` reverts to the legacy boxed-externref
 * path so a regression can be hot-fixed without redeploying the
 * compiler. `JS2WASM_IR_OBJECT_SHAPES=1` (or unset) keeps the new
 * behaviour. Re-evaluated on every call so vitest can flip the flag
 * per-test.
 *
 * History: Phase 1 (PR #143) shipped behind the gate as opt-IN.
 * Phase 2 (this PR) graduates the gate after local equivalence /
 * IR / object-tests showed identical pass/fail counts with the flag
 * on vs. off — i.e. no observable regressions. CI's test262 sharded
 * run is the authoritative arbiter for conformance numbers.
 */
function objectShapesEnabled(): boolean {
  return process.env.JS2WASM_IR_OBJECT_SHAPES !== "0";
}

/**
 * #1126 Stage 2 — integer-domain inference flag. Default **OFF** until
 * Stage 3 lands the emitter side. While off, all producer rules below
 * fall back to their pre-#1126 behaviour (`F64` for numeric literals,
 * `DYNAMIC` for bitwise/shift ops, etc.) so this PR cannot change the
 * shape of any compiled function.
 *
 * To opt in locally: `JS2WASM_IR_I32_DOMAIN=1 npm test`.
 *
 * This mirrors the staged-rollout pattern from #1231 (object shapes)
 * and #1238 (pseudo-extern Array). When Stage 3 ships, the default
 * flips to ON and the env var becomes an opt-out (`=0`) emergency hatch.
 */
function i32DomainEnabled(): boolean {
  return process.env.JS2WASM_IR_I32_DOMAIN === "1";
}

// Range constants for integer-domain literal classification.
// Inclusive of MIN_I32, exclusive of (MAX_I32 + 1) = 2^31. The u32
// upper bound is 2^32 (exclusive). `Number.isSafeInteger` covers
// values up to 2^53, but Stage 2 only narrows into 32-bit domains.
const MIN_I32 = -0x80000000; // -(2^31)
const MAX_I32_PLUS_1 = 0x80000000; // 2^31
const MAX_U32_PLUS_1 = 0x100000000; // 2^32

export interface TypeMapEntry {
  readonly params: readonly LatticeType[];
  readonly returnType: LatticeType;
}

/** Structural propagation result keyed only by canonical source-unit identity. */
export type IrUnitTypeMap = ReadonlyMap<IrUnitId, TypeMapEntry>;

/**
 * Temporary Commit-2 compatibility projection for still-name-keyed selector
 * and from-AST APIs. Semantic propagation is performed by
 * `buildIrUnitTypeMap`; this map is only a validated one-to-one view.
 */
export type TypeMap = ReadonlyMap<string, TypeMapEntry>;

const UNKNOWN: LatticeType = { kind: "unknown" };
const F64: LatticeType = { kind: "f64" };
const I32: LatticeType = { kind: "i32" };
const U32: LatticeType = { kind: "u32" };
const BOOL: LatticeType = { kind: "bool" };
const STRING: LatticeType = { kind: "string" };
const DYNAMIC: LatticeType = { kind: "dynamic" };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface PropagationFunction {
  readonly unitId: IrUnitId;
  readonly displayName: string;
  readonly declaration: ts.FunctionDeclaration;
}

type CallTargetResolver = (identifier: ts.Identifier) => IrUnitId | undefined;

/**
 * Build propagation facts for the requested source files using the exact AST
 * declarations captured by `identityContext.inventory`.
 *
 * Source-array order is deliberately ignored. Declarations are visited in the
 * inventory's canonical source/declaration order, and checker symbols resolve
 * only when they identify one exact indexed executable declaration. When no
 * checker is supplied, textual calls are accepted only when the display name
 * is unique in this propagation population.
 */
export function buildIrUnitTypeMap(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker | undefined,
  identityContext: IrPlanningIdentityContext,
  entrypointSeeds?: DtsEntrypointSeeds,
): IrUnitTypeMap {
  const functions = collectIndexedFunctionDeclarations(sourceFiles, identityContext);
  const decls = new Map(functions.map((info) => [info.unitId, info.declaration] as const));
  if (decls.size === 0) return new Map();

  const resolveCallTarget = makeCallTargetResolver(functions, checker, identityContext);

  // Seed: explicit TS annotations + checker-derived signatures.
  const entries = new Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>();
  const seeds = new Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>();
  for (const [unitId, fn] of decls) {
    const seed = seedFromDeclaration(fn, checker);
    applyDtsEntrypointSeeds(seed, fn, entrypointSeeds);
    seeds.set(unitId, seed);
    entries.set(unitId, {
      params: [...seed.params],
      returnType: seed.returnType,
    });
  }

  // Build the call graph: caller ID → list of (callee ID, argExprs).
  const callGraph = buildCallGraph(decls, resolveCallTarget);

  // Pre-compute the reverse graph for caller-scoped arg propagation.
  // For each callee, remember every (caller ID, argExprs) pair calling it.
  type Inbound = {
    callerUnitId: IrUnitId;
    callerParamNames: readonly string[];
    argExprs: readonly ts.Expression[];
  };
  const inbound = new Map<IrUnitId, Inbound[]>();
  for (const [callerUnitId, sites] of callGraph) {
    const fn = decls.get(callerUnitId)!;
    const callerParamNames = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
    for (const site of sites) {
      if (!decls.has(site.callee)) continue;
      let arr = inbound.get(site.callee);
      if (!arr) {
        arr = [];
        inbound.set(site.callee, arr);
      }
      arr.push({ callerUnitId, callerParamNames, argExprs: site.argExprs });
    }
  }

  // Worklist fixpoint. Cap iteration count to avoid pathological
  // non-termination (join is monotone on a finite lattice, so this is
  // really just a safety valve).
  const MAX_ITERS = 50;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let changed = false;
    for (const [unitId, fn] of decls) {
      const cur = entries.get(unitId)!;
      const seed = seeds.get(unitId)!;

      // --- param types ------------------------------------------------
      // Start from seed (TS annotation / checker). For each caller call
      // site, infer each arg expression's type using the CALLER's
      // current param-scope and join it into our param.
      const newParams: LatticeType[] = seed.params.map((t) => t);
      const inboundSites = inbound.get(unitId) ?? [];
      for (const site of inboundSites) {
        const callerEntry = entries.get(site.callerUnitId);
        if (!callerEntry) continue;
        const callerScope = new Map<string, LatticeType>();
        for (let i = 0; i < site.callerParamNames.length; i++) {
          if (site.callerParamNames[i]) {
            callerScope.set(site.callerParamNames[i]!, callerEntry.params[i] ?? UNKNOWN);
          }
        }
        for (let i = 0; i < newParams.length && i < site.argExprs.length; i++) {
          const argType = inferExpr(site.argExprs[i]!, callerScope, entries, resolveCallTarget);
          newParams[i] = join(newParams[i]!, argType);
        }
      }

      // --- return type ------------------------------------------------
      // Start from seed. Walk the body tracking scope (params + simple
      // `let`/`const` initializers) and for each return statement join
      // its inferred type.
      //
      // Asymmetric join rule: if the seed is already a concrete primitive
      // and the body inference produces `dynamic`, keep the seed. Our
      // expression inference is deliberately narrow (no property access,
      // no method calls, etc.) — a `dynamic` result often just means we
      // couldn't see through the local structure, not that the function
      // is truly dynamic. Explicit annotations / checker-derived types
      // are more authoritative. For functions whose seed is `unknown`,
      // we fall through to the normal join so genuine body evidence
      // (e.g. "returns a string") still surfaces as dynamic.
      const ownScope = new Map<string, LatticeType>();
      for (let i = 0; i < fn.parameters.length; i++) {
        const p = fn.parameters[i]!;
        if (ts.isIdentifier(p.name)) {
          ownScope.set(p.name.text, newParams[i] ?? UNKNOWN);
        }
      }
      let newReturn: LatticeType = seed.returnType;
      if (fn.body) {
        // #1845 — a concrete seed keeps its authority over a `dynamic` body
        // inference (our expression inference is deliberately narrow, so
        // `dynamic` usually just means "couldn't see through the local
        // structure"). The integer subdomains `i32`/`u32` are every bit as
        // concrete as `f64`/`bool`/`string`/`object` and must be listed here
        // too — otherwise, once integer-domain seeding is enabled
        // (`JS2WASM_IR_I32_DOMAIN=1`), an i32/u32 seed would be silently
        // widened to `dynamic` by an unresolved body return.
        const seedConcrete =
          seed.returnType.kind === "f64" ||
          seed.returnType.kind === "i32" ||
          seed.returnType.kind === "u32" ||
          seed.returnType.kind === "bool" ||
          seed.returnType.kind === "string" ||
          seed.returnType.kind === "object";
        walkBodyForReturns(fn.body, ownScope, entries, resolveCallTarget, (t) => {
          if (seedConcrete && t.kind === "dynamic") return; // keep seed authority
          newReturn = join(newReturn, t);
        });
      }

      // --- detect change ---------------------------------------------
      if (!paramsEqual(cur.params, newParams) || !typesEqual(cur.returnType, newReturn)) {
        entries.set(unitId, { params: newParams, returnType: newReturn });
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Freeze into the readonly public shape.
  const out = new Map<IrUnitId, TypeMapEntry>();
  for (const [unitId, e] of entries) {
    out.set(unitId, { params: e.params, returnType: e.returnType });
  }
  return out;
}

/**
 * Explicit compatibility adapter for the current name-keyed selector seam.
 * Colliding labels are omitted rather than selecting a first/last entry.
 */
export function buildLegacyProjectedTypeMap(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  identityContext: IrPlanningIdentityContext,
): TypeMap {
  const sourceFiles = [sourceFile];
  return projectIrUnitTypeMapToLegacy(
    sourceFiles,
    buildIrUnitTypeMap(sourceFiles, checker, identityContext),
    identityContext,
  );
}

/**
 * @deprecated Local single-source compatibility overload. Production
 * multi-source planning must pass its authoritative context or call
 * `buildIrUnitTypeMap` directly.
 */
export function buildTypeMap(sourceFile: ts.SourceFile, checker?: ts.TypeChecker): TypeMap;
export function buildTypeMap(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
  identityContext: IrPlanningIdentityContext,
): TypeMap;
export function buildTypeMap(
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
  identityContext?: IrPlanningIdentityContext,
): TypeMap {
  return buildLegacyProjectedTypeMap(
    sourceFile,
    checker,
    identityContext ?? buildLocalIrPlanningIdentityContext(sourceFile, checker),
  );
}

function buildLocalIrPlanningIdentityContext(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker | undefined,
): IrPlanningIdentityContext {
  const inventory = buildIrUnitInventory(
    [sourceFile],
    checker ? { entrySource: sourceFile, checker } : { entrySource: sourceFile },
  );
  return buildIrPlanningIdentityContext(inventory);
}

export function projectIrUnitTypeMapToLegacy(
  sourceFiles: readonly ts.SourceFile[],
  structural: IrUnitTypeMap,
  identityContext: IrPlanningIdentityContext,
): TypeMap {
  const functions = collectIndexedFunctionDeclarations(sourceFiles, identityContext);
  const projection = buildPropagationLegacyProjection(functions);

  const projected = new Map<string, TypeMapEntry>();
  for (const info of functions) {
    const pair = projection.getByUnitId(info.unitId);
    if (!pair) continue;
    const entry = structural.get(info.unitId);
    if (entry) projected.set(pair.legacyName, entry);
  }
  return projected;
}

/**
 * Conservative partial inverse for the legacy evidence seam. Unknown names
 * and labels omitted by duplicate-name demotion do not create structural rows.
 */
export function projectLegacyTypeMapToIrUnitsConservatively(
  sourceFiles: readonly ts.SourceFile[],
  projected: TypeMap,
  identityContext: IrPlanningIdentityContext,
): IrUnitTypeMap {
  const functions = collectIndexedFunctionDeclarations(sourceFiles, identityContext);
  const projection = buildPropagationLegacyProjection(functions);

  const structural = new Map<IrUnitId, TypeMapEntry>();
  for (const info of functions) {
    const pair = projection.getByUnitId(info.unitId);
    if (!pair) continue;
    const entry = projected.get(pair.legacyName);
    if (entry) structural.set(info.unitId, entry);
  }
  return structural;
}

function buildPropagationLegacyProjection(functions: readonly PropagationFunction[]): IrLegacyUnitProjection {
  const counts = new Map<string, number>();
  for (const info of functions) counts.set(info.displayName, (counts.get(info.displayName) ?? 0) + 1);
  return buildIrLegacyUnitProjection(
    functions
      .filter((info) => counts.get(info.displayName) === 1)
      .map((info) => ({ unitId: info.unitId, legacyName: info.displayName })),
  );
}

/** Build the unique-label subset that the temporary name-keyed seam can represent. */
export function buildConservativePropagationLegacyProjection(
  sourceFiles: readonly ts.SourceFile[],
  identityContext: IrPlanningIdentityContext,
): IrLegacyUnitProjection {
  return buildPropagationLegacyProjection(collectIndexedFunctionDeclarations(sourceFiles, identityContext));
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function seedFromDeclaration(
  fn: ts.FunctionDeclaration,
  checker: ts.TypeChecker | undefined,
): { params: LatticeType[]; returnType: LatticeType } {
  const params: LatticeType[] = [];
  for (const p of fn.parameters) {
    params.push(seedParamType(p, checker));
  }
  const returnType = seedReturnType(fn, checker);
  return { params, returnType };
}

// (#743) `.d.ts` entrypoint seeding — SEED, do not force. An exported
// entrypoint has no internal call sites, so its implicit-`any` params start
// (and end) at `unknown`; the shipped declaration's `string`/`number` claim is
// exactly the missing seed. Only `unknown` positions are replaced (an explicit
// TS annotation or checker fact keeps its authority), and the seed is a
// fixpoint STARTING point: inbound call-site evidence still joins on top, so a
// conflicting internal caller widens per the lattice — the claim never beats
// evidence. The map is pre-restricted (src/checker/dts-entrypoint-seeds.ts)
// to exported top-level functions of the entry file and to the two atoms whose
// export boundary is already guarded (f64 ToNumber-coerces; native-string refs
// trap on a violating external call). The legacy lane consults the SAME map in
// `inferImplicitAnyParamType`, keeping IR/legacy seed facts identical.
function applyDtsEntrypointSeeds(
  seed: { params: LatticeType[] },
  fn: ts.FunctionDeclaration,
  entrypointSeeds: DtsEntrypointSeeds | undefined,
): void {
  if (!entrypointSeeds || !fn.name) return;
  const atoms = entrypointSeeds.get(fn.name.text);
  if (!atoms) return;
  for (let i = 0; i < seed.params.length && i < atoms.length; i++) {
    const atom = atoms[i];
    if (atom !== null && atom !== undefined && seed.params[i]!.kind === "unknown") {
      seed.params[i] = atom === "f64" ? F64 : STRING;
    }
  }
}

function seedParamType(param: ts.ParameterDeclaration, checker: ts.TypeChecker | undefined): LatticeType {
  // Rest / destructured / optional / initializer-holding params are
  // out of Phase-2 scope. They'll fall to `dynamic` here so the
  // selector rejects them cleanly.
  if (param.dotDotDotToken || !ts.isIdentifier(param.name)) return DYNAMIC;
  if (param.questionToken || param.initializer) return DYNAMIC;

  // Explicit TS type node wins and is authoritative.
  if (param.type) {
    const t = typeNodeToLattice(param.type);
    if (t !== null) return t;
    return DYNAMIC;
  }

  // No annotation: ask the checker. This covers JSDoc-typed .js files
  // as well as `implicit-any` locals.
  if (!checker) return UNKNOWN;
  const ty = checker.getTypeAtLocation(param);
  return tsTypeToLattice(ty, checker);
}

function seedReturnType(
  fn: ts.FunctionDeclaration | ts.FunctionExpression,
  checker: ts.TypeChecker | undefined,
): LatticeType {
  if (fn.type) {
    const t = typeNodeToLattice(fn.type);
    if (t !== null) return t;
    return DYNAMIC;
  }
  if (!checker) return UNKNOWN;
  const sig = checker.getSignatureFromDeclaration(fn);
  if (!sig) return UNKNOWN;
  const ty = sig.getReturnType();
  return tsTypeToLattice(ty, checker);
}

function typeNodeToLattice(node: ts.TypeNode): LatticeType | null {
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return F64;
    case ts.SyntaxKind.BooleanKeyword:
      return BOOL;
    default:
      return null;
  }
}

function tsTypeToLattice(ty: ts.Type, _checker: ts.TypeChecker): LatticeType {
  const flags = ty.getFlags();
  // Order matters — check the concrete categories first so subtypes of
  // `any` (which also has NumberLike flags in some checker paths) are
  // still picked up.
  if (flags & ts.TypeFlags.NumberLike) return F64;
  if (flags & ts.TypeFlags.BooleanLike) return BOOL;
  if (flags & ts.TypeFlags.StringLike) return STRING;
  // Unresolved / implicit-any / never-inferred leaves us at unknown so
  // propagation can still grow the fact.
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return UNKNOWN;
  // Never is unreachable — treat as unknown so it doesn't kill fixpoint.
  if (flags & ts.TypeFlags.Never) return UNKNOWN;
  // #1231 Phase 1 — under the env gate, TS-inferred object types seed as
  // UNKNOWN so the body-walk pass can refine the shape via `inferExpr`.
  // Without this, an unannotated `function createPoint(x, y) { return
  // {x, y}; }` would have its checker-derived return type `{x: any,
  // y: any}` lower to DYNAMIC, absorb every body-observed atom, and
  // block the IR claim. Outside the gate the legacy DYNAMIC fallback
  // is preserved.
  if (flags & ts.TypeFlags.Object && objectShapesEnabled()) return UNKNOWN;
  // Object / union / enum / etc remain `dynamic` for now — they'd need
  // richer shape inference to be usable in the IR selector.
  return DYNAMIC;
}

// ---------------------------------------------------------------------------
// Call graph
// ---------------------------------------------------------------------------

interface CallSite {
  readonly callee: IrUnitId;
  readonly argExprs: readonly ts.Expression[];
}

function buildCallGraph(
  decls: ReadonlyMap<IrUnitId, ts.FunctionDeclaration>,
  resolveCallTarget: CallTargetResolver,
): Map<IrUnitId, CallSite[]> {
  const graph = new Map<IrUnitId, CallSite[]>();
  for (const [unitId, fn] of decls) {
    if (!fn.body) {
      graph.set(unitId, []);
      continue;
    }
    const sites: CallSite[] = [];
    const visit = (node: ts.Node): void => {
      // Don't descend into nested function-like nodes — those are out
      // of our top-level-call-graph scope.
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)
      ) {
        // Skip nested functions but only AFTER the top-level one. The
        // guard here catches any inner function-like; the outer fn.body
        // is visited directly below.
        if (node !== fn) return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = resolveCallTarget(node.expression);
        if (callee && decls.has(callee)) {
          sites.push({ callee, argExprs: node.arguments.slice() });
        }
      }
      // (#743) `new F(…)` feeds F's params exactly as `F(…)` does, and via
      // this graph the fixpoint makes that TRANSITIVE — the thing the
      // single-hop legacy scan (#4117: 2 acorn slots) structurally cannot do.
      // Graph only: `inferExpr` keeps typing the `new` expression `dynamic`.
      // SAME flag as the legacy halves, or IR/legacy would infer different
      // signatures and demote through the typeIdx-parity IR fallback.
      // `new F` without parens has NO argument list → empty argExprs
      // (all-params-under-applied). Full rationale + transitive proof:
      // tests/issue-743-ctor-sites-in-fixpoint.test.ts.
      if (fnctorCtorParamTypesFlagEnabled() && ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = resolveCallTarget(node.expression);
        if (callee && decls.has(callee)) {
          sites.push({ callee, argExprs: node.arguments === undefined ? [] : node.arguments.slice() });
        }
      }
      forEachChild(node, visit);
    };
    forEachChild(fn.body, visit);
    graph.set(unitId, sites);
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Expression inference
// ---------------------------------------------------------------------------

/**
 * (#743) Optional precision extension for a SATELLITE evaluation.
 *
 * The shared lattice core is ONE implementation — a forked evaluator would have
 * to re-derive every operator's semantics and would drift. Instead a satellite
 * hands `inferExpr` a `tryInfer` that gets first refusal on each node: returning
 * a `LatticeType` overrides the shared dispatch for that node, `undefined` (the
 * only thing a satellite says for nodes it has no rule for) falls through
 * unchanged.
 *
 * The always-on `buildIrUnitTypeMap` path passes NOTHING, so `ext === undefined`
 * on every main-map call and the main `IrUnitTypeMap` is byte-identical by
 * construction (#1712 parity) rather than by measurement. The measurement is
 * still taken — see the issue's Results sections — but it confirms an invariant
 * the type signature already guarantees.
 *
 * `ext` MUST be threaded through every internal recursion site. A site that
 * drops it does not crash; it silently answers the pre-extension type for that
 * subtree, which is a wrong-but-plausible fact. See the nesting-depth fixtures
 * in `tests/issue-743-i32-producers.test.ts`.
 */
export interface InferExtension {
  tryInfer(expr: ts.Expression, scope: ReadonlyMap<string, LatticeType>): LatticeType | undefined;
}

/**
 * Structural type of an expression, using the given param/local scope and
 * the current TypeMap iteration state for cross-function return types.
 *
 * Conservative for unsupported nodes → `dynamic`.
 */
function inferExpr(
  expr: ts.Expression,
  scope: ReadonlyMap<string, LatticeType>,
  entries: ReadonlyMap<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>,
  resolveCallTarget: CallTargetResolver,
  ext?: InferExtension,
): LatticeType {
  if (ts.isParenthesizedExpression(expr)) {
    return inferExpr(expr.expression, scope, entries, resolveCallTarget, ext);
  }
  if (ext !== undefined) {
    const extended = ext.tryInfer(expr, scope);
    if (extended !== undefined) return extended;
  }
  if (ts.isNumericLiteral(expr)) {
    // #1126 Stage 2 — integer-literal classification. JavaScript numeric
    // literals are spec'd as f64, but many code paths use them as
    // integer constants (`for (let i = 0; ...)`, `arr[0]`, bit masks).
    // When the flag is on, classify the literal into the narrowest
    // exact-integer domain it fits:
    //   • integer in [-2^31, 2^31)   → I32 (preserves signed arithmetic)
    //   • integer in [2^31, 2^32)    → U32 (cannot fit signed; unsigned-only)
    //   • non-integer or out of u32  → F64 (existing behaviour)
    // `Number.isInteger(NaN)` and `Number.isInteger(Infinity)` are
    // both false so those naturally widen to F64. Negative zero is
    // an integer; we keep it in I32 (its f64 vs. i32 representations
    // are equivalent for arithmetic).
    if (i32DomainEnabled()) {
      const v = +expr.text;
      if (Number.isFinite(v) && Number.isInteger(v)) {
        if (v >= MIN_I32 && v < MAX_I32_PLUS_1) return I32;
        if (v >= 0 && v < MAX_U32_PLUS_1) return U32;
      }
    }
    return F64;
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return BOOL;
  // #1231 Phase 2 — string-typed argument literals (e.g.
  // `createUser("Alice", 30)`) seed the callee's param atom as STRING
  // so the typed-shape lattice can build mixed-type structs like
  // `{name: string, age: f64}`. Without this, the literal infers to
  // DYNAMIC and the receiving param widens too. Template literals
  // without substitutions (`\`hello\``) tokenise as
  // NoSubstitutionTemplateLiteral and are equivalent to a string
  // literal at this layer.
  if (ts.isStringLiteral(expr) || expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return STRING;
  if (ts.isIdentifier(expr)) {
    return scope.get(expr.text) ?? DYNAMIC;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    const rand = inferExpr(expr.operand, scope, entries, resolveCallTarget, ext);
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.PlusToken:
        // Unary `-` must widen i32 to f64: `-(-2^31) = 2^31` overflows
        // the signed i32 range, so we conservatively return F64. Unary
        // `+` is the JS ToNumber coercion which also normalises to
        // f64. Both operands are still `f64Compatible` (i32/u32 widen
        // cleanly), so the predicate is unchanged.
        return f64Compatible(rand) ? F64 : DYNAMIC;
      case ts.SyntaxKind.ExclamationToken:
        return boolCompatible(rand) ? BOOL : DYNAMIC;
      case ts.SyntaxKind.TildeToken:
        // #1126 Stage 2 — JS bitwise NOT (`~e`) applies ToInt32(e) and
        // returns ~ToInt32(e), which is always a signed 32-bit integer.
        // Producer rule: `~(any f64-compatible) → I32`.
        if (i32DomainEnabled() && f64Compatible(rand)) return I32;
        return DYNAMIC;
      default:
        return DYNAMIC;
    }
  }
  if (ts.isBinaryExpression(expr)) {
    const l = inferExpr(expr.left, scope, entries, resolveCallTarget, ext);
    const r = inferExpr(expr.right, scope, entries, resolveCallTarget, ext);
    switch (expr.operatorToken.kind) {
      // ─── Arithmetic ────────────────────────────────────────────────
      // #1126 Stage 2 — `+ - * / %` always widens to F64 even when both
      // operands are integer-domain. JavaScript `+` does not wrap on
      // overflow: `(2^30) * 2` is exactly `2^31` (still safe in f64),
      // but `i32.mul` would trap-or-wrap into the signed range. Returning
      // F64 here is the structural fix for #1236 — the f64Compatible
      // predicate accepts i32/u32 (from Stage 1) so an i32+i32
      // expression cleanly widens via `f64.convert_i32_s` at emit time.
      // `%` (PercentToken) was previously absent from this arm and fell
      // through to DYNAMIC; it follows the same arithmetic semantics so
      // we add it now (also avoids a Stage-2 surprise where `i32 % i32`
      // would have stayed DYNAMIC).
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.SlashToken:
      case ts.SyntaxKind.PercentToken:
        return f64Compatible(l) && f64Compatible(r) ? F64 : DYNAMIC;
      // ─── Bitwise (& | ^) ───────────────────────────────────────────
      // #1126 Stage 2 — JS bitwise ops apply ToInt32 to each operand
      // and return a signed 32-bit integer. Producer: I32. Behind the
      // i32-domain flag.
      case ts.SyntaxKind.AmpersandToken:
      case ts.SyntaxKind.BarToken:
      case ts.SyntaxKind.CaretToken:
        if (i32DomainEnabled() && f64Compatible(l) && f64Compatible(r)) return I32;
        return DYNAMIC;
      // ─── Shift left / signed shift right ───────────────────────────
      // `e1 << e2` and `e1 >> e2` apply ToInt32 to e1 and ToUint32(e2)
      // (mod 32); the result is a signed Int32. Producer: I32.
      case ts.SyntaxKind.LessThanLessThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        if (i32DomainEnabled() && f64Compatible(l) && f64Compatible(r)) return I32;
        return DYNAMIC;
      // ─── Unsigned shift right ──────────────────────────────────────
      // `e1 >>> e2` applies ToUint32(e1) and ToUint32(e2); result is
      // an unsigned 32-bit integer. Producer: U32.
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        if (i32DomainEnabled() && f64Compatible(l) && f64Compatible(r)) return U32;
        return DYNAMIC;
      // ─── Comparisons ───────────────────────────────────────────────
      // Both sides f64-compatible (which now includes i32/u32) → BOOL.
      // Stage 3's emitter will pick `i32.lt_s` vs `i32.lt_u` vs
      // `f64.lt` based on the operand atoms; for the lattice the
      // result is the same boolean.
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return f64Compatible(l) && f64Compatible(r) ? BOOL : DYNAMIC;
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        // Both sides must inhabit the same primitive class.
        if (f64Compatible(l) && f64Compatible(r)) return BOOL;
        if (boolCompatible(l) && boolCompatible(r)) return BOOL;
        return DYNAMIC;
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
        // #1845 — `a && b` / `a || b` evaluate to one of the *operand values*
        // (per ECMAScript §13.13/§13.14 ShortCircuit), NOT a coerced boolean.
        // The previous rule claimed `BOOL` whenever both sides were merely
        // `boolCompatible`, which also accepts `unknown` — so an unresolved
        // (possibly non-boolean) param/return got seeded as `bool`, and
        // `lowerBinary` would then emit `i32.and`/`i32.or` on a non-integer
        // value. Sound rule: the tightest type is the join of the two operand
        // values, but only when both are *concrete* — `unknown` on either side
        // means we cannot prove the result's shape (`join` would optimistically
        // adopt the other side's type), so it falls to `DYNAMIC`.
        if (l.kind === "unknown" || r.kind === "unknown" || l.kind === "dynamic" || r.kind === "dynamic") {
          return DYNAMIC;
        }
        return join(l, r);
      default:
        return DYNAMIC;
    }
  }
  if (ts.isConditionalExpression(expr)) {
    const cond = inferExpr(expr.condition, scope, entries, resolveCallTarget, ext);
    if (!boolCompatible(cond)) return DYNAMIC;
    return join(
      inferExpr(expr.whenTrue, scope, entries, resolveCallTarget, ext),
      inferExpr(expr.whenFalse, scope, entries, resolveCallTarget, ext),
    );
  }
  if (ts.isCallExpression(expr)) {
    // #1126 Stage 2 — recognise `Math.imul` / `Math.clz32` as integer
    // builtins. Both are ToInt32-coerced producers per the ECMAScript
    // spec:
    //   • Math.imul(a, b) → signed 32-bit multiplication, Int32 result
    //   • Math.clz32(x)   → count of leading zeros, Uint32 result
    // The receiver must be the literal identifier `Math`; we do not
    // trace aliases (`const M = Math; M.imul(...)`) — Stage 4
    // cross-fn narrowing can pick those up later.
    if (
      i32DomainEnabled() &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Math" &&
      ts.isIdentifier(expr.expression.name)
    ) {
      const method = expr.expression.name.text;
      if (method === "imul") return I32;
      if (method === "clz32") return U32;
      // Fall through for other Math methods — they remain DYNAMIC.
    }
    if (!ts.isIdentifier(expr.expression)) return DYNAMIC;
    const target = resolveCallTarget(expr.expression);
    const entry = target ? entries.get(target) : undefined;
    if (!entry) return DYNAMIC;
    return entry.returnType;
  }
  // #1231 Phase 1 — object literal: build a typed shape from each
  // property's inferred atom. Any property that doesn't reduce to a
  // `LatticeAtom` (i.e. `unknown`, `union`, or `dynamic`) widens the
  // whole literal to `dynamic`. Spread / methods / getters / setters /
  // computed keys / duplicate keys also widen — those force the
  // function back to the legacy boxed path.
  if (ts.isObjectLiteralExpression(expr) && objectShapesEnabled()) {
    return inferObjectLiteralAtom(expr, scope, entries, resolveCallTarget, ext);
  }
  // #1231 Phase 1 — property / element access on a known object atom:
  // look up the field in the receiver's shape and return its atom.
  // When the receiver is a union or dynamic we can't pick a unique
  // field, so widen to dynamic.
  if (ts.isPropertyAccessExpression(expr)) {
    return inferPropertyAccessAtom(expr, scope, entries, resolveCallTarget, ext);
  }
  if (ts.isElementAccessExpression(expr)) {
    return inferElementAccessAtom(expr, scope, entries, resolveCallTarget, ext);
  }
  // (#743) `this` resolves to whatever the CALLER bound under the reserved key
  // `"<this>"`. Provably inert for the main fixpoint: `"<this>"` is not a legal
  // identifier, and `buildScope`/`seedParamType` only ever key this map by
  // `p.name.text`, so nothing here can bind it. (A key of `"this"` would NOT be
  // inert — a TS `this` parameter declares a real parameter with that text.)
  // The fnctor-graph satellite binds it to a per-owner instance atom so nested
  // reads (`this.pos - this.lineStart`) and bare-`this` arguments
  // (`new Token(this)`) carry field facts; see src/ir/fnctor-method-edges.ts.
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return scope.get("<this>") ?? DYNAMIC;
  return DYNAMIC;
}

/**
 * Build an `object` atom from an object literal. Returns `DYNAMIC` if
 * any property's atom is not a concrete `LatticeAtom` (unknown / union /
 * dynamic), or if the literal contains shapes Phase 1 doesn't model
 * (spread, methods, accessors, computed keys, duplicate keys, empty
 * literal). The depth cap (`LATTICE_OBJECT_SHAPE_MAX_DEPTH`) is checked
 * after sub-inference so a deeply-nested literal widens cleanly.
 */
function inferObjectLiteralAtom(
  expr: ts.ObjectLiteralExpression,
  scope: ReadonlyMap<string, LatticeType>,
  entries: ReadonlyMap<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>,
  resolveCallTarget: CallTargetResolver,
  ext?: InferExtension,
): LatticeType {
  if (expr.properties.length === 0) return DYNAMIC;
  const fields: { name: string; type: LatticeAtom }[] = [];
  const seen = new Set<string>();
  for (const prop of expr.properties) {
    let name: string | null;
    let valExpr: ts.Expression;
    if (ts.isPropertyAssignment(prop)) {
      name = phase1ObjectPropertyName(prop.name);
      if (name === null) return DYNAMIC;
      valExpr = prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      name = prop.name.text;
      valExpr = prop.name; // identifier ref
    } else {
      // SpreadAssignment, MethodDeclaration, GetAccessor, SetAccessor — defer to legacy.
      return DYNAMIC;
    }
    if (seen.has(name)) return DYNAMIC; // duplicate keys not in Phase 1
    seen.add(name);
    const fieldType = inferExpr(valExpr, scope, entries, resolveCallTarget, ext);
    if (!isAtomLattice(fieldType)) return DYNAMIC;
    fields.push({ name, type: fieldType });
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const atom: LatticeAtom = { kind: "object", fields };
  // Depth cap — a Phase 1 atom must not exceed the recursive shape
  // depth limit. Widening here (instead of inside the loop) lets nested
  // call return types contribute their own bounded shapes; only the
  // construction site enforces the cap.
  if (objectAtomDepth(atom) > LATTICE_OBJECT_SHAPE_MAX_DEPTH) return DYNAMIC;
  return atom;
}

/**
 * Look up `expr.name` against the receiver's object atom. Returns the
 * field's atom if the receiver is an object atom and the field exists;
 * otherwise widens to `dynamic`. Note that property access doesn't
 * need its own gate — when `objectShapesEnabled()` is false no source
 * produces an object atom, so the `recvType.kind === "object"` arm is
 * never reached.
 */
function inferPropertyAccessAtom(
  expr: ts.PropertyAccessExpression,
  scope: ReadonlyMap<string, LatticeType>,
  entries: ReadonlyMap<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>,
  resolveCallTarget: CallTargetResolver,
  ext?: InferExtension,
): LatticeType {
  if (!ts.isIdentifier(expr.name)) return DYNAMIC;
  if (expr.questionDotToken) return DYNAMIC;
  const recvType = inferExpr(expr.expression, scope, entries, resolveCallTarget, ext);
  if (recvType.kind !== "object") return DYNAMIC;
  const propName = expr.name.text;
  const field = recvType.fields.find((f) => f.name === propName);
  if (!field) return DYNAMIC;
  return field.type;
}

/**
 * Element access with a string-literal argument is sugar for property
 * access; numeric / computed / non-literal keys widen to `dynamic`.
 */
function inferElementAccessAtom(
  expr: ts.ElementAccessExpression,
  scope: ReadonlyMap<string, LatticeType>,
  entries: ReadonlyMap<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>,
  resolveCallTarget: CallTargetResolver,
  ext?: InferExtension,
): LatticeType {
  if (expr.questionDotToken) return DYNAMIC;
  const arg = expr.argumentExpression;
  if (!(ts.isStringLiteral(arg) || arg.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)) {
    return DYNAMIC;
  }
  const recvType = inferExpr(expr.expression, scope, entries, resolveCallTarget, ext);
  if (recvType.kind !== "object") return DYNAMIC;
  const propName = (arg as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
  const field = recvType.fields.find((f) => f.name === propName);
  if (!field) return DYNAMIC;
  return field.type;
}

/**
 * Resolve an object literal's PropertyName to its canonical text key.
 * Identifier and StringLiteral keys produce their text; NumericLiteral
 * keys produce their canonical JS toString. Computed keys widen to
 * legacy by returning null. Mirrors the helper in `from-ast.ts` —
 * duplicated here to keep `propagate.ts` self-contained.
 */
function phase1ObjectPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * Compute the recursive object-shape depth of a `LatticeAtom`. A scalar
 * atom has depth 0; an object atom has `1 + max(field depth)`. Used to
 * enforce `LATTICE_OBJECT_SHAPE_MAX_DEPTH` when constructing new shapes
 * and when joining two object atoms.
 */
function objectAtomDepth(a: LatticeAtom): number {
  if (a.kind !== "object") return 0;
  let max = 0;
  for (const f of a.fields) {
    const d = objectAtomDepth(f.type);
    if (d > max) max = d;
  }
  return max + 1;
}

function f64Compatible(t: LatticeType): boolean {
  // #1126 Stage 1 — `i32` and `u32` are numeric subdomains of `f64`:
  // a value in either can be widened to f64 with `f64.convert_i32_s/u`
  // without loss, so any `f64`-shaped expression context (arithmetic,
  // numeric comparisons) accepts them. The lattice atoms remain
  // distinct so Stage 3's emitter can pick the narrowed-i32 path
  // when both operands stay narrow. `unknown` stays compatible so
  // unresolved-but-not-yet-widened values propagate through fixpoint.
  return t.kind === "f64" || t.kind === "i32" || t.kind === "u32" || t.kind === "unknown";
}

function boolCompatible(t: LatticeType): boolean {
  return t.kind === "bool" || t.kind === "unknown";
}

// ---------------------------------------------------------------------------
// Lattice operations
// ---------------------------------------------------------------------------

function join(a: LatticeType, b: LatticeType): LatticeType {
  if (a.kind === "dynamic" || b.kind === "dynamic") return DYNAMIC;
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;

  // #1126 Stage 1 — numeric-domain widening rules. Joining two distinct
  // numeric atoms (any combination of i32/u32/f64) widens to f64 rather
  // than forming a union, because:
  //
  //   • A union `{i32, f64}` would force a tagged-union representation
  //     for what is logically still "a JS number" — wasteful, and the
  //     V1 union lowering doesn't support i32-as-bare-i32 anyway (the
  //     i32 slot is reserved for bool).
  //   • `i32 ⊔ u32 = f64` (not a union) because the value `2^31` is
  //     positive in u32 but negative in i32 — the only domain that
  //     contains both interpretations losslessly is f64. Encoding that
  //     as a tagged union would require runtime sign-disambiguation
  //     which f64 already represents directly.
  //   • i32/u32 are subdomains of f64 (`f64Compatible` returns true for
  //     both), so widening preserves every fact a downstream consumer
  //     could care about.
  //
  // Same-kind atom join (i32 ⊔ i32, u32 ⊔ u32) collapses normally via
  // the atomsEqual fast path below.
  if (isAtomLattice(a) && isAtomLattice(b)) {
    const aNumeric = a.kind === "f64" || a.kind === "i32" || a.kind === "u32";
    const bNumeric = b.kind === "f64" || b.kind === "i32" || b.kind === "u32";
    if (aNumeric && bNumeric && a.kind !== b.kind) return F64;
  }

  // Atom ⊔ Atom: same kind collapses; different kinds form a union.
  if (isAtomLattice(a) && isAtomLattice(b)) {
    if (atomsEqual(a, b)) return a;
    return makeUnion([a, b]);
  }

  // Union ⊔ Atom or Atom ⊔ Union: add the atom to the member set.
  if (a.kind === "union" && isAtomLattice(b)) {
    return extendUnion(a.members, b);
  }
  if (b.kind === "union" && isAtomLattice(a)) {
    return extendUnion(b.members, a);
  }

  // Union ⊔ Union: concatenate both member sets.
  if (a.kind === "union" && b.kind === "union") {
    let acc: LatticeType = a;
    for (const m of b.members) {
      if (acc.kind === "dynamic") return DYNAMIC;
      acc = acc.kind === "union" ? extendUnion(acc.members, m) : extendUnion([acc as LatticeAtom], m);
    }
    return acc;
  }

  // Mixed cases with unknown already handled; anything else is dynamic.
  return DYNAMIC;
}

function isAtomLattice(t: LatticeType): t is LatticeAtom {
  return (
    t.kind === "f64" ||
    t.kind === "i32" ||
    t.kind === "u32" ||
    t.kind === "bool" ||
    t.kind === "string" ||
    t.kind === "object"
  );
}

function atomsEqual(a: LatticeAtom, b: LatticeAtom): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "object" && b.kind === "object") {
    if (a.fields.length !== b.fields.length) return false;
    // Field lists are name-sorted at construction time so positional
    // comparison is sufficient.
    for (let i = 0; i < a.fields.length; i++) {
      const af = a.fields[i]!;
      const bf = b.fields[i]!;
      if (af.name !== bf.name) return false;
      if (!atomsEqual(af.type, bf.type)) return false;
    }
    return true;
  }
  return true;
}

/**
 * Pre-pass for `makeUnion` — #1126 Stage 1 numeric collapse.
 *
 * If two or more *different* numeric atoms (any combination of f64/i32/u32)
 * appear in the input, replace all of them with a single f64 atom. This
 * preserves the invariant established by `join`: a union never simultaneously
 * holds an integer-domain atom and a wider numeric atom. Rationale matches
 * `join`'s numeric-widening rule — i32/u32 are subdomains of f64, encoding
 * them as siblings in a tagged union would force runtime sign-disambiguation
 * for no semantic gain.
 *
 * Returns the input array unchanged when at most one numeric atom is present
 * (the common case for non-numeric unions like `{string, bool}`).
 */
function collapseNumericAtoms(members: readonly LatticeAtom[]): readonly LatticeAtom[] {
  const distinctNumericKinds = new Set<string>();
  for (const m of members) {
    if (m.kind === "f64" || m.kind === "i32" || m.kind === "u32") distinctNumericKinds.add(m.kind);
  }
  if (distinctNumericKinds.size <= 1) return members;
  const out: LatticeAtom[] = [];
  let f64Added = false;
  for (const m of members) {
    if (m.kind === "f64" || m.kind === "i32" || m.kind === "u32") {
      if (!f64Added) {
        out.push({ kind: "f64" });
        f64Added = true;
      }
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Build a canonical union from a list of atoms (dedupe + sort). */
function makeUnion(members: readonly LatticeAtom[]): LatticeType {
  const collapsed = collapseNumericAtoms(members);
  const deduped: LatticeAtom[] = [];
  for (const m of collapsed) {
    if (!deduped.some((d) => atomsEqual(d, m))) deduped.push(m);
  }
  if (deduped.length > LATTICE_UNION_MAX_MEMBERS) return DYNAMIC;
  if (deduped.length === 1) return deduped[0]!;
  deduped.sort(atomOrder);
  return { kind: "union", members: deduped };
}

function extendUnion(members: readonly LatticeAtom[], atom: LatticeAtom): LatticeType {
  if (members.some((m) => atomsEqual(m, atom))) {
    return makeUnion(members);
  }
  return makeUnion([...members, atom]);
}

/** Canonical ordering used when emitting unions — stable for typesEqual. */
function atomOrder(a: LatticeAtom, b: LatticeAtom): number {
  const order = atomKindOrder(a.kind) - atomKindOrder(b.kind);
  if (order !== 0) return order;
  if (a.kind === "object" && b.kind === "object") {
    return atomDescription(a).localeCompare(atomDescription(b));
  }
  return 0;
}

/**
 * Stable string description of a LatticeAtom — used for canonical
 * union ordering. Object atoms produce a recursive `{name:type,...}`
 * stringification of their field list (already name-sorted).
 */
function atomDescription(a: LatticeAtom): string {
  if (a.kind === "object") {
    return `{${a.fields.map((f) => `${f.name}:${atomDescription(f.type)}`).join(",")}}`;
  }
  return a.kind;
}

function atomKindOrder(k: LatticeAtom["kind"]): number {
  switch (k) {
    case "f64":
      return 0;
    // i32/u32 sort right after f64 — they're numeric atoms, so within a
    // canonical union they cluster together. Order: f64 < i32 < u32 <
    // bool < string < object. The relative ordering doesn't affect
    // semantics; it only affects the deterministic canonical form used
    // by `typesEqual` for fixpoint convergence.
    case "i32":
      return 1;
    case "u32":
      return 2;
    case "bool":
      return 3;
    case "string":
      return 4;
    case "object":
      return 5;
  }
}

function typesEqual(a: LatticeType, b: LatticeType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "union" && b.kind === "union") {
    if (a.members.length !== b.members.length) return false;
    for (let i = 0; i < a.members.length; i++) {
      if (!atomsEqual(a.members[i]!, b.members[i]!)) return false;
    }
    return true;
  }
  if (a.kind === "object" && b.kind === "object") return atomsEqual(a, b);
  return true;
}

function paramsEqual(a: readonly LatticeType[], b: readonly LatticeType[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!typesEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectIndexedFunctionDeclarations(
  sourceFiles: readonly ts.SourceFile[],
  identityContext: IrPlanningIdentityContext,
): readonly PropagationFunction[] {
  const selectedSources = new Set<ts.SourceFile>();
  for (const sourceFile of sourceFiles) {
    if (!identityContext.sourceIdBySourceFile.has(sourceFile)) {
      throw new IrPlanningIdentityInvariantError(
        "source-record-mismatch",
        `IR propagation source ${sourceFile.fileName} is not part of the supplied planning identity context`,
      );
    }
    selectedSources.add(sourceFile);
  }

  const functions: PropagationFunction[] = [];
  for (const unit of identityContext.inventory.allUnits) {
    const declaration = identityContext.declarationByUnitId.get(unit.id);
    if (
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      !declaration.name ||
      !declaration.body ||
      !ts.isSourceFile(declaration.parent) ||
      !selectedSources.has(declaration.parent)
    ) {
      continue;
    }
    functions.push({ unitId: unit.id, displayName: declaration.name.text, declaration });
  }
  return functions;
}

function makeCallTargetResolver(
  functions: readonly PropagationFunction[],
  checker: ts.TypeChecker | undefined,
  identityContext: IrPlanningIdentityContext,
): CallTargetResolver {
  const eligible = new Set(functions.map((info) => info.unitId));
  if (!checker) {
    const byDisplayName = new Map<string, IrUnitId[]>();
    for (const info of functions) {
      const matches = byDisplayName.get(info.displayName);
      if (matches) matches.push(info.unitId);
      else byDisplayName.set(info.displayName, [info.unitId]);
    }
    return (identifier) => {
      const matches = byDisplayName.get(identifier.text);
      return matches?.length === 1 ? matches[0] : undefined;
    };
  }

  const symbolCache = new Map<ts.Symbol, IrUnitId | null>();
  const identifierCache = new Map<ts.Identifier, IrUnitId | null>();
  const resolveSymbol = (input: ts.Symbol): IrUnitId | undefined => {
    if (symbolCache.has(input)) return symbolCache.get(input) ?? undefined;
    let symbol = input;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        symbolCache.set(input, null);
        return undefined;
      }
    }
    if (symbolCache.has(symbol)) {
      const resolved = symbolCache.get(symbol) ?? null;
      symbolCache.set(input, resolved);
      return resolved ?? undefined;
    }

    let match: IrUnitId | undefined;
    let ambiguous = false;
    const consider = (declaration: ts.Declaration | undefined): void => {
      if (!declaration) return;
      const unitId = identityContext.unitIdByDeclaration.get(declaration);
      if (!unitId || !eligible.has(unitId)) return;
      if (match !== undefined && match !== unitId) ambiguous = true;
      else match = unitId;
    };
    for (const declaration of symbol.declarations ?? []) consider(declaration);
    consider(symbol.valueDeclaration);
    const resolved = ambiguous ? null : (match ?? null);
    symbolCache.set(symbol, resolved);
    symbolCache.set(input, resolved);
    return resolved ?? undefined;
  };

  return (identifier) => {
    if (identifierCache.has(identifier)) return identifierCache.get(identifier) ?? undefined;
    const symbol = checker.getSymbolAtLocation(identifier);
    const resolved = symbol ? (resolveSymbol(symbol) ?? null) : null;
    identifierCache.set(identifier, resolved);
    return resolved ?? undefined;
  };
}

/**
 * Walk the function body, tracking `let`/`const` declarations into a
 * mutable scope clone and reporting every reachable `return` expression's
 * inferred type via `cb`. Nested function-like nodes are skipped.
 *
 * This is NOT a full CFG analysis — it's a structural walk that treats
 * `if/else`, blocks, and statement sequences as scope-extending without
 * modeling branch-divergent scope state. For Phase-2-claimable functions
 * (enforced by the selector) the shape is narrow enough that this is
 * equivalent to a proper analysis: no reassignment (let/const only,
 * Phase 1 shape rejects later `x = …`), no break/continue, returns
 * only at tails.
 */
function walkBodyForReturns(
  body: ts.Node,
  paramScope: ReadonlyMap<string, LatticeType>,
  entries: ReadonlyMap<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>,
  resolveCallTarget: CallTargetResolver,
  cb: (t: LatticeType) => void,
  ext?: InferExtension,
): void {
  const walk = (node: ts.Node, scope: Map<string, LatticeType>): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessor(node) ||
      ts.isSetAccessor(node) ||
      ts.isClassExpression(node) ||
      ts.isClassDeclaration(node)
    ) {
      return;
    }

    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const childScope = new Map(scope);
      for (const s of node.statements) walk(s, childScope);
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (!d.initializer) continue;
        const t = inferExpr(d.initializer, scope, entries, resolveCallTarget, ext);
        scope.set(d.name.text, t);
      }
      return;
    }

    if (ts.isReturnStatement(node)) {
      if (!node.expression) return;
      cb(inferExpr(node.expression, scope, entries, resolveCallTarget, ext));
      return;
    }

    if (ts.isIfStatement(node)) {
      walk(node.thenStatement, scope);
      if (node.elseStatement) walk(node.elseStatement, scope);
      return;
    }

    if (ts.isExpressionStatement(node)) {
      return;
    }

    // Default: recurse, propagating scope. For anything we don't
    // specifically recognize, we still visit children so nested
    // `return` statements inside unexpected statement shapes aren't
    // lost.
    forEachChild(node, (child) => walk(child, scope));
  };

  const rootScope = new Map<string, LatticeType>(paramScope);
  // Body of a FunctionDeclaration is a Block. Walk its statements in
  // the root scope so param types are visible.
  forEachChild(body, (child) => walk(child, rootScope));
}

// ---------------------------------------------------------------------------
// LatticeType → IrType lowering
// ---------------------------------------------------------------------------

/**
 * Lower a `LatticeType` to the middle-end `IrType` used by `from-ast.ts`
 * / `lower.ts`. Returns `null` when the lattice value is not representable
 * as a concrete IR type (unknown, dynamic, or a union with members the
 * tagged-union registry doesn't support).
 *
 * V1 union mapping:
 *   - `{f64, bool}`        → `IrType.union<f64, i32>`        (i32 holds bool)
 *   - `{f64, string}`      → null (heterogeneous-width, deferred)
 *   - `{object(A), object(B)}` → null (reference unions, deferred)
 */
export function lowerTypeToIrType(t: LatticeType): import("./nodes.js").IrType | null {
  switch (t.kind) {
    case "f64":
      return { kind: "val", val: { kind: "f64" } };
    // #1126 Stage 1 — both `i32` and `u32` lattice atoms lower to the same
    // Wasm `i32` storage but are tagged with the IR `signed` fact so
    // Stage 3 emit decisions (signed vs unsigned shifts, comparisons,
    // conversions back to f64) can be made structurally. `bool` still
    // lowers as i32 with default (signed) semantics — the v1 union
    // mapping already relies on bool taking the i32 slot, and bool/i32
    // never co-exist in the same union here.
    case "i32":
      return { kind: "val", val: { kind: "i32" }, signed: true };
    case "u32":
      return { kind: "val", val: { kind: "i32" }, signed: false };
    case "bool":
      return { kind: "val", val: { kind: "i32" } };
    case "string":
      // #1169a — strings now flow through the IR via the backend-agnostic
      // `IrType.string` marker. The actual Wasm representation (externref
      // vs `(ref $AnyString)`) is decided by the lowerer's resolver based
      // on the active string backend.
      return { kind: "string" };
    case "object": {
      // #1231 Phase 1 — recursively lower the object atom's field list
      // to an IR object shape. Each field's atom must lower cleanly; any
      // null bubbles up so the caller can fall back to legacy. Field
      // names are already canonicalised (sorted) at construction time.
      const fields: { name: string; type: import("./nodes.js").IrType }[] = [];
      for (const f of t.fields) {
        const ir = lowerTypeToIrType(f.type);
        if (ir === null) return null;
        fields.push({ name: f.name, type: ir });
      }
      if (fields.length === 0) return null;
      return { kind: "object", shape: { fields } };
    }
    case "union": {
      // #1926 — union members are IrTypes now; wrap each scalar ValType in a
      // `val`-kind IrType. V1 still admits only f64/i32 scalar members.
      const members: import("./nodes.js").IrType[] = [];
      for (const m of t.members) {
        if (m.kind === "f64") members.push({ kind: "val", val: { kind: "f64" } });
        else if (m.kind === "bool") members.push({ kind: "val", val: { kind: "i32" } });
        // string/object members not supported in V1 tagged unions.
        // #1126 Stage 1 — i32/u32 atoms also fall through to `return null`
        // here. They should never reach this case in practice: the lattice
        // `join` rules collapse `i32 ⊔ f64 = f64` and `i32 ⊔ u32 = f64`,
        // so a union containing an integer-domain atom only forms when
        // joining with a non-numeric atom (string/object/bool). That
        // shape isn't representable in V1 tagged unions either way.
        else return null;
      }
      if (members.length < 2) return null;
      return { kind: "union", members };
    }
    case "unknown":
    case "dynamic":
      return null;
  }
}

/** Explicit name-keyed adapter retained only for the existing lattice-rule unit tests. */
function inferLegacyExpressionForTests(
  expr: ts.Expression,
  scope: ReadonlyMap<string, LatticeType>,
  entries: ReadonlyMap<string, { params: LatticeType[]; returnType: LatticeType }>,
): LatticeType {
  const structuralEntries = new Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>();
  for (const [legacyName, entry] of entries) structuralEntries.set(legacyName as IrUnitId, entry);
  return inferExpr(expr, scope, structuralEntries, (identifier) => {
    const legacyName = identifier.text as IrUnitId;
    return structuralEntries.has(legacyName) ? legacyName : undefined;
  });
}

// (#743) Shared propagation core for the flag-gated fnctor method-edge
// satellite (src/ir/fnctor-method-edges.ts). The satellite runs a SECOND,
// self-contained fixpoint over prototype/static methods and function-expression
// constructors — a population this module's `collectIndexedFunctionDeclarations`
// deliberately excludes — and reuses the exact lattice rules so the two
// fixpoints cannot drift on operator/join semantics. Deliberately NOT widened
// into `buildIrUnitTypeMap` itself: the main map feeds IR selection and the
// legacy-parity seams, so any change to its entries shifts IR claims; the
// satellite's facts feed only the fnctor field-slot consumer
// (src/codegen/fnctor-ctor-param-types.ts) and therefore cannot cause
// typeIdx-parity demotions. Rationale + measurements: plan/issues/743.
export const _propagationCore = {
  inferExpr,
  walkBodyForReturns,
  seedParamType,
  seedReturnType,
  join,
  paramsEqual,
  typesEqual,
  UNKNOWN,
  DYNAMIC,
} as const;

// Exported for tests — let them poke at the lattice without rebuilding
// everything from scratch.
export const _internals = {
  join,
  inferExpr: inferLegacyExpressionForTests,
  tsTypeToLattice,
  typeNodeToLattice,
  makeUnion,
  // #1126 Stage 1 — lattice atom constants for unit tests.
  F64,
  I32,
  U32,
  BOOL,
  STRING,
  UNKNOWN,
  DYNAMIC,
  // #1126 Stage 2 — flag accessor for tests so the per-rule producers
  // can be exercised deterministically without touching `process.env`.
  i32DomainEnabled,
};
