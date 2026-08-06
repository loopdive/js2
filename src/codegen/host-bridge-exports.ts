// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// host-bridge-exports.ts — the #4035 export-policy sink.
//
// The host bridge is the surface a JAVASCRIPT host uses to reach inside WasmGC
// values it cannot otherwise read: `__vec_*` to materialize arrays,
// `__sget_*`/`__sset_*` to read compiled-struct fields (a plain `obj[field]` on
// a WasmGC struct yields `undefined`), `__call_fn*` to invoke closures,
// `__exn_render_*` to render a natively-thrown payload, `__stdout_*` to drain
// the host-free print sink. In js-host mode that is the CALLING CONVENTION and
// `src/runtime.ts` depends on it. In standalone/WASI there is no JS host: the
// module runs under wasmtime, needs its own exports plus `_start`, and the
// bridge's only consumers are harness-side (#2962, #3469).
//
// Because exports are GC roots, wasm-opt can strip none of what they pin — a
// standalone module that used one array and threw once shipped ~21 kB of
// float-formatting tables it never called (#4034 measured the cascade).
//
// **Why strip at the sink instead of gating each emitter.** Every producer
// stays unconditional, so there is exactly one decision point and no new
// "emitted but half-wired" states to reason about. Removing the export entry
// is enough: the following `eliminateDeadImports` pass plus `-O3` reclaim the
// functions, types and globals it was holding live. Gating ~15 emitters would
// spread the policy across the codegen and risk a partially-built bridge.

import type { WasmModule } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Export-name prefixes owned by the bridge. Short aliases (`$v0`, `$c0`, `$d0`,
 * `$cm`/`$ct`/`$cu`, `$dm`/`$dt`/`$du`) are the size-optimized twins
 * `src/runtime.ts` falls back to and are matched exactly, not by prefix, so a
 * user function called `$very_important` is never caught.
 */
const BRIDGE_PREFIXES: readonly string[] = [
  "__vec_",
  "__sget_",
  "__sset_",
  "__call_fn",
  "__closure_",
  "__is_vec",
  "__is_closure",
  "__is_data_struct",
  "__struct_field_names",
  "__exn_render_",
  "__stdout_",
  "__new_vec_",
  "__dv_byte_",
];

/** Exact alias names (see `_VEC_HOST_BRIDGE_EXPORTS` &c. in src/runtime.ts). */
const BRIDGE_ALIASES: ReadonlySet<string> = new Set([
  ...["$v0", "$v1", "$v2", "$v3", "$v4", "$v5"],
  ...[
    "$c0",
    "$c1",
    "$c2",
    "$c3",
    "$c4",
    "$c5",
    "$c6",
    "$c7",
    "$c8",
    "$c9",
    "$ca",
    "$cb",
    "$cc",
    "$cd",
    "$ce",
    "$cf",
    "$cg",
  ],
  ...["$cm", "$ct", "$cu"],
  ...["$d0", "$d1", "$dm", "$dt", "$du"],
]);

/**
 * The manifest/marker exports carry a NUL in the name
 * (`__\0js2_closure_host_bridge`), so match on the stable infix.
 */
const BRIDGE_INFIX = "js2_";

export function isHostBridgeExportName(name: string): boolean {
  if (BRIDGE_ALIASES.has(name)) return true;
  if (name.includes(BRIDGE_INFIX) && name.includes("host_bridge")) return true;
  return BRIDGE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Drop the bridge export entries when policy says this module does not publish
 * them. MUST run before `eliminateDeadImports` so the freed functions/types are
 * actually reclaimed rather than merely unreachable.
 *
 * Deliberately NOT stripped, because they are not JS-inspection surface:
 * `memory`, `_start` (the WASI entry point), `__exn_tag` (the exception tag a
 * pure-Wasm host still needs to catch), and every user export.
 */
export function stripHostBridgeExports(ctx: CodegenContext): number {
  if (ctx.emitHostBridge) return 0;
  const mod: WasmModule = ctx.mod;
  const before = mod.exports.length;
  mod.exports = mod.exports.filter((ex) => !isHostBridgeExportName(ex.name));
  return before - mod.exports.length;
}
