// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef } from "../ir/types.js";

/** Bound physical handles supplied by the owner after reservation, never allocated here. */
export interface PreparedNativeQueueHandle<Kind extends "type" | "global" | "function"> {
  readonly kind: Kind;
  readonly index: number;
}

/** Exact queue dependency snapshot. Promise/value policy and publication belong to its caller. */
export interface PreparedNativeMicrotaskReservations {
  readonly types: {
    readonly functions: PreparedNativeQueueHandle<"type">;
    readonly arguments: PreparedNativeQueueHandle<"type">;
    readonly callback: PreparedNativeQueueHandle<"type">;
  };
  readonly globals: {
    readonly head: PreparedNativeQueueHandle<"global">;
    readonly tail: PreparedNativeQueueHandle<"global">;
    readonly capacity: PreparedNativeQueueHandle<"global">;
    readonly functions: PreparedNativeQueueHandle<"global">;
    readonly captures: PreparedNativeQueueHandle<"global">;
    readonly arguments: PreparedNativeQueueHandle<"global">;
  };
  readonly grow: PreparedNativeQueueHandle<"function">;
  readonly initialCapacity: number;
}

export function buildGrowLocals(resources: PreparedNativeMicrotaskReservations): LocalDef[] {
  // Param 0: $newCap (i32). Local slots start at 1.
  return [
    { name: "$oldFuncs", type: { kind: "ref_null", typeIdx: resources.types.functions.index } },
    { name: "$oldCaps", type: { kind: "ref_null", typeIdx: resources.types.arguments.index } },
    { name: "$oldArgs", type: { kind: "ref_null", typeIdx: resources.types.arguments.index } },
    { name: "$oldHead", type: { kind: "i32" } },
    { name: "$oldTail", type: { kind: "i32" } },
    { name: "$i", type: { kind: "i32" } },
    { name: "$dst", type: { kind: "i32" } },
  ];
}

export function buildGrowBody(resources: PreparedNativeMicrotaskReservations): Instr[] {
  const newCapLocal = 0;
  const oldFuncs = 1;
  const oldCaps = 2;
  const oldArgs = 3;
  const oldHead = 4;
  const oldTail = 5;
  const i = 6;
  const dst = 7;

  return [
    // Snapshot the old state.
    { op: "global.get", index: resources.globals.functions.index },
    { op: "local.set", index: oldFuncs },
    { op: "global.get", index: resources.globals.captures.index },
    { op: "local.set", index: oldCaps },
    { op: "global.get", index: resources.globals.arguments.index },
    { op: "local.set", index: oldArgs },
    { op: "global.get", index: resources.globals.head.index },
    { op: "local.set", index: oldHead },
    { op: "global.get", index: resources.globals.tail.index },
    { op: "local.set", index: oldTail },

    // Allocate the new arrays with init = ref.null.
    // funcs: array.new (default=null funcref) of $newCap.
    { op: "ref.null.func" },
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: resources.types.functions.index },
    { op: "global.set", index: resources.globals.functions.index },

    { op: "ref.null.extern" },
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: resources.types.arguments.index },
    { op: "global.set", index: resources.globals.captures.index },

    { op: "ref.null.extern" },
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: resources.types.arguments.index },
    { op: "global.set", index: resources.globals.arguments.index },

    // If oldFuncs is null, no live entries to copy. Just reset head/tail
    // pointers and capacity, then return.
    { op: "local.get", index: oldFuncs },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "global.set", index: resources.globals.head.index },
        { op: "i32.const", value: 0 },
        { op: "global.set", index: resources.globals.tail.index },
        { op: "local.get", index: newCapLocal },
        { op: "global.set", index: resources.globals.capacity.index },
        { op: "return" },
      ],
    },

    // Copy live slice [oldHead, oldTail) into the new arrays starting at 0.
    { op: "local.get", index: oldHead },
    { op: "local.set", index: i },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: dst },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            { op: "local.get", index: oldTail },
            { op: "i32.eq" },
            // depth 1: exit the enclosing block (skip the loop label).
            { op: "br_if", depth: 1 },

            // funcs[dst] = oldFuncs[i]
            { op: "global.get", index: resources.globals.functions.index },
            { op: "local.get", index: dst },
            { op: "local.get", index: oldFuncs },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: resources.types.functions.index },
            { op: "array.set", typeIdx: resources.types.functions.index },

            // caps[dst] = oldCaps[i]
            { op: "global.get", index: resources.globals.captures.index },
            { op: "local.get", index: dst },
            { op: "local.get", index: oldCaps },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: resources.types.arguments.index },
            { op: "array.set", typeIdx: resources.types.arguments.index },

            // args[dst] = oldArgs[i]
            { op: "global.get", index: resources.globals.arguments.index },
            { op: "local.get", index: dst },
            { op: "local.get", index: oldArgs },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: resources.types.arguments.index },
            { op: "array.set", typeIdx: resources.types.arguments.index },

            // i++, dst++
            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "local.get", index: dst },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: dst },
            // depth 0: re-enter the loop label.
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Finalise head/tail/cap.
    { op: "i32.const", value: 0 },
    { op: "global.set", index: resources.globals.head.index },
    { op: "local.get", index: dst },
    { op: "global.set", index: resources.globals.tail.index },
    { op: "local.get", index: newCapLocal },
    { op: "global.set", index: resources.globals.capacity.index },
  ];
}

export function buildEnqueueBody(resources: PreparedNativeMicrotaskReservations): Instr[] {
  const fnLocal = 0;
  const capsLocal = 1;
  const argLocal = 2;

  return [
    // Lazy first-allocate. Test `funcs` against null.
    { op: "global.get", index: resources.globals.functions.index },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: resources.initialCapacity },
        { op: "call", funcIdx: resources.grow.index },
      ],
    },

    // If tail == cap, double the queue.
    { op: "global.get", index: resources.globals.tail.index },
    { op: "global.get", index: resources.globals.capacity.index },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: resources.globals.capacity.index },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" },
        { op: "call", funcIdx: resources.grow.index },
      ],
    },

    // Store fn, caps, arg at index `tail`.
    { op: "global.get", index: resources.globals.functions.index },
    { op: "ref.as_non_null" },
    { op: "global.get", index: resources.globals.tail.index },
    { op: "local.get", index: fnLocal },
    { op: "array.set", typeIdx: resources.types.functions.index },

    { op: "global.get", index: resources.globals.captures.index },
    { op: "ref.as_non_null" },
    { op: "global.get", index: resources.globals.tail.index },
    { op: "local.get", index: capsLocal },
    { op: "array.set", typeIdx: resources.types.arguments.index },

    { op: "global.get", index: resources.globals.arguments.index },
    { op: "ref.as_non_null" },
    { op: "global.get", index: resources.globals.tail.index },
    { op: "local.get", index: argLocal },
    { op: "array.set", typeIdx: resources.types.arguments.index },

    // tail++
    { op: "global.get", index: resources.globals.tail.index },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "global.set", index: resources.globals.tail.index },
  ];
}

export function buildDrainLocals(): LocalDef[] {
  return [
    { name: "$fn", type: { kind: "funcref" } },
    { name: "$caps", type: { kind: "externref" } },
    { name: "$arg", type: { kind: "externref" } },
  ];
}

export function buildDrainBody(resources: PreparedNativeMicrotaskReservations): Instr[] {
  const fnLocal = 0;
  const capsLocal = 1;
  const argLocal = 2;

  return [
    // If the queue was never used (`funcs` global null), there's nothing
    // to drain. Early-return to avoid `ref.as_non_null` on a null ref.
    { op: "global.get", index: resources.globals.functions.index },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "return" }],
    },

    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // Done when head == tail.
            { op: "global.get", index: resources.globals.head.index },
            { op: "global.get", index: resources.globals.tail.index },
            { op: "i32.eq" },
            // depth 1: exit the enclosing block (skip the loop label).
            { op: "br_if", depth: 1 },

            // Read fn, caps, arg at head.
            { op: "global.get", index: resources.globals.functions.index },
            { op: "ref.as_non_null" },
            { op: "global.get", index: resources.globals.head.index },
            { op: "array.get", typeIdx: resources.types.functions.index },
            { op: "local.set", index: fnLocal },

            { op: "global.get", index: resources.globals.captures.index },
            { op: "ref.as_non_null" },
            { op: "global.get", index: resources.globals.head.index },
            { op: "array.get", typeIdx: resources.types.arguments.index },
            { op: "local.set", index: capsLocal },

            { op: "global.get", index: resources.globals.arguments.index },
            { op: "ref.as_non_null" },
            { op: "global.get", index: resources.globals.head.index },
            { op: "array.get", typeIdx: resources.types.arguments.index },
            { op: "local.set", index: argLocal },

            // head++ (advance BEFORE the call so a callback that enqueues
            // more entries doesn't have to worry about an unconsumed slot).
            { op: "global.get", index: resources.globals.head.index },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "global.set", index: resources.globals.head.index },

            // call_ref fn(caps, arg) — push args then the funcref, then
            // ref.cast to a non-null `(ref $__mt_func_type)` because
            // call_ref requires a typed non-null funcref.
            { op: "local.get", index: capsLocal },
            { op: "local.get", index: argLocal },
            { op: "local.get", index: fnLocal },
            { op: "ref.cast", typeIdx: resources.types.callback.index },
            { op: "call_ref", typeIdx: resources.types.callback.index },
            { op: "drop" },

            // depth 0: re-enter the loop label.
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}
