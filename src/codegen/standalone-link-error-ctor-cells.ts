// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-link-error-ctor-cells.ts — (#6723 D4) ONE `TypeError` per linked
// standalone graph.
//
// THE DEFECT (measured 2026-09-29, `.tmp/p2.log`; linked test262 harness
// provider + body, `--target standalone`): `assert.throws(TypeError, fn)` runs
// in the PROVIDER, the thrown error and the `TypeError` argument come from the
// CONSUMER, and
//
// | read in the provider                      | answer                      |
// | ----------------------------------------- | --------------------------- |
// | `thrown.message`, `thrown.name`           | correct                     |
// | `thrown instanceof TypeError`             | true                        |
// | `thrown.constructor === expected`         | **false**                   |
// | `thrown.constructor.name`                 | **undefined**               |
//
// The error struct is a canonical runtime type, so every field read and the
// tag-based `instanceof` already work across the boundary. What does not is
// IDENTITY: `err.constructor` answers the module-local `__builtin_TypeError`
// carrier global (#3130), and each module has its own. The provider's is a
// different object from the consumer's `TypeError`, so the harness reports
// "Expected a TypeError but got a undefined" on every consumer-thrown error
// (39 + 3 rows of the #6723 P0 sample).
//
// THE FIX shares the eight Error-family carrier CELLS instead of copying
// values: the provider exports each `__builtin_<Name>` global (mutable
// externref) under an ABI name, and a consumer IMPORTS them in place of
// defining its own. Every reader in both modules — the bare-identifier read
// (`emitBuiltinNamespaceObject`) and the `err.constructor` arm
// (`fillExternGetErrorProps`) — already goes through `builtinObjectGlobals`
// with the same lazy "materialise if null" guard, so one cell means one
// constructor object for the graph, first-reader-wins, with no init-time
// handshake and nothing materialised eagerly.
//
// Why the consumer imports and not the other way round: the provider is
// compiled and cached before any consumer exists, and wasm imports cannot be
// cyclic (the #5383 S2m exception-tag argument).
//
// Why at context start: an import global takes an index BELOW every defined
// global, and nothing renumbers globals after the fact. The consumer registers
// the imports before it defines a single global, and declines (keeping its own
// module-local carriers, i.e. today's behaviour) if that window has passed.
//
// Scope: `--target standalone`, between modules of one linked project. The JS
// host lane shares its realm's constructors already and is untouched.

import type { CodegenContext } from "./context/types.js";
import { addImport } from "./registry/physical-imports.js";
import { WASI_ERROR_NAMES } from "./registry/error-types.js";

/** The wasm→wasm export name of the provider's carrier cell for `name`. */
function cellExportName(name: string): string {
  return `__js2wasm_link_error_ctor_${name}`;
}

/** The provider namespace a standalone consumer links, if any. */
function peerNamespace(ctx: CodegenContext): string | undefined {
  if (!ctx.standalone || ctx.exportsConsumedByWasm === true) return undefined;
  return [...ctx.linkedNamespaces].filter((name) => name.startsWith("js2wasm:npm:")).sort()[0];
}

/**
 * CONSUMER side: import the provider's eight carrier cells and register them
 * as this module's `__builtin_<Name>` globals. Must run before the first
 * defined global; a no-op for every module that is not a standalone consumer.
 */
export function importStandaloneLinkErrorCtorCells(ctx: CodegenContext): void {
  const namespace = peerNamespace(ctx);
  if (namespace === undefined || ctx.indexSpaceFrozen || ctx.mod.globals.length !== 0) return;
  for (const name of WASI_ERROR_NAMES) {
    if (ctx.builtinObjectGlobals.has(name)) continue;
    const index = ctx.numImportGlobals;
    const desc = { kind: "global" as const, type: { kind: "externref" as const }, mutable: true };
    if (addImport(ctx, namespace, cellExportName(name), desc) === undefined) return;
    ctx.builtinObjectGlobals.set(name, index);
  }
}

/**
 * PROVIDER side (finalize, from `finalizeStandaloneLinkReversePeer`): define any carrier cell the module did not already
 * need, and export all eight. The globals are the SAME ones the module's own
 * readers use (same `builtinObjectGlobals` key, same null-initialised shape as
 * `reserveBuiltinNamespaceObjectGlobal`), so the provider's behaviour is
 * unchanged when no consumer imports them.
 */
export function exportStandaloneLinkErrorCtorCells(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.exportsConsumedByWasm !== true) return;
  for (const name of WASI_ERROR_NAMES) {
    const exportName = cellExportName(name);
    if (ctx.mod.exports.some((entry) => entry.name === exportName)) continue;
    let index = ctx.builtinObjectGlobals.get(name);
    if (index === undefined) {
      index = ctx.numImportGlobals + ctx.mod.globals.length;
      ctx.mod.globals.push({
        name: `__builtin_${name}`,
        type: { kind: "externref" },
        mutable: true,
        init: [{ op: "ref.null.extern" }],
      });
      ctx.builtinObjectGlobals.set(name, index);
    }
    ctx.mod.exports.push({ name: exportName, desc: { kind: "global", index } });
  }
}
