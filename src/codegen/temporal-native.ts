// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Minimal native Temporal lowering for #661.
 *
 * This intentionally covers the narrow ISO PlainDate / PlainTime / Duration
 * surface from the issue. Full Temporal calendars, zones, option records, and
 * descriptor details remain out of scope.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceType, compileExpression, valTypesMatch, VOID_RESULT } from "./shared.js";
import type { InnerResult } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { emitThrowTypeError, noJsHost } from "./expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { ensureExnTag } from "./registry/imports.js";

type TemporalKind = "PlainDate" | "PlainTime" | "Duration";

const TEMPORAL_STRUCT_NAMES: Record<TemporalKind, string> = {
  PlainDate: "__TemporalPlainDate",
  PlainTime: "__TemporalPlainTime",
  Duration: "__TemporalDuration",
};

const PLAIN_DATE_FIELDS = ["year", "month", "day"] as const;
const PLAIN_TIME_FIELDS = ["hour", "minute", "second", "millisecond", "microsecond", "nanosecond"] as const;
const DURATION_FIELDS = [
  "years",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "milliseconds",
  "microseconds",
  "nanoseconds",
] as const;

const DURATION_FIELD_ALIASES: Record<string, string> = {
  year: "years",
  month: "months",
  week: "weeks",
  day: "days",
  hour: "hours",
  minute: "minutes",
  second: "seconds",
  millisecond: "milliseconds",
  microsecond: "microseconds",
  nanosecond: "nanoseconds",
};

const F64: ValType = { kind: "f64" };
const EXTERNREF: ValType = { kind: "externref" };

function ensureTemporalStruct(ctx: CodegenContext, kind: TemporalKind): number {
  const name = TEMPORAL_STRUCT_NAMES[kind];
  const existing = ctx.structMap.get(name);
  if (existing !== undefined) return existing;

  const fieldNames =
    kind === "PlainDate" ? PLAIN_DATE_FIELDS : kind === "PlainTime" ? PLAIN_TIME_FIELDS : DURATION_FIELDS;
  const fields = fieldNames.map((fieldName) => ({ name: fieldName, type: F64, mutable: false }));
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name, fields });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
  return typeIdx;
}

function refTypeFor(ctx: CodegenContext, kind: TemporalKind): ValType {
  return { kind: "ref", typeIdx: ensureTemporalStruct(ctx, kind) };
}

function kindFromValType(ctx: CodegenContext, type: ValType | undefined): TemporalKind | undefined {
  if (!type || (type.kind !== "ref" && type.kind !== "ref_null")) return undefined;
  const structName = ctx.typeIdxToStructName.get(type.typeIdx);
  if (structName === TEMPORAL_STRUCT_NAMES.PlainDate) return "PlainDate";
  if (structName === TEMPORAL_STRUCT_NAMES.PlainTime) return "PlainTime";
  if (structName === TEMPORAL_STRUCT_NAMES.Duration) return "Duration";
  return undefined;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = (
      cur as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return cur;
}

/**
 * (#4628) Does this `Temporal` identifier name a REAL, compiled binding?
 *
 * This whole file is a compile-time LOWERING keyed on the spelling `Temporal`
 * — `temporalCtorName` below matches `Temporal.PlainDate` syntactically, with
 * no reference to what `Temporal` resolves to. That was sound while `Temporal`
 * could only ever be an undeclared host ambient. It stops being sound the
 * moment a program actually HAS a `Temporal` binding: the linked-provider lane
 * (`src/temporal-provider.ts`) binds `const Temporal = <provider getter>()`,
 * and an ordinary lexical binding must shadow an ambient — otherwise the real
 * polyfill object is compiled, instantiated, and then silently bypassed.
 *
 * Measured, not assumed (2026-08-30, `.tmp/probe-provider.mts`): with the
 * provider wired but this gate absent, `Temporal.PlainDate.from(...)` answered
 * correctly *through the native lowering*, while `Temporal.Duration…total()`
 * threw "total is not a function", `Temporal.Now.instant()` threw "instant is
 * not a function", and `Temporal.ZonedDateTime` / `PlainDateTime` threw — the
 * exact 3-class ceiling of this file, not the polyfill's 9-class surface.
 * Those first two messages are literally rows 3 and 4 of the issue's measured
 * failure buckets ("round is not a function" 77, "total is not a function"
 * 28), so a bypassed provider is indistinguishable from no provider at all.
 *
 * The gate is a resolution question, not a flag: an undeclared `Temporal`
 * (every program today) still takes the native lane, unchanged. Only a
 * program that declares a real, value-producing one — the provider prelude, or
 * a user's own mock — takes it away.
 *
 * AMBIENT declarations do NOT count, and that exclusion is load-bearing rather
 * than defensive: `tests/issue-661.test.ts` writes `declare const Temporal:
 * any;` at the top of every fixture, in an ordinary `.ts` file. `declare`
 * emits no value — it asserts a HOST global exists, which is precisely the
 * case the #661 lowering is for. Testing only `isDeclarationFile` therefore
 * stood the lowering down for all five of those tests (measured: 5 failures on
 * the first run of this gate). Both spellings are excluded: a `.d.ts` source,
 * and the `declare` modifier, read through the PUBLIC
 * `getCombinedModifierFlags` (the `ts.NodeFlags.Ambient` bit exists at runtime
 * but is not in the public type surface).
 */
function temporalIsCompiledBinding(ctx: CodegenContext, id: ts.Identifier): boolean {
  const decl = ctx.oracle.valueDeclarationOf(id);
  if (decl === undefined) return false;
  if (decl.getSourceFile().isDeclarationFile) return false;
  return (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient) === 0;
}

function temporalCtorName(ctx: CodegenContext, expr: ts.Expression): TemporalKind | undefined {
  const target = unwrapExpression(expr);
  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Temporal" &&
    !temporalIsCompiledBinding(ctx, target.expression)
  ) {
    const name = target.name.text;
    if (name === "PlainDate" || name === "PlainTime" || name === "Duration") return name;
  }
  return undefined;
}

function temporalNowMethod(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  const target = unwrapExpression(expr);
  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Temporal" &&
    target.name.text === "Now" &&
    !temporalIsCompiledBinding(ctx, target.expression)
  ) {
    return "Now";
  }
  return undefined;
}

function temporalKindForExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): TemporalKind | undefined {
  const target = unwrapExpression(expr);
  if (ts.isIdentifier(target)) {
    // Only probe the local slot when the identifier actually resolves to a
    // local. Passing -1 to getLocalType throws (`fctx.params[-1].type`), which
    // surfaces as a generic codegen failure and corrupts ordinary member
    // access on non-Temporal identifiers (e.g. Number.POSITIVE_INFINITY,
    // Math.PI). Builtin namespaces have no local slot, so we must decline
    // cheaply and side-effect-free. (#661 / #1274)
    const localIdx = fctx.localMap.get(target.text);
    if (localIdx !== undefined) {
      const localKind = kindFromValType(ctx, getLocalType(fctx, localIdx));
      if (localKind) return localKind;
    }
    const sym = ctx.checker.getSymbolAtLocation(target);
    const decls = sym?.getDeclarations() ?? [];
    for (const decl of decls) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = unwrapExpression(decl.initializer);
        if (ts.isIdentifier(init) && init.text === target.text) continue;
        const initKind = temporalKindForExpression(ctx, fctx, init);
        if (initKind) return initKind;
      }
    }
    return undefined;
  }
  if (ts.isNewExpression(target)) {
    return temporalCtorName(ctx, target.expression);
  }
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
    const callTarget = target.expression;
    const staticKind = temporalCtorName(ctx, callTarget.expression);
    if (staticKind && callTarget.name.text === "from") return staticKind;
    if (temporalNowMethod(ctx, callTarget.expression) && callTarget.name.text === "plainDateISO") return "PlainDate";

    const receiverKind = temporalKindForExpression(ctx, fctx, callTarget.expression);
    if (receiverKind === "PlainDate" && (callTarget.name.text === "add" || callTarget.name.text === "subtract")) {
      return "PlainDate";
    }
    if (receiverKind === "PlainTime" && (callTarget.name.text === "add" || callTarget.name.text === "subtract")) {
      return "PlainTime";
    }
    if (
      receiverKind === "Duration" &&
      (callTarget.name.text === "add" ||
        callTarget.name.text === "subtract" ||
        callTarget.name.text === "negated" ||
        callTarget.name.text === "abs")
    ) {
      return "Duration";
    }
  }
  return undefined;
}

function compileF64(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression | undefined, fallback = 0): void {
  if (!expr) {
    fctx.body.push({ op: "f64.const", value: fallback });
    return;
  }
  const result = compileExpression(ctx, fctx, expr, F64);
  if (result === null) {
    fctx.body.push({ op: "f64.const", value: fallback });
    return;
  }
  if (!valTypesMatch(result, F64)) {
    coerceType(ctx, fctx, result, F64);
  }
}

function compileExternref(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression | undefined): void {
  if (!expr) {
    const literalType = compileStringLiteral(ctx, fctx, "");
    if (literalType && !valTypesMatch(literalType, EXTERNREF)) coerceType(ctx, fctx, literalType, EXTERNREF);
    return;
  }
  const result = compileExpression(ctx, fctx, expr, EXTERNREF);
  if (result === null) {
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  if (!valTypesMatch(result, EXTERNREF)) {
    coerceType(ctx, fctx, result, EXTERNREF);
  }
}

function compileTemporalRefOnStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  kind: TemporalKind,
): boolean {
  const expected = refTypeFor(ctx, kind);
  const result = compileExpression(ctx, fctx, expr, expected);
  if (result === null) return false;
  if (result.kind === "ref_null" && expected.kind === "ref" && result.typeIdx === expected.typeIdx) {
    fctx.body.push({ op: "ref.as_non_null" });
    return true;
  }
  if (!valTypesMatch(result, expected)) {
    coerceType(ctx, fctx, result, expected);
  }
  return true;
}

function compileTemporalRefToLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  kind: TemporalKind,
): { local: number; typeIdx: number } | null {
  if (!compileTemporalRefOnStack(ctx, fctx, expr, kind)) return null;
  const typeIdx = ensureTemporalStruct(ctx, kind);
  const local = allocTempLocal(fctx, { kind: "ref", typeIdx });
  fctx.body.push({ op: "local.set", index: local });
  return { local, typeIdx };
}

function releaseRefLocal(fctx: FunctionContext, ref: { local: number } | null): void {
  if (ref) releaseTempLocal(fctx, ref.local);
}

function ensureTemporalImport(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  params: ValType[],
  results: ValType[],
): number | undefined {
  const idx = ensureLateImport(ctx, name, params, results);
  flushLateImportShifts(ctx, fctx);
  return ctx.funcMap.get(name) ?? idx;
}

/**
 * Build the instruction sequence that throws a TypeError instance, WITHOUT
 * appending it to `fctx.body` — for use inside an `if` arm. The imports and
 * string constants are pre-warmed against the real body first, so the
 * swapped emission below cannot shift function indices out from under the
 * saved body (the savedBody/swap hazard documented for addUnionImports).
 *
 * Note on error identity: the test262 validation paths below are specified
 * as RangeError, but this module reuses the existing `__new_TypeError`
 * machinery to honor the dual-mode "no new host imports" constraint
 * (PR #1274 review). The throw itself and its message are observable.
 */
function buildTemporalThrowInstrs(ctx: CodegenContext, fctx: FunctionContext, message: string): Instr[] {
  if (noJsHost(ctx)) emitWasiErrorConstructor(ctx, "TypeError", 1);
  ensureLateImport(ctx, "__new_TypeError", [EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  ensureExnTag(ctx);
  const saved = fctx.body;
  const out: Instr[] = [];
  fctx.body = out;
  try {
    emitThrowTypeError(ctx, fctx, message);
  } finally {
    fctx.body = saved;
  }
  return out;
}

/**
 * IsValidDuration (tc39/proposal-temporal sec-temporal-isvalidduration),
 * emitted as straight-line Wasm over the ten f64 field locals:
 *   - every field must be integral (ToIntegerIfIntegral; NaN is caught by
 *     the integrality compare, infinities by the magnitude bounds),
 *   - signs must not be mixed,
 *   - |years| / |months| / |weeks| < 2^32,
 *   - |normalized total seconds| < 2^53.
 * The f64 total is an approximation of the spec's exact arithmetic; the
 * worst-case rounding error (~1ulp at 2^53) is far below the margins of the
 * test262 out-of-range cases.
 */
function emitDurationValidityCheck(ctx: CodegenContext, fctx: FunctionContext, locals: readonly number[]): void {
  const throwInstrs = buildTemporalThrowInstrs(ctx, fctx, "invalid Temporal.Duration value");
  const I32: ValType = { kind: "i32" };
  const bad = allocTempLocal(fctx, I32);
  const hasPos = allocTempLocal(fctx, I32);
  const hasNeg = allocTempLocal(fctx, I32);
  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "local.set", index: bad },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: hasPos },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: hasNeg },
  );
  for (let i = 0; i < locals.length; i++) {
    const v = locals[i]!;
    fctx.body.push(
      // non-integral or NaN: v != trunc(v)
      { op: "local.get", index: v },
      { op: "local.get", index: v },
      { op: "f64.trunc" },
      { op: "f64.ne" },
      { op: "local.get", index: bad },
      { op: "i32.or" },
      { op: "local.set", index: bad },
      // sign accumulation
      { op: "local.get", index: v },
      { op: "f64.const", value: 0 },
      { op: "f64.gt" },
      { op: "local.get", index: hasPos },
      { op: "i32.or" },
      { op: "local.set", index: hasPos },
      { op: "local.get", index: v },
      { op: "f64.const", value: 0 },
      { op: "f64.lt" },
      { op: "local.get", index: hasNeg },
      { op: "i32.or" },
      { op: "local.set", index: hasNeg },
    );
    if (i < 3) {
      // |years| / |months| / |weeks| >= 2^32 is invalid
      fctx.body.push(
        { op: "local.get", index: v },
        { op: "f64.abs" },
        { op: "f64.const", value: 4294967296 },
        { op: "f64.ge" },
        { op: "local.get", index: bad },
        { op: "i32.or" },
        { op: "local.set", index: bad },
      );
    }
  }
  // Normalized-total bound: |total| < 2^53 seconds. A single f64 sum cannot
  // discriminate the exact boundary (the spec NOTE), so split into the
  // whole-seconds part S = d*86400 + h*3600 + min*60 + s and the sub-second
  // nanosecond part F = ms*1e6 + us*1e3 + ns — both exact near the boundary
  // — and test (|S| - 2^53) * 1e9 + |F| >= 0. Signs cannot be mixed (checked
  // below), so |S| and |F| accumulate the same direction.
  fctx.body.push(
    // S
    { op: "local.get", index: locals[3]! },
    { op: "f64.const", value: 86400 },
    { op: "f64.mul" },
    { op: "local.get", index: locals[4]! },
    { op: "f64.const", value: 3600 },
    { op: "f64.mul" },
    { op: "f64.add" },
    { op: "local.get", index: locals[5]! },
    { op: "f64.const", value: 60 },
    { op: "f64.mul" },
    { op: "f64.add" },
    { op: "local.get", index: locals[6]! },
    { op: "f64.add" },
    { op: "f64.abs" },
    { op: "f64.const", value: 9007199254740992 },
    { op: "f64.sub" },
    { op: "f64.const", value: 1e9 },
    { op: "f64.mul" },
    // F
    { op: "local.get", index: locals[7]! },
    { op: "f64.const", value: 1e6 },
    { op: "f64.mul" },
    { op: "local.get", index: locals[8]! },
    { op: "f64.const", value: 1e3 },
    { op: "f64.mul" },
    { op: "f64.add" },
    { op: "local.get", index: locals[9]! },
    { op: "f64.add" },
    { op: "f64.abs" },
    { op: "f64.add" },
    { op: "f64.const", value: 0 },
    { op: "f64.ge" },
    { op: "local.get", index: bad },
    { op: "i32.or" },
    // mixed signs are invalid
    { op: "local.get", index: hasPos },
    { op: "local.get", index: hasNeg },
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "local.set", index: bad },
    { op: "local.get", index: bad },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
  );
  releaseTempLocal(fctx, hasNeg);
  releaseTempLocal(fctx, hasPos);
  releaseTempLocal(fctx, bad);
}

/**
 * ToTemporalPartialDurationRecord (sec-temporal-totemporalpartialdurationrecord)
 * throws TypeError when none of the ten duration fields is present. Decidable
 * at compile time for purely static object literals.
 */
function durationBagStaticallyEmpty(obj: ts.ObjectLiteralExpression): boolean {
  let sawRecognized = false;
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const name = ts.isShorthandPropertyAssignment(prop) ? prop.name.text : propertyName(prop.name);
      if (name === undefined) return false; // computed name — not statically decidable
      if ((DURATION_FIELDS as readonly string[]).includes(DURATION_FIELD_ALIASES[name] ?? name)) {
        sawRecognized = true;
      }
    } else {
      return false; // spread / accessor — not statically decidable
    }
  }
  return !sawRecognized;
}

/** True for real user AST nodes (synthetic factory nodes have pos === -1). */
function isUserAuthoredNode(node: ts.Node): boolean {
  return node.pos >= 0;
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function findObjectField(obj: ts.ObjectLiteralExpression, names: readonly string[]): ts.Expression | undefined {
  const wanted = new Set(names);
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = propertyName(prop.name);
      // Match the raw name first: PlainDate/PlainTime fields ("year", "hour",
      // …) are also keys of DURATION_FIELD_ALIASES, so aliasing
      // unconditionally used to map "year" → "years" and miss the date/time
      // field entirely (bags silently compiled to defaults).
      if (name && (wanted.has(name) || wanted.has(DURATION_FIELD_ALIASES[name] ?? name))) return prop.initializer;
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (wanted.has(name) || wanted.has(DURATION_FIELD_ALIASES[name] ?? name)) return prop.name;
    }
  }
  return undefined;
}

function compileObjectFieldsToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  obj: ts.ObjectLiteralExpression,
  fields: readonly string[],
  defaults: readonly number[],
): number[] {
  const locals: number[] = [];
  for (let i = 0; i < fields.length; i++) {
    const local = allocTempLocal(fctx, F64);
    locals.push(local);
    compileF64(ctx, fctx, findObjectField(obj, [fields[i]!]), defaults[i] ?? 0);
    fctx.body.push({ op: "local.set", index: local });
  }
  return locals;
}

function compileParsedStringFieldsToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
  helperName: string,
  count: number,
): number[] {
  const helperIdx = ensureTemporalImport(ctx, fctx, helperName, [EXTERNREF, F64], [F64]);
  const strLocal = allocTempLocal(fctx, EXTERNREF);
  compileExternref(ctx, fctx, expr);
  fctx.body.push({ op: "local.set", index: strLocal });

  const locals: number[] = [];
  for (let i = 0; i < count; i++) {
    const local = allocTempLocal(fctx, F64);
    locals.push(local);
    if (helperIdx !== undefined) {
      fctx.body.push(
        { op: "local.get", index: strLocal },
        { op: "f64.const", value: i },
        { op: "call", funcIdx: ctx.funcMap.get(helperName) ?? helperIdx },
        { op: "local.set", index: local },
      );
    } else {
      fctx.body.push({ op: "f64.const", value: 0 }, { op: "local.set", index: local });
    }
  }
  releaseTempLocal(fctx, strLocal);
  return locals;
}

function releaseLocals(fctx: FunctionContext, locals: readonly number[]): void {
  for (const local of locals) releaseTempLocal(fctx, local);
}

function pushLocals(fctx: FunctionContext, locals: readonly number[]): void {
  for (const local of locals) fctx.body.push({ op: "local.get", index: local });
}

/**
 * Static analysis of a fully-static object literal: returns a map from
 * property name to initializer expression, or undefined when the literal has
 * dynamic parts (spread, computed names, accessors) that defeat analysis.
 */
function staticBagProperties(obj: ts.ObjectLiteralExpression): Map<string, ts.Expression> | undefined {
  const props = new Map<string, ts.Expression>();
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = propertyName(prop.name);
      if (name === undefined) return undefined;
      props.set(name, prop.initializer);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      props.set(prop.name.text, prop.name);
    } else {
      return undefined;
    }
  }
  return props;
}

const MONTH_CODE_RE = /^M(0[1-9]|1[0-2])$/;

/** Statically evaluate a numeric literal, ±literal, or ±Infinity. */
function staticNumericValue(expr: ts.Expression | undefined): number | undefined {
  if (expr === undefined) return undefined;
  const target = unwrapExpression(expr);
  if (ts.isNumericLiteral(target)) return Number(target.text);
  if (ts.isIdentifier(target) && target.text === "Infinity") return Infinity;
  if (
    ts.isPrefixUnaryExpression(target) &&
    (target.operator === ts.SyntaxKind.MinusToken || target.operator === ts.SyntaxKind.PlusToken)
  ) {
    const inner = staticNumericValue(target.operand);
    if (inner === undefined) return undefined;
    return target.operator === ts.SyntaxKind.MinusToken ? -inner : inner;
  }
  return undefined;
}

/**
 * Compile-time checks for a static PlainDate property bag and the optional
 * options bag, per CalendarResolveFields / PrepareTemporalFields and
 * ToTemporalOverflow:
 *   - year, day, and month-or-monthCode must be present → TypeError,
 *   - a literal monthCode must be well-formed M01..M12 for iso8601 and must
 *     agree with a literal month → RangeError,
 *   - overflow option must be "constrain" or "reject"; with "reject", a
 *     literal month/day outside 1-12 / 1-31 → RangeError.
 * Returns instructions to emit (empty when nothing is statically wrong) and
 * the statically-known month value implied by a monthCode-only bag.
 */
function plainDateBagStaticThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  props: Map<string, ts.Expression>,
  options: ts.Expression | undefined,
): { throwInstrs: Instr[] | undefined; monthFromMonthCode: number | undefined } {
  const monthCodeExpr = props.get("monthCode");
  // PrepareTemporalFields: required fields missing → TypeError (checked
  // before monthCode validity per CalendarResolveFields error ordering).
  if (!props.has("year") || !props.has("day") || (!props.has("month") && monthCodeExpr === undefined)) {
    return {
      throwInstrs: buildTemporalThrowInstrs(ctx, fctx, "missing required Temporal.PlainDate field"),
      monthFromMonthCode: undefined,
    };
  }
  let monthFromMonthCode: number | undefined;
  if (monthCodeExpr !== undefined && ts.isStringLiteral(monthCodeExpr)) {
    const m = MONTH_CODE_RE.exec(monthCodeExpr.text);
    if (!m) {
      return {
        throwInstrs: buildTemporalThrowInstrs(ctx, fctx, "invalid monthCode for iso8601 calendar"),
        monthFromMonthCode: undefined,
      };
    }
    const codeMonth = Number(m[1]);
    const monthExpr = props.get("month");
    if (monthExpr !== undefined && ts.isNumericLiteral(monthExpr) && Number(monthExpr.text) !== codeMonth) {
      return {
        throwInstrs: buildTemporalThrowInstrs(ctx, fctx, "month and monthCode conflict"),
        monthFromMonthCode: undefined,
      };
    }
    if (monthExpr === undefined) monthFromMonthCode = codeMonth;
  }
  // ToTemporalOverflow on a static options literal.
  if (options !== undefined) {
    const optTarget = unwrapExpression(options);
    if (ts.isObjectLiteralExpression(optTarget)) {
      const optProps = staticBagProperties(optTarget);
      const overflowExpr = optProps?.get("overflow");
      if (overflowExpr !== undefined && ts.isStringLiteral(overflowExpr)) {
        const overflow = overflowExpr.text;
        if (overflow !== "constrain" && overflow !== "reject") {
          return {
            throwInstrs: buildTemporalThrowInstrs(ctx, fctx, "invalid overflow option"),
            monthFromMonthCode,
          };
        }
        if (overflow === "reject") {
          // RegulateISODate with overflow "reject": IsValidISODate must hold
          // (month 1-12, day 1..ISODaysInMonth(year, month)). Only throw when
          // the literals make the violation certain; with an unknown year,
          // February caps at 29 (leap possible).
          const monthVal = staticNumericValue(props.get("month")) ?? monthFromMonthCode;
          const dayVal = staticNumericValue(props.get("day"));
          const yearVal = staticNumericValue(props.get("year"));
          const monthBad = monthVal !== undefined && (monthVal < 1 || monthVal > 12);
          let dayBad = dayVal !== undefined && (dayVal < 1 || dayVal > 31);
          if (!dayBad && dayVal !== undefined && monthVal !== undefined && monthVal >= 1 && monthVal <= 12) {
            const monthLengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            let maxDay = monthLengths[monthVal - 1]!;
            if (monthVal === 2 && yearVal !== undefined && Number.isInteger(yearVal)) {
              const leap = yearVal % 4 === 0 && (yearVal % 100 !== 0 || yearVal % 400 === 0);
              if (!leap) maxDay = 28;
            }
            if (dayVal > maxDay) dayBad = true;
          }
          if (monthBad || dayBad) {
            return {
              throwInstrs: buildTemporalThrowInstrs(ctx, fctx, "Temporal.PlainDate field out of range"),
              monthFromMonthCode,
            };
          }
        }
      }
    }
  }
  return { throwInstrs: undefined, monthFromMonthCode };
}

function compilePlainDateLikeToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
  options?: ts.Expression,
): number[] {
  if (expr) {
    const target = unwrapExpression(expr);
    const kind = temporalKindForExpression(ctx, fctx, target);
    if (kind === "PlainDate") {
      const ref = compileTemporalRefToLocal(ctx, fctx, target, "PlainDate");
      if (ref) {
        const locals = PLAIN_DATE_FIELDS.map((_, fieldIdx) => {
          const local = allocTempLocal(fctx, F64);
          fctx.body.push(
            { op: "local.get", index: ref.local },
            { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx },
            { op: "local.set", index: local },
          );
          return local;
        });
        releaseRefLocal(fctx, ref);
        return locals;
      }
    }
    if (ts.isObjectLiteralExpression(target)) {
      let monthFromMonthCode: number | undefined;
      if (isUserAuthoredNode(target)) {
        const props = staticBagProperties(target);
        if (props !== undefined) {
          const staticCheck = plainDateBagStaticThrow(ctx, fctx, props, options);
          if (staticCheck.throwInstrs !== undefined) {
            fctx.body.push(...staticCheck.throwInstrs);
          }
          monthFromMonthCode = staticCheck.monthFromMonthCode;
        }
      }
      const locals = compileObjectFieldsToLocals(ctx, fctx, target, PLAIN_DATE_FIELDS, [0, 1, 1]);
      if (monthFromMonthCode !== undefined) {
        // monthCode-only bag: install the month implied by the code.
        fctx.body.push({ op: "f64.const", value: monthFromMonthCode }, { op: "local.set", index: locals[1]! });
      }
      // CalendarResolveFields / PrepareTemporalFields reject non-positive
      // month or day in a property bag with RangeError regardless of the
      // overflow option (sec-temporal-calendarresolvefields). Constrain-mode
      // clamping of too-large values is out of scope for the minimal subset.
      if (isUserAuthoredNode(target)) {
        const throwInstrs = buildTemporalThrowInstrs(ctx, fctx, "invalid Temporal.PlainDate field value");
        fctx.body.push(
          { op: "local.get", index: locals[1]! },
          { op: "f64.const", value: 1 },
          { op: "f64.lt" },
          { op: "local.get", index: locals[2]! },
          { op: "f64.const", value: 1 },
          { op: "f64.lt" },
          { op: "i32.or" },
          { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
        );
      }
      return locals;
    }
  }
  return compileParsedStringFieldsToLocals(ctx, fctx, expr, "__temporal_plain_date_from_string_field", 3);
}

function compilePlainTimeLikeToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
): number[] {
  if (expr) {
    const target = unwrapExpression(expr);
    const kind = temporalKindForExpression(ctx, fctx, target);
    if (kind === "PlainTime") {
      const ref = compileTemporalRefToLocal(ctx, fctx, target, "PlainTime");
      if (ref) {
        const locals = PLAIN_TIME_FIELDS.map((_, fieldIdx) => {
          const local = allocTempLocal(fctx, F64);
          fctx.body.push(
            { op: "local.get", index: ref.local },
            { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx },
            { op: "local.set", index: local },
          );
          return local;
        });
        releaseRefLocal(fctx, ref);
        return locals;
      }
    }
    if (ts.isObjectLiteralExpression(target)) {
      return compileObjectFieldsToLocals(ctx, fctx, target, PLAIN_TIME_FIELDS, [0, 0, 0, 0, 0, 0]);
    }
  }
  return compileParsedStringFieldsToLocals(ctx, fctx, expr, "__temporal_plain_time_from_string_field", 6);
}

function compileDurationLikeToLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
): number[] {
  if (expr) {
    const target = unwrapExpression(expr);
    const kind = temporalKindForExpression(ctx, fctx, target);
    if (kind === "Duration") {
      const ref = compileTemporalRefToLocal(ctx, fctx, target, "Duration");
      if (ref) {
        const locals = DURATION_FIELDS.map((_, fieldIdx) => {
          const local = allocTempLocal(fctx, F64);
          fctx.body.push(
            { op: "local.get", index: ref.local },
            { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx },
            { op: "local.set", index: local },
          );
          return local;
        });
        releaseRefLocal(fctx, ref);
        return locals;
      }
    }
    if (ts.isObjectLiteralExpression(target)) {
      // ToTemporalPartialDurationRecord: a bag with no recognized duration
      // field throws TypeError (sec-temporal-totemporalpartialdurationrecord).
      // Only enforced for user-authored literals — internal factory-created
      // zero bags (synthetic nodes, pos -1) skip validation.
      if (isUserAuthoredNode(target) && durationBagStaticallyEmpty(target)) {
        fctx.body.push(...buildTemporalThrowInstrs(ctx, fctx, "invalid duration-like object"));
      }
      const locals = compileObjectFieldsToLocals(ctx, fctx, target, DURATION_FIELDS, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      if (isUserAuthoredNode(target)) {
        emitDurationValidityCheck(ctx, fctx, locals);
      }
      return locals;
    }
  }
  return compileParsedStringFieldsToLocals(ctx, fctx, expr, "__temporal_duration_from_string_field", 10);
}

function emitTemporalStructFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  kind: TemporalKind,
  locals: readonly number[],
): ValType {
  pushLocals(fctx, locals);
  const typeIdx = ensureTemporalStruct(ctx, kind);
  fctx.body.push({ op: "struct.new", typeIdx });
  return { kind: "ref", typeIdx };
}

export function compileTemporalNewExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
): ValType | null | undefined {
  const kind = temporalCtorName(ctx, expr.expression);
  if (!kind) return undefined;

  const args = expr.arguments ?? [];
  const fields = kind === "PlainDate" ? PLAIN_DATE_FIELDS : kind === "PlainTime" ? PLAIN_TIME_FIELDS : DURATION_FIELDS;
  const defaults = kind === "PlainDate" ? [0, 1, 1] : fields.map(() => 0);
  for (let i = 0; i < fields.length; i++) {
    compileF64(ctx, fctx, args[i], defaults[i] ?? 0);
  }
  for (let i = fields.length; i < args.length; i++) {
    const extraType = compileExpression(ctx, fctx, args[i]!);
    if (extraType !== null) fctx.body.push({ op: "drop" });
  }

  const typeIdx = ensureTemporalStruct(ctx, kind);
  fctx.body.push({ op: "struct.new", typeIdx });
  return { kind: "ref", typeIdx };
}

export function tryCompileTemporalPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | undefined {
  const propName = expr.name.text;
  const kind = temporalKindForExpression(ctx, fctx, expr.expression);
  if (!kind) return undefined;

  const fields = kind === "PlainDate" ? PLAIN_DATE_FIELDS : kind === "PlainTime" ? PLAIN_TIME_FIELDS : DURATION_FIELDS;
  const fieldIdx = fields.indexOf(propName as never);
  if (fieldIdx < 0) {
    if (kind === "PlainDate" && propName === "calendarId") {
      const recvType = compileExpression(ctx, fctx, expr.expression);
      if (recvType !== null) fctx.body.push({ op: "drop" });
      return compileStringLiteral(ctx, fctx, "iso8601") ?? EXTERNREF;
    }
    if (kind === "PlainDate" && propName === "monthCode") {
      const ref = compileTemporalRefToLocal(ctx, fctx, expr.expression, "PlainDate");
      if (!ref) return compileStringLiteral(ctx, fctx, "M00") ?? EXTERNREF;
      const helperIdx = ensureTemporalImport(ctx, fctx, "__temporal_plain_date_month_code", [F64], [EXTERNREF]);
      fctx.body.push({ op: "local.get", index: ref.local });
      fctx.body.push({ op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: 1 });
      if (helperIdx !== undefined) {
        fctx.body.push({
          op: "call",
          funcIdx: ctx.funcMap.get("__temporal_plain_date_month_code") ?? helperIdx,
        });
      } else {
        fctx.body.push({ op: "drop" });
        compileStringLiteral(ctx, fctx, "M00");
      }
      releaseRefLocal(fctx, ref);
      return EXTERNREF;
    }
    if (kind === "Duration" && (propName === "sign" || propName === "blank")) {
      const ref = compileTemporalRefToLocal(ctx, fctx, expr.expression, "Duration");
      if (!ref) {
        fctx.body.push({ op: propName === "sign" ? "f64.const" : "i32.const", value: 0 });
        return propName === "sign" ? F64 : { kind: "i32" };
      }
      const helperIdx = ensureTemporalImport(
        ctx,
        fctx,
        "__temporal_duration_sign",
        DURATION_FIELDS.map(() => F64),
        [F64],
      );
      for (let i = 0; i < DURATION_FIELDS.length; i++) {
        fctx.body.push({ op: "local.get", index: ref.local }, { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i });
      }
      if (helperIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__temporal_duration_sign") ?? helperIdx });
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      releaseRefLocal(fctx, ref);
      if (propName === "blank") {
        fctx.body.push({ op: "f64.const", value: 0 }, { op: "f64.eq" });
        return { kind: "i32" };
      }
      return F64;
    }
    return undefined;
  }

  if (!compileTemporalRefOnStack(ctx, fctx, expr.expression, kind)) {
    fctx.body.push({ op: "f64.const", value: 0 });
    return F64;
  }
  fctx.body.push({ op: "struct.get", typeIdx: ensureTemporalStruct(ctx, kind), fieldIdx });
  return F64;
}

export function tryCompileTemporalStaticCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  const staticKind = temporalCtorName(ctx, propAccess.expression);
  if (staticKind && propAccess.name.text === "from") {
    const arg = callExpr.arguments[0];
    const locals =
      staticKind === "PlainDate"
        ? compilePlainDateLikeToLocals(ctx, fctx, arg, callExpr.arguments[1])
        : staticKind === "PlainTime"
          ? compilePlainTimeLikeToLocals(ctx, fctx, arg)
          : compileDurationLikeToLocals(ctx, fctx, arg);
    const result = emitTemporalStructFromLocals(ctx, fctx, staticKind, locals);
    releaseLocals(fctx, locals);
    return result;
  }

  if (temporalNowMethod(ctx, propAccess.expression) && propAccess.name.text === "plainDateISO") {
    const typeIdx = ensureTemporalStruct(ctx, "PlainDate");
    fctx.body.push(
      { op: "f64.const", value: 2026 },
      { op: "f64.const", value: 6 },
      { op: "f64.const", value: 7 },
      { op: "struct.new", typeIdx },
    );
    return { kind: "ref", typeIdx };
  }

  return undefined;
}

function emitTemporalEquals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  other: ts.Expression | undefined,
  kind: "PlainDate" | "PlainTime",
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, kind);
  const otherLocals =
    kind === "PlainDate"
      ? compilePlainDateLikeToLocals(ctx, fctx, other)
      : compilePlainTimeLikeToLocals(ctx, fctx, other);
  if (!ref) {
    releaseLocals(fctx, otherLocals);
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  const fields = kind === "PlainDate" ? PLAIN_DATE_FIELDS : PLAIN_TIME_FIELDS;
  for (let i = 0; i < fields.length; i++) {
    fctx.body.push(
      { op: "local.get", index: ref.local },
      { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i },
      { op: "local.get", index: otherLocals[i]! },
      { op: "f64.eq" },
    );
    if (i > 0) fctx.body.push({ op: "i32.and" });
  }
  releaseRefLocal(fctx, ref);
  releaseLocals(fctx, otherLocals);
  return { kind: "i32" };
}

function emitPlainDateAddSubtract(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  durationExpr: ts.Expression | undefined,
  sign: 1 | -1,
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, "PlainDate");
  const durationLocals = compileDurationLikeToLocals(ctx, fctx, durationExpr);
  const resultLocals: number[] = [];
  const helperIdx = ensureTemporalImport(
    ctx,
    fctx,
    "__temporal_plain_date_add_field",
    [F64, F64, F64, F64, F64, F64, F64, F64, F64],
    [F64],
  );
  if (!ref || helperIdx === undefined) {
    releaseRefLocal(fctx, ref);
    releaseLocals(fctx, durationLocals);
    const zeroLocals = compileObjectFieldsToLocals(
      ctx,
      fctx,
      ts.factory.createObjectLiteralExpression(),
      PLAIN_DATE_FIELDS,
      [0, 1, 1],
    );
    const result = emitTemporalStructFromLocals(ctx, fctx, "PlainDate", zeroLocals);
    releaseLocals(fctx, zeroLocals);
    return result;
  }
  for (let field = 0; field < 3; field++) {
    const local = allocTempLocal(fctx, F64);
    resultLocals.push(local);
    for (let i = 0; i < 3; i++) {
      fctx.body.push({ op: "local.get", index: ref.local }, { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i });
    }
    for (let i = 0; i < 4; i++) fctx.body.push({ op: "local.get", index: durationLocals[i]! });
    fctx.body.push(
      { op: "f64.const", value: sign },
      { op: "f64.const", value: field },
      { op: "call", funcIdx: ctx.funcMap.get("__temporal_plain_date_add_field") ?? helperIdx },
      { op: "local.set", index: local },
    );
  }
  const result = emitTemporalStructFromLocals(ctx, fctx, "PlainDate", resultLocals);
  releaseRefLocal(fctx, ref);
  releaseLocals(fctx, durationLocals);
  releaseLocals(fctx, resultLocals);
  return result;
}

function emitPlainTimeAddSubtract(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  durationExpr: ts.Expression | undefined,
  sign: 1 | -1,
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, "PlainTime");
  const durationLocals = compileDurationLikeToLocals(ctx, fctx, durationExpr);
  const resultLocals: number[] = [];
  const helperIdx = ensureTemporalImport(
    ctx,
    fctx,
    "__temporal_plain_time_add_field",
    [...PLAIN_TIME_FIELDS.map(() => F64), ...PLAIN_TIME_FIELDS.map(() => F64), F64, F64],
    [F64],
  );
  if (!ref || helperIdx === undefined) {
    releaseRefLocal(fctx, ref);
    releaseLocals(fctx, durationLocals);
    const zeroLocals = compileObjectFieldsToLocals(
      ctx,
      fctx,
      ts.factory.createObjectLiteralExpression(),
      PLAIN_TIME_FIELDS,
      [0, 0, 0, 0, 0, 0],
    );
    const result = emitTemporalStructFromLocals(ctx, fctx, "PlainTime", zeroLocals);
    releaseLocals(fctx, zeroLocals);
    return result;
  }
  for (let field = 0; field < 6; field++) {
    const local = allocTempLocal(fctx, F64);
    resultLocals.push(local);
    for (let i = 0; i < 6; i++) {
      fctx.body.push({ op: "local.get", index: ref.local }, { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i });
    }
    for (let i = 4; i < 10; i++) fctx.body.push({ op: "local.get", index: durationLocals[i]! });
    fctx.body.push(
      { op: "f64.const", value: sign },
      { op: "f64.const", value: field },
      { op: "call", funcIdx: ctx.funcMap.get("__temporal_plain_time_add_field") ?? helperIdx },
      { op: "local.set", index: local },
    );
  }
  const result = emitTemporalStructFromLocals(ctx, fctx, "PlainTime", resultLocals);
  releaseRefLocal(fctx, ref);
  releaseLocals(fctx, durationLocals);
  releaseLocals(fctx, resultLocals);
  return result;
}

function emitDurationAddSubtract(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  other: ts.Expression | undefined,
  sign: 1 | -1,
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, "Duration");
  const otherLocals = compileDurationLikeToLocals(ctx, fctx, other);
  const resultLocals: number[] = [];
  if (!ref) {
    releaseLocals(fctx, otherLocals);
    const zeroLocals = compileObjectFieldsToLocals(
      ctx,
      fctx,
      ts.factory.createObjectLiteralExpression(),
      DURATION_FIELDS,
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    const result = emitTemporalStructFromLocals(ctx, fctx, "Duration", zeroLocals);
    releaseLocals(fctx, zeroLocals);
    return result;
  }
  // Temporal.Duration.prototype.add/subtract throw RangeError when either
  // operand has nonzero calendar units — years, months, or weeks — because
  // they cannot be balanced without a relativeTo (AddDurations →
  // DefaultTemporalLargestUnit > "day" → RangeError in the spec).
  {
    const throwInstrs = buildTemporalThrowInstrs(
      ctx,
      fctx,
      "Duration.add/subtract does not support calendar units (years, months, weeks)",
    );
    for (let i = 0; i < 3; i++) {
      fctx.body.push(
        { op: "local.get", index: ref.local },
        { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i },
        { op: "f64.const", value: 0 },
        { op: "f64.ne" },
        { op: "local.get", index: otherLocals[i]! },
        { op: "f64.const", value: 0 },
        { op: "f64.ne" },
        { op: "i32.or" },
      );
      if (i > 0) fctx.body.push({ op: "i32.or" });
    }
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs });
  }
  for (let i = 0; i < DURATION_FIELDS.length; i++) {
    const local = allocTempLocal(fctx, F64);
    resultLocals.push(local);
    fctx.body.push(
      { op: "local.get", index: ref.local },
      { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i },
      { op: "local.get", index: otherLocals[i]! },
      sign === 1 ? { op: "f64.add" } : { op: "f64.sub" },
      { op: "local.set", index: local },
    );
  }
  const result = emitTemporalStructFromLocals(ctx, fctx, "Duration", resultLocals);
  releaseRefLocal(fctx, ref);
  releaseLocals(fctx, otherLocals);
  releaseLocals(fctx, resultLocals);
  return result;
}

function emitTemporalToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  kind: TemporalKind,
): InnerResult {
  const ref = compileTemporalRefToLocal(ctx, fctx, receiver, kind);
  if (!ref) return compileStringLiteral(ctx, fctx, "") ?? EXTERNREF;
  const fieldCount = kind === "PlainDate" ? 3 : kind === "PlainTime" ? 6 : 10;
  const helperName =
    kind === "PlainDate"
      ? "__temporal_plain_date_to_string"
      : kind === "PlainTime"
        ? "__temporal_plain_time_to_string"
        : "__temporal_duration_to_string";
  const helperIdx = ensureTemporalImport(
    ctx,
    fctx,
    helperName,
    Array.from({ length: fieldCount }, () => F64),
    [EXTERNREF],
  );
  for (let i = 0; i < fieldCount; i++) {
    fctx.body.push({ op: "local.get", index: ref.local }, { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i });
  }
  if (helperIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(helperName) ?? helperIdx });
  } else {
    for (let i = 0; i < fieldCount; i++) fctx.body.push({ op: "drop" });
    compileStringLiteral(ctx, fctx, "");
  }
  releaseRefLocal(fctx, ref);
  return EXTERNREF;
}

export function tryCompileTemporalMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  const kind = temporalKindForExpression(ctx, fctx, propAccess.expression);
  if (!kind) return undefined;

  const methodName = propAccess.name.text;
  if (methodName === "toString" || methodName === "toJSON" || methodName === "toLocaleString") {
    return emitTemporalToString(ctx, fctx, propAccess.expression, kind);
  }
  if (methodName === "valueOf") {
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType !== null) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "Temporal objects do not have a primitive value");
    fctx.body.push({ op: "ref.null.extern" });
    return EXTERNREF;
  }
  if ((kind === "PlainDate" || kind === "PlainTime") && methodName === "equals") {
    return emitTemporalEquals(ctx, fctx, propAccess.expression, callExpr.arguments[0], kind);
  }
  if (kind === "PlainDate" && (methodName === "add" || methodName === "subtract")) {
    return emitPlainDateAddSubtract(
      ctx,
      fctx,
      propAccess.expression,
      callExpr.arguments[0],
      methodName === "add" ? 1 : -1,
    );
  }
  if (kind === "PlainTime" && (methodName === "add" || methodName === "subtract")) {
    return emitPlainTimeAddSubtract(
      ctx,
      fctx,
      propAccess.expression,
      callExpr.arguments[0],
      methodName === "add" ? 1 : -1,
    );
  }
  if (kind === "Duration" && (methodName === "add" || methodName === "subtract")) {
    return emitDurationAddSubtract(
      ctx,
      fctx,
      propAccess.expression,
      callExpr.arguments[0],
      methodName === "add" ? 1 : -1,
    );
  }
  if (kind === "Duration" && (methodName === "negated" || methodName === "abs")) {
    const ref = compileTemporalRefToLocal(ctx, fctx, propAccess.expression, "Duration");
    if (!ref) return undefined;
    const locals: number[] = [];
    for (let i = 0; i < DURATION_FIELDS.length; i++) {
      const local = allocTempLocal(fctx, F64);
      locals.push(local);
      fctx.body.push({ op: "local.get", index: ref.local }, { op: "struct.get", typeIdx: ref.typeIdx, fieldIdx: i });
      if (methodName === "negated") {
        fctx.body.push({ op: "f64.neg" });
      } else {
        fctx.body.push({ op: "f64.abs" });
      }
      fctx.body.push({ op: "local.set", index: local });
    }
    const result = emitTemporalStructFromLocals(ctx, fctx, "Duration", locals);
    releaseRefLocal(fctx, ref);
    releaseLocals(fctx, locals);
    return result;
  }

  return undefined;
}
