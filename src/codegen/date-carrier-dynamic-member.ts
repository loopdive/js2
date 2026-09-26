// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6678) `Date.prototype` members read off a Date that travelled through an
 * untyped slot, under `--target standalone`.
 *
 * ## The gap
 *
 * A Date the checker can see (`var d = new Date(t); d.getTime()`) lowers to
 * the native `$__Date` field read directly. A Date stored in an object property
 * and read back (`o._d = new Date(t); o._d.getTime()` — moment keeps every
 * instant in `this._d`) is an `any` receiver: the call goes through the closed
 * method dispatcher to `__extern_method_call`, and a value read through
 * `__extern_get`. Neither had a `$__Date` arm, so `__extern_get` answered
 * `undefined` for every member (`typeof o._d.getTime === "undefined"`), the
 * call answered `undefined`, and `o._d.valueOf()` fell to the inherited
 * Object path and answered the `toString()` text. moment then saw
 * `isNaN(this._d.getTime())` and made every moment invalid.
 *
 * ## The fix
 *
 * §10.1.8 OrdinaryGet on a Date walks to `Date.prototype`, and those members
 * already exist as identity-stable native closures (`Date.prototype.getTime`
 * value reads, `Date.prototype.getTime.call(d)`). Two finalize arms reuse them:
 *
 *  - `__extern_get(date, "<m>")` answers the `Date.prototype.<m>` singleton;
 *  - `__extern_method_call(date, "<m>", args)` resolves through that read and
 *    applies it with the Date as `this` (the #4619 `$NativeProto` arm's shape).
 *
 * ## Demand gate
 *
 * The arms answer only members whose closure the module has already minted;
 * minting happens at the first `new Date(...)` of a source file, for the Date
 * members that file names as a property (`.getTime`, `["valueOf"]`). A module
 * that never constructs a Date, or never names a Date member, emits exactly as
 * before. Members whose native body is not wired (the string formatters) are
 * not minted, so they keep their previous lowering rather than gaining a
 * throwing closure.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureDateNativeProtoGlue } from "./array-object-proto.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { ensureStandaloneNativeMethodClosure, getNativeProtoBuiltinGlue } from "./native-proto.js";
import { definedFuncAt } from "./func-space.js";
import { nativeStringLiteralInstrs, stringConstantExternrefInstrs } from "./native-strings.js";
import { flushLateImportShifts } from "./shared.js";

const namesBySourceFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();
const mintedSourceFiles = new WeakMap<CodegenContext, Set<ts.SourceFile>>();

/** Every static property name the file mentions (`.x`, `["x"]`). */
function propertyNamesOf(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = namesBySourceFile.get(sourceFile);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    // Synthesized subtrees (a spliced harness, a lowered `class extends Date`)
    // can carry nodes without a `name`/argument, so test before classifying.
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
    } else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (key && ts.isStringLiteralLike(key)) names.add(key.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  namesBySourceFile.set(sourceFile, names);
  return names;
}

/**
 * Mint the `Date.prototype` closures the file around `anchor` may read off an
 * untyped Date. Called at a standalone `new Date(...)` site; idempotent per
 * source file. Only members with a native body are minted.
 */
export function mintDateCarrierDynamicMembers(ctx: CodegenContext, fctx: FunctionContext, anchor: ts.Node): void {
  if (!ctx.standalone || ctx.wasi) return;
  const sourceFile = ts.getOriginalNode(anchor).getSourceFile() as ts.SourceFile | undefined;
  if (!sourceFile) return;
  let seen = mintedSourceFiles.get(ctx);
  if (!seen) mintedSourceFiles.set(ctx, (seen = new Set()));
  if (seen.has(sourceFile)) return;
  seen.add(sourceFile);
  const brand = ensureDateNativeProtoGlue(ctx);
  const glue = brand === undefined ? undefined : getNativeProtoBuiltinGlue(ctx, brand);
  if (brand === undefined || !glue) return;
  const named = propertyNamesOf(sourceFile);
  for (const member of glue.memberCsv.split(",")) {
    if (member.startsWith("@@") || member === "constructor" || !named.has(member)) continue;
    ensureStandaloneNativeMethodClosure(ctx, brand, member, "method");
  }
  flushLateImportShifts(ctx, fctx);
}

/**
 * The Date members this module minted a METHOD closure for, sorted. A member
 * the program assigns on some builtin prototype (`Date.prototype.getTime = …`)
 * is left to the existing lookup: the singleton would hide the override.
 */
function mintedDateMembers(ctx: CodegenContext, brand: number): string[] {
  const prefix = `__proto_method_${brand}_`;
  const members: string[] = [];
  for (const name of ctx.funcMap.keys()) {
    if (!name.startsWith(prefix)) continue;
    const member = name.slice(prefix.length);
    if (member.startsWith("get_") || member.startsWith("@@") || member === "constructor") continue;
    if (ctx.protoNamedWrittenMembers.has(member)) continue;
    members.push(member);
  }
  return members.sort();
}

/** `__extern_get(date, key)` → the minted `Date.prototype.<key>` singleton. */
function unshiftExternGetArm(ctx: CodegenContext, dateTypeIdx: number, brand: number, members: string[]): void {
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStr = ctx.anyStrTypeIdx;
  if (!fn || strFlattenIdx === undefined || strEqualsIdx === undefined || anyStr < 0) return;
  const keyLocal = 2 + fn.locals.length;
  const ladder: Instr[] = [];
  for (const member of members) {
    const closure = ensureStandaloneNativeMethodClosure(ctx, brand, member, "method");
    if (!closure) continue;
    ladder.push(
      { op: "local.get", index: keyLocal },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, member),
      { op: "call", funcIdx: strEqualsIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...pushBuiltinFnSingletonValueInstrs(ctx, closure), { op: "extern.convert_any" }, { op: "return" }],
      },
    );
  }
  if (ladder.length === 0) return;
  fn.locals.push({ name: "dck", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } });
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: dateTypeIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: strFlattenIdx },
    { op: "local.set", index: keyLocal },
    ...ladder,
  ];
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}

/** `__extern_method_call(date, key, args)` → apply the resolved member, `this` = the Date. */
function unshiftMethodCallArm(ctx: CodegenContext, dateTypeIdx: number): void {
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_method_call");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  if (!fn || externGetIdx === undefined || applyClosureIdx === undefined) return;
  const methodLocal = 3 + fn.locals.length;
  const nullishToNullIdx = ctx.funcMap.get("__nullish_to_null");
  const newLocals: { name: string; type: ValType }[] = [{ name: "dcm", type: { kind: "externref" } }];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: dateTypeIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: externGetIdx },
    ...(nullishToNullIdx === undefined ? [] : ([{ op: "call", funcIdx: nullishToNullIdx }] satisfies Instr[])),
    { op: "local.tee", index: methodLocal },
    { op: "ref.is_null" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: methodLocal },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "return" },
  ];
  fn.locals.push(...newLocals);
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}

/**
 * `__dyn_valueOf(date)` — the helper a zero-argument `<any>.valueOf()` lowers
 * to (wrapper-valueof.ts) returns a non-`$Object` receiver unchanged, which is
 * `Object.prototype.valueOf`; a Date answers its time value (§21.4.4.44).
 */
function unshiftDynValueOfArm(ctx: CodegenContext, dateTypeIdx: number): void {
  const helperIdx = ctx.funcMap.get("__dyn_valueOf");
  const fn = helperIdx === undefined ? undefined : definedFuncAt(ctx, helperIdx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  if (!fn || externGetIdx === undefined || applyClosureIdx === undefined || objVecNewIdx === undefined) return;
  const methodLocal = 1 + fn.locals.length;
  const nullishToNullIdx = ctx.funcMap.get("__nullish_to_null");
  fn.locals.push({ name: "dcv", type: { kind: "externref" } });
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: dateTypeIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 0 },
    ...stringConstantExternrefInstrs(ctx, "valueOf"),
    { op: "call", funcIdx: externGetIdx },
    ...(nullishToNullIdx === undefined ? [] : ([{ op: "call", funcIdx: nullishToNullIdx }] satisfies Instr[])),
    { op: "local.tee", index: methodLocal },
    { op: "ref.is_null" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: methodLocal },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: objVecNewIdx },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "return" },
  ];
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}

/**
 * Finalize: prepend the `$__Date` receiver arms onto `__extern_get`,
 * `__extern_method_call` and `__dyn_valueOf`. MUST run before `unshiftExternGetProtoCacheArm`,
 * which has to stay `__extern_get`'s prefix. No-op without a minted member.
 */
export function unshiftDateCarrierMemberArms(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.wasi) return;
  const dateTypeIdx = ctx.structMap.get("__Date");
  const brand = dateTypeIdx === undefined ? undefined : ctx.builtinBrandMap?.get("Date");
  if (dateTypeIdx === undefined || brand === undefined) return;
  const members = mintedDateMembers(ctx, brand);
  if (members.length === 0) return;
  unshiftExternGetArm(ctx, dateTypeIdx, brand, members);
  unshiftMethodCallArm(ctx, dateTypeIdx);
  if (members.includes("valueOf")) unshiftDynValueOfArm(ctx, dateTypeIdx);
}
