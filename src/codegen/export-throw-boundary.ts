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

import type { BlockType, CatchClause, FuncHandle, Instr, ValType, WasmExport, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, definedFuncHandleOf, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/** The host import that rethrows an unwrapped payload as a real JS exception. */
export const RETHROW_HOST_IMPORT = "__rethrow_host_exception";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * True when this module's exports are called by a JS HOST that can receive a
 * real `Error`.
 *
 * The native-first semantic-provider profile joins wasi/standalone in the
 * exclusion for the same reason: it refuses implicit `env::*` imports outright,
 * and the fallback is structural — no wrapper is minted, so the module keeps
 * raising the wasm exception exactly as it does today. A linked PROVIDER is
 * excluded on different grounds (its exports are wasm→wasm call targets); see
 * the header note.
 */
function hostFacingThrowBoundary(ctx: CodegenContext): boolean {
  if (ctx.wasi || ctx.standalone || ctx.strictNoHostImports) return false;
  if (ctx.targetProfile.semanticProviders === "native-first") return false;
  return ctx.exportsConsumedByWasm !== true;
}

/**
 * Register the export-boundary rethrow import the MOMENT the module first needs
 * an `__exn` tag — i.e. while bodies are still compiling.
 *
 * Deliberately not deferred to the wrapping pass itself. By finalize time the
 * data-struct host bridge has already baked function indices into tables,
 * globals and its manifest, and an import added there shifts the function index
 * space underneath them ("export __is_data_struct references missing func index
 * 13", measured 2026-09-06). Registering here keeps the wrapping pass purely
 * additive — it mints functions and rewrites export descriptors, never imports.
 *
 * A module that ends up wrapping nothing simply loses the import again to
 * dead-import elimination, which runs after the wrapping pass.
 */
export function ensureExportThrowRethrowImport(ctx: CodegenContext): void {
  if (!hostFacingThrowBoundary(ctx)) return;
  if (ctx.indexSpaceFrozen) return;
  if (ctx.funcMap.has(RETHROW_HOST_IMPORT)) return;
  ensureLateImport(ctx, RETHROW_HOST_IMPORT, [EXTERNREF], []);
  flushLateImportShifts(ctx, ctx.currentFunc ?? null);
}

/**
 * Exports that must keep their raw wasm-exception behaviour.
 *
 * Everything the compiler owns is `_`-prefixed: the `_start` WASI entry, the
 * `__module_init` initializer, the `__cb_*` callback bodies (whose throws the
 * runtime already unwraps in `normalizeModuleCallbackException`) and the
 * `__class_call_*` / `__get_member_*` dispatchers the host mirror drives. Those
 * are ABI surfaces with their own exception contracts, not user entry points.
 */
function isCompilerOwnedExport(name: string): boolean {
  return name.startsWith("_");
}

/**
 * Rewrite each host-facing function export to point at a wrapper that unwraps
 * an escaping `__exn` payload and rethrows it as a JS exception.
 *
 * No-op unless the module can actually throw (`exnTagIdx >= 0`), targets a JS
 * host, and owns its exports. Every other module keeps its previous bytes.
 */
export function wrapHostFacingExportsForThrow(ctx: CodegenContext): void {
  if (ctx.exnTagIdx < 0) return; // nothing in this module throws on our tag
  if (!hostFacingThrowBoundary(ctx)) return; // no JS host, or a linked provider

  // Ordinals are load-bearing: an export's Program-ABI identity is keyed by its
  // POSITION, and a prepared IR component may already have PLANTED that
  // ordinal's alias against the exact function it pointed at when it sealed
  // (`hasPlannedAlias`). Re-pointing such a row is refused by the ABI session,
  // so those exports take the in-place route below instead — which is sound
  // exactly when nothing inside the module calls them.
  // A compiler-owned export is frequently ALSO published under a short physical
  // alias (`$d1` beside `__struct_field_names`, the vec host-bridge family), and
  // those aliases carry no `_` prefix to recognise them by. Wrapping one half of
  // such a pair would give the same function two different exception contracts
  // depending on which name the host reached it through, so the target handle —
  // not the spelling — decides.
  const compilerOwnedTargets = new Set<FuncHandle>();
  for (const entry of ctx.mod.exports) {
    if (entry.desc.kind === "func" && isCompilerOwnedExport(entry.name)) compilerOwnedTargets.add(entry.desc.index);
  }

  const plans: ExportWrapPlan[] = [];
  let needsInternalScan = false;
  ctx.mod.exports.forEach((entry, ordinal) => {
    if (entry.desc.kind !== "func" || isCompilerOwnedExport(entry.name)) return;
    if (compilerOwnedTargets.has(entry.desc.index)) return;
    const preplanted = ctx.programAbiExports?.hasPlannedAlias(ordinal) === true;
    if (preplanted) needsInternalScan = true;
    plans.push({ entry, target: entry.desc.index, preplanted });
  });
  if (plans.length === 0) return;

  // Only pay for the whole-module reference scan when a pre-planted export
  // forces the in-place decision.
  const internallyReferenced = needsInternalScan ? collectInternalFuncReferences(ctx) : undefined;

  // Registered back at `ensureExnTag` — see `ensureExportThrowRethrowImport`
  // for why this pass must not add an import of its own.
  const rethrowIdx = ctx.funcMap.get(RETHROW_HOST_IMPORT);
  if (rethrowIdx === undefined) return; // host import unavailable — module unchanged

  // Already registered (the `exnTagIdx < 0` guard above), and identical to what
  // every `catch` site bakes. Read directly rather than calling `ensureExnTag`,
  // which would close an import cycle with registry/imports.ts.
  const tags = { exnTagIdx: ctx.exnTagIdx, rethrowIdx };
  for (const plan of plans) {
    if (plan.entry.desc.kind !== "func") continue;
    const target = plan.entry.desc.index;
    const signature = funcSignatureOf(ctx, target);
    if (!signature) continue;

    if (!plan.preplanted) {
      const wrapper = buildUnwrappingWrapper(ctx, plan.entry.name, target, signature.params, signature.results, tags);
      plan.entry.desc.index = wrapper;
      continue;
    }

    // Pre-planted: the export descriptor may not move, so wrap the exported
    // body itself. Sound ONLY when no wasm caller can observe the change — an
    // intra-module `catch $__exn` matches by TAG IDENTITY and would stop
    // matching a JS throw (see the header note). `collectInternalFuncReferences`
    // over-approximates, so an unrecognised reference form skips rather than
    // silently rewriting a function wasm still calls.
    const body = definedFuncAt(ctx, target);
    if (!body || internallyReferenced?.has(target) !== false) continue;
    body.body = [
      {
        op: "try",
        blockType: resultBlockType(ctx, signature.results),
        body: body.body,
        catches: [catchClauseForRethrow(tags)],
      },
    ];
  }
}

interface ExportWrapPlan {
  entry: WasmExport;
  target: FuncHandle;
  preplanted: boolean;
}

/**
 * Every function handle referenced from INSIDE the module: `call` /
 * `return_call` / `ref.func` in any body (including nested block, if, try and
 * catch arrays), the start function, and element segments.
 *
 * Deliberately mirrors the nested-array traversal of `shiftFuncIndices`
 * (registry/imports.ts) — the same coverage the late-import shift already
 * depends on module-wide.
 */
function collectInternalFuncReferences(ctx: CodegenContext): Set<FuncHandle> {
  const referenced = new Set<FuncHandle>();
  const seen = new Set<Instr[]>();
  const walk = (instrs: Instr[]): void => {
    if (seen.has(instrs)) return;
    seen.add(instrs);
    for (const instr of instrs) {
      if (instr.op === "call" || instr.op === "return_call" || instr.op === "ref.func") {
        referenced.add(instr.funcIdx);
      }
      const nested = instr as {
        body?: unknown;
        then?: unknown;
        else?: unknown;
        catches?: { body?: unknown }[];
        catchAll?: unknown;
      };
      if (Array.isArray(nested.body)) walk(nested.body as Instr[]);
      if (Array.isArray(nested.then)) walk(nested.then as Instr[]);
      if (Array.isArray(nested.else)) walk(nested.else as Instr[]);
      if (Array.isArray(nested.catches)) {
        for (const clause of nested.catches) {
          if (Array.isArray(clause?.body)) walk(clause.body as Instr[]);
        }
      }
      if (Array.isArray(nested.catchAll)) walk(nested.catchAll as Instr[]);
    }
  };
  for (const func of ctx.mod.functions) walk(func.body);
  for (const global of ctx.mod.globals) if (Array.isArray(global.init)) walk(global.init);
  if (ctx.mod.startFuncIdx !== undefined) referenced.add(ctx.mod.startFuncIdx);
  for (const segment of ctx.mod.elements) {
    walk(segment.offset);
    for (const funcIdx of segment.funcIndices) referenced.add(funcIdx);
  }
  for (const funcIdx of ctx.mod.declaredFuncRefs) referenced.add(funcIdx);
  return referenced;
}

/** `try` block type mirroring the wrapped function's results. */
function resultBlockType(ctx: CodegenContext, results: readonly ValType[]): BlockType {
  if (results.length === 0) return { kind: "empty" };
  if (results.length === 1) return { kind: "val", type: results[0]! };
  return { kind: "type", typeIdx: addFuncType(ctx, [], [...results]) };
}

/** `catch $__exn` → hand the tag's single externref payload to the host rethrow. */
function catchClauseForRethrow(tags: { exnTagIdx: number; rethrowIdx: number }): CatchClause {
  return {
    tagIdx: tags.exnTagIdx,
    body: [{ op: "call", funcIdx: tags.rethrowIdx }, { op: "unreachable" }],
  };
}

function buildUnwrappingWrapper(
  ctx: CodegenContext,
  exportName: string,
  target: FuncHandle,
  params: readonly ValType[],
  results: readonly ValType[],
  tags: { exnTagIdx: number; rethrowIdx: number },
): FuncHandle {
  const typeIdx = addFuncType(ctx, [...params], [...results]);
  const forward: Instr[] = params.map((_param, index) => ({ op: "local.get", index }));
  forward.push({ op: "call", funcIdx: target });

  // The legacy `try`/`catch` form is safe here because the pass only runs for
  // JS-host targets; `buildTargetTaggedTry`'s `try_table` lowering exists for
  // the wasi/standalone profiles this pass already declines.
  const body: Instr[] = [
    {
      op: "try",
      blockType: resultBlockType(ctx, results),
      body: forward,
      catches: [catchClauseForRethrow(tags)],
    },
  ];

  const funcIdx = mintDefinedFunc(ctx);
  const wrapper: WasmFunction = {
    name: `__export_throw_boundary_${exportName}`,
    typeIdx,
    locals: [],
    body,
    // Exported through the rewritten descriptor: `exported` keeps dead-code
    // elimination from reclaiming a function nothing calls internally.
    exported: true,
  };
  pushDefinedFunc(ctx, funcIdx, wrapper);
  return definedFuncHandleOf(ctx, wrapper) ?? funcIdx;
}
