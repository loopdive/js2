// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4484 C) Strict-mode §10.1.9 [[Set]] failure on a BUILTIN's non-writable own
 * data property — `Math.PI = 20`, `Function.length = 42`.
 *
 * ## The measured defect
 *
 * `Object.defineProperty`-created non-writable properties already throw in strict
 * code (#3872, `tryEmitNonWritablePropertyWrite` in assignment.ts), but that arm
 * reads `ctx.nonWritableExternKeys` — a mirror of what the PROGRAM defined. The
 * properties the SPEC declares non-writable on a builtin were never in it, so a
 * strict write to one silently did nothing: measured
 * `assert.throws(TypeError, function () { Math.PI = 20; })` → "no exception was
 * thrown at all" on `11.13.1-4-28gs`, `-29gs` and `11.13.1-4-6-s`.
 *
 * The SLOPPY behaviour was already right and is unchanged: `Math.PI = 3` is
 * dropped at collection (`builtin-write-keeps.ts` excludes the own static
 * surface), which is what §10.1.9.2 step 2.b prescribes for non-strict code.
 * This module only adds the strict-mode throw on top of it.
 *
 * ## What is in the table, and why nothing else is
 *
 * Only own data properties the spec fixes as `[[Writable]]: false` on a value
 * that is ALWAYS the intrinsic:
 *
 * | property                       | clause     | attributes                 |
 * | ------------------------------ | ---------- | -------------------------- |
 * | `Math.{PI,E,LN2,…}`            | §21.3.1    | `{w:f, e:f, c:f}`          |
 * | `Number.{MAX_VALUE,NaN,…}`     | §21.1.2    | `{w:f, e:f, c:f}`          |
 * | `<Ctor>.length`, `<Ctor>.name` | §20.2.4.1/2| `{w:f, e:f, c:t}`          |
 * | `<Ctor>.prototype`             | §20.2.4.3  | `{w:f, e:f, c:f}`          |
 *
 * `length`/`name`/`prototype` are admitted only for names in `BUILTIN_CTOR_ARITY`
 * — the same table `pushBuiltinCtorOwnPropSeed` uses to decide a carrier IS a
 * constructor, so the two cannot disagree about which names have these three
 * properties. `Math`/`JSON`/`Reflect` are absent from it and are namespaces, not
 * constructors; their `Math.length` is genuinely undefined and a write to it must
 * NOT throw.
 *
 * Everything else declines. In particular a builtin's METHODS (`JSON.stringify`,
 * `Array.isArray`) are `{[[Writable]]: true}` and a write to one is legal even in
 * strict code, so they are not here.
 *
 * ## Why a syntactic receiver, and why shadowing is checked
 *
 * The receiver must be the bare global identifier with no binding shadowing it.
 * `function f(Math) { "use strict"; Math.PI = 1; }` is a write to a parameter's
 * ordinary property and must succeed — a wrong throw here is catchable and
 * therefore observable, which is the same failure mode as the stale-static-type
 * folds this issue also fixes (`S11.8.6_A2.4_T1`).
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/** §21.3.1 — the `Math` value properties, all `{[[Writable]]: false}`. */
const MATH_CONSTANTS: ReadonlySet<string> = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);

/** §21.1.2 — the `Number` value properties, all `{[[Writable]]: false}`. */
const NUMBER_CONSTANTS: ReadonlySet<string> = new Set([
  "MAX_VALUE",
  "MIN_VALUE",
  "NaN",
  "NEGATIVE_INFINITY",
  "POSITIVE_INFINITY",
  "EPSILON",
  "MAX_SAFE_INTEGER",
  "MIN_SAFE_INTEGER",
]);

/**
 * §20.2.4 — the three own properties every builtin FUNCTION object carries with
 * `[[Writable]]: false`.
 */
const CTOR_NON_WRITABLE_PROPS: ReadonlySet<string> = new Set(["length", "name", "prototype"]);

/**
 * (#4621 family B) §19.1.1–19.1.3 — the three VALUE properties of the global
 * object, all `{ [[Writable]]: false, [[Enumerable]]: false,
 * [[Configurable]]: false }`. A strict-mode assignment to the BARE identifier
 * (`NaN = 12`) is a PutValue on a GlobalEnvironmentRecord reference whose
 * [[Set]] fails, so §6.2.5.6 step 6.a throws TypeError.
 *
 * This is the bare-identifier twin of the property-write table above: the same
 * spec fact, reached through a different reference form. The property spelling
 * `globalThis.NaN = 12` already throws through `tryEmitSpecNonWritableBuiltinWrite`
 * where the receiver resolves; the identifier spelling had no arm at all and
 * silently did nothing (measured: `built-ins/global/10.2.1.1.3-4-{16,18}-s.js`,
 * "Expected a TypeError to be thrown but no exception was thrown at all").
 *
 * Deliberately NOT here: `globalThis` itself (§19.1.4 is
 * `{ w:true, e:false, c:true }` — writable, so an assignment to it must
 * succeed), and every function-valued global (`parseInt`, `isNaN`, …), which are
 * writable too.
 */
const GLOBAL_NON_WRITABLE_VALUE_NAMES: ReadonlySet<string> = new Set(["NaN", "Infinity", "undefined"]);

/** See `GLOBAL_NON_WRITABLE_VALUE_NAMES`. */
export function isSpecNonWritableGlobalValueName(name: string): boolean {
  return GLOBAL_NON_WRITABLE_VALUE_NAMES.has(name);
}

/**
 * True when `<builtinName>.<propName>` is an own data property the spec fixes as
 * non-writable. `isConstructorName` is the caller's answer to "does this name
 * denote a builtin constructor" (`BUILTIN_CTOR_ARITY` membership), kept as a
 * parameter so this module does not import the arity table and risk drifting
 * from it.
 */
export function isSpecNonWritableBuiltinProp(
  builtinName: string,
  propName: string,
  isConstructorName: boolean,
): boolean {
  if (builtinName === "Math" && MATH_CONSTANTS.has(propName)) return true;
  if (builtinName === "Number" && NUMBER_CONSTANTS.has(propName)) return true;
  return isConstructorName && CTOR_NON_WRITABLE_PROPS.has(propName);
}

/**
 * True when `receiver` is the bare global `name` — an identifier with no local,
 * captured or module-level binding shadowing it.
 */
export function resolveUnshadowedGlobalIdentifier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): ts.Identifier | undefined {
  // `(Math as any).PI = 20` is the same write as `Math.PI = 20`. Without the
  // unwrap the guard declined on every cast form — which is how the TS-lane pin
  // for `Math.PI = 20` failed while the test262 (JS-lane) row passed.
  let receiver: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(receiver) ||
    ts.isAsExpression(receiver) ||
    ts.isNonNullExpression(receiver) ||
    ts.isTypeAssertionExpression(receiver)
  ) {
    receiver = receiver.expression;
  }
  return isUnshadowedGlobalIdentifier(ctx, fctx, receiver) ? receiver : undefined;
}

function isUnshadowedGlobalIdentifier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
): receiver is ts.Identifier {
  if (!ts.isIdentifier(receiver)) return false;
  const name = receiver.text;
  if (fctx.localMap.has(name)) return false;
  if (fctx.boxedCaptures?.has(name) ?? false) return false;
  if (ctx.moduleGlobals?.has(name) ?? false) return false;
  // A USER declaration of the name (`var Math = …`, `function Math(){}`) means
  // the receiver is not the intrinsic. The lib.d.ts ambient declaration
  // (`declare var Math: Math`) must NOT count — every builtin has one, and
  // treating it as a shadow made this predicate answer `false` for every name it
  // exists to recognise (measured: the guard never fired at all).
  const decl = ctx.oracle.valueDeclarationOf(receiver);
  if (decl === undefined) return true;
  return decl.getSourceFile().isDeclarationFile;
}
