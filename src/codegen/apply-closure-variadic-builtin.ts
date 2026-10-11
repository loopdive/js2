// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6701 — the variadic builtin value-closure arm of `__apply_closure`.
 *
 * `Math.max` / `Math.min` / `String.fromCharCode` reified as VALUES (#2933,
 * #4491) take ONE `(ref null $vec_externref)` args param instead of one param
 * per argument. A direct `m(3, 9, 1)` works because call-identifier.ts packs
 * the arguments for that func type, but every DYNAMIC invocation goes through
 * `__apply_closure(fn, thisArg, args)`, whose arity ladder
 * (`__call_fn_method_<n>`) has no arm for the vec convention — so under
 * `--target standalone`
 *
 *     Math.max.apply(null, [3, 9, 1]);   // answered -Infinity
 *     Math.max.call(null, 3, 9, 1);      // answered -Infinity
 *
 * (the body ran with a null vec and folded nothing). This arm runs ahead of
 * the ladder: when `fn` is a closure of the variadic builtin func type, it
 * copies the call's argument carrier (any array-like — `$ObjVec`, a concrete
 * `__vec_<k>`, an `arguments` object — read through `__extern_get_idx`) into a
 * fresh `$vec_externref` and `call_ref`s the closure with it. Modules that never
 * reified a variadic builtin value emit nothing (byte-identical).
 */
import type { Instr, ValType } from "../ir/types.js";
import { getClosureFuncSelfTypeIdx } from "./closures/funcref-wrapper-types.js";
import type { CodegenContext } from "./context/types.js";
import { BFN_ID_FIELD_IDX, linkedMetaSignatureGuard } from "./builtin-fn-meta.js";

/** A rest callback can share the builtin's signature, but not its identity. */
function variadicBuiltinIdentity(ctx: CodegenContext): Instr[] {
  const body: Instr[] = [{ op: "i32.const", value: 0 }];
  for (const key of ["static:Math.max", "static:Math.min", "static:String.fromCharCode"]) {
    const typeIdx = ctx.builtinFnMetaTypeByKey?.get(key);
    if (typeIdx === undefined) continue;
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: BFN_ID_FIELD_IDX },
          { op: "i32.const", value: typeIdx },
          { op: "i32.eq" },
          // (#6651 V0) linked modules: a peer closure can carry our id.
          ...linkedMetaSignatureGuard(ctx, typeIdx, [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }]),
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
      { op: "i32.or" },
    );
  }
  return body;
}

/**
 * Build the arm for `__apply_closure` (params 0=fn 1=recv 2=args; local
 * `argcLocal` already holds the raw argument count, `argcGlobalIdx` is reset
 * the way the bridge's own tail resets it). Appends its scratch
 * locals to `locals` (numbered from 3). Returns `[]` when the module has no
 * variadic builtin closure or the generic element reader is unavailable.
 */
export function buildVariadicBuiltinApplyArm(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  argcLocal: number,
  argcGlobalIdx: number,
): Instr[] {
  const variadic = ctx.standalone || ctx.wasi ? ctx.variadicBuiltinClosure : undefined;
  const externGetIdx = ctx.funcMap.get("__extern_get_idx");
  if (variadic === undefined || externGetIdx === undefined) return [];
  const { funcTypeIdx, structTypeIdx, vecTypeIdx, arrTypeIdx } = variadic;
  const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, funcTypeIdx) ?? structTypeIdx;
  const arrLocal = 3 + locals.length;
  locals.push({ name: "__variadic_builtin_arr", type: { kind: "ref_null", typeIdx: arrTypeIdx } });
  const iLocal = 3 + locals.length;
  locals.push({ name: "__variadic_builtin_i", type: { kind: "i32" } });
  const fnAs = (typeIdx: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
  ];
  return [
    // Signature equality alone also admits user `function (...args)` bodies.
    // This shortcut deliberately does not install a receiver, so only the
    // three receiver-independent builtin identities may bypass the method
    // dispatcher. The metadata id disambiguates canonicalized sibling types.
    ...variadicBuiltinIdentity(ctx),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...fnAs(structTypeIdx),
        { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 },
        { op: "ref.test", typeIdx: funcTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // arr = new externref[argc]; arr[i] = args[i]
            { op: "local.get", index: argcLocal },
            { op: "array.new_default", typeIdx: arrTypeIdx },
            { op: "local.set", index: arrLocal },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: iLocal },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: iLocal },
                    { op: "local.get", index: argcLocal },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: arrLocal },
                    { op: "local.get", index: iLocal },
                    { op: "local.get", index: 2 },
                    { op: "local.get", index: iLocal },
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: externGetIdx },
                    { op: "array.set", typeIdx: arrTypeIdx },
                    { op: "local.get", index: iLocal },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: iLocal },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            ...fnAs(selfTypeIdx),
            { op: "local.get", index: argcLocal },
            { op: "local.get", index: arrLocal },
            { op: "ref.as_non_null" },
            { op: "struct.new", typeIdx: vecTypeIdx },
            ...fnAs(structTypeIdx),
            { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 },
            { op: "ref.cast", typeIdx: funcTypeIdx },
            { op: "call_ref", typeIdx: funcTypeIdx },
            { op: "i32.const", value: -1 },
            { op: "global.set", index: argcGlobalIdx },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/**
 * The same arm for the fixed-arity method dispatcher `__call_fn_method_<arity>`
 * (params 0=this 1=fn 2..arity+1=args): the inline `.call` fast path
 * (closure-call-fast.ts) reaches it directly for `Math.max.call(null, 3, 9, 1)`,
 * whose generic arm would cast the first argument to the vec param. Packs the
 * `arity` supplied arguments exactly, the #3992 variadic native-proto arm's
 * convention. `restore` re-installs the saved `__current_this` and leaves the
 * externref result on the stack before the `return`.
 */
export function buildVariadicBuiltinMethodCallArm(
  ctx: CodegenContext,
  arity: number,
  anyLocal: number,
  restore: Instr[],
): Instr[] {
  const variadic = ctx.standalone || ctx.wasi ? ctx.variadicBuiltinClosure : undefined;
  if (variadic === undefined) return [];
  const { funcTypeIdx, structTypeIdx, vecTypeIdx, arrTypeIdx } = variadic;
  const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, funcTypeIdx) ?? structTypeIdx;
  const fnAs = (typeIdx: number): Instr[] => [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx },
  ];
  const args: Instr[] = [];
  for (let k = 0; k < arity; k++) args.push({ op: "local.get", index: 2 + k });
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: structTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...fnAs(structTypeIdx),
        { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 },
        { op: "ref.test", typeIdx: funcTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...fnAs(selfTypeIdx),
            { op: "i32.const", value: arity },
            ...args,
            { op: "array.new_fixed", typeIdx: arrTypeIdx, length: arity },
            { op: "struct.new", typeIdx: vecTypeIdx },
            ...fnAs(structTypeIdx),
            { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 },
            { op: "ref.cast", typeIdx: funcTypeIdx },
            { op: "call_ref", typeIdx: funcTypeIdx },
            ...restore,
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** `result → save; __current_this = prev; push save` — the dispatcher's arm tail. */
export function restoreThisKeepResult(resultSave: number, prevThis: number, currentThisGlobal: number): Instr[] {
  return [
    { op: "local.set", index: resultSave },
    { op: "local.get", index: prevThis },
    { op: "global.set", index: currentThisGlobal },
    { op: "local.get", index: resultSave },
  ];
}
