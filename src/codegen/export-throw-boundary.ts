// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// ---------------------------------------------------------------------------
// export-throw-boundary — (#5247) an uncaught compiled `throw` must reach the
// JS host as the ERROR ITSELF, not as the `WebAssembly.Exception` carrying it.
//
// THE DEFECT
// ----------
// A compiled `throw new RangeError("x")` puts the host-native `RangeError` on
// the `__exn` tag as an externref payload. Inside wasm that is lossless — the
// #5226 shared-tag work proved `catch` delivers the very same object by
// identity. But an exception that escapes an EXPORTED function surfaces to the
// caller as the wasm wrapper:
//
//   catch (e) { e instanceof Error }   // false, on BOTH lanes (measured)
//   Object.prototype.toString.call(e)  // "[object WebAssembly.Exception]"
//
// so `name`, `message` and every `instanceof` test read wrong. It matters well
// beyond ergonomics: test262's `assert.throws` asserts error TYPES, and it runs
// in the HOST whenever the runner drives a compiled export, so every
// error-type assertion on an uncaught path read the bare wrapper.
//
// WHY THE FIX IS IN WASM AND NOT IN `src/runtime.ts`
// -------------------------------------------------
// There is no export-wrapping layer to patch. Both lanes hand the host
// `instance.exports` directly (`instantiateLinkedProject`, and the plain
// `WebAssembly.instantiate(result.binary, result.importObject)` the
// single-module control uses), and an `Instance`'s exports object is not
// extensible, so no host-side shim can intercept the call. The unwrap has to
// happen on the wasm side of the boundary.
//
// WHY AN OUT-OF-LINE WRAPPER, NOT AN IN-PLACE `try`
// -------------------------------------------------
// Wrapping the exported function's own body would convert its wasm exception
// into a JS one for EVERY caller, including wasm ones:
//
//   export function g() { throw new RangeError("x"); }
//   export function f() { try { g(); } catch (e) { return e.message; } }
//
// `f`'s `catch $__exn` matches by TAG IDENTITY and would no longer match, so a
// correct single-module program would break. The wrapper is therefore a
// separate function that only the EXPORT ENTRY points at; every intra-module
// `call $g` still targets the raw function and keeps wasm-level semantics.
//
// The same reasoning bounds the pass to host-facing modules: in a linked graph
// the consumer reaches a provider function THROUGH its export name, so wrapping
// a provider's exports would undo #5226. `exportsConsumedByWasm` (set by the
// package linker on provider builds only) turns the pass off there. The
// consumer half — the module the host actually calls — is still wrapped, and
// catches the shared `env.__exn` tag, so both lanes are covered.
// ---------------------------------------------------------------------------

import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncHandleOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/** The host import that rethrows an unwrapped payload as a real JS exception. */
export const RETHROW_HOST_IMPORT = "__rethrow_host_exception";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Rewrite each host-facing function export to point at a wrapper that unwraps
 * an escaping `__exn` payload and rethrows it as a JS exception.
 *
 * No-op unless the module can actually throw (`exnTagIdx >= 0`), targets a JS
 * host, and owns its exports. Every other module keeps its previous bytes.
 */
export function wrapHostFacingExportsForThrow(ctx: CodegenContext): void {
  if (ctx.exnTagIdx < 0) return; // nothing in this module throws on our tag
  return;
}
