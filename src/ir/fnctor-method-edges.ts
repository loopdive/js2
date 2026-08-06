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
//  - A dynamic-key CALL anywhere (`x[k](…)`, non-literal `k`) can dispatch to
//    any method → ALL method nodes are dropped.
//  - Write-once discipline: a method assigned twice, conditionally, at
//    non-top-level, through a computed key, `defineProperty`-installed, or on a
//    reassigned/deleted prototype contributes NO node. Its body is still walked
//    for sites, with its parameters bound DYNAMIC — conservative both ways.
//  - A constructor/function whose VALUE escapes (referenced outside callee /
//    property-base / export positions) is poisoned to all-DYNAMIC params: a
//    `var C2 = F; new C2()` alias or `arr.push(F)` flow would otherwise call it
//    with args this graph cannot see.
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
import { _propagationCore as core, type LatticeType } from "./propagate.js";

interface GraphNode {
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

interface Edge {
  readonly callee: IrUnitId;
  readonly argExprs: readonly ts.Expression[];
  /** Enclosing function-like chain, outermost first (empty at top level). */
  readonly scopeChain: readonly ts.SignatureDeclaration[];
}

const memo = new WeakMap<ts.SourceFile, ReadonlyMap<string, readonly LatticeType[]>>();

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
  const cached = memo.get(sourceFile);
  if (cached) return cached;
  const result = analyze(sourceFile, host.checker);
  memo.set(sourceFile, result);
  return result;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

function isFunctionLikeNode(node: ts.Node): node is ts.SignatureDeclaration {
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

function analyze(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ReadonlyMap<string, readonly LatticeType[]> {
  const nodes = new Map<IrUnitId, GraphNode>();
  const nodeIdBySymbol = new Map<ts.Symbol, IrUnitId>();
  const nodeIdByFn = new Map<ts.Node, IrUnitId>();
  let nextId = 0;
  const mkId = (): IrUnitId => `__fnctor_graph_${nextId++}` as IrUnitId;

  const symOf = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);

  // ── 1. Top-level callables ────────────────────────────────────────────────
  const addCallable = (
    name: string,
    fn: ts.FunctionDeclaration | ts.FunctionExpression,
    symbols: readonly (ts.Symbol | undefined)[],
  ): void => {
    const id = mkId();
    const node: GraphNode = { id, kind: "callable", name, fn, poisoned: false };
    nodes.set(id, node);
    nodeIdByFn.set(fn, id);
    for (const sym of symbols) {
      if (!sym) continue;
      if (nodeIdBySymbol.has(sym)) {
        // Same binding declared twice with function initializers — ambiguous.
        const prev = nodes.get(nodeIdBySymbol.get(sym)!);
        if (prev) prev.poisoned = true;
        node.poisoned = true;
        continue;
      }
      nodeIdBySymbol.set(sym, id);
    }
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      addCallable(stmt.name.text, stmt, [symOf(stmt.name)]);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = unwrap(d.initializer);
        if (ts.isFunctionExpression(init) && init.body) {
          addCallable(d.name.text, init, [symOf(d.name), init.name ? symOf(init.name) : undefined]);
        }
      }
    }
  }

  // ── 2. Top-level prototype aliases (`var pp = F.prototype`) ──────────────
  const protoAliasOwner = new Map<ts.Symbol, IrUnitId>();
  const protoPoisoned = new Set<IrUnitId>();
  const staticPoisoned = new Set<IrUnitId>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = unwrap(d.initializer);
      if (!ts.isPropertyAccessExpression(init) || init.name.text !== "prototype") continue;
      const base = unwrap(init.expression);
      if (!ts.isIdentifier(base)) continue;
      const ownerSym = symOf(base);
      const ownerId = ownerSym ? nodeIdBySymbol.get(ownerSym) : undefined;
      if (ownerId === undefined) continue;
      const aliasSym = symOf(d.name);
      if (!aliasSym) continue;
      const prev = protoAliasOwner.get(aliasSym);
      if (prev !== undefined && prev !== ownerId) {
        protoPoisoned.add(prev);
        protoPoisoned.add(ownerId);
        continue;
      }
      protoAliasOwner.set(aliasSym, ownerId);
    }
  }

  // ── 3. Whole-file scan ────────────────────────────────────────────────────
  interface MethodWriteState {
    decl?: ts.FunctionExpression;
    bad: boolean;
  }
  // "<ownerId> <space> <name>" → state
  const methodWrites = new Map<string, MethodWriteState>();
  const runtimeDefinedProtoKeys = new Map<IrUnitId, Set<string>>();
  const valueReadNames = new Set<string>();
  let poisonAllMethods = false;
  let poisonAllCtors = false;
  const callSites: ts.CallExpression[] = [];
  const newSites: ts.NewExpression[] = [];

  const writeKey = (ownerId: IrUnitId, space: "static" | "proto", name: string): string => `${ownerId} ${space} ${name}`;

  /** Resolve a member-access BASE to the method space it addresses, if any. */
  const spaceOfBase = (baseExpr: ts.Expression): { ownerId: IrUnitId; space: "static" | "proto" } | undefined => {
    const base = unwrap(baseExpr);
    if (ts.isPropertyAccessExpression(base) && base.name.text === "prototype") {
      const inner = unwrap(base.expression);
      if (ts.isIdentifier(inner)) {
        const sym = symOf(inner);
        const ownerId = sym ? nodeIdBySymbol.get(sym) : undefined;
        if (ownerId !== undefined) return { ownerId, space: "proto" };
      }
      return undefined;
    }
    if (ts.isIdentifier(base)) {
      const sym = symOf(base);
      if (sym) {
        const aliasOwner = protoAliasOwner.get(sym);
        if (aliasOwner !== undefined) return { ownerId: aliasOwner, space: "proto" };
        const ownerId = nodeIdBySymbol.get(sym);
        if (ownerId !== undefined) return { ownerId, space: "static" };
      }
    }
    return undefined;
  };

  const isTopLevelAssignment = (assign: ts.Node): boolean =>
    assign.parent !== undefined && ts.isExpressionStatement(assign.parent) && assign.parent.parent === sourceFile;

  const recordMethodWrite = (
    ownerId: IrUnitId,
    space: "static" | "proto",
    name: string,
    rhs: ts.Expression,
    topLevel: boolean,
  ): void => {
    const key = writeKey(ownerId, space, name);
    const prev = methodWrites.get(key);
    const fnRhs = unwrap(rhs);
    if (prev !== undefined || !topLevel || !ts.isFunctionExpression(fnRhs) || !fnRhs.body) {
      methodWrites.set(key, { bad: true });
      return;
    }
    methodWrites.set(key, { decl: fnRhs, bad: false });
  };

  const objectDefineKind = (call: ts.CallExpression): "many" | "one" | undefined => {
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const base = unwrap(callee.expression);
    if (!ts.isIdentifier(base) || base.text !== "Object") return undefined;
    if (callee.name.text === "defineProperties") return "many";
    if (callee.name.text === "defineProperty") return "one";
    return undefined;
  };

  /** Keys of an object literal, or a top-level once-declared var holding one. */
  const resolveLiteralKeys = (arg: ts.Expression): Set<string> | undefined => {
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
  };

  const handleObjectDefine = (call: ts.CallExpression): void => {
    const kind = objectDefineKind(call);
    if (kind === undefined || call.arguments.length < 2) return;
    const space = spaceOfBase(call.arguments[0]!);
    if (space === undefined) return;
    let demote: Set<string> | undefined;
    if (kind === "one") {
      const key = unwrap(call.arguments[1]!);
      demote = ts.isStringLiteral(key) ? new Set([key.text]) : undefined;
    } else {
      demote = resolveLiteralKeys(call.arguments[1]!);
    }
    if (demote === undefined) {
      (space.space === "proto" ? protoPoisoned : staticPoisoned).add(space.ownerId);
      return;
    }
    if (space.space === "proto") {
      let keys = runtimeDefinedProtoKeys.get(space.ownerId);
      if (!keys) {
        keys = new Set();
        runtimeDefinedProtoKeys.set(space.ownerId, keys);
      }
      for (const key of demote) {
        keys.add(key);
        methodWrites.set(writeKey(space.ownerId, "proto", key), { bad: true });
      }
    } else {
      for (const key of demote) methodWrites.set(writeKey(space.ownerId, "static", key), { bad: true });
    }
  };

  /** Escape check for a callable-node identifier reference. */
  const isAllowedCallableRef = (id: ts.Identifier): boolean => {
    // Climb wrappers so `(F)(…)` / `new (F as any)(…)` count as callee uses.
    let node: ts.Node = id;
    while (
      node.parent !== undefined &&
      (ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isNonNullExpression(node.parent))
    ) {
      node = node.parent;
    }
    const parent = node.parent;
    if (parent === undefined) return false;
    if (ts.isCallExpression(parent) && parent.expression === node) return true;
    if (ts.isNewExpression(parent) && parent.expression === node) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return true;
    if (ts.isVariableDeclaration(parent) && parent.name === id) return true;
    if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) return true; // its own name
    if (ts.isExportSpecifier(parent)) return true; // export boundary — family trust model
    if (ts.isExportAssignment(parent)) return true;
    return false;
  };

  const scan = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = n.left;
      if (ts.isPropertyAccessExpression(left) && !ts.isPrivateIdentifier(left.name)) {
        if (left.name.text === "prototype") {
          // `F.prototype = …` — prototype object replaced.
          const inner = unwrap(left.expression);
          if (ts.isIdentifier(inner)) {
            const sym = symOf(inner);
            const ownerId = sym ? nodeIdBySymbol.get(sym) : undefined;
            if (ownerId !== undefined) protoPoisoned.add(ownerId);
          }
        } else {
          const space = spaceOfBase(left.expression);
          if (space !== undefined) {
            recordMethodWrite(space.ownerId, space.space, left.name.text, n.right, isTopLevelAssignment(n));
          }
        }
      } else if (ts.isElementAccessExpression(left)) {
        const space = spaceOfBase(left.expression);
        if (space !== undefined) {
          // Computed write on a tracked space — any name could be written.
          (space.space === "proto" ? protoPoisoned : staticPoisoned).add(space.ownerId);
        }
      } else if (ts.isIdentifier(left)) {
        const sym = symOf(left);
        const aliasOwner = sym ? protoAliasOwner.get(sym) : undefined;
        if (aliasOwner !== undefined) protoPoisoned.add(aliasOwner); // alias reassigned
      }
    }
    if (ts.isDeleteExpression(n)) {
      const t = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) {
        const space = spaceOfBase(t.expression);
        if (space !== undefined) (space.space === "proto" ? protoPoisoned : staticPoisoned).add(space.ownerId);
      }
    }
    if (ts.isCallExpression(n)) {
      handleObjectDefine(n);
      callSites.push(n);
      const callee = unwrap(n.expression);
      if (ts.isElementAccessExpression(callee)) {
        const key = unwrap(callee.argumentExpression);
        if (!(ts.isStringLiteral(key) || key.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)) {
          // Dynamic-key dispatch can reach any method by any name.
          poisonAllMethods = true;
        }
      }
    }
    if (ts.isNewExpression(n)) newSites.push(n);
    if (ts.isPropertyAccessExpression(n) && !ts.isPrivateIdentifier(n.name)) {
      const parent = n.parent;
      const isDirectCallee = parent !== undefined && ts.isCallExpression(parent) && parent.expression === n;
      const isInstallTarget =
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === n;
      if (!isDirectCallee && !isInstallTarget) valueReadNames.add(n.name.text);
    }
    if (ts.isIdentifier(n)) {
      const sym = symOf(n);
      const nodeId = sym ? nodeIdBySymbol.get(sym) : undefined;
      if (nodeId !== undefined && !isAllowedCallableRef(n)) {
        const node = nodes.get(nodeId);
        if (node) node.poisoned = true; // value escaped — unseen call/construct sites possible
      }
    }
    forEachChild(n, scan);
  };
  scan(sourceFile);

  // ── 4. Materialize write-once method nodes ────────────────────────────────
  const methodNodesByName = new Map<string, GraphNode[]>();
  const staticMethodNode = new Map<string, GraphNode>(); // "<ownerId> <name>"
  if (!poisonAllMethods) {
    for (const [key, state] of methodWrites) {
      if (state.bad || !state.decl) continue;
      const [ownerId, space, name] = key.split(" ") as [IrUnitId, "static" | "proto", string];
      if ((space === "proto" ? protoPoisoned : staticPoisoned).has(ownerId)) continue;
      if (space === "proto" && runtimeDefinedProtoKeys.get(ownerId)?.has(name)) continue;
      if (valueReadNames.has(name)) continue; // method value may escape → unseen dispatch
      const id = mkId();
      const node: GraphNode = {
        id,
        kind: space === "proto" ? "proto-method" : "static-method",
        name,
        ownerId,
        fn: state.decl,
        poisoned: false,
      };
      nodes.set(id, node);
      nodeIdByFn.set(state.decl, id);
      const arr = methodNodesByName.get(name);
      if (arr) arr.push(node);
      else methodNodesByName.set(name, [node]);
      if (space === "static") staticMethodNode.set(`${ownerId} ${name}`, node);
    }
  }

  // ── 5. Edges ──────────────────────────────────────────────────────────────
  const scopeChainOf = (site: ts.Node): ts.SignatureDeclaration[] => {
    const chain: ts.SignatureDeclaration[] = [];
    for (let cur: ts.Node | undefined = site.parent; cur !== undefined; cur = cur.parent) {
      if (isFunctionLikeNode(cur)) chain.unshift(cur);
    }
    return chain;
  };

  /** Nearest `this`-binding enclosing function (arrows are transparent). */
  const enclosingThisBinder = (site: ts.Node): ts.Node | undefined => {
    for (let cur: ts.Node | undefined = site.parent; cur !== undefined; cur = cur.parent) {
      if (ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur)) return cur;
      if (
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur) ||
        ts.isGetAccessor(cur) ||
        ts.isSetAccessor(cur)
      ) {
        return cur; // class semantics — `this` is never a fnctor in this population
      }
    }
    return undefined;
  };

  const edges: Edge[] = [];
  const addEdge = (callee: IrUnitId, site: ts.CallExpression | ts.NewExpression): void => {
    edges.push({
      callee,
      argExprs: site.arguments === undefined ? [] : site.arguments.slice(),
      scopeChain: scopeChainOf(site),
    });
  };

  const methodTargets = (name: string, receiver: ts.Expression): readonly GraphNode[] => {
    const recv = unwrap(receiver);
    if (ts.isIdentifier(recv)) {
      const sym = symOf(recv);
      const ctorId = sym ? nodeIdBySymbol.get(sym) : undefined;
      if (ctorId !== undefined) {
        // The receiver IS the constructor object — only its own static slot.
        const target = staticMethodNode.get(`${ctorId} ${name}`);
        return target ? [target] : [];
      }
    }
    return methodNodesByName.get(name) ?? [];
  };

  for (const call of callSites) {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) {
      const sym = symOf(callee);
      const target = sym ? nodeIdBySymbol.get(sym) : undefined;
      if (target !== undefined) addEdge(target, call);
      continue;
    }
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

  for (const site of newSites) {
    const callee = unwrap(site.expression);
    if (ts.isIdentifier(callee)) {
      const sym = symOf(callee);
      const target = sym ? nodeIdBySymbol.get(sym) : undefined;
      if (target !== undefined) addEdge(target, site);
      continue;
    }
    if (callee.kind !== ts.SyntaxKind.ThisKeyword) continue; // other shapes construct only escaped (already-poisoned) values
    const binder = enclosingThisBinder(site);
    if (binder === undefined) continue; // top-level `new this` — never a fnctor
    if (
      ts.isMethodDeclaration(binder) ||
      ts.isConstructorDeclaration(binder) ||
      ts.isGetAccessor(binder) ||
      ts.isSetAccessor(binder)
    ) {
      continue; // class member — `this` is the class, outside this population
    }
    const binderNodeId = nodeIdByFn.get(binder);
    const binderNode = binderNodeId !== undefined ? nodes.get(binderNodeId) : undefined;
    if (binderNode?.kind === "static-method" && binderNode.ownerId !== undefined) {
      addEdge(binderNode.ownerId, site); // `this` === the owner constructor
      continue;
    }
    if (binderNode?.kind === "proto-method") continue; // `this` is an instance — not constructable here
    // `new this` in a plain function or a demoted method: `this` could be
    // rebound to ANY constructor via .call/.apply — no ctor fact is safe.
    poisonAllCtors = true;
  }

  if (poisonAllCtors) return new Map();

  // ── 6. Fixpoint (propagate.ts lattice core) ───────────────────────────────
  const entries = new Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>();
  const seeds = new Map<IrUnitId, { params: LatticeType[]; returnType: LatticeType }>();
  for (const node of nodes.values()) {
    const params = node.fn.parameters.map((p) => (node.poisoned ? core.DYNAMIC : core.seedParamType(p, checker)));
    const returnType = node.poisoned ? core.DYNAMIC : core.seedReturnType(node.fn, checker);
    seeds.set(node.id, { params, returnType });
    entries.set(node.id, { params: [...params], returnType });
  }

  const resolver = (identifier: ts.Identifier): IrUnitId | undefined => {
    const sym = symOf(identifier);
    return sym ? nodeIdBySymbol.get(sym) : undefined;
  };

  const inbound = new Map<IrUnitId, Edge[]>();
  for (const edge of edges) {
    const arr = inbound.get(edge.callee);
    if (arr) arr.push(edge);
    else inbound.set(edge.callee, [edge]);
  }

  const buildScope = (chain: readonly ts.SignatureDeclaration[]): Map<string, LatticeType> => {
    const scope = new Map<string, LatticeType>();
    for (const fnLike of chain) {
      const nodeId = nodeIdByFn.get(fnLike);
      const entry = nodeId !== undefined ? entries.get(nodeId) : undefined;
      const params = fnLike.parameters;
      for (let i = 0; i < params.length; i++) {
        const p = params[i]!;
        if (ts.isIdentifier(p.name)) scope.set(p.name.text, entry ? (entry.params[i] ?? core.DYNAMIC) : core.DYNAMIC);
      }
    }
    return scope;
  };

  const MAX_ITERS = 50;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let changed = false;
    for (const node of nodes.values()) {
      if (node.poisoned) continue;
      const cur = entries.get(node.id)!;
      const seed = seeds.get(node.id)!;
      const newParams = seed.params.map((t) => t);
      for (const site of inbound.get(node.id) ?? []) {
        const scope = buildScope(site.scopeChain);
        for (let i = 0; i < newParams.length && i < site.argExprs.length; i++) {
          newParams[i] = core.join(newParams[i]!, core.inferExpr(site.argExprs[i]!, scope, entries, resolver));
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
        core.walkBodyForReturns(node.fn.body, ownScope, entries, resolver, (t) => {
          if (seedConcrete && t.kind === "dynamic") return;
          newReturn = core.join(newReturn, t);
        });
      }
      if (!core.paramsEqual(cur.params, newParams) || !core.typesEqual(cur.returnType, newReturn)) {
        entries.set(node.id, { params: newParams, returnType: newReturn });
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ── 7. Output: per-callable param facts, unique names only ────────────────
  const nameCounts = new Map<string, number>();
  for (const node of nodes.values()) {
    if (node.kind === "callable") nameCounts.set(node.name, (nameCounts.get(node.name) ?? 0) + 1);
  }
  const out = new Map<string, readonly LatticeType[]>();
  for (const node of nodes.values()) {
    if (node.kind !== "callable" || node.poisoned || nameCounts.get(node.name) !== 1) continue;
    out.set(node.name, entries.get(node.id)!.params);
  }
  return out;
}
