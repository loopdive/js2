// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// emit-helpers.ts — small pure emit utilities factored out of index.ts (#3272)
// to remove copy-pasted idioms. No codegen-context coupling beyond the passed
// `WasmModule`; safe to import from any codegen module.

import type { WasmModule } from "../ir/types.js";

/**
 * Is `structName` a compiler-synthetic / internal struct that must be skipped
 * when iterating `ctx.structFields` to emit host-facing field getters/setters
 * or classification exports? Matches the wrapper boxes (`Wrapper…`), the
 * `$AnyValue` any-box, the `__vec_` / `__arr_` runtime array/vec structs, and
 * (#3927) the `__cold` tails of hot/cold-split fnctor structs.
 * Factored out of ~9 byte-identical inline guards (#3272).
 *
 * The cold tail is listed here because it is a PRIVATE payload of its owner,
 * never a receiver: no value of that type is ever handed to user code, so an
 * arm keyed on `ref.test $…__cold` can only be dead — or, under WasmGC's
 * structural canonicalization of same-shaped structs, WRONGLY live. Consumers
 * reach a cold field through the owner's `$cold` slot
 * (`findColdStructsForField`), never by enumerating the tail as a shape.
 */
export function isSyntheticStructName(structName: string): boolean {
  return (
    structName.startsWith("Wrapper") ||
    structName === "$AnyValue" ||
    structName.startsWith("__vec_") ||
    structName.startsWith("__arr_") ||
    structName.endsWith("__cold") ||
    // (#3927 per-type layouts) `__lay<k>` sibling layouts and the `__resid`
    // carrier of a split fnctor family. The resid is a private payload exactly
    // like the cold tail. The layouts ARE receiver shapes, but their generic
    // enumeration is wrong twice over: presence-only surfaces must answer from
    // the BASE presence words (layout-independent, the issue §6 constraint),
    // and value surfaces must dispatch by the `$shape` stamp because sibling
    // layouts with identical field kinds share ONE canonical wasm type — a
    // bare `ref.test` arm reads another field's slot. Layout-aware consumers
    // get explicit arms via fnctor-layout-emit.ts instead.
    structName.endsWith("__resid") ||
    /__lay[0-9]+$/.test(structName)
  );
}

/**
 * Push a function export entry onto `mod.exports`. Factored out of the
 * `mod.exports.push({ name, desc: { kind: "func", index } })` idiom repeated at
 * many finalize-pass sites (#3272).
 */
export function exportFunc(mod: WasmModule, name: string, funcIdx: number): void {
  mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
}
