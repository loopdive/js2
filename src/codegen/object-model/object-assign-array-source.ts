// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7155) The ARRAY-source arm of the native `__object_assign` per-source loop.
 *
 * §20.1.2.1 step 4.b copies `from.[[OwnPropertyKeys]]()` — for an Array
 * (§10.4.2) that is its present integer indices ascending, then `length`, which
 * is non-enumerable and so never copied. A native array is a `__vec_<k>` struct
 * subtyping `$__vec_base`, not an open `$Object`, so the loop's `$Object` arm
 * skipped it and object spread / `Object.assign` of an array copied nothing —
 * or, worse, the spread call site materialized the vec's physical fields and
 * produced `{ length: 2, data: … }` (`{ ...[5, 6] }` listed `length,data`).
 *
 * The arm tests the same `$__vec_base` predicate the `__object_keys` /
 * `__object_keys_forin` vec arm uses, then for `i` in `0 … length-1` asks the
 * `HasProperty` chokepoint `__extern_has_idx` (holes and deleted indices answer
 * false and are skipped), and copies `Set(to, i, Get(from, i), true)` through
 * `__extern_set_strict` — the write the `$Object` arm uses; its ToPropertyKey
 * yields the canonical `"i"`, so the #7148 key order (integer keys ascending
 * first) is the target's own. Holes are skipped only where `__extern_has_idx`
 * models them (gc native-first / standalone; wasi's lacks the hole arms).
 *
 * Emitted inside `__object_assign`'s per-source loop, whose local layout is
 * {@link ASSIGN_LOCALS}; it reuses the closed-struct arm's scratch locals
 * (count / index / key), as the arms run one after the other and each
 * re-initializes them. Returns `[]` (byte-inert) when a dependency is absent.
 */
import type { Instr } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

function isArrayFact(ctx: CodegenContext, expr: ts.Expression): boolean {
  const kind = ctx.oracle.typeFactOf(expr).kind;
  return kind === "array" || kind === "tuple";
}

/**
 * `Object.assign(<non-array>, …, <array>, …)`: lib.es2015 types the result
 * `T & U[]`, so an unannotated binding would take an array slot, but the call
 * returns the (non-array) target. `call` is the ambient `Object.assign` call.
 */
export function objectAssignArraySourceLies(ctx: CodegenContext, call: ts.CallExpression): boolean {
  if (!(ctx.standalone || ctx.wasi)) return false;
  const [target, ...sources] = call.arguments;
  if (target === undefined || ts.isSpreadElement(target) || isArrayFact(ctx, target)) return false;
  return sources.some((arg) => !ts.isSpreadElement(arg) && isArrayFact(ctx, arg));
}

/** `__object_assign`'s locals: 0=target, 6=srcAny, 12=srcExt, 14/15/16=closed-struct scratch. */
const ASSIGN_LOCALS = { target: 0, sourceAny: 6, source: 12, count: 14, index: 15, key: 16 } as const;

export function arrayAssignSourceInstrs(ctx: CodegenContext, vecBaseTypeIdx: number): Instr[] {
  const hasIdxIdx = ctx.funcMap.get("__extern_has_idx");
  const getIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const strictSetIdx = ctx.funcMap.get("__extern_set_strict");
  if (
    vecBaseTypeIdx < 0 ||
    hasIdxIdx === undefined ||
    getIdxIdx === undefined ||
    boxNumberIdx === undefined ||
    strictSetIdx === undefined
  ) {
    return [];
  }
  const { target, sourceAny, source, count, index, key } = ASSIGN_LOCALS;
  return [
    { op: "local.get", index: sourceAny },
    { op: "ref.test", typeIdx: vecBaseTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: sourceAny },
        { op: "ref.cast", typeIdx: vecBaseTypeIdx },
        { op: "struct.get", typeIdx: vecBaseTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: count },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: index },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: index },
                { op: "local.get", index: count },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // HasProperty(from, i): a hole is not an own key.
                { op: "local.get", index: source },
                { op: "local.get", index: index },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: hasIdxIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // key = i; `__extern_set_strict`'s ToPropertyKey makes it "i"
                    { op: "local.get", index: index },
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: boxNumberIdx },
                    { op: "local.set", index: key },
                    // Set(to, key, Get(from, i), true)
                    { op: "local.get", index: target },
                    { op: "local.get", index: key },
                    { op: "local.get", index: source },
                    { op: "local.get", index: index },
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: getIdxIdx },
                    { op: "call", funcIdx: strictSetIdx },
                  ],
                },
                { op: "local.get", index: index },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: index },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}
