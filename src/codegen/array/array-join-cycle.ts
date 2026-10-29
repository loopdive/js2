// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7147) The join cycle guard of the native lanes' `Array.prototype.join` /
 * `Array.prototype.toString`.
 *
 * A nested array element stringifies through `Array.prototype.toString`, i.e.
 * a recursive `join(",")` (§23.1.3.36 → §23.1.3.18). The spec has no cycle
 * rule, so `a.push(a); a.join()` would recurse forever; every engine instead
 * renders an array that is ALREADY being joined as the empty string (V8's join
 * stack: `[1, 2, a].join()` with `a` itself in slot 2 is `"1,2,"`). This module
 * is that stack for the wasm lanes, with V8's contract:
 *
 *   - `__join_cycle_enter(arr) -> i32` — 1 when `arr` is on the stack (the
 *     caller answers ""), else pushes it and returns 0;
 *   - `__join_cycle_leave()` — pops the top frame.
 *
 * The stack is a linked list of `$__join_frame { arr: eqref, next: eqref }`
 * cells in one mutable global. A frame left behind by an element `toString`
 * that throws would make every later join of that array answer "", so the
 * joining loop runs inside a catch that pops and rethrows (`guardedJoinFold`):
 * the module tag on every lane, plus `catch_all` on the legacy-EH (JS-host
 * embedded) lane, where a foreign host exception can cross the fold.
 *
 * Residual: a wasm TRAP or an engine stack overflow inside an element
 * `toString` is not catchable by wasm, so the frames of the joins it aborted
 * stay on the stack, and an embedder that catches the trap and keeps using the
 * instance sees "" for those arrays in later joins. Nothing in the module can
 * tell a stale frame from a live outer join, so it is not reset here.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { addFuncType, registerStructType } from "../registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { buildTargetTaggedTry } from "../../wasm/physical/exception-control.js";
import { ensureExnTag } from "../registry/physical-imports.js";

const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type
const ENTER = "__join_cycle_enter";
const LEAVE = "__join_cycle_leave";

function ensureJoinCycleGuard(ctx: CodegenContext): { enter: number; leave: number } {
  const known = ctx.funcMap.get(ENTER);
  if (known !== undefined) return { enter: known, leave: ctx.funcMap.get(LEAVE)! };
  const eqref: ValType = { kind: "eqref" };
  const frame = registerStructType(ctx, "__join_frame", [
    { name: "arr", type: eqref, mutable: false },
    { name: "next", type: eqref, mutable: false },
  ]);
  const head = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({ name: "__join_stack", type: eqref, mutable: true, init: [{ op: "ref.null.eq" }] });

  // enter: params 0=arr(externref); locals 1=a(eqref), 2=cur(eqref)
  const enter = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, enter, {
    name: ENTER,
    typeIdx: addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]),
    locals: [
      { name: "a", type: eqref },
      { name: "cur", type: eqref },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "local.set", index: 1 },
          { op: "global.get", index: head },
          { op: "local.set", index: 2 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: 2 },
                  { op: "ref.is_null" },
                  { op: "br_if", depth: 1 },
                  { op: "local.get", index: 2 },
                  { op: "ref.cast", typeIdx: frame },
                  { op: "struct.get", typeIdx: frame, fieldIdx: 0 },
                  { op: "local.get", index: 1 },
                  { op: "ref.eq" },
                  { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
                  { op: "local.get", index: 2 },
                  { op: "ref.cast", typeIdx: frame },
                  { op: "struct.get", typeIdx: frame, fieldIdx: 1 },
                  { op: "local.set", index: 2 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
        ],
      },
      // Push even a non-`eq` receiver (as null) so enter/leave always pair.
      { op: "local.get", index: 1 },
      { op: "global.get", index: head },
      { op: "struct.new", typeIdx: frame },
      { op: "global.set", index: head },
      { op: "i32.const", value: 0 },
    ],
    exported: false,
  });
  ctx.funcMap.set(ENTER, enter);

  const leave = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, leave, {
    name: LEAVE,
    typeIdx: addFuncType(ctx, [], []),
    locals: [],
    body: [
      { op: "global.get", index: head },
      { op: "ref.cast", typeIdx: frame },
      { op: "struct.get", typeIdx: frame, fieldIdx: 1 },
      { op: "global.set", index: head },
    ],
    exported: false,
  });
  ctx.funcMap.set(LEAVE, leave);
  return { enter, leave };
}

/**
 * `arr` (instrs leaving the receiver as externref) → run `fold` with `arr` on
 * the join stack, or skip it when `arr` is already there (the caller's result
 * local keeps its initial ""). A throwing `fold` pops before the exception
 * propagates (see the module header for the trap residual).
 */
export function guardedJoinFold(ctx: CodegenContext, arr: Instr[], fold: Instr[]): Instr[] {
  const { enter, leave } = ensureJoinCycleGuard(ctx);
  const tagIdx = ensureExnTag(ctx); // already minted by the object runtime every caller reaches
  const pop = (): Instr => ({ op: "call", funcIdx: leave }); // fresh per site: index shifts mutate in place
  // The legacy `try` (JS-host-embedded lane) also pops on a foreign exception;
  // standalone/WASI throw nothing but the module tag (and traps, see above).
  const guarded = buildTargetTaggedTry(
    ctx,
    { kind: "empty" },
    fold,
    [{ tagIdx, body: [pop(), { op: "throw", tagIdx }] }],
    [pop(), { op: "rethrow", depth: 0 }],
  );
  return [
    ...arr,
    { op: "call", funcIdx: enter },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [guarded, pop()],
    },
  ];
}
