// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-link-boundary.ts — (#5383 S2d) the wasm→wasm twin of the #5225
// cross-module struct-owner registry.
//
// THE DEFECT THIS EXISTS FOR (measured 2026-09-08, `.tmp/s2d/probe4`):
// a value minted by a linked PROVIDER and read by the CONSUMER answers nothing
// under `--target standalone` — `Object.keys(NS).length` is 0 where the same
// read inside the provider answers 3, and `NS.a` is `undefined`.
//
// Root cause: standalone puts NO self-describing property bag on a value. Every
// dynamic read is a module-local `ref.test` ladder over the struct types THAT
// module declared, filled at finalize (`__extern_get`, `__object_keys`). A
// provider-minted struct is in the provider's ladder and in no other, so the
// consumer's ladder misses on every arm and falls through to its terminal.
// (Verified from the other side: a module's own generic terminals DO decode its
// own static-shape structs — `.tmp/s2d/probe11`, keys 3 / get 1 / call 1.)
//
// The JS-host lane never sees this because the linker replaces the boundary
// value with a host mirror bound to the provider's `__struct_field_names` /
// `__sget_*` exports, and #5225's `_crossModuleStructs` registry re-points a
// read at the module that can decode it. Neither exists without a JS host.
//
// The fix mirrors that design in pure wasm: the provider EXPORTS its generic
// terminals under stable names, and the consumer calls them when its own ladder
// has already missed. This is deliberately a MISS-PATH mechanism — a receiver
// the consumer can decode never reaches the peer call, so the single-module
// lane and every local read stay byte-identical.
//
// Scope: `--target standalone` only, and only between modules of one linked
// project. The JS-host lane keeps the host mirror and is untouched (byte A/B in
// #5383's S2d notes).

import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import type { CodegenContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";

const EXTERNREF: ValType = { kind: "externref" };

/** `registerNative` as `ensureObjectRuntime` defines it (structural, not imported). */
type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

/** Provider-exported generic terminals. The name is the wasm→wasm ABI. */
export const LINK_BOUNDARY_EXPORTS = Object.freeze({
  memberGet: "__js2wasm_link_member_get",
  objectKeys: "__js2wasm_link_object_keys",
  apply: "__js2wasm_link_apply",
} as const);

/** The internal terminal each boundary name wraps, and its signature. */
const TERMINALS: ReadonlyArray<{ export: string; internal: string; params: ValType[] }> = [
  { export: LINK_BOUNDARY_EXPORTS.memberGet, internal: "__extern_get", params: [EXTERNREF, EXTERNREF] },
  { export: LINK_BOUNDARY_EXPORTS.objectKeys, internal: "__object_keys", params: [EXTERNREF] },
  { export: LINK_BOUNDARY_EXPORTS.apply, internal: "__apply_closure", params: [EXTERNREF, EXTERNREF, EXTERNREF] },
];

/** A module compiled as a linked provider whose consumer is wasm, not JS. */
function isWasmConsumedStandaloneProvider(ctx: CodegenContext): boolean {
  return ctx.standalone && ctx.exportsConsumedByWasm === true;
}

/** The provider namespaces this module may route a missed read to. */
function peerNamespaces(ctx: CodegenContext): string[] {
  if (!ctx.standalone || isWasmConsumedStandaloneProvider(ctx)) return [];
  return [...ctx.linkedNamespaces].filter((name) => name.startsWith("js2wasm:npm:")).sort();
}

/**
 * Emit the provider-side boundary terminals.
 *
 * NOT raw re-exports of `__extern_get` / `__object_keys`, and the difference is
 * the whole correctness argument: each wrapper normalises "I do not know this
 * value" to `ref.null.extern`, so the consumer can tell a real answer from a
 * miss and keep its own local answer otherwise. Without that the consumer would
 * have to trust the peer's `undefined` singleton (a DIFFERENT module's global —
 * its `x === undefined` identity is not the consumer's) and the peer's empty
 * key vec would out-rank the consumer's own carrier-bag keys.
 *
 * Both normalisations are answer-preserving: a property that is genuinely
 * `undefined` on a foreign object, and an object with genuinely zero own keys,
 * fall back to the consumer's local miss — which answers `undefined` / empty.
 *
 * `__apply_closure` needs no wrapper: calling a closure the peer does not own
 * cannot be confused with a value, and the consumer only reaches it after its
 * own closure test has already failed.
 */
export function emitStandaloneLinkBoundaryTerminals(ctx: CodegenContext, registerNative: RegisterNative): void {
  if (!isWasmConsumedStandaloneProvider(ctx)) return;
  const externGet = ctx.funcMap.get("__extern_get");
  const isUndefined = ctx.funcMap.get("__extern_is_undefined");
  if (externGet !== undefined && isUndefined !== undefined && !ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.memberGet)) {
    registerNative(
      LINK_BOUNDARY_EXPORTS.memberGet,
      [EXTERNREF, EXTERNREF],
      [EXTERNREF],
      [{ name: "v", type: EXTERNREF }],
      [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: externGet },
        { op: "local.tee", index: 2 },
        { op: "call", funcIdx: isUndefined },
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: [{ op: "ref.null.extern" }],
          else: [{ op: "local.get", index: 2 }],
        },
      ],
    );
  }
  const objectKeys = ctx.funcMap.get("__object_keys");
  const externLength = ctx.funcMap.get("__extern_length");
  if (objectKeys !== undefined && externLength !== undefined && !ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.objectKeys)) {
    registerNative(
      LINK_BOUNDARY_EXPORTS.objectKeys,
      [EXTERNREF],
      [EXTERNREF],
      [{ name: "v", type: EXTERNREF }],
      [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: objectKeys },
        { op: "local.tee", index: 1 },
        { op: "call", funcIdx: externLength },
        { op: "f64.const", value: 0 },
        { op: "f64.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: [{ op: "ref.null.extern" }],
          else: [{ op: "local.get", index: 1 }],
        },
      ],
    );
  }
}

/**
 * Publish the generic terminals of a standalone provider.
 *
 * Called at finalize, when every terminal has been filled. A terminal the
 * module never needed is simply not published: the consumer's import is added
 * only for a namespace it links, and a provider that has no object runtime at
 * all cannot own a value the consumer could ask about.
 */
export function publishStandaloneLinkBoundaryExports(ctx: CodegenContext): void {
  if (!isWasmConsumedStandaloneProvider(ctx)) return;
  const published = new Set(ctx.mod.exports.map((entry) => entry.name));
  for (const terminal of TERMINALS) {
    if (published.has(terminal.export)) continue;
    // The wrapper (when one was emitted) is registered UNDER the export name;
    // `__apply_closure` is published directly.
    const index = ctx.funcMap.get(terminal.export) ?? ctx.funcMap.get(terminal.internal);
    if (index === undefined) continue;
    ctx.mod.exports.push({ name: terminal.export, desc: { kind: "func", index } });
  }
}

/**
 * The imported peer terminal, or undefined when this module has no standalone
 * provider to ask.
 *
 * ONE peer, deliberately: the export name IS the ABI, and `ensureLateImport`
 * keys `funcMap` by that name, so a second namespace publishing the same name
 * cannot be told apart without a per-namespace alias. #5383's graph is one
 * provider; a multi-provider standalone graph keeps today's behaviour for the
 * namespaces after the first (nothing decodes, exactly as before this module),
 * rather than silently asking the wrong module.
 *
 * MUST be called before the index-space freeze (#1984) — `ensureObjectRuntime`
 * is the caller, alongside the host lane's `__boundary_object_*` twins.
 */
export function standaloneLinkBoundaryPeerIndices(ctx: CodegenContext): {
  memberGet?: number;
  objectKeys?: number;
} {
  const namespace = peerNamespaces(ctx)[0];
  if (namespace === undefined) return {};
  // Register BOTH, then flush, then read the indices back. Each late import
  // SHIFTS the function index space, so an index captured from the first
  // `ensureLateImport` return names a different function once the second lands
  // (measured: the consumer called the 3-parameter apply terminal with 2
  // arguments and the module failed to validate). This is the same
  // register-all-then-flush-then-look-up discipline the `__boundary_object_*`
  // block above follows, and for the same reason.
  for (const terminal of TERMINALS) {
    ensureLateImport(ctx, terminal.export, [...terminal.params], [EXTERNREF], namespace);
  }
  flushLateImportShifts(ctx, null);
  return {
    memberGet: ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.memberGet),
    objectKeys: ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.objectKeys),
  };
}
