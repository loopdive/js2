// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4218 kill order 1) Syntactic lib.d.ts declaration index + TypeNode mapper.
 *
 * The extern/global collection pre-pass (extern-declarations.ts) used to
 * resolve every lib.d.ts member through the TS5 `TypeChecker`
 * (`getTypeAtLocation`/`getSignatureFromDeclaration`/`getReturnTypeOfSignature`/
 * `getSymbolAtLocation`) — measured at ~254k checker calls per compile, 96 %
 * of the compiler's total checker traffic. Lib declaration files are FULLY
 * ANNOTATED by construction, so every one of those queries is answerable from
 * the syntax alone:
 *
 *  - member/param/return types are explicit `TypeNode`s;
 *  - declaration merging (`interface Date` across lib.es5/es2015/…) is a
 *    name-keyed index over the lib files in program order;
 *  - generic constraints (`getBaseConstraintOfType`) are the type parameter's
 *    declared `constraint` node, found lexically in the enclosing
 *    signature/interface/class;
 *  - type aliases (`type GLenum = number`) resolve through the same index.
 *
 * {@link mapLibTypeNodeToWasm} mirrors `mapTsTypeToWasm` (checker/type-mapper.ts)
 * decision-for-decision for the type shapes that occur in declaration files,
 * so the collected extern signatures — and therefore the emitted import/type
 * tables — stay byte-identical to the checker-driven walk. The user-file
 * collection path keeps the checker (user declares are input-driven and
 * cheap); only the lib-file walk passes an index.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { hasDeclareModifier } from "./ast-modifiers.js";

/** Mirror of checker/type-mapper.ts BUILTIN_TYPES — the wasm-native names that
 * must NOT be classified as extern classes via the `declare var X: XConstructor`
 * pattern. Kept in sync manually; the sets change together (#4218). */
const BUILTIN_TYPES = new Set([
  "Array",
  "Number",
  "Boolean",
  "String",
  "Object",
  "Function",
  "Symbol",
  "BigInt",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "ArrayBuffer",
  "DataView",
  "Date",
  "JSON",
  "Math",
  "Promise",
  "Generator",
  "Iterator",
  "IterableIterator",
  "Iterable",
  "IteratorResult",
  "IteratorYieldResult",
  "IteratorReturnResult",
]);

export interface LibDeclIndex {
  /** Merged `interface X` declarations by name, program order. */
  interfaces: Map<string, ts.InterfaceDeclaration[]>;
  /** `type X = …` aliases by name (first wins — lib aliases don't merge). */
  aliases: Map<string, ts.TypeAliasDeclaration>;
  /** Ambient `declare var X: …` by name (first wins). */
  vars: Map<string, ts.VariableDeclaration>;
  /** Ambient `declare class X` by name (first wins). */
  classes: Map<string, ts.ClassDeclaration>;
}

/**
 * Index the top-level ambient declarations of the given declaration files.
 * Called once per compile over the program's `lib.*.d.ts` source files, in
 * program order — the order determines declaration-merge order, which
 * determines member-collection order (first declaration wins on duplicates),
 * mirroring the checker's `symbol.getDeclarations()` order.
 */
export function buildLibDeclIndex(files: readonly ts.SourceFile[]): LibDeclIndex {
  const index: LibDeclIndex = {
    interfaces: new Map(),
    aliases: new Map(),
    vars: new Map(),
    classes: new Map(),
  };
  for (const sf of files) {
    for (const stmt of sf.statements) {
      if (ts.isInterfaceDeclaration(stmt)) {
        const list = index.interfaces.get(stmt.name.text);
        if (list) list.push(stmt);
        else index.interfaces.set(stmt.name.text, [stmt]);
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        if (!index.aliases.has(stmt.name.text)) index.aliases.set(stmt.name.text, stmt);
      } else if (ts.isVariableStatement(stmt) && hasDeclareModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && !index.vars.has(decl.name.text)) {
            index.vars.set(decl.name.text, decl);
          }
        }
      } else if (ts.isClassDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt)) {
        if (!index.classes.has(stmt.name.text)) index.classes.set(stmt.name.text, stmt);
      }
    }
  }
  return index;
}

/** Type-parameter scope: name → declared constraint node (undefined = unconstrained). */
export type TypeParamScope = Map<string, ts.TypeNode | undefined>;

/**
 * Collect the lexical type-parameter scope for a member: the member's own
 * type parameters plus those of the enclosing interface/class declarations.
 * Inner declarations shadow outer ones (set last).
 */
export function typeParamScopeOf(
  ...owners: readonly (
    | { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> | readonly ts.TypeParameterDeclaration[] }
    | undefined
  )[]
): TypeParamScope {
  const scope: TypeParamScope = new Map();
  // Outer-to-inner so inner shadows outer.
  for (let i = owners.length - 1; i >= 0; i--) {
    const tp = owners[i]?.typeParameters;
    if (!tp) continue;
    for (const p of tp) scope.set(p.name.text, p.constraint);
  }
  return scope;
}

const MAX_TYPE_DEPTH = 12;

/** Rightmost identifier text of a type reference name (Intl.Foo → "Foo"). */
export function typeRefName(name: ts.EntityName): string {
  return ts.isQualifiedName(name) ? name.right.text : name.text;
}

/**
 * Resolve a type NAME through non-generic alias chains
 * (`type WindowProxy = Window` → "Window"), mirroring how the checker's
 * symbol for an alias-typed declaration reports the ALIASED type's name.
 * Names that are not aliases (or generic aliases, or alias targets that are
 * not plain type references) resolve to themselves at the last step reached.
 * The merge-group park of PR #4481 traced to exactly this: `declare var
 * parent: WindowProxy` classified as non-extern because the alias was not
 * followed, silently dropping the `global_parent` host-import registration.
 */
export function resolveLibTypeName(name: string, index: LibDeclIndex, depth = 0): string {
  if (depth > MAX_TYPE_DEPTH) return name;
  const alias = index.aliases.get(name);
  if (!alias || (alias.typeParameters && alias.typeParameters.length > 0)) return name;
  const target = alias.type;
  if (!ts.isTypeReferenceNode(target)) return name;
  return resolveLibTypeName(typeRefName(target.typeName), index, depth + 1);
}

/** Identifier/rightmost name of a heritage `extends X<…>` expression, mirroring
 * the checker's `getTypeAtLocation → getSymbol().name` on the heritage ref. */
export function heritageBaseName(typeRef: ts.ExpressionWithTypeArguments): string | undefined {
  const e = typeRef.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return undefined;
}

function isNullishTypeNode(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword || node.kind === ts.SyntaxKind.VoidKeyword) return true;
  return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * Mirror of `isVoidType(checker.getReturnTypeOfSignature(sig))` for a declared
 * return type node: void / undefined ⇒ the method registers no result.
 * A missing annotation is `any` (NOT void), matching the checker.
 */
export function isVoidTypeNode(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  if (node.kind === ts.SyntaxKind.VoidKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (ts.isParenthesizedTypeNode(node)) return isVoidTypeNode(node.type);
  // `asserts value [is T]` — the checker types assertion signatures as void.
  if (ts.isTypePredicateNode(node) && node.assertsModifier) return true;
  return false;
}

/**
 * Construct signatures declared on the merged `interface <name>` declarations
 * (e.g. `DateConstructor`), in merge order. Mirrors
 * the checker's `getTypeAtLocation → getConstructSignatures` for the flat
 * XConstructor interfaces that occur in lib files.
 */
export function libConstructSignatures(name: string, index: LibDeclIndex): ts.ConstructSignatureDeclaration[] {
  const out: ts.ConstructSignatureDeclaration[] = [];
  for (const iface of index.interfaces.get(resolveLibTypeName(name, index)) ?? []) {
    for (const m of iface.members) {
      if (ts.isConstructSignatureDeclaration(m)) out.push(m);
    }
  }
  return out;
}

/**
 * Mirror of `isExternalDeclaredClass` (checker/type-mapper.ts) for a TYPE NAME
 * declared in the lib index. True when the name is backed by:
 *  - an ambient `declare class X`, or
 *  - `declare var X: { …; new(): X }` (inline construct signature), or
 *  - `declare var X: XConstructor` where the referenced interface has
 *    construct signatures AND X is not a wasm-native builtin.
 */
export function isExternDeclaredLibName(rawName: string, index: LibDeclIndex): boolean {
  // Aliases (`type WindowProxy = Window`) classify as their target — the
  // checker's merged symbol never sees the alias name.
  const name = resolveLibTypeName(rawName, index);
  if (index.classes.has(name)) return true;
  const v = index.vars.get(name);
  if (!v || !v.type) return false;
  if (ts.isTypeLiteralNode(v.type)) {
    return v.type.members.some((m) => ts.isConstructSignatureDeclaration(m));
  }
  if (ts.isTypeReferenceNode(v.type) && !BUILTIN_TYPES.has(name)) {
    return libConstructSignatures(typeRefName(v.type.typeName), index).length > 0;
  }
  return false;
}

/** Declared type of the property `prop` on the given declared TYPE node —
 * looks through TypeLiteral members directly and TypeReference targets via
 * the merged interface index. */
function memberTypeOf(typeNode: ts.TypeNode, prop: string, index: LibDeclIndex): ts.TypeNode | undefined {
  const memberIn = (members: readonly ts.TypeElement[]): ts.TypeNode | undefined => {
    for (const m of members) {
      if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name) && m.name.text === prop) return m.type;
    }
    return undefined;
  };
  if (ts.isTypeLiteralNode(typeNode)) return memberIn(typeNode.members);
  if (ts.isTypeReferenceNode(typeNode)) {
    const target = resolveLibTypeName(typeRefName(typeNode.typeName), index);
    for (const iface of index.interfaces.get(target) ?? []) {
      const t = memberIn(iface.members);
      if (t) return t;
    }
  }
  return undefined;
}

/** Resolve `typeof <entity>` to the entity's declared type node: `typeof X`
 * is the ambient `declare var X`'s type; `typeof X.Y` is member `Y` on it. */
function resolveTypeQueryNode(name: ts.EntityName, index: LibDeclIndex): ts.TypeNode | undefined {
  if (ts.isIdentifier(name)) return index.vars.get(name.text)?.type;
  const base = resolveTypeQueryNode(name.left, index);
  return base ? memberTypeOf(base, name.right.text, index) : undefined;
}

/**
 * Syntactic mirror of `mapTsTypeToWasm` (checker/type-mapper.ts) over declared
 * type nodes. Decision table must stay aligned with the checker version:
 *
 * | declared type                    | ValType                  |
 * | -------------------------------- | ------------------------ |
 * | bigint                           | i64 (bigint brand)       |
 * | number / numeric literal         | f64                      |
 * | boolean / true / false           | i32 (boolean brand)      |
 * | string / string literal          | externref                |
 * | void / undefined                 | i32                      |
 * | null                             | externref                |
 * | symbol / unique symbol           | i32                      |
 * | union                            | drop nullish parts; 1 →  |
 * |                                  | inner; same-kind → first;|
 * |                                  | else externref           |
 * | type parameter                   | its constraint, else     |
 * |                                  | externref                |
 * | alias (non-generic)              | resolve through index    |
 * | everything else (objects, arrays,|                          |
 * | functions, any, unknown, …)      | externref                |
 */
export function mapLibTypeNodeToWasm(
  node: ts.TypeNode | undefined,
  index: LibDeclIndex,
  scope: TypeParamScope,
  depth = 0,
): ValType {
  if (!node || depth > MAX_TYPE_DEPTH) return { kind: "externref" };
  switch (node.kind) {
    case ts.SyntaxKind.BigIntKeyword:
      return { kind: "i64", bigint: true };
    case ts.SyntaxKind.NumberKeyword:
      return { kind: "f64" };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: "i32", boolean: true };
    case ts.SyntaxKind.StringKeyword:
      return { kind: "externref" };
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
      return { kind: "i32" };
    case ts.SyntaxKind.SymbolKeyword:
      return { kind: "i32" };
    default:
      break;
  }
  if (ts.isParenthesizedTypeNode(node)) return mapLibTypeNodeToWasm(node.type, index, scope, depth + 1);
  // Type predicates (`x is T`) are boolean-valued at runtime — the checker
  // maps the signature's return type to boolean (branded i32). `asserts`
  // predicates are void; callers check isVoidTypeNode first.
  if (ts.isTypePredicateNode(node)) return { kind: "i32", boolean: true };
  // `unique symbol` (SymbolConstructor.iterator etc.) — checker maps
  // UniqueESSymbol to i32, same as `symbol`.
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.UniqueKeyword) {
    return mapLibTypeNodeToWasm(node.type, index, scope, depth + 1);
  }
  if (ts.isLiteralTypeNode(node)) {
    switch (node.literal.kind) {
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.PrefixUnaryExpression: // -1 literal types
        return { kind: "f64" };
      case ts.SyntaxKind.BigIntLiteral:
        return { kind: "i64", bigint: true };
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
        return { kind: "i32", boolean: true };
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.NullKeyword:
        return { kind: "externref" };
      default:
        return { kind: "externref" };
    }
  }
  if (ts.isUnionTypeNode(node)) {
    const nonNullish = node.types.filter((t) => !isNullishTypeNode(t));
    if (nonNullish.length === 1) {
      const inner = mapLibTypeNodeToWasm(nonNullish[0], index, scope, depth + 1);
      if (inner.kind === "ref") return { kind: "ref_null", typeIdx: inner.typeIdx };
      return inner;
    }
    if (nonNullish.length > 1) {
      const mapped = nonNullish.map((t) => mapLibTypeNodeToWasm(t, index, scope, depth + 1));
      if (mapped.every((m) => m.kind === mapped[0].kind)) return mapped[0];
    }
    return { kind: "externref" };
  }
  // `typeof X` / `typeof X.Y` queries (FileReader.readyState is declared as
  // `typeof FileReader.EMPTY | …`). Resolve through the ambient declare-var's
  // declared type; unresolvable queries stay externref.
  if (ts.isTypeQueryNode(node)) {
    const resolved = resolveTypeQueryNode(node.exprName, index);
    return resolved ? mapLibTypeNodeToWasm(resolved, index, scope, depth + 1) : { kind: "externref" };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = typeRefName(node.typeName);
    // A reference into the lexical type-parameter scope resolves through the
    // declared constraint — mirroring `getBaseConstraintOfType`.
    if (ts.isIdentifier(node.typeName) && scope.has(name)) {
      const constraint = scope.get(name);
      return constraint ? mapLibTypeNodeToWasm(constraint, index, scope, depth + 1) : { kind: "externref" };
    }
    // Non-generic alias (e.g. `type GLenum = number`) resolves structurally.
    const alias = index.aliases.get(name);
    if (alias && ts.isIdentifier(node.typeName) && (!alias.typeParameters || alias.typeParameters.length === 0)) {
      return mapLibTypeNodeToWasm(alias.type, index, scope, depth + 1);
    }
    // Interfaces / classes / generic aliases → opaque JS object.
    return { kind: "externref" };
  }
  // Arrays, tuples, functions, type literals, intersections, keyof/indexed
  // access, conditional/mapped types, any, unknown, … → externref.
  return { kind: "externref" };
}
