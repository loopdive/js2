// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5152) §7.2.8 `IsRegExp` at RUNTIME for the three `String.prototype` search
 * predicates that refuse a RegExp argument — `includes` / `startsWith` /
 * `endsWith` (§22.1.3.{7,23,6} step 3).
 *
 * The pre-existing standalone guard (#2598, `argIsStaticRegExp` in
 * `string-ops.ts`) is purely STATIC: a RegExp literal or a `RegExp`-typed
 * expression throws unconditionally, anything else is waved through. That
 * answers the wrong question twice:
 *
 *   - a plain object carrying `Symbol.match` IS a RegExp for §7.2.8 and was
 *     waved through;
 *   - `IsRegExp` performs `Get(argument, @@match)`, so a *poisoned* `@@match`
 *     GETTER must run and its abrupt completion must propagate — the static
 *     throw pre-empts it and raises the wrong error (a TypeError instead of
 *     whatever the getter threw).
 *
 * This module emits the spec sequence instead, host-free: evaluate the argument
 * ONCE into an externref temp, read `@@match` through the native `__extern_get`
 * (the getter runs; an abrupt completion propagates by itself), and decide:
 *
 *   matcher is not undefined  ⇒ ToBoolean(matcher) ⇒ TypeError when true
 *   matcher is undefined      ⇒ [[RegExpMatcher]] present? (`ref.test
 *                                $NativeRegExp`) ⇒ TypeError when so
 *
 * then finishes the spec's step 4 `ToString(searchString)` from the SAME temp
 * (via `emitStringProtoToStringFlat`, which carries the §7.1.17 Symbol throw and
 * the ToPrimitive-first sequence), so the argument is never evaluated twice.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./expressions/helpers.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { ensureAnyToStringHelper } from "./native-strings.js";
import { emitStringProtoToStringFlat } from "./string-proto-tostring.js";
import { flatStringType } from "./index.js";
import { addUnionImports } from "./registry/imports.js";

/** The `$NativeRegExp` struct's registration key (`regexp-standalone.ts`). */
const STANDALONE_REGEXP_STRUCT_NAME = "__StandaloneRegExp";

const EXTERNREF: ValType = { kind: "externref" };

/** `Symbol.match`'s well-known id in the compiler's symbol table (literals.ts). */
const SYMBOL_MATCH_ID = 7;

/**
 * Could this argument expression be an object at runtime (and therefore carry
 * `@@match`)? A provably primitive argument — `"x"`, `1`, a `string`-typed
 * variable — cannot be a RegExp, so it keeps the existing (cheaper, well-tested)
 * `emitArgAsNativeString` lane byte-for-byte.
 */
const PRIMITIVE_FACT_KINDS: ReadonlySet<string> = new Set([
  "number",
  "boolean",
  "string",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "void",
]);

function argCouldBeRegExp(ctx: CodegenContext, arg: ts.Expression): boolean {
  const fact = ctx.oracle.typeFactOf(arg);
  if (fact.kind === "union") return !fact.parts.every((part) => PRIMITIVE_FACT_KINDS.has(part.kind));
  return !PRIMITIVE_FACT_KINDS.has(fact.kind);
}

/**
 * Emit `IsRegExp(searchString)` + `ToString(searchString)` for one of the three
 * search predicates, leaving the coerced needle in a fresh local whose index is
 * returned. `null` ⇒ this lane does not apply (static primitive argument, JS-host
 * mode, or a substrate helper is missing) and the caller keeps its existing path.
 */
export function tryEmitRuntimeIsRegExpSearchArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  method: string,
): number | null {
  if (!noJsHost(ctx)) return null;
  if (!argCouldBeRegExp(ctx, arg)) return null;

  ensureObjectRuntime(ctx);
  addUnionImports(ctx);
  const boxSymIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__is_truthy", [EXTERNREF], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (
    boxSymIdx === undefined ||
    externGetIdx === undefined ||
    isUndefinedIdx === undefined ||
    isTruthyIdx === undefined ||
    flattenIdx === undefined
  ) {
    return null;
  }

  const argLocal = allocLocal(fctx, `__isre_arg_${fctx.locals.length}`, EXTERNREF);
  const matcherLocal = allocLocal(fctx, `__isre_matcher_${fctx.locals.length}`, EXTERNREF);
  const t = compileExpression(ctx, fctx, arg);
  if (t === null) return null;
  if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  fctx.body.push({ op: "local.set", index: argLocal });

  const typeErr = (): Instr[] =>
    buildThrowJsErrorInstrs(
      ctx,
      "TypeError",
      `TypeError: First argument to String.prototype.${method} must not be a regular expression`,
      { flush: fctx },
    );

  // A null / undefined argument is not an object: skip the whole check and let
  // ToString turn it into "null" / "undefined" (§22.1.3.7 step 3 → step 4).
  const notNullish: Instr[] = [];
  // matcher = Get(argument, @@match) — the getter RUNS here.
  notNullish.push({ op: "local.get", index: argLocal });
  notNullish.push({ op: "i32.const", value: SYMBOL_MATCH_ID });
  notNullish.push({ op: "call", funcIdx: boxSymIdx });
  notNullish.push({ op: "call", funcIdx: externGetIdx });
  notNullish.push({ op: "local.set", index: matcherLocal });
  const matcherDefined: Instr[] = [
    { op: "local.get", index: matcherLocal },
    { op: "call", funcIdx: isTruthyIdx },
    { op: "if", blockType: { kind: "empty" }, then: typeErr(), else: [] },
  ];
  // matcher === undefined ⇒ fall back to the [[RegExpMatcher]] slot test.
  const matcherUndefined: Instr[] = [];
  // Only when the module ALREADY carries the standalone RegExp struct — never
  // register it here. Registering a struct type on demand renumbers the module
  // type table under every index already baked into emitted instructions
  // (#2901), and a module with no RegExp in it cannot hold one at runtime
  // anyway, so the test is trivially false there.
  const reTypeIdx = ctx.structMap.get(STANDALONE_REGEXP_STRUCT_NAME);
  if (reTypeIdx !== undefined) {
    matcherUndefined.push(
      { op: "local.get", index: argLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: reTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: typeErr(), else: [] },
    );
  }
  notNullish.push({ op: "local.get", index: matcherLocal });
  notNullish.push({ op: "call", funcIdx: isUndefinedIdx });
  notNullish.push({ op: "local.get", index: matcherLocal });
  notNullish.push({ op: "ref.is_null" });
  notNullish.push({ op: "i32.or" });
  notNullish.push({
    op: "if",
    blockType: { kind: "empty" },
    then: matcherUndefined,
    else: matcherDefined,
  });

  fctx.body.push({ op: "local.get", index: argLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "local.get", index: argLocal });
  fctx.body.push({ op: "call", funcIdx: isUndefinedIdx });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: notNullish, else: [] });

  // step 4: searchStr = ? ToString(searchString) — from the SAME temp.
  const needleLocal = allocLocal(fctx, `__isre_needle_${fctx.locals.length}`, flatStringType(ctx));
  emitStringProtoToStringFlat(ctx, fctx, argLocal, anyToStrIdx, flattenIdx);
  fctx.body.push({ op: "local.set", index: needleLocal });
  return needleLocal;
}
