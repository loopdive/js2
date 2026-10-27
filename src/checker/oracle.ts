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
import { symbolShadowsBuiltinGlobal } from "./builtin-shadow.js"; // (#5096) intrinsic-shadow claim gate

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
  /**
   * Value declaration for an identifier binding, resolved THROUGH import
   * aliases. `valueDeclarationOf` stops at the `import` clause/specifier that
   * introduced the name, which hides what the imported module actually binds;
   * this variant follows the alias to the declaration the exporting module
   * wrote (`var isArray = Array.isArray` behind `import isArray from
   * "lodash/isArray.js"`). Non-alias bindings answer exactly as
   * `valueDeclarationOf` does.
   */
  aliasedValueDeclarationOf(id: ts.Node): ts.Declaration | undefined;
  /** All declarations for an exact binding, without exposing its Symbol. */
  declarationsOf(node: ts.Node): readonly ts.Declaration[];
  /**
   * Variable declaration for a plain identifier binding. Returning the AST
   * declaration (rather than the checker Symbol) keeps binding-identity
   * queries inside the oracle boundary while allowing callers to inspect
   * declaration syntax such as `var` versus `let`/`const`.
   */
  variableDeclarationOf(id: ts.Node): ts.VariableDeclaration | undefined;
  /**
   * (#7156) The string keys a `for (k in <expr>)` over a CLOSED static shape
   * enumerates, in enumeration order — the key list the static for-in unroll
   * emits. A receiver that is provably a `new C(…)` of a simple class chain
   * yields only its own fields (parameter properties, then fields, base class
   * first, integer-index keys ahead); private names, methods, accessors and
   * statics are dropped. An object literal with a spread is ordered as the
   * literal builds it (`{...a, z}` is `a`'s keys, then `z`). Everything else
   * keeps the checker's property list and order. `undefined` when this backend
   * cannot answer.
   */
  forInStaticKeysOf(expr: ts.Expression): readonly string[] | undefined;
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

  forInStaticKeysOf(expr: ts.Expression): readonly string[] | undefined {
    try {
      return this.forInKeysOfExpr(expr, 0);
    } catch {
      return undefined;
    }
  }

  private forInKeysOfExpr(expr: ts.Expression, depth: number): readonly string[] {
    let e = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    const typeKeys = (): readonly string[] =>
      forInKeysOfType(this.checker, this.checker.getTypeAtLocation(expr), this.isProvableNewInstance(e));
    if (depth > 8) return typeKeys();
    const literal = ts.isIdentifier(e) ? this.constInitializerOf(e) : e;
    if (!literal || !ts.isObjectLiteralExpression(literal) || !literal.properties.some(ts.isSpreadAssignment)) {
      return typeKeys();
    }
    // `{...a, z}`: the checker's spread type lists the literal's own members
    // first, but the object is built left to right and a redefined key keeps
    // its first position. Use that order when every member name is static and
    // the resulting set is exactly the checker's; otherwise keep the checker's.
    const keys: string[] = [];
    for (const prop of literal.properties) {
      const names = ts.isSpreadAssignment(prop)
        ? this.forInKeysOfExpr(prop.expression, depth + 1)
        : [staticMemberName(prop.name)];
      for (const name of names) {
        if (name === undefined) return typeKeys();
        if (!keys.includes(name)) keys.push(name);
      }
    }
    const checkerKeys = typeKeys();
    if (keys.length !== checkerKeys.length || !checkerKeys.every((k) => keys.includes(k))) return checkerKeys;
    return keys;
  }

  /**
   * (#7156) Is this receiver provably an object built by its class's own
   * constructor? A `new C(…)` expression, or a `const` bound to one with no
   * type annotation or an annotation of exactly the constructed type. A
   * class-TYPED value proves nothing: TypeScript accepts an object literal, or
   * a subclass instance that turns a method into a field, for a class type.
   */
  private isProvableNewInstance(e: ts.Expression): boolean {
    const unwrap = (x: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(x) ? unwrap(x.expression) : x);
    if (ts.isNewExpression(e)) return true;
    if (!ts.isIdentifier(e)) return false;
    const init = this.constInitializerOf(e);
    if (!init || !ts.isNewExpression(unwrap(init))) return false;
    const decl = this.variableDeclarationOf(e);
    if (!decl) return false;
    return !decl.type || this.checker.getTypeAtLocation(decl.type) === this.checker.getTypeAtLocation(init);
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

  aliasedValueDeclarationOf(id: ts.Node): ts.Declaration | undefined {
    try {
      if (!ts.isIdentifier(id)) return undefined;
      const sym =
        id.parent && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
          ? (
              this.checker as unknown as {
                getShorthandAssignmentValueSymbol?: (node: ts.Node) => ts.Symbol | undefined;
              }
            ).getShorthandAssignmentValueSymbol?.(id.parent)
          : this.checker.getSymbolAtLocation(id);
      if (sym === undefined) return undefined;
      const resolved = (sym.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(sym) : sym;
      return resolved?.valueDeclaration ?? resolved?.declarations?.[0];
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
    if (f & ts.TypeFlags.StringLike) return { kind: "string" }; // (#6868) incl. template-literal / string-mapping types
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
      // (#5096) The `BUILTIN_NAMES` match is a NAME claim, so it must not
      // outrank the binding the name actually resolves to. `class Map { … }`
      // gives its own symbol the name `"Map"`, so this arm answered
      // `{kind:"builtin", name:"Map"}` for the user class's own constructor —
      // and `isFreshlyConstructedNonCallable` reads a `builtin` fact as
      // "carries no [[Construct]]", so `new Map()` compiled to a hard
      // `TypeError: Map is not a constructor`. Consult the declaration first:
      // only the AMBIENT intrinsic keeps the builtin fact; a user binding of
      // the same spelling falls through to the ordinary
      // construct-signature / class classification two lines below, which is
      // exactly what an unshadowed name of any other spelling already gets.
      if (name && BUILTIN_NAMES.has(name) && !symbolShadowsBuiltinGlobal(t.symbol)) {
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

/** (#7156) A member name that is a plain identifier or string literal. */
function staticMemberName(name: ts.Node | undefined): string | undefined {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/** (#7156) A canonical array-index key: "0".."4294967294", no leading zeros. */
function isArrayIndexKey(key: string): boolean {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === key;
}

/** (#7156) The class (interface) type behind a class-instance type, else undefined. */
function classTargetOf(t: ts.Type): ts.InterfaceType | undefined {
  const objectFlags = (t as ts.ObjectType).objectFlags ?? 0;
  const target = objectFlags & ts.ObjectFlags.Reference ? (t as ts.TypeReference).target : t;
  return ((target as ts.ObjectType).objectFlags ?? 0) & ts.ObjectFlags.Class ? (target as ts.InterfaceType) : undefined;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

/**
 * (#7156) The property key a member name denotes, when it is fully understood:
 * a plain, string or numeric name, a `#private` name, or a computed key that is
 * a string/numeric literal or an identifier whose type is a string literal
 * (`const K = "k"`). `undefined` for anything else.
 */
function simpleMemberKey(checker: ts.TypeChecker, name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (!ts.isComputedPropertyName(name)) return undefined;
  const e = name.expression;
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isNumericLiteral(e)) return String(Number(e.text));
  if (!ts.isIdentifier(e)) return undefined;
  const t = checker.getTypeAtLocation(e);
  return t.isStringLiteral() ? t.value : undefined;
}

/**
 * (#7156) The member kinds a SIMPLE class may declare, classified as an
 * own-property `"field"` (a plain field or a parameter property), a
 * prototype-or-nothing `"other"` (method, accessor, auto-`accessor`, `#private`
 * member), or `undefined` when the member is not understood (`declare` or
 * `abstract` fields, non-literal computed keys).
 */
function simpleMemberKind(checker: ts.TypeChecker, member: ts.ClassElement): "field" | "other" | "static" | undefined {
  if (hasModifier(member, ts.SyntaxKind.StaticKeyword) || ts.isClassStaticBlockDeclaration(member)) return "static";
  if (
    ts.isConstructorDeclaration(member) ||
    ts.isSemicolonClassElement(member) ||
    ts.isIndexSignatureDeclaration(member)
  ) {
    return "other";
  }
  if (member.name && simpleMemberKey(checker, member.name) === undefined) return undefined;
  if (member.name && ts.isPrivateIdentifier(member.name)) return "other";
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
    return "other";
  }
  if (!ts.isPropertyDeclaration(member)) return undefined;
  if (hasModifier(member, ts.SyntaxKind.DeclareKeyword) || hasModifier(member, ts.SyntaxKind.AbstractKeyword))
    return undefined;
  return hasModifier(member, ts.SyntaxKind.AccessorKeyword) ? "other" : "field";
}

/**
 * (#7156) The own-field declarations of a SIMPLE class chain, base class first,
 * each class's parameter properties before its fields — or `undefined` when the
 * chain is not simple. Simple means: every class is a plain class declaration
 * (no interface/namespace merge), the chain ends at no base (not a builtin,
 * mixin or other non-class), every member is one `simpleMemberKind`
 * understands, and no name is a field in one class and a method/accessor in
 * another (a base field under a derived getter is still own at runtime).
 */
function simpleChainFieldDeclarations(checker: ts.TypeChecker, t: ts.Type): ts.Declaration[] | undefined {
  const perClass: ts.Declaration[][] = [];
  const kindOf = new Map<string, "field" | "other">();
  let cur: ts.Type | undefined = t;
  for (let depth = 0; cur; depth++) {
    const target = classTargetOf(cur);
    const decls = target?.symbol?.declarations ?? [];
    const decl = decls[0];
    if (!target || depth >= 32 || decls.length !== 1 || !decl || !ts.isClassLike(decl)) return undefined;
    const fields: ts.Declaration[] = [];
    const params: ts.Declaration[] = [];
    for (const member of decl.members) {
      const kind = simpleMemberKind(checker, member);
      if (kind === undefined) return undefined;
      if (kind === "static") continue;
      if (ts.isConstructorDeclaration(member) && member.body) {
        for (const param of member.parameters) if (ts.isParameterPropertyDeclaration(param, member)) params.push(param);
      }
      if (kind === "field") fields.push(member);
      if (!member.name || ts.isConstructorDeclaration(member)) continue;
      const key = simpleMemberKey(checker, member.name)!;
      if (kindOf.get(key) !== undefined && kindOf.get(key) !== kind) return undefined;
      kindOf.set(key, kind);
    }
    for (const param of params as ts.ParameterDeclaration[]) {
      const key = simpleMemberKey(checker, param.name);
      if (key === undefined) return undefined;
      if (kindOf.get(key) === "other") return undefined;
      kindOf.set(key, "field");
    }
    perClass.unshift([...params, ...fields]);
    cur = checker.getBaseTypes(target)[0];
  }
  return perClass.flat();
}

/**
 * (#7156) Static for-in keys of a checker type. A PROVABLE instance (see
 * `isProvableNewInstance`) whose whole class chain is simple
 * (`simpleChainFieldDeclarations`) enumerates exactly its own fields:
 * parameter properties, then fields, base class first, a redeclared field
 * keeping the base position; methods, accessors, statics and `#private` names
 * are dropped, names come from the checker's symbols so computed literal keys
 * keep their place, and integer-index keys go first in ascending order. ANY
 * other receiver or type, or a class chain with a member that is not
 * understood, keeps the checker's property list and order, exactly as before
 * #7156.
 */
function forInKeysOfType(checker: ts.TypeChecker, type: ts.Type, provableInstance: boolean): readonly string[] {
  const t = type.getNonNullableType();
  const props = t.getProperties();
  const checkerKeys = props.map((p) => p.name);
  if (!provableInstance || !classTargetOf(t)) return checkerKeys;
  const fieldDecls = simpleChainFieldDeclarations(checker, t);
  if (!fieldDecls) return checkerKeys;
  const fieldDeclSet = new Set<ts.Declaration>(fieldDecls);
  // Every checker property must be fully explained by the chain's members: a
  // field (kept) or a member that is not own (dropped). Anything else — a JS
  // `this.x = …` assignment, a lib member — keeps the checker's list.
  const nameOfDecl = new Map<ts.Declaration, string>();
  for (const p of props) {
    for (const d of p.declarations ?? []) nameOfDecl.set(d, p.name);
  }
  for (let cur: ts.Type | undefined = t; cur; ) {
    const target = classTargetOf(cur);
    if (!target) break;
    for (const p of cur.getProperties()) for (const d of p.declarations ?? []) nameOfDecl.set(d, p.name);
    cur = checker.getBaseTypes(target)[0];
  }
  const ordered: string[] = [];
  for (const d of fieldDecls) {
    const name = nameOfDecl.get(d);
    if (name === undefined || name.startsWith("__@")) return checkerKeys;
    if (!ordered.includes(name)) ordered.push(name);
  }
  for (const p of props) {
    const decls = p.declarations ?? [];
    if (decls.length === 0) return checkerKeys;
    const isField = decls.some((d) => fieldDeclSet.has(d));
    if (isField !== ordered.includes(p.name)) return checkerKeys;
    if (!isField && !decls.every((d) => ts.isClassElement(d) || ts.isParameter(d))) return checkerKeys;
  }
  if (!ordered.every((name) => checkerKeys.includes(name))) return checkerKeys;
  // OrdinaryOwnPropertyKeys: integer-index keys first, ascending, then the
  // string keys in creation order.
  const indices = ordered.filter(isArrayIndexKey).sort((x, y) => Number(x) - Number(y));
  return [...indices, ...ordered.filter((k) => !isArrayIndexKey(k))];
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
