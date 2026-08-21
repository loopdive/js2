// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2875 wave-4 lane F) `delete <Builtin>.prototype.<member>` actually removes
 * the member.
 *
 * ## The measured defect
 *
 * Every own property of a builtin prototype is `{[[Configurable]]: true}`
 * (§17: only the function-object `length`/`name` and a ctor's `prototype` are
 * not), so `delete RegExp.prototype.global` must succeed AND must make
 * `RegExp.prototype.hasOwnProperty('global')` answer `false` afterwards.
 * Measured on this branch's base (`--target standalone`, probe
 * `test262/test/probe/f-re-proto.js`):
 *
 * | step                                        | base     | spec     |
 * | ------------------------------------------- | -------- | -------- |
 * | `RegExp.prototype.hasOwnProperty('global')` | `true`   | `true`   |
 * | `delete RegExp.prototype.global`            | `true`   | `true`   |
 * | `…hasOwnProperty('global')` again           | **`true`** | `false` |
 *
 * The delete reported success and changed nothing: a builtin prototype is a
 * `$NativeProto` glue singleton, and its own-member set is the `$memberCsv`
 * native string that `__nproto_hasown` (#4248) scans. `__delete_property` only
 * knows how to tombstone a `$PropEntry` row in a `$Object` hash table, so it
 * never touched the CSV.
 *
 * ## Why rewriting the CSV is the whole fix
 *
 * `$memberCsv` is a MUTABLE `externref` field, and at RUNTIME exactly one
 * consumer reads it: `__nproto_hasown`, which backs `__hasOwnProperty`,
 * `__object_hasOwn` and `__propertyIsEnumerable`. (Every other `memberCsv`
 * mention in codegen is the COMPILE-TIME `glue.memberCsv`, consulted while
 * emitting static member reads — those are unaffected, by design: this is the
 * reflective own-property surface, not the dispatch table.) So removing the
 * token from the string is exactly, and only, the observable delete.
 *
 * The rewrite is comma-padded — `",…csv…,"` with `",member,"` replaced by `","`
 * — so a member name that is a substring of another (`unicode` inside
 * `unicodeSets`) can never be matched partially. The padding commas are left in
 * place rather than sliced off: `__nproto_hasown`'s scanner treats every
 * comma-delimited run as a token and the end of string as a delimiter, so the
 * extra empty tokens match nothing and cost one comparison each.
 *
 * ## Scope
 *
 * - Builtin protos only (`$isClass == 0`): a user-class proto is a
 *   `$NativeProto` façade over the class's own machinery (#2101) and its
 *   deletes are answered elsewhere.
 * - Answers 0 — falls through to the untouched `__delete_property` body —
 *   whenever the receiver is not a builtin proto, the key is not a string, or
 *   the key is not currently in the CSV. It never claims a delete it did not
 *   perform.
 * - Demand-gated on `$NativeProto` existing in the module.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

/** `$NativeProto` field indices — the reader-visible contract (native-proto.ts). */
const NP_IS_CLASS = 1;
const NP_MEMBER_CSV = 4;

const DELETE_FN = "__nproto_delete";

/**
 * Register `__nproto_delete(obj externref, key externref) -> i32`: 1 when `obj`
 * is a builtin `$NativeProto` whose `$memberCsv` advertised `key` and the CSV
 * has now been rewritten without it, else 0.
 */
function registerNativeProtoDelete(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(DELETE_FN);
  if (existing !== undefined) return existing;
  const protoTypeIdx = ctx.nativeProtoTypeIdx;
  if (protoTypeIdx === undefined) return undefined;
  const anyStr = ctx.anyStrTypeIdx;
  const natStr = ctx.nativeStrTypeIdx;
  if (anyStr < 0 || natStr < 0) return undefined;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  const replaceIdx = ctx.nativeStrHelpers.get("__str_replace");
  if (flattenIdx === undefined || equalsIdx === undefined) return undefined;
  if (concatIdx === undefined || replaceIdx === undefined) return undefined;

  // params: 0 obj, 1 key
  const L_PROTO = 2;
  const L_FKEY = 3;
  const L_FCSV = 4;
  const L_PAD = 5;
  const L_NEEDLE = 6;
  const L_OUT = 7;
  const strNull: ValType = { kind: "ref_null", typeIdx: natStr };
  const locals: { name: string; type: ValType }[] = [
    { name: "proto", type: { kind: "ref_null", typeIdx: protoTypeIdx } },
    { name: "fkey", type: strNull },
    { name: "fcsv", type: strNull },
    { name: "pad", type: strNull },
    { name: "needle", type: strNull },
    // `__str_replace` is declared to return `$AnyString`, and the replaced
    // result is a ROPE — holding it in a `$NativeString` local made the
    // emitter insert a narrowing cast that trapped ("illegal cast in
    // __delete_property"). Keep it wide and flatten explicitly.
    { name: "out", type: { kind: "ref_null", typeIdx: anyStr } },
  ];
  const returnZero: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  const comma = (): Instr[] => nativeStringLiteralInstrs(ctx, ",");
  // The receiver is recovered ONCE into a local and every later use reads that
  // local. Repeating `local.get 0; any.convert_extern; ref.cast` instead was
  // measured to produce INVALID Wasm after this function is inlined into
  // `__delete_property`: the caller-side pass forwarded the FIRST occurrence's
  // already-cast value into the later `local.get 0` sites, so the body's own
  // `any.convert_extern` was handed a `(ref null $NativeProto)` and validation
  // failed with "any.convert_extern[0] expected type externref".
  const protoRef: Instr[] = [{ op: "local.get", index: L_PROTO }, { op: "ref.as_non_null" }];
  const csvAny: Instr[] = [
    ...protoRef,
    { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_MEMBER_CSV },
    { op: "any.convert_extern" },
  ];
  /**
   * `"," + <local> + ","`, flattened.
   *
   * The operand comes from a LOCAL, never from an inline `local.get 0` chain:
   * a literal push interleaved with a parameter read tripped the caller-side
   * inliner (measured — the inlined copy in `__delete_property` dropped the
   * `local.get 0`, leaving `any.convert_extern` reading the comma literal and
   * failing validation).
   */
  const pad = (strLocal: number): Instr[] => [
    ...comma(),
    { op: "local.get", index: strLocal },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: concatIdx },
    ...comma(),
    { op: "call", funcIdx: concatIdx },
    { op: "call", funcIdx: flattenIdx },
  ];

  const body: Instr[] = [
    // The receiver must be a BUILTIN `$NativeProto`.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: protoTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: protoTypeIdx },
    { op: "local.set", index: L_PROTO },
    ...protoRef,
    { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_IS_CLASS },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // A non-string key names no member.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // …and the CSV must be one (always is for a glue-built proto).
    ...csvAny,
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // fkey = flatten(key)   ·   fcsv = flatten(csv)
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: L_FKEY },
    ...csvAny,
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: L_FCSV },
    // pad = "," + csv + ","   ·   needle = "," + key + ","
    ...pad(L_FCSV),
    { op: "local.set", index: L_PAD },
    ...pad(L_FKEY),
    { op: "local.set", index: L_NEEDLE },
    // out = replace(pad, needle, ",")  — first occurrence, and a comma-padded
    // token can occur at most once in a well-formed CSV.
    { op: "local.get", index: L_PAD },
    { op: "ref.as_non_null" },
    { op: "local.get", index: L_NEEDLE },
    { op: "ref.as_non_null" },
    ...comma(),
    { op: "call", funcIdx: replaceIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: L_OUT },
    // Unchanged ⇒ the key was not advertised ⇒ this arm did not delete anything.
    { op: "local.get", index: L_OUT },
    { op: "ref.as_non_null" },
    { op: "local.get", index: L_PAD },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: equalsIdx },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // Publish the rewritten member set.
    ...protoRef,
    { op: "local.get", index: L_OUT },
    { op: "ref.as_non_null" },
    { op: "extern.convert_any" },
    { op: "struct.set", typeIdx: protoTypeIdx, fieldIdx: NP_MEMBER_CSV },
    { op: "i32.const", value: 1 },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(DELETE_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: DELETE_FN, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/**
 * Finalize splice: teach `__delete_property` about builtin-prototype members.
 *
 * Runs at finalize for the same reason `unshiftNativeProtoHasOwnArms` does —
 * `$NativeProto` is registered lazily during body compilation, long after the
 * object runtime is emitted. Minting here is append-only and the `call` is baked
 * in the same pass, so no previously-resolved funcIdx moves.
 */
export function unshiftNativeProtoDeleteArm(ctx: CodegenContext): void {
  const funcIdx = registerNativeProtoDelete(ctx);
  if (funcIdx === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__delete_property");
  if (!fn) return;
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
  );
}
