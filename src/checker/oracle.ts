// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1930) TypeOracle — the ONE type-query boundary between the TypeScript
 * checker and codegen.
 *
 * Design contract (agreed with #2134/#2135 owners, recorded in
 * plan/issues/1930-typeoracle-type-query-boundary.md "Agreed seams"):
 *
 *  - **Registry-free facts** (Constraint A): every answer is a pure function
 *    of `(checker, AST node)`. Answers NEVER depend on `ctx.mod`,
 *    `ctx.structFields`, or any codegen registry — so the oracle returns
 *    identical answers at ANY pipeline position (load-bearing for #2138's
 *    IR-first hoist). `ValType` is registry-coupled (`typeIdx`); the oracle
 *    therefore speaks `TypeFact`, and the codegen-side adapter maps facts to
 *    `ValType` WITH registration in the codegen lane.
 *  - **Query-only** (Constraint B): no side effects. Registration
 *    (`ensureStructForType`, `getOrRegisterVecType`) is the CALLER's job.
 *  - **No `ts.Type` escapes**: neither parameters nor results of the public
 *    surface expose checker objects (the TS7 `LspOracle` cannot produce them).
 *  - **Memoized**: per-node WeakMap caches — the June-audit "type info
 *    gathered four times" theme dies here.
 *
 * v1 implements the primitive/classification subset the Slice-1 pilot and
 * the #2104 boxing thin-slice need; the FROZEN surface below is the full
 * design (see the issue file, section D3). Unimplemented depth returns
 * `{ kind: "unresolvable" }` / `undefined` — never a guess.
 */
import { ts } from "../ts-api.js";

/** JS runtime tag classification (aligned with the #2104 JsTag module). */
export type JsTag = "number" | "string" | "boolean" | "bigint" | "symbol" | "undefined" | "object" | "function";

export interface SignatureFact {
  params: TypeFact[];
  returns: TypeFact;
  declaredArity: number;
}

export interface ShapeFact {
  props: { name: string; fact: TypeFact }[];
}

/**
 * Registry-free type facts. Strictly ABOVE ValType: nothing here indexes a
 * Wasm module type table.
 */
export type TypeFact =
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "string" }
  | { kind: "bigint" }
  | { kind: "symbol" }
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "void" }
  | { kind: "array"; element: TypeFact }
  | { kind: "tuple"; elements: TypeFact[] }
  | { kind: "function"; signature?: SignatureFact }
  | { kind: "class"; name: string }
  | { kind: "builtin"; name: string }
  | { kind: "object"; shape?: ShapeFact }
  | { kind: "union"; parts: TypeFact[]; nullable: boolean; undefinable: boolean }
  | { kind: "any" }
  | { kind: "unknown" }
  | { kind: "unresolvable" };

/**
 * Opaque type-identity token replacing `ts.Type`-as-Map-key uses
 * (`anonTypeMap`, `objectHashConsumerTypes`). Interning contract: two nodes
 * whose checker types are the SAME `ts.Type` object yield the SAME token
 * (`===`); distinct type objects yield distinct tokens. (Slice 5 consumes
 * this; defined now so the surface is frozen.)
 */
export type OracleTypeKey = symbol & { readonly __brand: "OracleTypeKey" };

export interface TypeOracle {
  /** The workhorse: the registry-free fact for a node's type. */
  typeFactOf(node: ts.Node): TypeFact;
  /** Static JS runtime tag of an expression, or "mixed" when not static. */
  staticJsTypeOf(expr: ts.Expression): JsTag | "mixed";
  /** Does this expression statically produce a boolean? (Slice 3 deepens
   *  this with the expression-kernel analysis; v1 is checker-type-based.) */
  isBooleanProducing(expr: ts.Expression): boolean;
  /** Union-aware nullability of the node's type. */
  nullabilityOf(node: ts.Node): { nullable: boolean; undefinable: boolean };
  /** Union member facts (undefined when the type is not a union). */
  unionPartsOf(node: ts.Node): TypeFact[] | undefined;
  /** Call signature fact (undefined when not callable / not resolvable). */
  signatureOf(node: ts.Node): SignatureFact | undefined;
  /** Fact for property `name` on the node's type. */
  propertyFactOf(node: ts.Node, name: string): TypeFact;
  /** Element fact for arrays/tuples. */
  elementFactOf(node: ts.Node): TypeFact;
  /** Contextual (expected) type fact at an expression position. */
  contextualFactOf(expr: ts.Expression): TypeFact | undefined;
  /** Builtin receiver classification (Date/Promise/RegExp/…): the nominal
   *  builtin name, or undefined. Standardizes the `symName !== "Date"`-class
   *  gates (#2767 family). */
  builtinReceiverOf(node: ts.Node): string | undefined;
  /**
   * (#4016) Does this node's type carry the WELL-KNOWN SYMBOL member
   * `[Symbol.<name>]`? Three-valued on purpose:
   *
   *   - `true`      the member is present (e.g. `RegExp` carries all five of
   *                 `@@match`/`@@matchAll`/`@@replace`/`@@search`/`@@split`);
   *   - `false`     PROVABLY absent — every constituent of the type was
   *                 resolvable and none declared the member;
   *   - `undefined` unknowable (`any` / `unknown` / a union with such a part).
   *
   * The distinction is load-bearing for the §22.1.3 `String.prototype`
   * search-value dispatch: only a **provable** `false` licenses lowering the
   * spec's plain-`ToString` path, because a value that MIGHT carry `@@split`
   * must reach the symbol-protocol dispatch instead. `undefined` and `true`
   * are both "do not take the ToString shortcut".
   *
   * This is a genuine type-shape fact, not a `ts.Type` identity leak: the
   * answer is a tri-state boolean and no checker object escapes. It lives here
   * rather than at the call site precisely so `src/codegen/**` need not reach
   * for the raw checker (#1930 / #3273).
   */
  wellKnownSymbolMemberOf(node: ts.Node, name: string): boolean | undefined;
  /** Stable identity token for the node's checker type (Slice 5). */
  typeKeyOf(node: ts.Node): OracleTypeKey;
  /** Declared type NAME when the node's type has a named symbol. */
  declaredNameOf(node: ts.Node): string | undefined;
  /** Whether an identifier has no value binding in the checker environment. */
  isUnresolvableIdentifier(id: ts.Identifier): boolean;
  /**
   * (#869) Immutable-`const` binding resolution for compile-time default-param
   * folding. If `id` is an identifier that references a `const` variable
   * declaration with an initializer, returns that initializer expression;
   * otherwise `undefined`. Deliberately excludes `let`/`var` (reassignable — a
   * default that reads them must observe the CALL-TIME value, §10.2.11),
   * ambient/uninitialized consts, destructuring-bound consts, and non-variable
   * bindings (parameters, enum members, functions). Returns an AST node, not a
   * `ts.Type`, so it honors the no-checker-object-escapes contract.
   */
  constInitializerOf(id: ts.Node): ts.Expression | undefined;
  /**
   * Initializer for a plain identifier variable binding (`const`/`let`/`var`).
   * This is the binding-resolution seam for analyses that separately prove
   * single assignment and therefore must not narrow the query to `const`.
   */
  variableInitializerOf(id: ts.Node): ts.Expression | undefined;
  /**
   * Value declaration for an identifier binding. Returning the AST declaration
   * keeps declaration-source and binding-identity proofs inside the oracle
   * boundary without exposing the checker Symbol.
   */
  valueDeclarationOf(id: ts.Node): ts.Declaration | undefined;
  /** All declarations for an exact binding, without exposing its Symbol. */
  declarationsOf(node: ts.Node): readonly ts.Declaration[];
  /**
   * Variable declaration for a plain identifier binding. Returning the AST
   * declaration (rather than the checker Symbol) keeps binding-identity
   * queries inside the oracle boundary while allowing callers to inspect
   * declaration syntax such as `var` versus `let`/`const`.
   */
  variableDeclarationOf(id: ts.Node): ts.VariableDeclaration | undefined;
}

/** Builtins with first-class compiler handling (mirrors type-mapper's set —
 *  will be unified with it in Slice 2 when type-mapper folds in). */
export const BUILTIN_NAMES = new Set([
  "Array",
  "ArrayBuffer",
  "DataView",
  "Date",
  "Error",
  "Function",
  "Generator",
  "Iterable",
  "IterableIterator",
  "Iterator",
  "JSON",
  "Map",
  "Math",
  "Promise",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "Symbol",
  "WeakMap",
  "WeakSet",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * The checker-backed oracle (today's lane). A future `LspOracle` (TS7,
 * #1029) implements the same interface over
 * `src/checker/language-service.ts` without `createProgram`.
 */
export class TsCheckerOracle implements TypeOracle {
  private readonly factCache = new WeakMap<ts.Node, TypeFact>();
  private readonly keyCache = new WeakMap<object, OracleTypeKey>();
  // (#4218 P1) Declaration-resolution queries are the hottest surface after
  // the lib-walk removal (binding helpers call them per identifier READ, so
  // the same node recurs many times per compile). Memoize per node like
  // typeFactOf; `null` records a resolved-to-nothing answer so misses are
  // cached too.
  private readonly valueDeclCache = new WeakMap<ts.Node, ts.Declaration | null>();
  private readonly declarationsCache = new WeakMap<ts.Node, readonly ts.Declaration[]>();
  private keyCounter = 0;

  constructor(private readonly checker: ts.TypeChecker) {}

  typeFactOf(node: ts.Node): TypeFact {
    const cached = this.factCache.get(node);
    if (cached) return cached;
    let fact: TypeFact;
    try {
      const t = this.checker.getTypeAtLocation(node);
      fact = t ? this.factOfType(t, 0) : { kind: "unresolvable" };
    } catch {
      fact = { kind: "unresolvable" };
    }
    this.factCache.set(node, fact);
    return fact;
  }

  staticJsTypeOf(expr: ts.Expression): JsTag | "mixed" {
    const fact = this.typeFactOf(expr);
    return jsTagOfFact(fact) ?? "mixed";
  }

  isBooleanProducing(expr: ts.Expression): boolean {
    return this.typeFactOf(expr).kind === "boolean";
  }

  nullabilityOf(node: ts.Node): { nullable: boolean; undefinable: boolean } {
    const fact = this.typeFactOf(node);
    if (fact.kind === "union") return { nullable: fact.nullable, undefinable: fact.undefinable };
    return {
      nullable: fact.kind === "null",
      undefinable: fact.kind === "undefined" || fact.kind === "void",
    };
  }

  unionPartsOf(node: ts.Node): TypeFact[] | undefined {
    const fact = this.typeFactOf(node);
    return fact.kind === "union" ? fact.parts : undefined;
  }

  signatureOf(node: ts.Node): SignatureFact | undefined {
    try {
      const t = this.checker.getTypeAtLocation(node);
      const sig = t?.getCallSignatures?.()[0];
      if (!sig) return undefined;
      return {
        params: sig.parameters.map((p) => {
          const d = p.valueDeclaration;
          return d ? this.typeFactOf(d) : ({ kind: "unresolvable" } as TypeFact);
        }),
        returns: this.factOfType(this.checker.getReturnTypeOfSignature(sig), 0),
        declaredArity: sig.parameters.length,
      };
    } catch {
      return undefined;
    }
  }

  propertyFactOf(node: ts.Node, name: string): TypeFact {
    try {
      const t = this.checker.getTypeAtLocation(node);
      const prop = t?.getProperty?.(name);
      if (!prop) return { kind: "unresolvable" };
      const pt = this.checker.getTypeOfSymbol(prop);
      return pt ? this.factOfType(pt, 0) : { kind: "unresolvable" };
    } catch {
      return { kind: "unresolvable" };
    }
  }

  elementFactOf(node: ts.Node): TypeFact {
    const fact = this.typeFactOf(node);
    if (fact.kind === "array") return fact.element;
    if (fact.kind === "tuple") return fact.elements[0] ?? { kind: "unresolvable" };
    return { kind: "unresolvable" };
  }

  contextualFactOf(expr: ts.Expression): TypeFact | undefined {
    try {
      const t = this.checker.getContextualType(expr);
      return t ? this.factOfType(t, 0) : undefined;
    } catch {
      return undefined;
    }
  }

  builtinReceiverOf(node: ts.Node): string | undefined {
    const fact = this.typeFactOf(node);
    return fact.kind === "builtin" ? fact.name : undefined;
  }

  wellKnownSymbolMemberOf(node: ts.Node, name: string): boolean | undefined {
    try {
      const t = this.checker.getTypeAtLocation(node);
      return t ? this.wellKnownSymbolOnType(t, name, 0) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * (#4016) Recursive worker for {@link wellKnownSymbolMemberOf}.
   *
   * TypeScript models a `[Symbol.foo]` member as a late-bound property whose
   * ESCAPED name is `__@foo@<declId>` (the trailing id disambiguates distinct
   * `unique symbol` declarations); older/ambient shapes can appear as bare
   * `__@foo`. Both spellings are matched. A union answers `true` if ANY
   * constituent carries the member (the runtime value could be that one) and
   * `undefined` if any constituent was itself unknowable.
   */
  private wellKnownSymbolOnType(t: ts.Type, name: string, depth: number): boolean | undefined {
    if (depth > 6) return undefined;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
    if (t.isUnion?.()) {
      let unknowable = false;
      for (const part of (t as ts.UnionType).types) {
        const answer = this.wellKnownSymbolOnType(part, name, depth + 1);
        if (answer === true) return true;
        if (answer === undefined) unknowable = true;
      }
      return unknowable ? undefined : false;
    }
    let props: readonly ts.Symbol[];
    try {
      props = this.checker.getPropertiesOfType(t);
    } catch {
      return undefined;
    }
    const suffixed = `__@${name}@`;
    const bare = `__@${name}`;
    for (const prop of props) {
      const escaped = prop.escapedName as string;
      if (escaped === bare || escaped.startsWith(suffixed)) return true;
    }
    return false;
  }

  typeKeyOf(node: ts.Node): OracleTypeKey {
    const t = this.checker.getTypeAtLocation(node) as unknown as object;
    let key = this.keyCache.get(t);
    if (!key) {
      key = Symbol(`oracle-type-${this.keyCounter++}`) as OracleTypeKey;
      this.keyCache.set(t, key);
    }
    return key;
  }

  isUnresolvableIdentifier(id: ts.Identifier): boolean {
    try {
      return this.checker.getSymbolAtLocation(id) === undefined;
    } catch {
      return true;
    }
  }

  declaredNameOf(node: ts.Node): string | undefined {
    try {
      const t = this.checker.getTypeAtLocation(node);
      const name = t?.symbol?.name ?? t?.aliasSymbol?.name;
      return name && name !== "__type" && name !== "__object" ? name : undefined;
    } catch {
      return undefined;
    }
  }

  constInitializerOf(id: ts.Node): ts.Expression | undefined {
    try {
      if (!ts.isIdentifier(id)) return undefined;
      const sym = this.checker.getSymbolAtLocation(id);
      const decl = sym?.valueDeclaration;
      // Must be a `const` variable declaration with an initializer, bound to a
      // plain identifier (not a destructuring pattern).
      if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
      if (!ts.isIdentifier(decl.name)) return undefined;
      const list = decl.parent;
      if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return undefined;
      return decl.initializer;
    } catch {
      return undefined;
    }
  }

  variableInitializerOf(id: ts.Node): ts.Expression | undefined {
    return this.variableDeclarationOf(id)?.initializer;
  }

  variableDeclarationOf(id: ts.Node): ts.VariableDeclaration | undefined {
    try {
      const decl = this.valueDeclarationOf(id);
      if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) {
        return undefined;
      }
      return decl;
    } catch {
      return undefined;
    }
  }

  valueDeclarationOf(id: ts.Node): ts.Declaration | undefined {
    const cached = this.valueDeclCache.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const resolved = this.valueDeclarationOfUncached(id);
    this.valueDeclCache.set(id, resolved ?? null);
    return resolved;
  }

  private valueDeclarationOfUncached(id: ts.Node): ts.Declaration | undefined {
    try {
      if (!ts.isIdentifier(id)) return undefined;
      // A shorthand assignment (`{ value }`) has a synthetic property symbol
      // at the identifier location. Resolve the value-side binding instead so
      // callers get the declaration that JavaScript actually reads.
      const sym =
        id.parent && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
          ? (
              this.checker as unknown as {
                getShorthandAssignmentValueSymbol?: (node: ts.Node) => ts.Symbol | undefined;
              }
            ).getShorthandAssignmentValueSymbol?.(id.parent)
          : this.checker.getSymbolAtLocation(id);
      return sym?.valueDeclaration ?? sym?.declarations?.[0];
    } catch {
      return undefined;
    }
  }

  declarationsOf(node: ts.Node): readonly ts.Declaration[] {
    const cached = this.declarationsCache.get(node);
    if (cached) return cached;
    let decls: readonly ts.Declaration[];
    try {
      decls = [...(this.checker.getSymbolAtLocation(node)?.declarations ?? [])];
    } catch {
      decls = [];
    }
    this.declarationsCache.set(node, decls);
    return decls;
  }

  /** Internal: classify a checker type into a registry-free fact. */
  private factOfType(t: ts.Type, depth: number): TypeFact {
    if (depth > 6) return { kind: "unresolvable" };
    const f = t.flags;
    if (f & ts.TypeFlags.Any) return { kind: "any" };
    if (f & ts.TypeFlags.Unknown) return { kind: "unknown" };
    if (f & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return { kind: "number" };
    if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return { kind: "boolean" };
    if (f & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) return { kind: "string" };
    if (f & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return { kind: "bigint" };
    if (f & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return { kind: "symbol" };
    if (f & ts.TypeFlags.Undefined) return { kind: "undefined" };
    if (f & ts.TypeFlags.Null) return { kind: "null" };
    if (f & ts.TypeFlags.Void) return { kind: "void" };
    if (t.isUnion?.()) {
      const rawParts = (t as ts.UnionType).types;
      let nullable = false;
      let undefinable = false;
      const parts: TypeFact[] = [];
      for (const p of rawParts) {
        if (p.flags & ts.TypeFlags.Null) {
          nullable = true;
          continue;
        }
        if (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
          undefinable = true;
          continue;
        }
        parts.push(this.factOfType(p, depth + 1));
      }
      // boolean literals present as a 2-part union true|false — collapse.
      if (parts.length > 0 && parts.every((p) => p.kind === "boolean")) {
        if (!nullable && !undefinable) return { kind: "boolean" };
      }
      return { kind: "union", parts, nullable, undefinable };
    }
    if (f & ts.TypeFlags.Object) {
      const checkerWithCollectionPredicates = this.checker as ts.TypeChecker & {
        isArrayType?: (type: ts.Type) => boolean;
        isTupleType?: (type: ts.Type) => boolean;
        getTypeArguments?: (type: ts.TypeReference) => readonly ts.Type[];
      };
      const typeArguments =
        checkerWithCollectionPredicates.getTypeArguments?.(t as ts.TypeReference) ??
        (t as ts.TypeReference).typeArguments ??
        [];
      if (checkerWithCollectionPredicates.isTupleType?.(t) === true) {
        return { kind: "tuple", elements: typeArguments.map((element) => this.factOfType(element, depth + 1)) };
      }
      if (checkerWithCollectionPredicates.isArrayType?.(t) === true) {
        const element = typeArguments[0];
        return { kind: "array", element: element ? this.factOfType(element, depth + 1) : { kind: "any" } };
      }
      const name = t.symbol?.name;
      if (name && BUILTIN_NAMES.has(name)) {
        if (name === "Array") {
          const elem = typeArguments[0];
          return { kind: "array", element: elem ? this.factOfType(elem, depth + 1) : { kind: "any" } };
        }
        return { kind: "builtin", name };
      }
      if (t.getCallSignatures?.().length > 0 || t.getConstructSignatures?.().length > 0) return { kind: "function" };
      if (name && name !== "__type" && name !== "__object") return { kind: "class", name };
      return { kind: "object" };
    }
    return { kind: "unresolvable" };
  }
}

/**
 * (#1930 Slice 3 — the Q-TAG syntactic spine) Does this expression
 * SYNTACTICALLY produce a JS boolean? THE single definition of the
 * boolean-producing spine, extracted verbatim from `declarations.ts`'s
 * `isBooleanExpr` kernel-fixpoint closure (#2795) so future edits happen in
 * one place. The accept-set is EXACTLY the extracted matcher's:
 *
 *   - `true` / `false` literals
 *   - `!x` (boolean regardless of operand)
 *   - relational / equality binaries (`< <= > >= == === != !==`) and
 *     `instanceof` / `in`
 *   - `&&` / `||` when BOTH operands qualify
 *   - ternary when BOTH branches qualify
 *   - a call `f(...)` when `isBooleanCallable(f)` says so (the kernel
 *     fixpoint passes live membership of its boolean-kernel set; the default
 *     recognizes only `Boolean(x)`)
 *   - parenthesized / `as` / non-null / type-assertion wrappers recurse
 *
 * Pure function of (AST, hook) — Constraint-A-clean: the hook is an explicit
 * input, so the fixpoint's evolving candidate set stays with its owner.
 * Deliberately SEPARATE from `TypeOracle.isBooleanProducing` (the
 * checker-fact lane): merging them would newly brand kernels whose returns
 * are checker-typed-boolean identifiers the syntactic spine rejects (e.g. a
 * `: boolean` param read) — a behavior change needing its own measured slice
 * (recorded as verdict V6 in the issue's divergence table).
 */
export function isSyntacticallyBooleanExpr(
  expr: ts.Expression,
  isBooleanCallable: (name: string) => boolean = (name) => name === "Boolean",
  depth = 0,
): boolean {
  if (depth > 64) return false;
  if (ts.isParenthesizedExpression(expr)) {
    return isSyntacticallyBooleanExpr(expr.expression, isBooleanCallable, depth + 1);
  }
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
    return isSyntacticallyBooleanExpr(expr.expression, isBooleanCallable, depth + 1);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPrefixUnaryExpression(expr)) {
    // `!x` is boolean regardless of operand type.
    return expr.operator === ts.SyntaxKind.ExclamationToken;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.InstanceOfKeyword ||
      op === ts.SyntaxKind.InKeyword
    ) {
      return true;
    }
    // `&&` / `||` are boolean only when BOTH operands are boolean.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return (
        isSyntacticallyBooleanExpr(expr.left, isBooleanCallable, depth + 1) &&
        isSyntacticallyBooleanExpr(expr.right, isBooleanCallable, depth + 1)
      );
    }
    return false;
  }
  if (ts.isConditionalExpression(expr)) {
    return (
      isSyntacticallyBooleanExpr(expr.whenTrue, isBooleanCallable, depth + 1) &&
      isSyntacticallyBooleanExpr(expr.whenFalse, isBooleanCallable, depth + 1)
    );
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return isBooleanCallable(expr.expression.text);
  }
  return false;
}

/** Fact → static JS tag, when unambiguous. */
export function jsTagOfFact(fact: TypeFact): JsTag | undefined {
  switch (fact.kind) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "undefined":
    case "void":
      return "undefined";
    case "null":
    case "array":
    case "tuple":
    case "object":
    case "builtin":
    case "class":
      return "object";
    case "function":
      return "function";
    default:
      return undefined;
  }
}
