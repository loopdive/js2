// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6642 S62) §21.2.3.3 `BigInt.prototype.toString` for a DYNAMIC receiver, and
 * ToString of a bigint, under `--target standalone`.
 *
 * ## The gap
 *
 * The standalone bigint carrier is a module-private `$BigInt` struct with one
 * immutable i64 field, minted lazily by `addUnionImportsAsNativeFuncs`. It is
 * not a `$Object`, not a vec, not a closure carrier and not an `$AnyValue` tag,
 * so it fell off the end of BOTH stringification ladders:
 *
 * | shape (receiver's static type is `any`)      | base                      |
 * | -------------------------------------------- | ------------------------- |
 * | `b.toString(16)` / `b.toString()`            | `TypeError: called value is not a function` |
 * | `String(b)` (`__any_to_string`)              | **null** — the caller then traps |
 * | `"" + b`                                     | correct (`__to_primitive`'s own bigint arm) |
 * | `(255n).toString(16)` static receiver        | correct (#1644 slice D)   |
 *
 * The `"" + b` row is the tell: the ANSWER machinery has existed since #1644 —
 * `bigint_toString_radix(i64, i32) -> externref` in `bigint-format-native.ts`
 * formats radices 2..36 exactly, sign-aware, straight off the i64. Only the two
 * dynamic ROUTES to it were missing, and this module adds exactly those two.
 *
 * ## Why this blocked the Temporal rows, and why it had to come with link 4
 *
 * `@js-temporal/polyfill` converts its JSBI carrier to a real BigInt with
 * `globalThis.BigInt(t.toString(10))`. Before `"BigInt"` was seeded into
 * `STANDALONE_GLOBAL_CONSTRUCTOR_NAMES` the `void 0 !== globalThis.BigInt`
 * guard short-circuited and that line never ran; seeding the realm constructor
 * is what first EXECUTES it, on a receiver whose `toString` was not callable.
 * That is why S61 measured links 3+4 turning a wrong VALUE into a thrown
 * TypeError and held them back — this module is the missing precondition.
 *
 * ## Why an arm and not a `%BigInt.prototype%` brand
 *
 * The three wrapper families (`Number` / `String` / `Boolean`) get their
 * dynamic-receiver routing from a real `$NativeProto` brand with a member CSV
 * and reflective member bodies (`array-object-proto.ts`,
 * `wrapper-proto-to-string.ts`). BigInt has no such brand, and minting one is a
 * whole slice: a brand-table entry, a member CSV, `thisBigIntValue`, a
 * companion seeder. The single member that is broken has a complete native
 * formatter already, so the arm resolves it by NAME against an interned
 * `$NativeString` — the `ta-dyn-method-call.ts` shape — and declines
 * everything else. `BigInt.prototype` therefore stays exactly as un-reified as
 * it is on the base; only the CALL is answered.
 *
 * ## Absent-not-wrong
 *
 * Every guard exits through `br_if 0` out of a `block`, so a decline leaves the
 * untouched body to answer and the stack empty. The arm claims a call only when
 * the receiver is the `$BigInt` carrier AND the key is the interned string
 * `"toString"`; a bigint receiver's any other member, and every other
 * receiver brand, reach precisely the arms they reach today.
 *
 * ## Demand
 *
 * Both splices are gated on `ctx.nativeBigIntTypeIdx >= 0` — the module
 * actually minted the bigint carrier, i.e. it uses BigInt at all. A module that
 * does not compiles byte-identically. There is deliberately no additional AST
 * scan: unlike the Number arm (whose gate has to exclude the near-universal
 * 0-argument `x.toString()`), "this module has a bigint" is already the narrow
 * condition, and a module that has one must be able to print it.
 *
 * ## Range
 *
 * The carrier is ONE i64, so the answer is exact on [-2^63, 2^63-1] and the
 * lane's arithmetic wraps modulo 2^64 above it — the same documented limit
 * S61's StringToBigInt parser carries, so a parsed string and a printed value
 * agree. Arbitrary precision is a whole-lane change (a limb representation).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { emitNativeBigIntFormat } from "./bigint-format-native.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ANY_TO_STRING_HELPER, nativeStringLiteralInstrs } from "./native-strings.js";
import { runtimeToNumberInstrs } from "./coercion-engine.js";

/** Radix used when the argument is absent, `null` or `undefined` (§21.2.3.3 step 2). */
const DEFAULT_RADIX = 10;

/**
 * Mint `bigint_toString_radix` if the module has not already demanded it, and
 * return its index.
 *
 * `emitNativeBigIntFormat` mints DEFINED functions (append-only) and pulls the
 * native-string helpers, so calling it at finalize cannot move an
 * already-registered function index — the stale-`funcIdx` hazard #6642's Fix 1
 * had to repair only applies to late IMPORTS.
 */
function ensureBigIntRadixFormatter(ctx: CodegenContext): number | undefined {
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return undefined;
  if (!ctx.funcMap.has("bigint_toString_radix")) {
    emitNativeBigIntFormat(ctx, new Set(["bigint_toString_radix"]));
  }
  return ctx.funcMap.get("bigint_toString_radix");
}

/**
 * `String(<bigint>)` / every other `__any_to_string` caller.
 *
 * Spliced at the FRONT of `__any_to_string`, the `unshiftDateToStringArm`
 * (#4564) shape: param 0 is an `anyref`, and `ref.test` on a null anyref is 0,
 * so a null receiver falls through to the original first instruction untouched.
 * The helper's declared result is `ref $AnyString` and the formatter answers an
 * externref over a `$NativeString`, so the claim ends
 * `any.convert_extern; ref.cast $AnyString; return`.
 */
export function unshiftAnyToStringBigIntArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  if (ctx.nativeBigIntTypeIdx < 0) return;
  if (ctx.anyStrTypeIdx < 0) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === ANY_TO_STRING_HELPER);
  if (!fn) return;
  const marker = ctx as unknown as { __bigintAnyToStringArmFilled?: boolean };
  if (marker.__bigintAnyToStringArmFilled === true) return;
  const formatIdx = ensureBigIntRadixFormatter(ctx);
  if (formatIdx === undefined) return;
  marker.__bigintAnyToStringArmFilled = true;

  fn.body.unshift({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
      { op: "local.get", index: 0 },
      { op: "ref.cast", typeIdx: ctx.nativeBigIntTypeIdx },
      { op: "struct.get", typeIdx: ctx.nativeBigIntTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: DEFAULT_RADIX },
      { op: "call", funcIdx: formatIdx },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "return" },
    ],
  });
}

/**
 * Prepend the bigint-PRIMITIVE receiver arm onto `__extern_method_call`.
 *
 * ABI of the host function: param 0 = receiver externref, 1 = key externref,
 * 2 = args `$ObjVec` (as externref).
 *
 * The radix ladder is §21.2.3.3 steps 2–4 and is deliberately the same shape as
 * `emitNumberProtoToStringBody`'s (wrapper-proto-to-string.ts): an absent,
 * `null` or `undefined` argument means 10 and SKIPS the range check, so
 * `b.toString(undefined)` is decimal and not a RangeError; anything else is
 * floored and must land in [2, 36].
 */
export function unshiftExternMethodCallBigIntPrimitiveArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  if (ctx.nativeBigIntTypeIdx < 0) return;
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return;
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  const objVecArrTypeIdx = ctx.objectRuntimeTypes?.objVecArrTypeIdx;
  if (objVecTypeIdx === undefined || objVecArrTypeIdx === undefined) return;
  // §7.1.4 ToNumber of the radix argument, taken from the single coercion
  // engine rather than hand-rolled — the same route `builtin-ctor-callable.ts`
  // uses for `Number(x)`.
  const toNumberInstrs = runtimeToNumberInstrs(ctx);
  if (toNumberInstrs === null) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_method_call");
  if (!fn) return;
  const marker = ctx as unknown as { __bigintExternMethodCallArmFilled?: boolean };
  if (marker.__bigintExternMethodCallArmFilled === true) return;
  const formatIdx = ensureBigIntRadixFormatter(ctx);
  if (formatIdx === undefined) return;
  const nameLiteral = nativeStringLiteralInstrs(ctx, "toString");
  if (nameLiteral.length === 0) return;
  marker.__bigintExternMethodCallArmFilled = true;

  const isUndefinedIdx = ctx.funcMap.get("__typeof_undefined");
  const base = 3 + fn.locals.length;
  const RECV_ANY = base;
  const ARGS_ANY = base + 1;
  const ARG0 = base + 2;
  const RADIX_F64 = base + 3;
  const newLocals: { name: string; type: ValType }[] = [
    { name: "bpts_recv", type: { kind: "anyref" } },
    { name: "bpts_args", type: { kind: "anyref" } },
    { name: "bpts_a0", type: { kind: "externref" } },
    { name: "bpts_radix", type: { kind: "f64" } },
  ];

  // §21.2.3.3 step 3-4 on a supplied, non-undefined argument.
  const validateRadix: Instr[] = [
    { op: "local.get", index: ARG0 },
    ...toNumberInstrs,
    { op: "f64.floor" },
    { op: "local.tee", index: RADIX_F64 },
    { op: "f64.const", value: 2 },
    { op: "f64.lt" },
    { op: "local.get", index: RADIX_F64 },
    { op: "f64.const", value: 36 },
    { op: "f64.gt" },
    { op: "i32.or" },
    // A non-numeric radix floors to NaN; the range test is false for NaN
    // either way, so it is tested explicitly.
    { op: "local.get", index: RADIX_F64 },
    { op: "local.get", index: RADIX_F64 },
    { op: "f64.ne" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "RangeError", "toString() radix must be between 2 and 36", {
        forceInModuleCtor: true,
      }),
    },
  ];
  const presentArm: Instr[] =
    isUndefinedIdx === undefined
      ? validateRadix
      : [
          { op: "local.get", index: ARG0 },
          { op: "call", funcIdx: isUndefinedIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: validateRadix },
        ];

  const body: Instr[] = [
    // 1. the receiver must be the native bigint carrier.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: RECV_ANY },
    { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    // 2. the key must be the interned native string "toString"; a rope or any
    //    other member declines.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.nativeStrTypeIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx },
    ...nameLiteral,
    { op: "ref.eq" },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    // 3. radix := argument 0 of the `$ObjVec`, defaulting to 10.
    { op: "f64.const", value: DEFAULT_RADIX },
    { op: "local.set", index: RADIX_F64 },
    { op: "ref.null.extern" },
    { op: "local.set", index: ARG0 },
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: ARGS_ANY },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ARGS_ANY },
        { op: "ref.cast", typeIdx: objVecTypeIdx },
        { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: ARGS_ANY },
            { op: "ref.cast", typeIdx: objVecTypeIdx },
            { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
            { op: "i32.const", value: 0 },
            { op: "array.get", typeIdx: objVecArrTypeIdx },
            { op: "local.set", index: ARG0 },
          ],
        },
      ],
    },
    { op: "local.get", index: ARG0 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: presentArm },
    // 4. format the i64 exactly.
    { op: "local.get", index: RECV_ANY },
    { op: "ref.cast", typeIdx: ctx.nativeBigIntTypeIdx },
    { op: "struct.get", typeIdx: ctx.nativeBigIntTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: RADIX_F64 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "call", funcIdx: formatIdx },
    { op: "return" },
  ];

  fn.locals.push(...newLocals);
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}
