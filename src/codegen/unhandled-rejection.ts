// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ─── (#2958) standalone/WASI unhandled-rejection tracking ───────────────────
//
// A native `$Promise` that settles REJECTED with no reaction attached is a
// silent failure in standalone/WASI mode (host mode inherits the JS host's
// HostPromiseRejectionTracker; standalone had nothing — the program exited 0
// with the error swallowed). This mirrors Node's default: at PROGRAM EXIT (the
// `_start` tail, after the microtask/event-loop drain), report every still-
// unhandled rejection to stderr and `proc_exit(1)`.
//
// Mechanism (self-contained; NO change to the `$Promise` struct layout, so none
// of the ~17 `struct.new $Promise` sites need touching):
//   - an intrusive singly-linked list of `$__unhandled_node` records, prepended
//     (O(1)) whenever a promise rejects with a null callback list — both at the
//     direct `Promise.reject(x)` mint (`emitStandalonePromiseReject`) and at the
//     `__promise_reject` settle of a previously-pending promise (which is the
//     funnel for async-fn rejections, executor `reject`, `.then`-chain rejection
//     propagation, combinator rejections and resolve-value adoption rejects);
//   - a later `.then/.catch` on an already-rejected receiver marks the matching
//     node handled (`__mark_rejection_handled`), so the reporter skips it —
//     which also silences a same-turn late attach, since the report is deferred
//     to program exit.
// The whole substrate is `ctx.wasi`-gated; a non-wasi build never registers it.
//
// Extracted from async-scheduler.ts (#3102 LOC-budget) — the inline hooks that
// call into this substrate (settle-body note, `.then`/`.finally` mark, `await`
// and combinator mark) stay beside the machinery they patch in async-scheduler /
// async-frame / promise-combinators; only the standalone helper family lives here.

import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { getOrInitState, type AsyncSchedulerState, type CodegenContextWithScheduler } from "./async-scheduler.js";

/**
 * (#2958) Idempotently register the unhandled-rejection tracking substrate:
 * the `$__unhandled_node` struct type, the `__unhandled_head` list-head global,
 * and the `__mark_rejection_handled(p eqref)` helper. No-op unless `ctx.wasi`
 * (the native `$Promise` carrier is wasi-gated). Must run BEFORE any
 * `buildPromiseSettleBody` call so the settle body can read the head global idx.
 */
export function ensureUnhandledRejectionTracking(ctx: CodegenContext): void {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (!ctx.wasi) return;
  if (state.unhandledHeadGlobalIdx !== -1) return; // already registered

  // $__unhandled_node { promise (ref null eq), next externref, handled i32 (mut) }.
  // `promise` is stored as `eqref` so the mark-handled walk can `ref.eq`-compare
  // it against the receiver promise; `next` rides an externref (the existing
  // $PromiseCallback pattern — avoids a self-referential type def); `handled`
  // starts 0 and flips to 1 when a reaction is later attached.
  const nodeTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__unhandled_node",
    fields: [
      { name: "promise", type: { kind: "eqref" }, mutable: false },
      { name: "next", type: { kind: "externref" }, mutable: false },
      { name: "handled", type: { kind: "i32" }, mutable: true },
    ],
  });
  ctx.structMap.set("$__unhandled_node", nodeTypeIdx);
  ctx.typeIdxToStructName.set(nodeTypeIdx, "$__unhandled_node");
  ctx.structFields.set("$__unhandled_node", [
    { name: "promise", type: { kind: "eqref" as const }, mutable: false },
    { name: "next", type: { kind: "externref" as const }, mutable: false },
    { name: "handled", type: { kind: "i32" as const }, mutable: true },
  ]);
  state.unhandledNodeTypeIdx = nodeTypeIdx;

  // Global list head (externref → the most-recently-prepended node, or null).
  const headGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__unhandled_head",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  state.unhandledHeadGlobalIdx = headGlobalIdx;

  // __mark_rejection_handled(p eqref): walk the list; the (single) node whose
  // `promise` is ref-identical to `p` gets `handled = 1`, then stop.
  const markTypeIdx = addFuncType(ctx, [{ kind: "eqref" }], [], "$__mark_rejection_handled_type");
  const markFuncIdx = mintDefinedFunc(ctx);
  const CUR = 1; // local: current node as externref
  const NODE = 2; // local: current node cast to (ref $__unhandled_node)
  pushDefinedFunc(ctx, markFuncIdx, {
    name: "__mark_rejection_handled",
    typeIdx: markTypeIdx,
    locals: [
      { name: "$cur", type: { kind: "externref" } },
      { name: "$node", type: { kind: "ref", typeIdx: nodeTypeIdx } },
    ],
    body: [
      { op: "global.get", index: headGlobalIdx },
      { op: "local.set", index: CUR },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: CUR },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: CUR },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: nodeTypeIdx },
              { op: "local.set", index: NODE },
              // if ref.eq(node.promise, p): node.handled = 1; break.
              { op: "local.get", index: NODE },
              { op: "struct.get", typeIdx: nodeTypeIdx, fieldIdx: 0 },
              { op: "local.get", index: 0 },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: NODE },
                  { op: "i32.const", value: 1 },
                  { op: "struct.set", typeIdx: nodeTypeIdx, fieldIdx: 2 },
                  { op: "br", depth: 2 },
                ],
              },
              // cur = node.next
              { op: "local.get", index: NODE },
              { op: "struct.get", typeIdx: nodeTypeIdx, fieldIdx: 1 },
              { op: "local.set", index: CUR },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ],
    exported: false,
  });
  ctx.funcMap.set("__mark_rejection_handled", markFuncIdx);
  state.markRejectionHandledFuncIdx = markFuncIdx;
}

/**
 * (#2958) Emit `__note_unhandled_rejection`-equivalent inline instructions that
 * prepend `promiseInstrs`' value (which MUST leave a `(ref $Promise)` /
 * eqref-compatible value on the stack) onto `__unhandled_head`. Returns [] when
 * tracking is inactive (non-wasi). The value is consumed (not left on stack).
 */
export function buildNoteUnhandledRejection(state: AsyncSchedulerState, promiseOnStack: Instr[]): Instr[] {
  if (state.unhandledHeadGlobalIdx < 0 || state.unhandledNodeTypeIdx < 0) return [];
  return [
    // node = $__unhandled_node{ promise: <p>, next: __unhandled_head, handled: 0 }
    ...promiseOnStack,
    { op: "global.get", index: state.unhandledHeadGlobalIdx },
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: state.unhandledNodeTypeIdx },
    { op: "extern.convert_any" },
    { op: "global.set", index: state.unhandledHeadGlobalIdx },
  ];
}

/**
 * (#2958) Lazily emit `__report_unhandled_rejections()` and return its funcIdx
 * (or -1). Walks `__unhandled_head`; for every still-unhandled node writes a
 * diagnostic line to stderr and, if any were found, `proc_exit(1)`s. Called from
 * `addWasiStartExport` AFTER all imports are fixed so the fd_write / proc_exit
 * indices it bakes are final (the #2642 late-import-funcidx-shift discipline).
 *
 * Per-reason stringification is deferred to #2962; the message is a constant
 * ("Unhandled promise rejection\n"), which satisfies AC1/AC2 and keeps the slice
 * bounded. Returns -1 (no reporter) unless tracking is active AND the fd_write +
 * proc_exit imports exist.
 */
export function ensureUnhandledRejectionReporter(ctx: CodegenContext): number {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  const existing = ctx.funcMap.get("__report_unhandled_rejections");
  if (existing !== undefined) return existing;
  if (!ctx.wasi) return -1;
  if (state.unhandledHeadGlobalIdx < 0 || state.unhandledNodeTypeIdx < 0) return -1;
  if (ctx.wasiProcExitIdx < 0) return -1;
  // Need a stderr write path: direct fd_write import, or the node:fs writeSync shim.
  const directWrite = !ctx.linkNodeShims;
  if (directWrite ? ctx.wasiFdWriteIdx < 0 : ctx.nodeFsWriteSyncIdx < 0) return -1;

  // Allocate the constant diagnostic in a data segment (page-0 bump allocator,
  // same region as wasiAllocStringData — offsets ≥ 1024, clear of the shared
  // iovec scratch at memory[0..8]).
  const msgBytes = new TextEncoder().encode("Unhandled promise rejection\n");
  let msgOffset = 1024;
  for (const seg of ctx.mod.dataSegments) {
    const segEnd = seg.offset + seg.bytes.length;
    if (segEnd > msgOffset) msgOffset = segEnd;
  }
  ctx.mod.dataSegments.push({ offset: msgOffset, bytes: msgBytes });
  const msgLen = msgBytes.length;

  // The stderr write: mirror __wasi_write_string_stderr — direct WASI builds an
  // iovec at memory[0..7] and calls fd_write(2,…); the node shim calls
  // writeSync(2, ptr, len) and drops the byte count.
  const writeStderr: Instr[] = directWrite
    ? [
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: msgOffset },
        { op: "i32.store", align: 2, offset: 0 },
        { op: "i32.const", value: 4 },
        { op: "i32.const", value: msgLen },
        { op: "i32.store", align: 2, offset: 0 },
        { op: "i32.const", value: 2 }, // fd = stderr
        { op: "i32.const", value: 0 }, // iovs ptr
        { op: "i32.const", value: 1 }, // iovs len
        { op: "i32.const", value: 8 }, // nwritten ptr
        { op: "call", funcIdx: ctx.wasiFdWriteIdx },
        { op: "drop" },
      ]
    : [
        { op: "i32.const", value: 2 }, // fd = stderr
        { op: "i32.const", value: msgOffset },
        { op: "i32.const", value: msgLen },
        { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx },
        { op: "drop" },
      ];

  const nodeTypeIdx = state.unhandledNodeTypeIdx;
  const funcTypeIdx = addFuncType(ctx, [], [], "$__report_unhandled_rejections_type");
  const funcIdx = mintDefinedFunc(ctx);
  const CUR = 0;
  const NODE = 1;
  const ANY = 2;
  pushDefinedFunc(ctx, funcIdx, {
    name: "__report_unhandled_rejections",
    typeIdx: funcTypeIdx,
    locals: [
      { name: "$cur", type: { kind: "externref" } },
      { name: "$node", type: { kind: "ref", typeIdx: nodeTypeIdx } },
      { name: "$any", type: { kind: "i32" } },
    ],
    body: [
      { op: "global.get", index: state.unhandledHeadGlobalIdx },
      { op: "local.set", index: CUR },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: CUR },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: CUR },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: nodeTypeIdx },
              { op: "local.set", index: NODE },
              // if node.handled == 0: write the diagnostic; any = 1.
              { op: "local.get", index: NODE },
              { op: "struct.get", typeIdx: nodeTypeIdx, fieldIdx: 2 },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...writeStderr, { op: "i32.const", value: 1 }, { op: "local.set", index: ANY }],
              },
              { op: "local.get", index: NODE },
              { op: "struct.get", typeIdx: nodeTypeIdx, fieldIdx: 1 },
              { op: "local.set", index: CUR },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Any unhandled rejection makes the program exit nonzero (Node parity).
      { op: "local.get", index: ANY },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "call", funcIdx: ctx.wasiProcExitIdx }, { op: "unreachable" }],
      },
    ],
    exported: false,
  });
  ctx.funcMap.set("__report_unhandled_rejections", funcIdx);
  return funcIdx;
}
