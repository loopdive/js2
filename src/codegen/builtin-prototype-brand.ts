// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3610) **Static** receiver brand gate for `<Builtin>.prototype.<member>`.
 *
 * ## The defect this closes
 *
 * Nearly every native builtin arm under `src/codegen/` discriminates its
 * receiver by the **TypeScript type name** (`objType.getSymbol()?.name` /
 * `ctx.oracle.builtinReceiverOf`). For a `<Ctor>.prototype` receiver TypeScript
 * reports the *instance* type name — `Uint8ClampedArray.prototype` has type
 * `Uint8ClampedArray`, `Date.prototype` has type `Date` — because lib.d.ts
 * declares `interface DateConstructor { prototype: Date }`. So the arms treat
 * the **prototype object** as an **instance** and emit the instance lowering:
 * an unconditional `ref.cast` to the backing vec/struct (→ uncatchable
 * `illegal cast`) or a bare `struct.get` on a null receiver (→ uncatchable
 * `null reference`).
 *
 * A trap is strictly worse than a wrong answer: it aborts the whole module and
 * escapes `try`/`catch`, so `assert.throws(TypeError, …)` can never observe the
 * TypeError the spec requires.
 *
 * ## Why a STATIC gate is the right general mechanism here
 *
 * Every member in the tables below begins with `RequireInternalSlot(O, [[…]])`
 * (or `ValidateTypedArray` / `thisTimeValue`), and a builtin's `.prototype` is
 * an **ordinary object that provably never carries that slot** (§23.2.7
 * "The %TypedArray% prototype object … is not a TypedArray instance",
 * §21.4.4 "The Date prototype object … is not a Date instance", …). So
 * `<Ctor>.prototype.<member>` is a *compile-time-decidable* unconditional
 * TypeError. We compile the brand check away (project principle: compile away,
 * don't emulate) instead of paying a runtime `ref.test` on every instance call.
 *
 * The complementary DYNAMIC gate — `ref.test` + catchable TypeError for a
 * receiver that is only known at runtime not to carry the slot — already
 * exists as {@link ./receiver-brand.ts}'s `emitReceiverBrandCheck` and is used
 * by the reflective closure bodies (`gOPD(X.prototype, m).get.call(recv)`).
 * The two are siblings, not alternatives: this one covers the *syntactic*
 * prototype receiver that never reaches a reflective closure at all.
 *
 * ## Shadow safety
 *
 * The gate fires only when the base identifier's own type symbol is the lib
 * `<Name>Constructor` interface (`declare var Date: DateConstructor`). A
 * user-declared `class Date {}` types its identifier as `typeof Date` with
 * symbol name `Date`, so it never matches — the gate cannot hijack a
 * user-defined class that happens to share a builtin name. This is strictly
 * tighter than the `getSymbol()?.name` test the surrounding arms use, and it
 * is answered entirely through `ctx.oracle` (no raw checker use).
 *
 * ## Lane scope
 *
 * `noJsHost` only (standalone / WASI). In JS-host mode these reads/calls
 * already route to the host getter, which throws a genuine host TypeError;
 * re-routing them to a wasm-constructed one would be a behavioural change to a
 * lane that is not broken. See #3610.
 *
 * ---
 *
 * ## (#4076) Sibling arm: the BORROWED receiver
 *
 * The gate above answers "the receiver **is** `<Ctor>.prototype`". This module
 * also hosts the complementary question: `<Ctor>.prototype.<m>.call(recv, …)`,
 * where the `this` value is the *first argument* rather than the callee's base.
 *
 * The defect is the same shape as #4017 — **a static path that knows the answer
 * degrades to a silent wrong answer once its vehicle is gone.** In JS-host mode
 * the borrowed call rides the `__proto_method_call` host import, and the JS
 * engine performs `RequireObjectCoercible` / `IsCallable` for us. Standalone has
 * no host, so `calls.ts` either synthesises a bare `recv.<m>(…)` or falls
 * through to a refuse-loud `reportError`. Neither survives:
 *
 *   - the synthesised bare call constant-folds an answer (`false` for
 *     `hasOwnProperty`, the receiver itself for `valueOf`) without ever running
 *     step 1 of the spec algorithm;
 *   - **the refuse-loud is not loud.** `reportError` is emitted WITHOUT
 *     `sticky`, and `compileExpressionBody`'s `null`-result unwind
 *     (`rollbackSpeculative`, expressions.ts) DISCARDS non-sticky diagnostics
 *     and substitutes `pushDefaultValue`. Measured on `--target standalone`:
 *     `Object.prototype.valueOf.call(undefined)` compiles clean, with zero
 *     imports, to `global.get $undefined; extern.convert_any; drop` — the
 *     default-value placeholder. The refusal was raised and then erased.
 *
 * So the standalone lane answers `undefined` where the spec demands a TypeError,
 * and every `assert.throws(TypeError, …)` over the shape reports
 * "Expected a TypeError to be thrown but no exception was thrown at all".
 *
 * The fix keeps the #4017 discipline: **decide statically, throw statically.**
 * We fire ONLY on a receiver whose invalidity is a *proof*, never a guess:
 *
 *   - `Object.prototype.<m>` — step 1/2 is `ToObject(this value)`, so the
 *     receiver must be **provably nullish**: the `null` keyword, or an
 *     expression the oracle types exactly `undefined`/`null`. A primitive is
 *     NOT invalid here (`hasOwnProperty.call("ab","0")` is legitimately `true`).
 *   - `Function.prototype.<m>` — step 2 is `IsCallable(func)`, so additionally a
 *     **syntactically** non-callable literal (`{}`, `[]`, `/re/`, `"s"`, `1`,
 *     `true`) qualifies. Syntax, not inference: an `object`-typed identifier may
 *     hold a function at run time under `allowJs`, so identifiers are refused.
 *
 * A widened `any`, an unresolvable identifier, or anything merely *nullable*
 * falls through untouched, so the gate can never manufacture a throw for a
 * receiver that might be valid at run time. This is deliberately NARROWER than
 * `resolvesToNonConstructableValue`, which also claims `.bind()`/`.call()`/
 * `.apply()` RESULTS — sound only behind a runtime re-check, because a bound
 * function IS constructable when its target is, and `f.call(x)` can return a
 * constructor. That over-claim is not inherited here.
 */
import ts from "typescript";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError, noJsHost } from "./js-errors.js";
import { compileExpression } from "./shared.js"; // (#4556)

/** WasmGC `none` bottom heap type (signed LEB −18) — `ref.null none`, the
 *  canonical `anyref` null (mirrors receiver-brand.ts / map-runtime.ts). */
const NONE_HEAP = -18;

const TYPED_ARRAY_CTORS = [
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
] as const;

/**
 * Accessor getters whose spec step 1–2 is `RequireInternalSlot` — reading one
 * off the constructor's `.prototype` object throws TypeError unconditionally.
 *
 * Deliberately EXCLUDED — these have an explicit spec carve-out that returns a
 * value instead of throwing when `this` is the prototype, so a gate here would
 * be a wrong answer:
 *   - `RegExp.prototype.{source,flags,global,…}` (§22.2.6: `SameValue(R, %RegExp.prototype%)`
 *     → `"(?:)"` / `""` / `undefined`).
 *   - `Array.prototype.length` / `String.prototype.length` — own data properties
 *     of the prototype object itself (0), not brand-checked accessors.
 */
const BRANDED_PROTO_GETTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ...TYPED_ARRAY_CTORS.map(
    (name) => [name, new Set(["buffer", "byteLength", "byteOffset", "length"])] as [string, ReadonlySet<string>],
  ),
  // §25.1.6 — get ArrayBuffer.prototype.{byteLength,maxByteLength,resizable,detached}
  ["ArrayBuffer", new Set(["byteLength", "maxByteLength", "resizable", "detached"])],
  // §25.2.5 — get SharedArrayBuffer.prototype.{byteLength,maxByteLength,growable}
  ["SharedArrayBuffer", new Set(["byteLength", "maxByteLength", "growable"])],
  // §25.3.4 — get DataView.prototype.{buffer,byteLength,byteOffset}
  ["DataView", new Set(["buffer", "byteLength", "byteOffset"])],
]);

/**
 * §23.2.3 — every `%TypedArray%.prototype` method starts at
 * `ValidateTypedArray(this)` → `RequireInternalSlot(O, [[TypedArrayName]])`.
 *
 * `toString` / `toLocaleString` are EXCLUDED: `%TypedArray%.prototype.toString`
 * IS `Array.prototype.toString` (§23.2.3.32), a generic function, so gating it
 * would be gating a member the prototype legitimately shares with Array.
 * (It still throws — via the `join` it forwards to — just not from here.)
 */
const TYPED_ARRAY_PROTO_METHODS: ReadonlySet<string> = new Set([
  "at",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "reverse",
  "set",
  "slice",
  "some",
  "sort",
  "subarray",
  "toReversed",
  "toSorted",
  "values",
  "with",
]);

/**
 * §21.4.4 — every `Date.prototype` method starts at `thisTimeValue(this)` (or
 * `ToObject` + an inherited `valueOf` that does), which throws TypeError when
 * `this` has no [[DateValue]]. `Date.prototype` provably has none. Mirrors the
 * `DATE_METHODS` set in `expressions/builtins.ts` (`compileDateMethodCall`),
 * which is exactly the set that lowers to a `struct.get $Date` on the receiver
 * — i.e. exactly the set that traps `null reference` today.
 *
 * Inherited `Object.prototype` members (`hasOwnProperty`, `isPrototypeOf`, …)
 * are NOT here: they are generic and must keep working on a prototype object.
 *
 * RegExp is absent on purpose: `RegExp.prototype.test()` already throws a
 * catchable TypeError via the native RegExp lowering, and `RegExp.prototype.exec()`
 * is claimed by an earlier dispatch arm that this gate never sees (it returns a
 * wrong value rather than trapping — a correctness gap, not a trap; tracked in
 * #3610). Its accessors additionally have the §22.2.6 prototype carve-out
 * (`source` → `"(?:)"`), so the family is not a uniform "always throws" one.
 */
const BRANDED_PROTO_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ...TYPED_ARRAY_CTORS.map((name) => [name, TYPED_ARRAY_PROTO_METHODS] as [string, ReadonlySet<string>]),
  // §25.1.6 / §25.2.5 — RequireInternalSlot([[ArrayBufferData]]).
  ["ArrayBuffer", new Set(["slice", "resize", "transfer", "transferToFixedLength", "transferToImmutable"])],
  ["SharedArrayBuffer", new Set(["slice", "grow"])],
  // §24.1.3 / §24.2.4 — RequireInternalSlot([[MapData]] / [[SetData]]).
  ["Map", new Set(["get", "set", "has", "delete", "clear", "forEach", "entries", "keys", "values"])],
  [
    "Set",
    new Set([
      "add",
      "has",
      "delete",
      "clear",
      "forEach",
      "entries",
      "keys",
      "values",
      "union",
      "intersection",
      "difference",
      "symmetricDifference",
      "isSubsetOf",
      "isSupersetOf",
      "isDisjointFrom",
    ]),
  ],
  ["WeakMap", new Set(["get", "set", "has", "delete"])],
  ["WeakSet", new Set(["add", "has", "delete"])],
  [
    "Date",
    new Set([
      "getTime",
      "valueOf",
      "getFullYear",
      "getMonth",
      "getDate",
      "getHours",
      "getMinutes",
      "getSeconds",
      "getMilliseconds",
      "getDay",
      "setTime",
      "setMilliseconds",
      "setSeconds",
      "setMinutes",
      "setHours",
      "setUTCMilliseconds",
      "setUTCSeconds",
      "setUTCMinutes",
      "setUTCHours",
      "setDate",
      "setUTCDate",
      "setMonth",
      "setUTCMonth",
      "setFullYear",
      "setUTCFullYear",
      "setYear",
      "getYear",
      "getTimezoneOffset",
      "getUTCFullYear",
      "getUTCMonth",
      "getUTCDate",
      "getUTCHours",
      "getUTCMinutes",
      "getUTCSeconds",
      "getUTCMilliseconds",
      "getUTCDay",
      "toISOString",
      "toJSON",
      "toString",
      "toDateString",
      "toTimeString",
      "toLocaleDateString",
      "toLocaleTimeString",
      "toLocaleString",
      "toUTCString",
      "toGMTString",
    ]),
  ],
]);

/**
 * When `recv` is syntactically `<Id>.prototype` and `<Id>` is the LIB global
 * constructor of that name, return the constructor name; otherwise undefined.
 *
 * The lib-identity test is `declaredNameOf(<Id>) === "<Id>Constructor"` — the
 * uniform lib.d.ts shape (`declare var Date: DateConstructor`). A user
 * `class Date {}` gives `declaredNameOf` === `"Date"`, so it is rejected.
 */
export function builtinPrototypeReceiver(ctx: CodegenContext, recv: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(recv) || recv.name.text !== "prototype") return undefined;
  const base = recv.expression;
  if (!ts.isIdentifier(base)) return undefined;
  const name = base.text;
  return ctx.oracle.declaredNameOf(base) === `${name}Constructor` ? name : undefined;
}

/**
 * Emit the unconditional catchable TypeError plus a typed, unreachable sentinel
 * so the surrounding expression keeps its static ValType and the stack stays
 * well-typed (`throw` is stack-polymorphic, but the emitters downstream of a
 * property read still reason about a concrete result type).
 */
function emitBrandThrowWithSentinel(
  ctx: CodegenContext,
  fctx: FunctionContext,
  message: string,
  result: ValType,
): ValType {
  emitThrowTypeError(ctx, fctx, message);
  for (const instr of sentinelInstrs(result)) fctx.body.push(instr);
  return result;
}

/** A zero/null value of `t`, emitted after the (terminal) throw purely to keep
 *  the surrounding expression's static ValType and the stack well-typed. */
function sentinelInstrs(t: ValType): Instr[] {
  switch (t.kind) {
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    case "externref":
      return [{ op: "ref.null.extern" }];
    case "funcref":
      return [{ op: "ref.null.func" }];
    case "anyref":
      return [{ op: "ref.null", typeIdx: NONE_HEAP }];
    case "ref":
      return [{ op: "ref.null", typeIdx: t.typeIdx }, { op: "ref.as_non_null" }];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: t.typeIdx }];
    default:
      return [{ op: "f64.const", value: 0 }];
  }
}

/**
 * Property-read arm: `<Builtin>.prototype.<brandedGetter>`.
 *
 * Returns the result ValType when the gate fired (a TypeError throw was
 * emitted), or `undefined` to fall through to the normal dispatch chain.
 *
 * The receiver is NOT compiled: it is syntactically an identifier plus a
 * `.prototype` read, which is observably side-effect-free, so skipping it
 * preserves evaluation order.
 */
export function tryBuiltinPrototypeGetterBrandThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (!noJsHost(ctx) && !ctx.strictNoHostImports) return undefined;
  const ctor = builtinPrototypeReceiver(ctx, expr.expression);
  if (ctor === undefined) return undefined;
  if (BRANDED_PROTO_GETTERS.get(ctor)?.has(propName) !== true) return undefined;
  const result: ValType = propName === "buffer" ? { kind: "externref" } : ctx.fast ? { kind: "i32" } : { kind: "f64" };
  return emitBrandThrowWithSentinel(
    ctx,
    fctx,
    `TypeError: Method get ${ctor}.prototype.${propName} called on incompatible receiver ${ctor}.prototype`,
    result,
  );
}

/**
 * Method-call arm: `<Builtin>.prototype.<brandedMethod>(...args)`.
 *
 * Arguments ARE compiled (and dropped): per §13.3.6.1 EvaluateCall runs
 * ArgumentListEvaluation BEFORE Call(), so `Date.prototype.setFullYear(f())`
 * must still observe `f()`'s side effects before the TypeError.
 *
 * `compileArg` is injected to avoid a module cycle with `expressions.ts`.
 */
export function tryBuiltinPrototypeMethodBrandThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  compileArg: (arg: ts.Expression) => ValType | null,
  expectedType?: ValType,
): ValType | undefined {
  if (!noJsHost(ctx) && !ctx.strictNoHostImports) return undefined;
  // (#4556) `<Builtin>.prototype.isPrototypeOf(V)` is not a brand THROW — it
  // has a real answer. Handled here so the dispatch site stays untouched.
  const isProto = tryBuiltinPrototypeIsPrototypeOf(ctx, fctx, expr, propAccess);
  if (isProto !== undefined) return isProto;
  const ctor = builtinPrototypeReceiver(ctx, propAccess.expression);
  if (ctor === undefined) return undefined;
  const method = propAccess.name.text;
  if (BRANDED_PROTO_METHODS.get(ctor)?.has(method) !== true) return undefined;
  for (const arg of expr.arguments) {
    const t = compileArg(arg);
    if (t !== null) fctx.body.push({ op: "drop" });
  }
  // Honour the contextual type when the caller has one: these methods return
  // arrays / views / iterators, and handing back an f64 where a `(ref $vec)`
  // was requested would force a coercion the (dead) sentinel cannot satisfy.
  return emitBrandThrowWithSentinel(
    ctx,
    fctx,
    `TypeError: Method ${ctor}.prototype.${method} called on incompatible receiver ${ctor}.prototype`,
    expectedType ?? (ctx.fast ? { kind: "i32" } : { kind: "f64" }),
  );
}

/**
 * (#4556) Method-call arm: `<Builtin>.prototype.isPrototypeOf(V)`.
 *
 * §20.1.3.3 is "walk V's prototype chain looking for O". With
 * `O = <Ctor>.prototype` that is exactly OrdinaryHasInstance(<Ctor>, V) minus
 * the IsCallable check a lib constructor always passes — i.e. the SAME question
 * `V instanceof <Ctor>` already answers, and standalone already answers it
 * natively (`[1,2] instanceof Array` is `true`, `{} instanceof Array` is
 * `false`). So we compile the call away into the `instanceof` lowering rather
 * than materialising a prototype OBJECT that standalone does not have.
 *
 * Without this the receiver `Array.prototype` compiled to a null ref and the
 * call trapped with "Cannot access property on null or undefined" — an
 * uncatchable abort where the spec wants `true` (test262
 * `built-ins/Array/{S15.4.1_A1.1_T3, S15.4.2.1_A1.1_T3, length/S15.4.2.2_A1.1_T3}`).
 *
 * `Object` is DELIBERATELY EXCLUDED. Its borrowed/direct spellings already
 * route to the native open-object chain walk `__isPrototypeOf`, which walks the
 * REAL chain and is strictly more faithful than the brand equivalence here —
 * `Object.prototype.isPrototypeOf(new String("a"))` is `true` per spec, and a
 * brand test would not say so. Never shadow a working path with a weaker one.
 *
 * Reached from {@link tryBuiltinPrototypeMethodBrandThrow}, which is already
 * the first arm on the `<Builtin>.prototype.<m>(…)` dispatch — hanging it there
 * keeps the call site unchanged.
 */
function tryBuiltinPrototypeIsPrototypeOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | undefined {
  if (propAccess.name.text !== "isPrototypeOf") return undefined;
  const ctor = builtinPrototypeReceiver(ctx, propAccess.expression);
  if (ctor === undefined || ctor === "Object") return undefined;
  const value = expr.arguments[0];
  if (value === undefined) {
    // §20.1.3.3 step 1 — a missing argument is not an Object, so `false`.
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32", boolean: true };
  }
  // `<Ctor>.prototype`'s own base identifier IS the constructor reference.
  const ctorRef = (propAccess.expression as ts.PropertyAccessExpression).expression;
  const synth = ts.factory.createBinaryExpression(value, ts.SyntaxKind.InstanceOfKeyword, ctorRef);
  ts.setTextRange(synth, expr);
  (synth as unknown as { parent: ts.Node }).parent = expr.parent;
  // Routed through the general expression compiler, NOT `compileInstanceOf`
  // directly: the BUILTIN `instanceof` arms (`resolveInstanceOfRHS` and the
  // host / object-family / wrapper lowerings) live ABOVE it in expressions.ts,
  // and `compileInstanceOf` alone only knows USER class struct tags — it
  // answered `false` for `Array() instanceof Array`.
  const r = compileExpression(ctx, fctx, synth);
  return r === null ? undefined : r;
}

// ───────────────────────── (#4076) borrowed-receiver arm ─────────────────────

/**
 * `<Ctor>.prototype.<method>` pairs whose spec algorithm rejects a nullish
 * `this` in **step 1 or 2**, before any observable step. The value is the
 * result ValType to hand back for the (dead) sentinel after the throw.
 *
 * Object.prototype — §20.1.3, step "Let O be ? ToObject(this value)":
 *   valueOf (§20.1.3.7 s1) · toLocaleString (§20.1.3.5 — `Invoke(O,"toString")`
 *   → GetV → ToObject) · hasOwnProperty (§20.1.3.2 s2) ·
 *   propertyIsEnumerable (§20.1.3.4 s2).
 *
 * Function.prototype — §20.2.3, step "If IsCallable(func) is false, throw a
 * TypeError exception": call (s2) · apply (s2) · bind (s2) · toString (s2/s5).
 *
 * DELIBERATELY ABSENT, each for a spec reason — adding one would be a wrong
 * answer, not a missing one:
 *
 *   - `Object.prototype.toString` — §20.1.3.6 steps 1–2 return
 *     `"[object Undefined]"` / `"[object Null]"` for a nullish `this`. It is the
 *     one Object.prototype method that must NOT throw here.
 *   - `Object.prototype.isPrototypeOf` — §20.1.3.3 step 1 is
 *     "If V is not an Object, return false", which runs BEFORE ToObject(this).
 *     Whether it throws depends on the ARGUMENT, not the receiver, so a
 *     receiver-only gate cannot decide it.
 *   - `String.prototype.*` — already routed through
 *     `emitBorrowedStringReceiverToString` (#3254), which performs
 *     RequireObjectCoercible + ToString on the borrowed receiver. Duplicating it
 *     here would shadow a working path.
 *   - the `BRANDED_PROTO_METHODS` ctors above (Map/Set/WeakMap/WeakSet/Date/
 *     ArrayBuffer/TypedArray) — their `RequireInternalSlot` does reject a
 *     nullish `this`, but the borrowed form ALREADY throws correctly today
 *     (36 `this-not-object-throw*.js` files pass). They are a follow-on with
 *     a 36-file at-risk pool and a 1-file yield; not worth coupling to this.
 */
const NULLISH_THIS_THROWS: ReadonlyMap<string, ReadonlyMap<string, ValType>> = new Map<
  string,
  ReadonlyMap<string, ValType>
>([
  [
    "Object",
    new Map<string, ValType>([
      ["valueOf", { kind: "externref" }],
      ["toLocaleString", { kind: "externref" }],
      ["hasOwnProperty", { kind: "i32", boolean: true }],
      ["propertyIsEnumerable", { kind: "i32", boolean: true }],
    ]),
  ],
  [
    "Function",
    new Map<string, ValType>([
      ["toString", { kind: "externref" }],
      ["call", { kind: "externref" }],
      ["apply", { kind: "externref" }],
      ["bind", { kind: "externref" }],
    ]),
  ],
]);

/**
 * Is `expr` **provably** the `undefined` or `null` value?
 *
 * Proof, not guess. `typeFactOf` reports `undefined`/`null` only for a type that
 * IS exactly that — TypeScript never widens an `any`, an unresolvable
 * identifier, or a merely-nullable union down to them. A shadowing
 * `var undefined = {}` retypes the identifier, so the gate correctly declines.
 * The bare `null` keyword is accepted syntactically because a `null` literal in
 * a `strictNullChecks: false` program types as `any`.
 *
 * `void`-typed expressions are EXCLUDED on purpose: under `allowJs` a JS
 * function with no `return` infers `void`, but nothing prevents it from
 * returning a value at run time, so `void` is not a proof.
 */
function provablyNullishReceiver(ctx: CodegenContext, expr: ts.Expression): boolean {
  const e = skipParens(expr);
  if (e.kind === ts.SyntaxKind.NullKeyword) return true;
  const fact = ctx.oracle.typeFactOf(e);
  return fact.kind === "undefined" || fact.kind === "null";
}

function skipParens(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/**
 * Is `expr` **syntactically** a value that can never be callable?
 *
 * This is a SYNTAX fact, not a type inference: an object literal, an array
 * literal, a regular-expression literal and the primitive literals each
 * evaluate to a value with no [[Call]] slot, in every program, whatever
 * TypeScript thinks the type is. That distinction matters under `allowJs` +
 * `skipSemanticDiagnostics`, where an `object`-typed *identifier* may well hold
 * a function at run time — which is exactly why identifiers are NOT accepted
 * here. Used only for the `Function.prototype` family, whose step 2 is
 * "If IsCallable(func) is false, throw a TypeError exception" (§20.2.3).
 */
function syntacticallyNotCallable(expr: ts.Expression): boolean {
  const e = skipParens(expr);
  return (
    ts.isObjectLiteralExpression(e) ||
    ts.isArrayLiteralExpression(e) ||
    ts.isRegularExpressionLiteral(e) ||
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword
  );
}

/**
 * Call-expression arm: `<Ctor>.prototype.<method>.call(recv, …args)` where
 * `recv` is provably nullish and `<method>`'s step 1/2 rejects it.
 *
 * Returns the result ValType when the gate fired, or `undefined` to fall
 * through to the normal dispatch chain.
 *
 * **Evaluation order.** §13.3.6.1 EvaluateCall runs ArgumentListEvaluation
 * before Call, so every argument of the OUTER `.call(...)` — the borrowed
 * receiver included — is evaluated before `Function.prototype.call` ever
 * invokes the target. We therefore compile all arguments in source order and
 * drop each before throwing, so their side effects are preserved.
 *
 * **Known incompleteness, stated rather than hidden.** For
 * `hasOwnProperty`/`propertyIsEnumerable` the spec runs `ToPropertyKey(V)`
 * BEFORE `ToObject(this)` (§20.1.3.2 s1–s2), so a key whose `toString` throws
 * must surface THAT error, not our TypeError. Compiling the key argument
 * evaluates the expression but does not apply ToPropertyKey, so
 * `hasOwnProperty/topropertykey_before_toobject.js` stays failing (it fails
 * today too — this is not a regression, and it is excluded from the claimed
 * flips). Every trigger file that flips passes a plain string literal, for which
 * ToPropertyKey is the identity.
 *
 * `compileArg` is injected to avoid a module cycle with `expressions.ts`.
 */
export function tryBorrowedPrototypeNullishThisThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  /** The callee's base — `<Ctor>.prototype.<method>` in `<…>.call(recv, …)`. */
  borrowedMethod: ts.Expression,
  compileArg: (arg: ts.Expression) => ValType | null,
  expectedType?: ValType,
): ValType | undefined {
  if (!noJsHost(ctx) && !ctx.strictNoHostImports) return undefined;
  let base: ts.Expression = borrowedMethod;
  while (ts.isParenthesizedExpression(base)) base = base.expression;
  if (!ts.isPropertyAccessExpression(base)) return undefined;
  const method = base.name.text;
  // Shadow safety: the base must be the LIB constructor (`declare var Object:
  // ObjectConstructor`), not a user `class Object {}` — same test as the
  // prototype-receiver arm above, and strictly tighter than the surrounding
  // dispatch's raw identifier-text comparison.
  const ctor = builtinPrototypeReceiver(ctx, base.expression);
  if (ctor === undefined) return undefined;
  const result = NULLISH_THIS_THROWS.get(ctor)?.get(method);
  if (result === undefined) return undefined;
  const receiver = expr.arguments[0];
  if (receiver === undefined) return undefined;
  // Object.prototype: only `RequireObjectCoercible` fails statically — a
  // primitive receiver is perfectly legal there (`hasOwnProperty.call("ab","0")`
  // is `true`). Function.prototype: step 2 is `IsCallable`, so a syntactically
  // non-callable literal fails it too.
  const invalidThis =
    provablyNullishReceiver(ctx, receiver) || (ctor === "Function" && syntacticallyNotCallable(receiver));
  if (!invalidThis) return undefined;

  for (const arg of expr.arguments) {
    const t = compileArg(arg);
    if (t !== null) fctx.body.push({ op: "drop" });
  }
  const what =
    ctor === "Function"
      ? `Function.prototype.${method} called on non-callable receiver`
      : `Object.prototype.${method} called on null or undefined`;
  return emitBrandThrowWithSentinel(ctx, fctx, `TypeError: ${what}`, expectedType ?? result);
}
