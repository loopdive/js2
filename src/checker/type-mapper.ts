// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";

/** Types with built-in wasm GC handling that should NOT be treated as extern classes */
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

/**
 * (#3907) `fast` no longer influences the `number` mapping and is retained only
 * because it is threaded through the recursive calls below. Do NOT reintroduce
 * a mode-dependent numeric representation here — see the `number` arm.
 */
export function mapTsTypeToWasm(type: ts.Type, checker: ts.TypeChecker, fast?: boolean): ValType {
  if (type.flags & ts.TypeFlags.BigInt || type.flags & ts.TypeFlags.BigIntLiteral) {
    // (#1644) Brand the i64 as bigint so coercion sites box/unbox it as a JS
    // bigint (not a number). A `: bigint`-typed local/param/return carries the
    // brand, so reads re-emit it. Native `type i64 = number` resolves through a
    // different path and stays unbranded.
    return { kind: "i64", bigint: true };
  }
  if (type.flags & ts.TypeFlags.Number || type.flags & ts.TypeFlags.NumberLiteral) {
    // (#3907) This was `{ kind: fast ? "i32" : "f64" }`, and it is THE narrowing
    // site behind the mixed/fibonacci wrap. It made EVERY TypeScript `number` a
    // Wasm i32 under `fast` — local, parameter, return, array element, object
    // field — so `Math.sqrt(2)` was 1, `100000 * 100000` was 1410065408, and the
    // published `gc-native` benchmark lane was comparing wrapping 32-bit integer
    // arithmetic against JS's IEEE-754 doubles.
    //
    // A TS `number` is an IEEE-754 double in every mode. i32 storage is reached
    // only through a PROOF, all of which live elsewhere and were already
    // correct: the explicit `type i32 = number` opt-in (#323/#3673),
    // `collectI32CoercedLocals` (#1120/#1236/#2789), `detectI32LoopVar`,
    // `planI32Slots` (#3741), and the ToInt32-guarded operator paths in
    // `binary-ops.ts`. Note #1236 and #2789 had already hardened those matchers
    // against exactly this failure mode — the bug was upstream of all of them.
    return { kind: "f64" };
  }
  if (type.flags & ts.TypeFlags.Boolean || type.flags & ts.TypeFlags.BooleanLiteral) {
    // (#1788) Brand the i32 as boolean so struct field getters box it as a JS
    // boolean (`__box_boolean`) rather than a number (`__box_number`). The brand
    // is structurally inert — every `.kind === "i32"` check still matches, so
    // boolean locals / params / arithmetic keep bare-i32 codegen. Only the
    // struct-field boxing decision (`buildGetterExtract`) reads `.boolean`.
    return { kind: "i32", boolean: true };
  }
  if (type.flags & ts.TypeFlags.String || type.flags & ts.TypeFlags.StringLiteral) {
    return { kind: "externref" }; // JS string pass-through
  }
  if (type.flags & ts.TypeFlags.Void || type.flags & ts.TypeFlags.Undefined) {
    return { kind: "i32" }; // void → no result (handled in codegen)
  }
  if (type.flags & ts.TypeFlags.Null) {
    return { kind: "externref" };
  }

  // Symbol types (ESSymbol, UniqueESSymbol) → i32 (unique counter ID).
  // (#2792) NOT broadly `symbol`-branded here. Branding every symbol local/param
  // would route ALL symbol→externref coercions through `__box_symbol`, but other
  // boxing sites (object-literal fields, etc.) still box via `__box_number`. That
  // mismatch regressed the host `Object/values/symbols-omitted` canary
  // (`Object.values({key: s})[0] === s` compared a __box_symbol Symbol against a
  // __box_number Number → false), confirming #2785's reason for deferring broad
  // branding ("bound blast radius"). The F1 `symbol[]` OOB→undefined read keys on
  // the TS type instead — `f1ElementBoxType` reconstructs the `symbol` brand at
  // the read site, so its box choice is self-consistent without branding the
  // ValType. A future symbol-as-any value-rep pass (#2610) can make ALL symbol
  // boxing consistent, at which point this can be branded.
  if ((type.flags & ts.TypeFlags.ESSymbol) !== 0 || (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0) {
    return { kind: "i32" };
  }

  // Union with null/undefined/void → unwrap to inner type
  // (#1550) Treat `void` the same as `undefined` here — JS-runtime-equivalent.
  // TS infers binding types like `void | null` for `function f({w = counter()} = {w: null})`
  // because `counter()` has return type `void`. Without filtering Void, the union
  // collapses to just `void` → i32, losing the actual null/string/number type info
  // and erasing the destructured value at runtime.
  if (type.isUnion()) {
    const nonNullish = type.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined) && !(t.flags & ts.TypeFlags.Void),
    );
    if (nonNullish.length === 1) {
      const inner = mapTsTypeToWasm(nonNullish[0]!, checker, fast);
      if (inner.kind === "ref") return { kind: "ref_null", typeIdx: inner.typeIdx };
      // T | undefined for primitives → just use T (e.g. number | undefined → f64)
      return inner;
    }
    // Check if all non-nullish types map to the same Wasm kind (e.g. 0 | 2 → f64)
    if (nonNullish.length > 1) {
      const mapped = nonNullish.map((t) => mapTsTypeToWasm(t, checker, fast));
      if (mapped.every((m) => m.kind === mapped[0]!.kind)) {
        return mapped[0]!;
      }
    }
    // Real heterogeneous union → externref
    return { kind: "externref" };
  }

  // Object types (interfaces, arrays, functions)
  if (type.flags & ts.TypeFlags.Object) {
    if (isExternalDeclaredClass(type, checker)) return { kind: "externref" };
    // Placeholder -1 for named structs — resolved by resolveWasmType in codegen.
    // If codegen can't resolve it (e.g. Array, Function), it falls back here
    // and resolveWasmType passes it through, so we use externref as safe fallback.
    return { kind: "externref" };
  }

  // Type parameter (generics) — check constraint, fallback to externref
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint) {
      return mapTsTypeToWasm(constraint, checker, fast);
    }
    return { kind: "externref" };
  }

  // any/unknown/error → treat as externref (opaque JS value)
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return { kind: "externref" };
  }

  return { kind: "externref" };
}

/** Check if a type is an externally declared class (declare class / declare var with constructor) */
export function isExternalDeclaredClass(type: ts.Type, checker?: ts.TypeChecker): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  const decls = symbol.getDeclarations();
  if (!decls || decls.length === 0) return false;
  const symName = symbol.getName();
  if (
    decls.some(
      (d) =>
        // declare class Foo { ... }
        (ts.isClassDeclaration(d) && isDeclareContext(d)) ||
        // declare var Foo: { prototype: Foo; new(): Foo }  (lib.dom.d.ts pattern)
        (ts.isVariableDeclaration(d) && isDeclareVarWithConstructor(d)) ||
        // declare var Date: DateConstructor  (TypeReferenceNode pattern, skip builtins)
        (ts.isVariableDeclaration(d) &&
          checker &&
          !BUILTIN_TYPES.has(symName) &&
          isDeclareVarWithTypeRefConstructor(d, checker)),
    )
  )
    return true;

  return false;
}

function isDeclareVarWithConstructor(d: ts.VariableDeclaration): boolean {
  const stmt = d.parent?.parent;
  if (!stmt || !ts.isVariableStatement(stmt)) return false;
  if (!isDeclareContext(stmt)) return false;
  if (!d.type || !ts.isTypeLiteralNode(d.type)) return false;
  return d.type.members.some((m) => ts.isConstructSignatureDeclaration(m));
}

/** Check declare var with TypeReferenceNode type that has construct signatures (e.g. declare var Date: DateConstructor) */
function isDeclareVarWithTypeRefConstructor(d: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  const stmt = d.parent?.parent;
  if (!stmt || !ts.isVariableStatement(stmt)) return false;
  if (!isDeclareContext(stmt)) return false;
  if (!d.type || !ts.isTypeReferenceNode(d.type)) return false;
  const refType = checker.getTypeAtLocation(d.type);
  return refType.getConstructSignatures().length > 0;
}

function isDeclareContext(node: ts.Node): boolean {
  if (ts.canHaveModifiers(node)) {
    const mods = ts.getModifiers(node);
    if (mods?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  // Check if inside a declare namespace/module
  // ClassDecl → ModuleBlock → ModuleDeclaration, so walk up
  if (node.parent) {
    if (ts.isModuleDeclaration(node.parent)) {
      return isDeclareContext(node.parent);
    }
    if (ts.isModuleBlock(node.parent)) {
      return isDeclareContext(node.parent.parent);
    }
  }
  // Top-level declarations in `.d.ts` files are implicitly ambient (#1287).
  // Without this, `export class Foo { children: Foo[] }` in a `.d.ts` would
  // be classified as a regular user class by `isExternalDeclaredClass` →
  // `ensureStructForType` registers a WasmGC struct with a self-referencing
  // field, producing a forward-reference heap type that fails Wasm validation.
  const sf = node.getSourceFile();
  if (sf && sf.isDeclarationFile) return true;
  return false;
}

/** Check if a ts.Type represents void */
export function isVoidType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Void) !== 0 || (type.flags & ts.TypeFlags.Undefined) !== 0;
}

/**
 * Resolve the Wasm type of a destructuring binding element's local (#821).
 *
 * For `{ s: t = counter() }` where `counter()` returns `void`, TS infers `t`'s
 * type as `void` (or `void | undefined`) — its only evidence is the default
 * initializer. `resolveWasmType` then maps that to `i32`, so the *actual*
 * property value (`null`/`0`/`false`/`''`, an externref) gets coerced into an
 * i32 local and is destroyed — the spec requires the present, non-`undefined`
 * value to be preserved and the default skipped (§13.3.3.6/§13.3.3.7).
 *
 * When an element has a default initializer AND the resolved type is the
 * void/undefined sentinel, the local must be `externref` so it can faithfully
 * hold whatever real value flows in. `resolve` is the caller's
 * `resolveWasmType(ctx, tsType)` (passed in to avoid a circular import).
 */
export function resolveBindingElementType(
  element: ts.BindingElement,
  tsType: ts.Type,
  resolve: (t: ts.Type) => ValType,
): ValType {
  const resolved = resolve(tsType);
  if (element.initializer && isVoidType(tsType)) {
    return { kind: "externref" };
  }
  // (#3315/#3423) A scalar destructuring binding WITHOUT a default can always
  // receive `undefined`: an object property may be absent, an array/iterator
  // may be shorter than the pattern, or the source may explicitly contain an
  // `undefined`. The checker frequently reports `number` here because it
  // infers from a contextual/default type rather than from every runtime value
  // which BindingInitialization can produce. Storing such a binding in an f64
  // local (or module global) silently degrades `undefined` to the numeric NaN
  // sentinel — the #3423 `Expected SameValue(«NaN», «undefined»)` signature.
  //
  // Widen the binding slot to externref so undefined identity survives; numeric
  // use sites unbox (ToNumber(undefined) = NaN, matching JS coercion semantics).
  // This applies uniformly to parameters, declarations, and for-of heads. The
  // distinction matters because declarations and loop heads also publish their
  // slots as module globals, and widening only the parameter lane leaves the
  // local/global pair inconsistent. It is deliberately limited to f64 scalar
  // bindings without a per-element default: native i32/bool annotations are an
  // explicit representation choice, and a default consumes `undefined` before
  // it reaches the binding.
  if (isUndefWidenedBindingElement(element, resolved)) {
    return { kind: "externref" };
  }
  return resolved;
}

/**
 * (#3315/#3423) True when the binding element falls under the
 * undefined-preserving widening rule above (any destructuring pattern,
 * no default, scalar f64 checker rep). Exported so allocation sites can ALSO
 * register the name in `fctx.undefWidenedLocals`, which tells the identifier
 * read path to skip checker-type unbox narrowing for these locals.
 */
export function isUndefWidenedBindingElement(element: ts.BindingElement, resolved: ValType): boolean {
  return !element.initializer && !element.dotDotDotToken && resolved.kind === "f64";
}

/**
 * Brand a f64 value read for an undefined-capable binding before it is boxed.
 *
 * Numeric Wasm arrays/struct fields use `UNDEF_F64_BITS` for a missing or
 * explicit-undefined value. The ordinary f64→externref coercion quite
 * correctly boxes arbitrary numeric NaN as a Number; a destructuring binding
 * is the exception because this particular f64 slot is known to carry the
 * language-level undefined sentinel. Keeping that fact on the source type
 * lets the shared coercion engine map only this read back to real undefined.
 */
export function undefinedPreservingBindingSourceType(element: ts.BindingElement, source: ValType): ValType {
  if (source.kind !== "f64") return source;
  if (!isUndefWidenedBindingElement(element, source)) return source;
  return source.undefSentinel === true ? source : { kind: "f64", undefSentinel: true };
}

/** Check if a ts.Type represents bigint */
export function isBigIntType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.BigInt) !== 0 || (type.flags & ts.TypeFlags.BigIntLiteral) !== 0;
}

/** Check if a ts.Type represents number */
export function isNumberType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Number) !== 0 || (type.flags & ts.TypeFlags.NumberLiteral) !== 0;
}

export type NullablePrimitiveKind = "number" | "boolean" | "string" | "bigint";

export interface NullablePrimitiveInfo {
  primitiveKind: NullablePrimitiveKind;
  hasNull: boolean;
  hasUndefined: boolean;
}

function primitiveKindOfType(type: ts.Type): NullablePrimitiveKind | null {
  if (isNumberType(type)) return "number";
  if (isBooleanType(type)) return "boolean";
  if (isStringType(type)) return "string";
  if (isBigIntType(type)) return "bigint";
  return null;
}

/** Check if a type is a nullable primitive sentinel, e.g. number | null or boolean | undefined. */
export function getNullablePrimitiveInfo(type: ts.Type): NullablePrimitiveInfo | null {
  if (!type.isUnion()) return null;
  let hasNull = false;
  let hasUndefined = false;
  const nonNullTypes: ts.Type[] = [];
  for (const part of type.types) {
    if (part.flags & ts.TypeFlags.Null) {
      hasNull = true;
      continue;
    }
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
      hasUndefined = true;
      continue;
    }
    nonNullTypes.push(part);
  }
  if (!hasNull && !hasUndefined) return null;
  if (nonNullTypes.length === 0) return null;
  const firstKind = primitiveKindOfType(nonNullTypes[0]!);
  if (!firstKind) return null;
  if (!nonNullTypes.every((part) => primitiveKindOfType(part) === firstKind)) return null;
  return { primitiveKind: firstKind, hasNull, hasUndefined };
}

export function isNullablePrimitiveType(type: ts.Type): boolean {
  return getNullablePrimitiveInfo(type) !== null;
}

/** Check if a ts.Type represents boolean */
export function isBooleanType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Boolean) !== 0 || (type.flags & ts.TypeFlags.BooleanLiteral) !== 0;
}

/** Check if a ts.Type represents string (including String wrapper object) */
export function isStringType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.String) !== 0 || (type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return true;
  }
  // (#4607) A UNION whose every constituent is a string literal is a string —
  // and `typeof x` is exactly that shape: TS types it as the 8-member union
  // `"string" | "number" | … | "function"`. Without this the predicate answers
  // `false` for every `typeof` result, so `(typeof u).length` misses the
  // string-`length` arm and falls through to the dynamic member-get, which in
  // native-string mode reads a vec `$length` field off a `$AnyString` and
  // answers `NaN`. `mapTsTypeToWasm` already lowers such a union to exactly the
  // same ValType as a plain `string` (every constituent maps to `externref`, so
  // the all-same-kind arm returns `externref`), so recognizing it here does not
  // introduce a type/carrier disagreement anywhere.
  if (isStringLiteralUnion(type)) return true;
  // Also recognize the String wrapper object type (e.g. from `new String("x")`)
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const sym = type.getSymbol();
    if (sym && sym.name === "String") return true;
  }
  return false;
}

/**
 * (#4607) True for a union type whose constituents are ALL string/string-literal
 * types (e.g. `"a" | "b"`, or the `typeof` operator's own 8-member union).
 * Deliberately strict: one non-string constituent (`"a" | 0`, `string | null`)
 * makes it false, so the heterogeneous-union carriers are untouched.
 */
function isStringLiteralUnion(type: ts.Type): boolean {
  if (!type.isUnion()) return false;
  if (type.types.length === 0) return false;
  return type.types.every((part) => (part.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0);
}

/** Check if a ts.Type represents the Number wrapper object (e.g. `new Number(1)`) */
export function isNumberWrapperType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const sym = type.getSymbol();
    if (sym && sym.name === "Number") return true;
  }
  return false;
}

/** Check if a ts.Type represents the String wrapper object (e.g. `new String("x")`) */
export function isStringWrapperType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const sym = type.getSymbol();
    if (sym && sym.name === "String") return true;
  }
  return false;
}

/** Check if a ts.Type represents the Boolean wrapper object (e.g. `new Boolean(false)`) */
export function isBooleanWrapperType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const sym = type.getSymbol();
    if (sym && sym.name === "Boolean") return true;
  }
  return false;
}

/**
 * Check if a ts.Type is any of Number/String/Boolean wrapper object types (#1111).
 * These are JS objects (typeof x === "object") even though they wrap primitives.
 * Used to route equality through JS host == / === with no numeric fallback,
 * since wrappers have object identity semantics, not value semantics.
 */
export function isWrapperObjectType(type: ts.Type): boolean {
  return isNumberWrapperType(type) || isStringWrapperType(type) || isBooleanWrapperType(type);
}

/**
 * Check if a ts.Type is a Symbol type.
 */
export function isSymbolType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.ESSymbol) !== 0 || (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0;
}

/**
 * Check if a ts.Type is Promise<T>.
 * Returns true for the built-in Promise generic type.
 */
export function isPromiseType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  return symbol.name === "Promise" && !!(type.flags & ts.TypeFlags.Object);
}

/**
 * Check if a ts.Type is Generator<T>, Iterator<T>, or IterableIterator<T>.
 * Returns true for any of the built-in generator/iterator types.
 */
export function isGeneratorType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  return (
    (symbol.name === "Generator" || symbol.name === "Iterator" || symbol.name === "IterableIterator") &&
    !!(type.flags & ts.TypeFlags.Object)
  );
}

/**
 * Check if a ts.Type is IteratorResult<T> (the return type of .next()).
 */
export function isIteratorResultType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  return (
    (symbol.name === "IteratorYieldResult" ||
      symbol.name === "IteratorReturnResult" ||
      symbol.name === "IteratorResult") &&
    !!(type.flags & ts.TypeFlags.Object)
  );
}

/**
 * Unwrap Promise<T> to T. If the type is not a Promise, returns the type unchanged.
 * Used to extract the inner type of async function return types.
 */
export function unwrapPromiseType(type: ts.Type, checker: ts.TypeChecker): ts.Type {
  if (!isPromiseType(type)) return type;
  const typeRef = type as ts.TypeReference;
  const typeArgs = checker.getTypeArguments(typeRef);
  if (typeArgs.length > 0) {
    return typeArgs[0]!;
  }
  return type;
}

/**
 * Check if a ts.Type is a heterogeneous union (e.g. number | string)
 * that requires externref boxing. Returns false for T | null/undefined unions
 * where the non-nullish types all map to the same Wasm kind.
 */
export function isHeterogeneousUnion(type: ts.Type, checker: ts.TypeChecker, fast?: boolean): boolean {
  if (!type.isUnion()) return false;
  const nonNullish = type.types.filter((t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined));
  if (nonNullish.length <= 1) return false;
  const mapped = nonNullish.map((t) => mapTsTypeToWasm(t, checker, fast));
  return !mapped.every((m) => m.kind === mapped[0]!.kind);
}

/**
 * (#745 S2) True for a *statically-known heterogeneous primitive* union —
 * ≥2 distinct primitive kinds among {number, string, boolean} after
 * filtering null/undefined/void. These are the unions that adopt the
 * universal `$AnyValue` tagged carrier (see #745 `## Design Decision`)
 * instead of externref boxing, in the lanes where `ctx.unionAnyRep` is on.
 *
 * Deliberately NARROW — returns false (preserving existing externref
 * behaviour) for:
 * - homogeneous unions (`"a" | "b"`, `0 | 2`, `true | false`) — these
 *   already collapse to a single Wasm kind in `mapTsTypeToWasm`;
 * - unions containing bigint (i64-branded; `$AnyValue` has no i64 payload),
 *   symbol, enum members, object/class/array/function members, or
 *   any/unknown — representation for those stays as-is until later slices;
 * - `T | null/undefined` single-kind nullables (the existing unwrap path).
 */
/**
 * (#745 S3) True when `node` (after unwrapping parens / `as` / `!`) is an
 * identifier whose DECLARED symbol type is a heterogeneous primitive union
 * (see {@link isHeterogeneousPrimitiveUnion}). Needed because assignment /
 * literal narrowing re-types the USE SITE (`x = "done"; x === "done"` reports
 * `"done"`) while the value stays in the `$AnyValue` carrier the S2 mapping
 * chose from the declaration type. Takes the checker as a local param —
 * symbol/binding resolution is explicitly outside the oracle's v1 scope
 * (#1930 D3), mirroring `isHeterogeneousUnion`'s signature.
 */
export function isDeclaredHeterogeneousPrimitiveUnion(checker: ts.TypeChecker, node: ts.Expression): boolean {
  let cur: ts.Expression = node;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur)) return false;
  const sym = checker.getSymbolAtLocation(cur);
  const decl = sym?.valueDeclaration;
  if (!decl) return false;
  try {
    return isHeterogeneousPrimitiveUnion(checker.getTypeOfSymbolAtLocation(sym, decl));
  } catch {
    return false;
  }
}

export function isHeterogeneousPrimitiveUnion(type: ts.Type): boolean {
  if (!type.isUnion()) return false;
  const nonNullish = type.types.filter(
    (t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)),
  );
  if (nonNullish.length < 2) return false;
  const kinds = new Set<string>();
  for (const t of nonNullish) {
    // Enum members carry NumberLiteral/StringLiteral flags too — exclude
    // explicitly so enum-typed unions keep their existing representation.
    if (t.flags & ts.TypeFlags.EnumLike) return false;
    if (t.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) kinds.add("number");
    else if (t.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) kinds.add("string");
    else if (t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) kinds.add("boolean");
    else return false; // non-primitive member → not this slice's shape
  }
  return kinds.size >= 2;
}
