// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2001 S1) Sparse-array hole representation — the `$Hole` anyref sentinel.
//
// A dense WasmGC vec (`struct(field0 length:i32, field1 data:(ref $arr_<elem>))`)
// has no native concept of an "absent" index. For an `any[]` / untyped array the
// element ValType is `externref`, and a literal elision (`OmittedExpression`,
// e.g. the gap in `[1, , 3]`) was previously lowered the same way an explicit
// `undefined` is — `emitUndefined` → the slot held JS `undefined`. A hole was
// therefore *indistinguishable* from a real `undefined`, so no array HOF could
// honour the spec's `HasProperty(O, ‹k›) is false ⇒ skip` rule (§23.1.3.*).
//
// The ratified representation (issue #2001 architect spec, 2026-06-21) is a
// single module-global **`$Hole`** sentinel: a unique, immutable, zero-field
// WasmGC struct whose ref identity is distinct from every value the language
// can produce (`undefined`, `null`, `$box_number`, NativeString, `$Object`,
// closures, i31ref, …). A vec slot equal to `$Hole` (by `ref.test (ref $Hole)`)
// *is* an absent index; anything else is present.
//
// **Scope (S1).** Only `any[]` / untyped array literals whose vec element
// ValType is `externref` participate. Typed `number[]` / `boolean[]` /
// `string[]` / struct `T[]` vecs (f64 / i32 / ref elements) are byte-identical —
// they never see a `$Hole` struct type, a `ref.test`, or any new op. This keeps
// the dense numeric kernel unchanged (the #1852 §3 typed-mainline-unboxed
// invariant applied locally).
//
// **Standalone parity.** `$Hole` is a pure WasmGC struct + global; the
// `ref.test` dispatch and `struct.new` const-init are engine-native and work
// identically under `--target standalone` / `wasi`. No host import. The
// read-boundary `$Hole → undefined` mapping reuses the existing `emitUndefined`
// (host: `__get_undefined`; standalone: `ref.null.extern`).
//
// **Critical invariant.** A hole is NEVER observed *as* the sentinel. Per
// §ToObject/Get, reading an absent index yields `undefined`, not the sentinel.
// Every value-producing read of a vec slot that may hold `$Hole` maps
// `$Hole → undefined` at the read boundary (`emitHoleToUndefined`); the sentinel
// is internal-only and must not leak into a binding, callback arg, coercion, or
// `===`.

import { ts, forEachChild } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, StructTypeDef } from "../ir/types.js";
import { allocTempLocal } from "./context/locals.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { isBrandedBuiltinName } from "./builtin-brands.js"; // (#4176) named proto-write pre-scan
import { planHoleyArrayCarrier } from "./holey-array-plan.js"; // (#4222) isolated sparse-carrier proof

/**
 * Cheap AST pre-scan: set `ctx.usesArrayHoles` when the program contains any
 * array-literal elision (`OmittedExpression`). Runs once before body
 * compilation (mirrors `scanForNewTarget`). When clear — the common case — the
 * hole read-guard is never emitted and every array read stays byte-identical.
 *
 * Setting the flag in a pre-pass (rather than lazily at the first hole-store)
 * is what lets a `a[i]` element *read* in one function emit the `$Hole → undefined`
 * guard even though the hole-bearing literal lives in a *different* function
 * compiled later — function compilation order is not source order, so a per-site
 * lazy flag would desync reads against stores.
 */
export function scanForArrayHoles(ctx: CodegenContext, root: ts.Node): void {
  const visit = (node: ts.Node): void => {
    if (
      ctx.usesArrayHoles &&
      ctx.protoIndexDirty &&
      ctx.protoNamedDirty &&
      ctx.protoMemberDirty &&
      ctx.vecAccessorDescriptorDirty &&
      ctx.vecIndexDeleteDirty &&
      ctx.vecOwnKeysDirty &&
      ctx.dynamicCodeDirty
    ) {
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) {
        if (ts.isOmittedExpression(el)) {
          ctx.usesArrayHoles = true;
          break;
        }
      }
    }
    if (!ctx.protoIndexDirty && isProtoIndexWrite(node)) {
      ctx.protoIndexDirty = true;
    }
    if (!ctx.protoNamedDirty && isProtoNamedWrite(node)) {
      ctx.protoNamedDirty = true;
    }
    if (!ctx.protoMemberDirty && isProtoMemberValueUse(node)) {
      ctx.protoMemberDirty = true;
    }
    if (!ctx.vecAccessorDescriptorDirty && isNonDataDescriptorDefine(node)) {
      ctx.vecAccessorDescriptorDirty = true;
    }
    if (!ctx.vecIndexDeleteDirty && isIndexDelete(node)) {
      ctx.vecIndexDeleteDirty = true;
    }
    if (!ctx.vecOwnKeysDirty && isOwnKeysOrDescriptorDefineUse(node)) {
      ctx.vecOwnKeysDirty = true;
    }
    // (#4159/#4160) Dynamic code defeats the whole pre-scan: static eval
    // inlining (#1163) splices parsed statements in during BODY compilation,
    // after this pass has finished, so `eval('Array.prototype[0] = 1')` would
    // otherwise leave every flag clear. Setting a flag lazily at splice time is
    // exactly the desync this pass exists to prevent, so presence of dynamic
    // code dirties everything, statically.
    if (!ctx.dynamicCodeDirty && isDynamicCodeUse(node)) {
      ctx.dynamicCodeDirty = true;
      ctx.protoIndexDirty = true;
      ctx.protoNamedDirty = true;
      ctx.protoMemberDirty = true;
      ctx.vecAccessorDescriptorDirty = true;
      ctx.vecIndexDeleteDirty = true;
      ctx.vecOwnKeysDirty = true;
    }
    forEachChild(node, visit);
  };
  visit(root);
  planHoleyArrayCarrier(ctx, root);
}

/**
 * Structurally `Array.prototype` or `Object.prototype`
 * (`PropertyAccess(Identifier "Array"|"Object", "prototype")`).
 *
 * (#4160) `Object.prototype` was added 2026-08-05. Only `Array.prototype` was
 * matched before, which missed the dominant test262 shape — `15.4.4.18-7-b-12`
 * and the 135 files sharing its assertion write `Object.prototype[1] = 1` and
 * then iterate an array-LIKE (a plain object with a `length`), never an array.
 */
function isArrayOrObjectPrototypeExpr(node: ts.Node): boolean {
  const inner = unwrapExpr(node);
  return (
    ts.isPropertyAccessExpression(inner) &&
    inner.name.text === "prototype" &&
    ts.isIdentifier(inner.expression) &&
    (inner.expression.text === "Array" || inner.expression.text === "Object")
  );
}

/**
 * Strip the wrappers that carry no runtime meaning — parentheses and the
 * type-only assertion forms — so a structural match sees the real expression.
 *
 * Load-bearing for TS input, which is what this compiler consumes: writing
 * `Array.prototype[0] = 1` in TypeScript needs a cast
 * (`(Array.prototype as any)[0] = 1`), and without this the `AsExpression`
 * wrapper made the match fail. test262's plain-JS corpus has no cast, which is
 * why the #2001 predicate worked there and the gap went unnoticed.
 */
function unwrapExpr(node: ts.Node): ts.Node {
  let cur = node;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression?.(cur) || ts.isSatisfiesExpression?.(cur)) {
      cur = (cur as ts.TypeAssertion | ts.SatisfiesExpression).expression;
      continue;
    }
    return cur;
  }
}

/** Descriptor fields that make a descriptor purely a DATA descriptor. */
const DATA_DESCRIPTOR_KEYS = new Set(["value", "writable", "enumerable", "configurable"]);

/**
 * Is `node` PROVABLY a data-only descriptor object literal — `{value, writable,
 * enumerable, configurable}` and nothing else?
 *
 * Deliberately conservative: anything this cannot see through (a spread, a
 * computed key, a `get`/`set` accessor or shorthand method, a descriptor held in
 * a variable rather than written inline) answers `false`, i.e. "may be an
 * accessor". False negatives cost a fast path; false positives would be a
 * miscompile.
 */
function isDataOnlyDescriptorLiteral(node: ts.Expression | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) return false;
    if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) return false;
    const name = prop.name;
    if (!name) return false;
    let key: string;
    if (ts.isIdentifier(name)) key = name.text;
    else if (ts.isStringLiteral(name)) key = name.text;
    else return false; // computed / numeric / private — cannot prove
    if (!DATA_DESCRIPTOR_KEYS.has(key)) return false;
  }
  return true;
}

/**
 * Is `node` provably a data-only descriptor BAG — the second argument shape of
 * `Object.defineProperties(O, props)` / `Object.create(proto, props)`, where
 * each own property's VALUE is itself a descriptor? Recurses one level, per the
 * #4159 edge-case note.
 */
function isDataOnlyDescriptorBag(node: ts.Expression | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  for (const prop of node.properties) {
    // Anything other than `key: <literal descriptor>` (spread, shorthand,
    // method, accessor) is unprovable.
    if (!ts.isPropertyAssignment(prop)) return false;
    if (!isDataOnlyDescriptorLiteral(prop.initializer)) return false;
  }
  return true;
}

/**
 * (#4159) Does this node install a descriptor that might be an ACCESSOR (or a
 * non-writable data descriptor) on some receiver?
 *
 * Matches `Object.defineProperty` / `Object.defineProperties` / `Object.create`
 * / `Reflect.defineProperty` whose descriptor argument is not provably
 * data-only. A plain `{value: 1, writable: true}` does NOT set the flag — that
 * case stays coherent through #3251's value write-back into the vec, so the
 * typed inline `array.get` fast path remains correct for it.
 *
 * Same deliberate over-approximation as `isProtoIndexWrite`: a module that might
 * install an accessor ANYWHERE loses the typed element fast path EVERYWHERE. The
 * flag is per-module, not per-array; a tighter escape analysis is the
 * measurement-driven follow-up, not this substrate.
 */
function isNonDataDescriptorDefine(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
  const ns = callee.expression.text;
  const method = callee.name.text;

  if (method === "defineProperty" && (ns === "Object" || ns === "Reflect")) {
    // (O, key, descriptor) — the descriptor is argument 2.
    return !isDataOnlyDescriptorLiteral(node.arguments[2]);
  }
  if (method === "defineProperties" && ns === "Object") {
    return !isDataOnlyDescriptorBag(node.arguments[1]);
  }
  if (method === "create" && ns === "Object") {
    // `Object.create(proto)` installs no descriptors at all.
    return node.arguments.length >= 2 && !isDataOnlyDescriptorBag(node.arguments[1]);
  }
  return false;
}

/**
 * (#4222) Does this node delete a COMPUTED property — `delete o[k]`?
 *
 * `delete o.k` is deliberately NOT matched: a dotted name can never be an array
 * index, so it cannot tombstone a dense vec slot, and matching it would arm the
 * overlay route for the ubiquitous `delete obj.field` idiom that has nothing to
 * do with arrays.
 *
 * Same per-module over-approximation as `isNonDataDescriptorDefine`: the key is
 * usually not statically known (`delete srcArr[idx]` inside a callback is the
 * dominant test262 shape), and the receiver's array-ness is a *type* question
 * this cheap syntactic pre-pass deliberately does not ask — it runs before body
 * compilation precisely so reads and stores cannot desync.
 */
function isIndexDelete(node: ts.Node): boolean {
  if (!ts.isDeleteExpression(node)) return false;
  return ts.isElementAccessExpression(unwrapExpr(node.expression));
}

/**
 * (#4230 L1) `Object`/`Reflect` member names that can either PUT a named
 * expando into the #3251 overlay companion or ASK for a vec's own key list.
 * Either one makes `vec-overlay-keys.ts` observable; neither present means it
 * cannot be, so the whole feature is skipped and emission stays byte-identical.
 */
const OWN_KEYS_OR_DEFINE_METHODS = new Set([
  "defineProperty",
  "defineProperties",
  "getOwnPropertyNames",
  "ownKeys",
  "getOwnPropertyDescriptors",
]);

/**
 * (#4230 L1) Does this node mention a descriptor-defining or own-name-reading
 * `Object`/`Reflect` builtin?
 *
 * Matched on the PROPERTY ACCESS, not the call, so `const f =
 * Object.getOwnPropertyNames; f(a)` is covered too. `create` is matched only in
 * call position with two arguments: `Object.create(proto)` installs no
 * descriptors, and it is far too common an idiom to arm the feature for.
 *
 * Deliberately syntactic and per-MODULE, like every other flag in this pre-scan
 * — it runs before body compilation so a consumer cannot desync from it.
 */
function isOwnKeysOrDescriptorDefineUse(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      callee.name.text === "create"
    ) {
      return node.arguments.length >= 2;
    }
    return false;
  }
  if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return false;
  const ns = node.expression.text;
  if (ns !== "Object" && ns !== "Reflect") return false;
  return OWN_KEYS_OR_DEFINE_METHODS.has(node.name.text);
}

/**
 * (#4159/#4160) Does this node introduce code the pre-scan cannot see — `eval(…)`,
 * `Function(…)`, or `new Function(…)`? Bare-identifier callees only: a
 * `foo.eval(…)` member call is not the global `eval`.
 */
function isDynamicCodeUse(node: ts.Node): boolean {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && (callee.text === "eval" || callee.text === "Function")) return true;
  }
  return false;
}

/**
 * (#2001 S2 / PR #2832 park; widened to `Object.prototype` by #4160) Does this
 * node WRITE an index property onto `Array.prototype` or `Object.prototype`?
 * Detects the shapes test262 uses to make an index
 * visible through the prototype chain (`HasProperty(O, k)` true although the
 * own slot is absent):
 *
 *   - `Object.defineProperty(Array.prototype, "0", …)` (and `defineProperties`
 *     / `Reflect.defineProperty`);
 *   - `Array.prototype[0] = …` / `Array.prototype["0"] = …` (any assignment
 *     operator; the index need not be a literal — `Array.prototype[i] = …`
 *     also counts).
 *
 * Property-name writes (`Array.prototype.foo = …`) do NOT set the flag — they
 * cannot make an integer index inherited. Reads (`Array.prototype.slice`) are
 * ignored entirely. This is a deliberate static over-approximation: a module
 * that dirties `Array.prototype` indices anywhere loses the HOF hole
 * visit-skip everywhere (falling back to the pre-S2 visit-with-`undefined`
 * behavior), because the flat vec cannot check the prototype per element at
 * runtime. See `protoIndexDirty` in context/types.ts.
 */
/**
 * (#4176) Structurally `<BrandedBuiltin>.prototype` — the generalization of
 * `isArrayOrObjectPrototypeExpr` to every constructor in the builtin brand
 * table (`Function.prototype`, `String.prototype`, `Error.prototype`, …).
 */
function isBrandedBuiltinPrototypeExpr(node: ts.Node): boolean {
  const inner = unwrapExpr(node);
  return (
    ts.isPropertyAccessExpression(inner) &&
    inner.name.text === "prototype" &&
    ts.isIdentifier(inner.expression) &&
    isBrandedBuiltinName(inner.expression.text)
  );
}

/**
 * (#4176) Does this node WRITE a NAMED (or any non-index, for the non-Array/
 * Object builtins any) property onto a branded builtin's `.prototype`? The
 * shapes test262 uses to make a named property inherited:
 *
 *   - `Function.prototype.value = …` / `Object.prototype.zzz = …` (any
 *     assignment operator — property-access form; `isProtoIndexWrite` only
 *     matches the ELEMENT-access form);
 *   - `String.prototype[k] = …` for a non-Object/Array builtin (element form
 *     — over-approximated into the named store, whose write arms accept both
 *     named and integer keys);
 *   - `Object.defineProperty(Number.prototype, …)` (+ `defineProperties` /
 *     `Reflect.defineProperty`) targeting a non-Object/Array builtin proto.
 *
 * Sets `protoNamedDirty` ONLY (store reservation) — never `protoIndexDirty`,
 * so the HOF hole visit-skip / typed element lanes keep their fast paths for
 * the polyfill idiom. Same deliberate static over-approximation as
 * `isProtoIndexWrite`.
 */
function isProtoNamedWrite(node: ts.Node): boolean {
  // `X.prototype.name = …` — property-access assignment target (any builtin,
  // including Object/Array whose index predicate ignores the named form).
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    const lhs = unwrapExpr(node.left);
    if (ts.isPropertyAccessExpression(lhs) && isBrandedBuiltinPrototypeExpr(lhs.expression)) return true;
    // `X.prototype[k] = …` for builtins the index predicate does not cover.
    if (
      ts.isElementAccessExpression(lhs) &&
      isBrandedBuiltinPrototypeExpr(lhs.expression) &&
      !isArrayOrObjectPrototypeExpr(lhs.expression)
    ) {
      return true;
    }
  }
  // Object/Reflect.defineProperty(ies)(X.prototype, …) for the non-Object/
  // Array builtins (the Object/Array form already sets `protoIndexDirty`,
  // which reserves the same store).
  if (
    ts.isCallExpression(node) &&
    node.arguments.length > 0 &&
    isBrandedBuiltinPrototypeExpr(node.arguments[0]) &&
    !isArrayOrObjectPrototypeExpr(node.arguments[0])
  ) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === "Object" || callee.expression.text === "Reflect") &&
      (callee.name.text === "defineProperty" || callee.name.text === "defineProperties")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * (#2175 V2-S3b-1) Can a branded builtin's `.prototype` reach the DYNAMIC
 * reader as a runtime value in this module? Two shapes:
 *
 *  - `<BrandedBuiltin>.prototype` in VALUE position — anything OTHER than
 *    being the object of a further property/element access (`X.prototype.m`
 *    and `X.prototype[k]` both resolve syntactically today and are unaffected
 *    by the store). `var p = RegExp.prototype`, `f(Array.prototype)`,
 *    `return Map.prototype`, `[String.prototype]` all qualify.
 *  - ANY `Object.getPrototypeOf(…)` call. This is deliberately
 *    receiver-agnostic: the dominant idiom is
 *    `var TypedArray = Object.getPrototypeOf(Int8Array)` followed by
 *    `TypedArray.prototype.<member>` (harness/testTypedArray.js:64), where the
 *    proto never appears syntactically at all. Narrowing this to a
 *    branded-ctor argument would miss every alias of that harness variable, and
 *    the flag only RESERVES helpers — the real per-brand cost is separately
 *    gated on that brand's `$NativeProto` actually being materialized.
 *
 * Read-only by construction, so it is disjoint from `isProtoIndexWrite` /
 * `isProtoNamedWrite`; it never sets `protoIndexDirty` and therefore never
 * disables the HOF hole visit-skip or the typed element lanes.
 */
function isProtoMemberValueUse(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "getPrototypeOf" &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === "Object" || callee.expression.text === "Reflect")
    ) {
      return true;
    }
  }
  if (!isBrandedBuiltinPrototypeExpr(node)) return false;
  const parent: ts.Node | undefined = node.parent;
  if (parent === undefined) return true;
  // Object-of-a-member-access ⇒ the syntactic path handles it; not a value use.
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    unwrapExpr(parent.expression) === unwrapExpr(node)
  ) {
    return false;
  }
  // `Object.defineProperty(X.prototype, …)` / `defineProperties` /
  // `Reflect.defineProperty` — the proto is a WRITE TARGET here, not a value
  // being read reflectively. `isProtoNamedWrite` already covers this exact
  // shape by setting `protoNamedDirty`, which reserves the same store; letting
  // it ALSO set `protoMemberDirty` would seed member closures into a plain
  // polyfill module that never reads a proto dynamically — wasted bytes, and
  // the seeder's extra functions can perturb IR eligibility (#2855 ratchet).
  // NO measurement is claimed for this rule: it was first written citing
  // `tests/issue-4176.test.ts` "prepared IR for-in shares prototype-companion
  // enumeration", which in fact fails on unmodified `origin/main` @ 9e17d34f3
  // as well (1 failed / 12 passed), so that test is NOT evidence here and was
  // not caused by this flag. Deliberately narrow: `getOwnPropertyDescriptor(
  // X.prototype, k)` and every other call-argument position still counts as a
  // value use, because those genuinely hand the proto to a dynamic reader.
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.length > 0 &&
    unwrapExpr(parent.arguments[0]!) === unwrapExpr(node)
  ) {
    const callee = parent.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === "Object" || callee.expression.text === "Reflect") &&
      (callee.name.text === "defineProperty" || callee.name.text === "defineProperties")
    ) {
      return false;
    }
  }
  return true;
}

function isProtoIndexWrite(node: ts.Node): boolean {
  // Object.defineProperty(Array.prototype, …) / Object.defineProperties /
  // Reflect.defineProperty — first argument is Array.prototype.
  if (ts.isCallExpression(node) && node.arguments.length > 0 && isArrayOrObjectPrototypeExpr(node.arguments[0])) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === "Object" || callee.expression.text === "Reflect") &&
      (callee.name.text === "defineProperty" || callee.name.text === "defineProperties")
    ) {
      return true;
    }
  }
  // Array.prototype[…] = … — element-access assignment target (any assignment op).
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    ts.isElementAccessExpression(unwrapExpr(node.left)) &&
    isArrayOrObjectPrototypeExpr((unwrapExpr(node.left) as ts.ElementAccessExpression).expression)
  ) {
    return true;
  }
  return false;
}

/**
 * Lazily register the `$Hole` struct type and the `$__hole` singleton global.
 * Idempotent — returns the absolute global index, caches both the type index
 * (`ctx.holeTypeIdx`) and the global index (`ctx.holeGlobalIdx`).
 *
 * Registered **late** (during body compilation, after class collection) and
 * **once**, per `project_type_index_shift_and_deadelim`: pushing a struct type
 * mid-class-collection would desync class struct typeidxs. Both call sites
 * (literal store + element read) run inside `compileDeclarations`, so the type
 * is always appended after the class struct types are fixed.
 *
 * The global is **immutable** with a constant `struct.new $Hole` initializer —
 * a valid WasmGC constant init expression for a zero-field immutable struct, so
 * `$Hole`'s ref identity is fixed at instantiation and every `global.get`
 * yields the same ref (required for `ref.test`/`ref.eq` identity). A const init
 * never contains a `call`, so it is immune to late-import index shifts.
 */
export function ensureHoleType(ctx: CodegenContext): number {
  if (ctx.holeGlobalIdx !== undefined) return ctx.holeGlobalIdx;

  // $Hole = (struct) — zero fields, immutable.
  const holeTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: "Hole", fields: [] } as StructTypeDef);
  ctx.holeTypeIdx = holeTypeIdx;
  ctx.structMap.set("Hole", holeTypeIdx);
  ctx.typeIdxToStructName.set(holeTypeIdx, "Hole");
  ctx.structFields.set("Hole", []);

  // (global $__hole (ref $Hole) (struct.new $Hole)) — immutable singleton.
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__hole",
    type: { kind: "ref", typeIdx: holeTypeIdx },
    mutable: false,
    init: [{ op: "struct.new", typeIdx: holeTypeIdx }],
  });
  ctx.holeGlobalIdx = globalIdx;
  return globalIdx;
}

/**
 * Push the `$Hole` sentinel as an `externref`, ready to store into an
 * externref-element vec slot (`array.new_fixed` / `array.set`).
 * Stack: `[] → [externref]`.
 */
export function emitHoleSentinel(ctx: CodegenContext, fctx: FunctionContext): void {
  fctx.body.push(...holeSentinelInstrs(ctx));
}

/** Detached form of {@link emitHoleSentinel} for helper and branch builders. */
export function holeSentinelInstrs(ctx: CodegenContext): Instr[] {
  const globalIdx = ensureHoleType(ctx);
  return [{ op: "global.get", index: globalIdx }, { op: "extern.convert_any" }];
}

/**
 * Read-boundary mapping: if the externref on the stack is the `$Hole` sentinel,
 * replace it with `undefined`; otherwise leave it unchanged.
 * Stack: `[externref] → [externref]`.
 *
 * The single most important correctness rule for sparse arrays — the sentinel
 * must never leak past a value-producing read. Reusable across S1 (element read,
 * join) and the later HOF / destructuring slices.
 */
export function emitHoleToUndefined(ctx: CodegenContext, fctx: FunctionContext): void {
  for (const instr of holeToUndefinedInstrs(ctx, fctx)) fctx.body.push(instr);
}

/**
 * Detached-`Instr[]` form of {@link emitHoleToUndefined}, for call sites that
 * assemble a callback-arg / loop-body instruction list off `fctx.body` (e.g.
 * `buildClosureCallInstrs`). Allocates the scratch temp via `fctx` and resolves
 * the `undefined` value up front (flushing any late-import shift into the
 * current body BEFORE the funcIdx is baked into the returned instrs), so the
 * sequence can be spliced anywhere. Stack: `[externref] → [externref]`.
 */
export function holeToUndefinedInstrs(ctx: CodegenContext, fctx: FunctionContext): Instr[] {
  // Callers gate on `ctx.usesArrayHoles`, so register `$Hole` here if a literal
  // store hasn't yet — function compilation order is not source order, and the
  // read of `a[i]` can be compiled before the `[1, , 3]` that introduces the
  // sentinel. Registering at the read site keeps the `ref.test` typeidx valid
  // either way (still after class collection — index-shift-safe).
  ensureHoleType(ctx);
  const holeTypeIdx = ctx.holeTypeIdx;
  const tmp = allocTempLocal(fctx, { kind: "externref" });

  // Resolve the `undefined` push now, flushing any late-import index shift into
  // `fctx.body` before the funcIdx is baked into the detached `then` arm.
  const undefBody: Instr[] = [];
  const saved = fctx.body;
  fctx.body = undefBody;
  emitUndefined(ctx, fctx);
  fctx.body = saved;

  return [
    { op: "local.tee", index: tmp },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: holeTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: undefBody,
      else: [{ op: "local.get", index: tmp }],
    },
  ];
}

/**
 * Instruction list form of the hole test for the array-join fold, where the
 * element-to-string conversion is assembled as a detached `Instr[]` (not pushed
 * onto `fctx.body`). Given the element `externref` already on the (virtual)
 * stack, returns instrs that leave `i32` = 1 iff the element is `$Hole`.
 * Caller wraps `whenHole` / `whenPresent` in the `if`. Registers `$Hole` on
 * demand (caller gates on `usesArrayHoles`), so the `ref.test` typeidx is valid
 * even if no hole-literal has been compiled yet in this module.
 */
export function holeTestInstrs(ctx: CodegenContext): Instr[] {
  ensureHoleType(ctx);
  const holeTypeIdx = ctx.holeTypeIdx;
  return [{ op: "any.convert_extern" }, { op: "ref.test", typeIdx: holeTypeIdx }];
}
