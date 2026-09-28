// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { buildBoxBooleanBody, buildBooleanBoxInitializer } from "../runtime/wasmgc/values/boolean-bodies.js";
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * (#3780) `__box_boolean`'s body, with the two carriers INTERNED rather than
 * allocated.
 *
 * A JS boolean is a primitive: `true` has no observable identity, the carrier's
 * `value` field is immutable, and every consumer discriminates it with
 * `ref.test`/`struct.get` rather than by reference. So the whole program needs
 * exactly two carriers, built once in the global init, and boxing collapses to
 * a `global.get`.
 *
 * This matters because `__box_boolean` is INLINED by `wasm-opt` into every
 * boolean-producing site — on the standalone acorn self-parse that is 742
 * static `struct.new` sites, the hottest of them the boolean arms of
 * `__extern_get`'s closed-struct field ladder. Each fired a fresh 16-byte GC
 * object on a path that runs millions of times per parse; interning removed
 * ~6 MB of the 58 MB allocated per parse.
 *
 * `mutable: false` globals with a `struct.new` initializer mirror the
 * `__undefined` singleton in `any-helpers.ts`, which already relies on
 * `struct.new` being a valid constant expression under the GC proposal.
 *
 * `JS2WASM_INTERNED_BOOL_BOXES=0` restores the allocating body — the paired
 * control the measurement above was taken against.
 */
export function boxBooleanBody(ctx: CodegenContext, boxBoolStructIdx: number): Instr[] {
  if (process.env.JS2WASM_INTERNED_BOOL_BOXES === "0")
    return buildBoxBooleanBody({ mode: "allocating", typeIndex: boxBoolStructIdx });

  const carrier = (value: 0 | 1): number => {
    const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: value === 1 ? "__box_boolean_true" : "__box_boolean_false",
      type: { kind: "ref", typeIdx: boxBoolStructIdx },
      mutable: false,
      init: buildBooleanBoxInitializer(boxBoolStructIdx, value),
    });
    return globalIdx;
  };
  const trueIdx = carrier(1);
  const falseIdx = carrier(0);
  return buildBoxBooleanBody({ mode: "interned", trueGlobalIndex: trueIdx, falseGlobalIndex: falseIdx });
}
