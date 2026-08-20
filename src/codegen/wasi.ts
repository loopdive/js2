// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// wasi.ts — the WASI IO helper subsystem (#3272, extracted verbatim from
// index.ts). Registers WASI/node:fs imports and emits the deferred clock /
// fd_write / string-encode / Uint8Array / ArrayBuffer / writeFileSync / sleep
// helpers used by the `--target wasi` and standalone stdio paths. index.ts
// imports these back for its compile driver and re-exports the public
// helpers/consts for their external callers (node-fs-api, deno-api, builtins,
// async-scheduler, linear-uint8-codegen).

import { ts, forEachChild } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import { addImport } from "./registry/imports.js";
import { enableStdinReactor, ensureTimerHeap } from "./async-scheduler.js";
import { ensureAnyToStringHelper, ensureNativeStringHelpers } from "./native-strings.js";
import { LINEAR_U8_ARENA_START } from "./linear-type-reservations.js";

/**
 * #2633 — does the source use stream-write IO that lowers, under
 * `--link node:fs`, to `node:fs` `writeSync` (console.log/warn/error,
 * process.stdout/stderr.write)? Drives the node:fs import registration in
 * `registerWasiImports`: even a program that never `import`s `node:fs`
 * explicitly needs the `node:fs` `writeSync` import the moment it writes to a
 * stream, because the std-IO write path is lowered to `node:fs` `writeSync(fd,
 * …)` (fd 1/2) — the bespoke `js2wasm:node-process` shim was retired (#2633).
 * Cheap syntactic scan — codegen lowers the calls regardless; this only decides
 * whether the `node:fs` write import is pulled in.
 */
function sourceUsesStreamWriteIo(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node)) {
      // console.log/warn/error
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "console" &&
        (node.name.text === "log" || node.name.text === "warn" || node.name.text === "error")
      ) {
        found = true;
        return;
      }
      // process.stdout.write / process.stderr.write
      if (
        node.name.text === "write" &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "process" &&
        (node.expression.name.text === "stdout" || node.expression.name.text === "stderr")
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Register WASI imports: fd_write, proc_exit, path_open, fd_close, linear memory, bump pointer global */
export function registerWasiImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  // Add linear memory for string data + iovec structs.
  //
  // Layout (#1618 collision fix): page 0 (0..64KB) holds the iovec/nwritten
  // scratch (0..15) and the bump-allocated data segments for string literals
  // (`wasiAllocStringData`, from offset 1024 up). The stdin read buffer and the
  // raw-byte write scratch MUST NOT alias those data segments — previously both
  // the literal segments and the stdin buffer started at 1024, so reading stdin
  // overwrote the initialized literal/newline bytes, corrupting console.log
  // output. We now place the stdin buffer in page 1 (WASI_STDIN_BUF_START) and
  // the write scratch in page 2 (WASI_WRITE_SCRATCH_START), well above any
  // data segment, and reserve 3 pages so both regions always exist.
  if (ctx.linkNodeShims) {
    // #2633 — std-IO under `--link node:fs` is satisfied entirely by the
    // `node:fs` interface (fd-based `readSync`/`writeSync`), the faithful
    // synchronous Node primitives. The bespoke `js2wasm:node-process` shim
    // (`stdout_write`/`stderr_write`/`stdin_read`) was retired: its functions
    // were a 1:1 fd-fixed special-case of `writeSync(1|2, …)` / `readSync(0,
    // …)`, so the std-IO write path (console.log/warn/error,
    // process.stdout/stderr.write) now lowers to `node:fs` `writeSync(fd, …)`
    // with the fd pushed explicitly. `node:fs` OWNS + exports the single shared
    // linear memory.
    //
    // The shim OWNS + exports the linear memory; the user module IMPORTS it
    // (memory index 0) so the shim can read/write the user's bytes over the
    // SAME memory with no instantiation cycle (shim imports only
    // wasi_snapshot_preview1; user imports {memory + io fns} from the
    // already-instantiated shim). The user module declares NO memory and exports
    // none. `min: 3` mirrors the inline path's reservation (page 0 scratch/data,
    // page 1 stdin buffer, page 2 write scratch). The memory import MUST precede
    // the func imports below so it sits at memory-index 0 (loads/stores/
    // `memory.size`/`memory.grow` all target it). Import order within the import
    // section does not perturb the func index space — only func imports increment it.
    addImport(ctx, "node:fs", "memory", { kind: "memory", min: 3 });

    // node:fs fd-based IO funcs: readSync(fd,ptr,len)->i32 /
    // writeSync(fd,ptr,len)->i32 over the shared memory. The user module imports
    // module `"node:fs"` (declaring WHAT it needs, not the shim that provides
    // it); the `node-fs.wat` shim is one provider. `writeSync` is registered
    // whenever the program does any stream write (explicit `import { writeSync }`
    // OR console.log/process.std*.write), `readSync` whenever it imports
    // `readSync` from node:fs.
    const usesWriteSync = ctx.wasiNodeFsFuncs.has("writeSync") || sourceUsesStreamWriteIo(sourceFile);
    const usesReadSync = ctx.wasiNodeFsFuncs.has("readSync");
    if (usesReadSync || usesWriteSync) {
      const fsIoType = addFuncType(
        ctx,
        [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
        [{ kind: "i32" }],
        "$node_fs_io",
      );
      if (usesReadSync) {
        addImport(ctx, "node:fs", "readSync", { kind: "func", typeIdx: fsIoType });
        ctx.nodeFsReadSyncIdx = ctx.funcMap.get("readSync")!;
      }
      if (usesWriteSync) {
        addImport(ctx, "node:fs", "writeSync", { kind: "func", typeIdx: fsIoType });
        ctx.nodeFsWriteSyncIdx = ctx.funcMap.get("writeSync")!;
      }
    }
  } else {
    ctx.mod.memories.push({ min: 3 });
    // WASI requires the memory to be exported as "memory"
    ctx.mod.exports.push({ name: "memory", desc: { kind: "memory", index: 0 } });
  }

  // Add bump pointer global (mutable i32, starts at 0)
  // We reserve the first 1024 bytes for iovec scratch space
  const bumpGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__wasi_bump_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 1024 }],
  });
  ctx.wasiBumpPtrGlobalIdx = bumpGlobalIdx;

  // #1886 Slice B — dedicated bump pointer for linear-backed Uint8Array buffers.
  // Starts at LINEAR_U8_ARENA_START (page 4) so it never aliases the page-0
  // string-literal data segments, the page-1 stdin buffer, or the page-2 write
  // scratch. (`$__wasi_bump_ptr` above is for string-literal data and lives in
  // page 0, so it is unsuitable.) The allocator + memory growth are emitted
  // lazily on first use (see ensureLinearU8AllocHelper); the region grows on
  // demand via memory.grow, so reserving 3 pages here is still enough.
  const u8ArenaGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__lin_u8_arena_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: LINEAR_U8_ARENA_START }],
  });
  ctx.linearU8ArenaGlobalIdx = u8ArenaGlobalIdx;

  // Check if source uses console.log/warn/error, process.exit, or node:fs functions
  let needsFdWrite = false;
  let needsConsoleStderr = false;
  let needsProcExit = false;
  let needsRandomGet = false;
  // #1484 — emit poll_oneoff + __wasi_sleep_ms helper when source references
  // setTimeout/setInterval/setImmediate. The bare-identifier call sites are
  // currently rejected at compile time by `rejectTimersUnderWasi`; emitting
  // the helper here keeps the infrastructure in place for the follow-up that
  // lowers timer calls to synchronous sleeps via the async scheduler.
  let needsPollOneoff = false;
  // #2632 Phase 1 — source references a timer / microtask scheduler global
  // (setTimeout/setInterval/clearTimeout/clearInterval/queueMicrotask). Drives
  // ensureTimerHeap + the run-loop reactor in emitDeferredWasiHelpers, and the
  // `getRunLoopFuncIdxForWasiStart` wiring in addWasiStartExport.
  let needsTimerHeap = false;
  // #2632 Phase 2 — source references the fd0 stdin reactor (a `__wasiStdinReadByte()`
  // call, or `process.stdin` streaming usage). Activates the multi-subscription
  // poll_oneoff (fd0 + timer) + internal stdin buffer; implies fd_read,
  // fd_fdstat_set_flags, poll_oneoff, clock_time_get, and the timer heap/run loop.
  let needsStdinReactor = false;
  // #1482: process.env.X access — register environ_get / environ_sizes_get +
  // the JS-polyfill fast-path host import.
  let needsEnviron = false;
  // (#1483) Detect Date.now / performance.now / new Date() — all routed to
  // WASI clock_time_get under --target wasi.
  let needsClockTimeGet = false;
  let needsFdRead = false;
  // #2684 — Deno synchronous stdio usage (`Deno.stdin.readSync` /
  // `Deno.{stdout,stderr}.writeSync`). Tracked separately from needsFdRead/Write
  // so the linkNodeShims recompute below can't drop the syscalls a Deno program
  // needs (Deno lowers to the DIRECT WASI path regardless of --link node:fs,
  // exactly like the raw-wasi import path). Re-asserted after that recompute.
  let denoUsesReadSync = false;
  let denoUsesWriteSync = false;

  // ctx.wasiNodeFsFuncs is populated from the original source before import preprocessing
  // (see detectNodeFsImports in compiler.ts)
  const needsPathOpen = ctx.wasiNodeFsFuncs.has("writeFileSync");

  function visit(node: ts.Node) {
    // (#2968) Any `throw` in the program can propagate uncaught to `_start`. The
    // uncaught-exception printer wired in `addWasiStartExport` renders the payload
    // to stderr via `fd_write` and calls `proc_exit(1)`, so a throwing WASI module
    // needs BOTH imports even when it does no explicit console/process I/O — a bare
    // `throw new TypeError("x")` otherwise exited 0 with no diagnostic. Registering
    // them here (during the normal import pass) keeps them in the existing WASI set
    // and avoids any late-import funcidx shift. Non-throwing modules are unaffected.
    if (ts.isThrowStatement(node)) {
      needsFdWrite = true;
      needsProcExit = true;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propAccess = node.expression;
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "console" &&
        ["log", "warn", "error"].includes(propAccess.name.text)
      ) {
        needsFdWrite = true;
        // #1493: console.warn/error must route to fd=2 (stderr), not fd=1 (stdout).
        if (propAccess.name.text === "warn" || propAccess.name.text === "error") {
          needsConsoleStderr = true;
        }
      }
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "process" &&
        propAccess.name.text === "exit"
      ) {
        needsProcExit = true;
      }
      // #1651: process.stdout.write(...) / process.stderr.write(...) need
      // fd_write. The callee is `process.<stream>.write` — a PropertyAccess
      // (name="write") whose receiver is itself `process.stdout|stderr`.
      if (
        propAccess.name.text === "write" &&
        ts.isPropertyAccessExpression(propAccess.expression) &&
        ts.isIdentifier(propAccess.expression.expression) &&
        propAccess.expression.expression.text === "process" &&
        (propAccess.expression.name.text === "stdout" || propAccess.expression.name.text === "stderr")
      ) {
        needsFdWrite = true;
        if (propAccess.expression.name.text === "stderr") {
          needsConsoleStderr = true;
        }
      }
      // #1322: Math.random() in WASI mode uses random_get for entropy
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "Math" &&
        propAccess.name.text === "random"
      ) {
        needsRandomGet = true;
      }
      // (#1483) Date.now() / performance.now()
      if (
        ts.isIdentifier(propAccess.expression) &&
        (propAccess.expression.text === "Date" || propAccess.expression.text === "performance") &&
        propAccess.name.text === "now"
      ) {
        needsClockTimeGet = true;
      }
    }
    // (#1483) `new Date()` (no args) defaults to current time → clock_time_get.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
      if (!node.arguments || node.arguments.length === 0) {
        needsClockTimeGet = true;
      }
    }
    // #1484 — track setTimeout/setInterval/setImmediate to drive poll_oneoff
    // helper emission. Only bare-identifier call positions count (member-name
    // positions like `obj.setTimeout` are skipped).
    // #2632 Phase 1 — setTimeout/setInterval/clearTimeout/clearInterval are now
    // LOWERED onto the timer heap + run-loop reactor (no longer rejected). They
    // require poll_oneoff (the blocking sleep), clock_time_get (monotonic now),
    // and the timer heap. queueMicrotask needs only the microtask queue, which
    // the reactor also drives, so it sets needsTimerHeap to wire the run loop.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      // A user function/local shadowing the global keeps its own semantics —
      // the reactor must NOT register/lower for it. The global timer names are
      // declared ONLY in lib .d.ts files; a user shadow has a declaration in a
      // real (.ts) source file. (Mirrors the call-site guard in calls.ts.)
      const isGlobalShadowed = (() => {
        const sym = ctx.checker.getSymbolAtLocation(node.expression);
        const decls = sym?.declarations;
        return !!decls && decls.length > 0 && !decls.every((d) => d.getSourceFile().isDeclarationFile);
      })();
      if (!isGlobalShadowed && (callee === "setTimeout" || callee === "setInterval" || callee === "setImmediate")) {
        needsPollOneoff = true;
      }
      if (!isGlobalShadowed && (callee === "setTimeout" || callee === "setInterval")) {
        needsPollOneoff = true;
        needsClockTimeGet = true;
        needsTimerHeap = true;
      }
      if (
        !isGlobalShadowed &&
        (callee === "clearTimeout" || callee === "clearInterval" || callee === "queueMicrotask")
      ) {
        needsTimerHeap = true;
      }
      // #2632 Phase 2 — `__wasiStdinReadByte()` is the internal-buffer primitive
      // exposed for the fd0 reactor (Phase 3's process.stdin Readable builds on
      // it). It activates the fd-readiness reactor + run loop. (No user shadow
      // applies — it is a js2wasm-internal name, not a lib global.)
      // #2632 Phase 3 adds three more internal stdin primitives the library
      // `process.stdin` Readable uses: read-N / available / EOF query and the
      // reactor-tick reader hook. They all activate the same fd0 reactor.
      if (
        callee === "__wasiStdinReadByte" ||
        callee === "__wasiStdinAvailable" ||
        callee === "__wasiStdinEof" ||
        callee === "__wasiStdinSetReader" ||
        callee === "__wasiStdinStop"
      ) {
        needsStdinReactor = true;
        needsFdRead = true;
        needsPollOneoff = true;
        needsClockTimeGet = true;
        needsTimerHeap = true;
      }
    }
    // #1482: detect `process.env.X` (PropertyAccessExpression nested two deep)
    // and `process.env["X"]` (ElementAccessExpression). The outer node may be
    // either form; we detect the inner `process.env` chain.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const obj = node.expression;
      if (
        ts.isPropertyAccessExpression(obj) &&
        ts.isIdentifier(obj.expression) &&
        obj.expression.text === "process" &&
        obj.name.text === "env"
      ) {
        needsEnviron = true;
      }
    }
    // #1653: process.stdin.read(buf, offset?) → triggers fd_read import (the
    // binary, incremental Node-API stdin read). Detect the
    // `process.stdin.read(...)` call shape so fd_read is registered.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "read" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "stdin" &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "process"
    ) {
      needsFdRead = true;
    }
    // #2684: Deno synchronous stdio → direct WASI fd_read/fd_write. Recognize the
    // ambient `Deno.stdin.readSync(buf)` / `Deno.{stdout,stderr}.writeSync(buf)`
    // member-call shapes so the syscalls are registered (the actual lowering is
    // in deno-api.ts; this only wires the import). Mirrors the process.stdin.read
    // and process.std*.write detection above.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "Deno"
    ) {
      const method = node.expression.name.text;
      const stream = node.expression.expression.name.text;
      if (method === "readSync" && stream === "stdin") denoUsesReadSync = true;
      if (method === "writeSync" && (stream === "stdout" || stream === "stderr")) {
        denoUsesWriteSync = true;
      }
    }
    forEachChild(node, visit);
  }
  forEachChild(sourceFile, visit);

  // (#2958) The native $Promise carrier reports an unhandled rejection at program
  // exit (the WASI `_start` tail) via fd_write(stderr) + proc_exit(1). That
  // reporter only observes rejections created by TOP-LEVEL execution (what
  // `__module_init`/`main` runs), so we register its two imports only when the
  // source uses `Promise`/`await` at top level — NOT inside a function/class body
  // whose rejections would surface only when a host calls that export directly
  // (those modules must stay import-free: they instantiate with `{}` and call the
  // export, never `_start` — e.g. the #2867/#2865 host-free carrier tests). A
  // module with only in-function promise usage keeps its exact prior import set;
  // dead-import elimination also drops these two if the reporter turns out unemitted.
  const scanTopLevelPromiseUsage = (node: ts.Node): void => {
    // Do not descend into function/class bodies — their promise usage is not
    // top-level execution.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isAwaitExpression(node) || (ts.isIdentifier(node) && node.text === "Promise")) {
      needsFdWrite = true;
      needsProcExit = true;
      return;
    }
    forEachChild(node, scanTopLevelPromiseUsage);
  };
  forEachChild(sourceFile, scanTopLevelPromiseUsage);

  // #2524 — remember whether the source needs a stream/console *write* helper
  // (console.log/warn/error, process.std*.write) independent of the syscall
  // import decision below. Under the node shims those helpers still get
  // emitted, but they call `node:fs::writeSync(fd, …)` instead of
  // `wasi_snapshot_preview1.fd_write` (#2633).
  const needsStreamWriteHelper = needsFdWrite;

  // writeFileSync also needs fd_write for the actual file data write
  if (needsPathOpen) needsFdWrite = true;

  // #2633 — under the node shims the stream/console IO path (process.std*.write,
  // console.log/warn/error) is lowered to `node:fs::writeSync` calls (registered
  // above), so it does NOT pull wasi_snapshot_preview1.fd_read/fd_write into the
  // user module. Only a file write (writeFileSync → path_open) still needs the
  // real syscalls. Recompute the syscall-import needs accordingly: keep fd_write
  // solely for the file path, and drop fd_read entirely (the `node:fs` shim owns
  // the read syscall; the hallucinated `process.stdin.read` was removed).
  if (ctx.linkNodeShims) {
    needsFdWrite = needsPathOpen;
    // #2632 Phase 2 — the fd0 reactor drives `fd_read` directly from readiness
    // (not the node-process shim's stdin_read). Keep the inline fd_read import
    // when the reactor is active; otherwise stdin flows through the shim.
    needsFdRead = needsStdinReactor;
  } else {
    // #2655 — DIRECT WASI Preview-1 path: a standalone `--target wasi` module
    // (no `--link node:fs`) that imports `readSync`/`writeSync` from node:fs
    // lowers fd-based `readSync(fd, buf, …)` / `writeSync(fd, buf, …)` straight to
    // `wasi_snapshot_preview1.fd_read` / `fd_write` (a plain BLOCKING read — NOT
    // the async reactor's non-blocking fd_read + poll_oneoff). `needsFdRead` is
    // otherwise only set by the hallucinated `process.stdin.read(...)` shape or
    // the stdin reactor; `needsFdWrite` only by console.log/process.std*.write —
    // so a bare `import { readSync, writeSync }` would have no syscall import to
    // call. Pull in the syscalls the imported bindings actually need.
    if (ctx.wasiNodeFsFuncs.has("readSync")) needsFdRead = true;
    if (ctx.wasiNodeFsFuncs.has("writeSync")) needsFdWrite = true;
  }

  // #2657 — RAW `wasi_snapshot_preview1` fd_read/fd_write import. When the source
  // imports the syscall by name (`import { fd_read, fd_write } from
  // "wasi_snapshot_preview1"`), the binding maps 1:1 to the import func, so the
  // import MUST be registered regardless of the shim/direct branch above (the
  // user wrote the syscall call explicitly). Routes the user binding to the same
  // `ctx.wasiFdReadIdx`/`wasiFdWriteIdx` — no duplicate import. This sits after
  // the linkNodeShims recompute so a raw `fd_read` import is never dropped.
  if (ctx.wasiRawImports.has("fd_read")) needsFdRead = true;
  if (ctx.wasiRawImports.has("fd_write")) needsFdWrite = true;

  // #2684 — Deno synchronous stdio lowers to the DIRECT WASI fd_read/fd_write
  // path (deno-api.ts), so its syscall imports must be registered regardless of
  // the shim/direct recompute above (mirrors the raw-wasi re-assertion). A Deno
  // program under --link node:fs is nonsensical, but this keeps the direct
  // path's imports from being dropped either way.
  if (denoUsesReadSync) needsFdRead = true;
  if (denoUsesWriteSync) needsFdWrite = true;

  // fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32
  if (needsFdWrite) {
    const fdWriteType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_fd_write",
    );
    addImport(ctx, "wasi_snapshot_preview1", "fd_write", { kind: "func", typeIdx: fdWriteType });
    ctx.wasiFdWriteIdx = ctx.funcMap.get("fd_write")!;
  }

  // proc_exit(code: i32) -> void
  if (needsProcExit) {
    const procExitType = addFuncType(ctx, [{ kind: "i32" }], [], "$wasi_proc_exit");
    addImport(ctx, "wasi_snapshot_preview1", "proc_exit", { kind: "func", typeIdx: procExitType });
    ctx.wasiProcExitIdx = ctx.funcMap.get("proc_exit")!;
  }

  // #1481: fd_read(fd, iovs, iovs_len, nread) -> errno (i32)
  if (needsFdRead) {
    const fdReadType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_fd_read",
    );
    addImport(ctx, "wasi_snapshot_preview1", "fd_read", { kind: "func", typeIdx: fdReadType });
    ctx.wasiFdReadIdx = ctx.funcMap.get("fd_read")!;
  }

  // #2632 Phase 2 — fd_fdstat_set_flags(fd, flags) -> errno (i32). Used by the
  // fd0 stdin reactor to put fd 0 in non-blocking mode so a post-readiness
  // fd_read can't block. Registered BEFORE any defined helper so its late-import
  // shift discipline matches fd_read / poll_oneoff (CLAUDE.md "addUnionImports").
  if (needsStdinReactor) {
    const setFlagsType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_fd_fdstat_set_flags",
    );
    addImport(ctx, "wasi_snapshot_preview1", "fd_fdstat_set_flags", { kind: "func", typeIdx: setFlagsType });
    ctx.wasiFdFdstatSetFlagsIdx = ctx.funcMap.get("fd_fdstat_set_flags")!;
  }

  // #1322: random_get(buf_ptr: i32, buf_len: i32) -> errno (i32)
  // Used by `Math_random` (emitted in math-helpers.ts:emitInlineMathFunctions).
  // Registered HERE — before any defined helpers — so the late-import shift
  // bug (CLAUDE.md "addUnionImports" note) doesn't break `__str_*` indices.
  if (needsRandomGet) {
    const randomGetType = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], "$wasi_random_get");
    addImport(ctx, "wasi_snapshot_preview1", "random_get", { kind: "func", typeIdx: randomGetType });
  }

  // #1484 — poll_oneoff(in: i32, out: i32, nsubs: i32, nevents_out: i32) -> errno (i32)
  // Registered when the source contains setTimeout/setInterval/setImmediate so the
  // (in-progress) __wasi_sleep_ms helper has its underlying import wired. Must be
  // registered BEFORE any defined helpers so late-import shifts (CLAUDE.md
  // "addUnionImports" note) don't break previously-recorded function indices.
  if (needsPollOneoff) {
    const pollType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_poll_oneoff",
    );
    addImport(ctx, "wasi_snapshot_preview1", "poll_oneoff", { kind: "func", typeIdx: pollType });
    ctx.wasiPollOneoffIdx = ctx.funcMap.get("poll_oneoff")!;
  }

  // #1482: process.env access — register the WASI environ imports for protocol
  // compliance (a wasmtime host can satisfy these) AND register the JS-polyfill
  // fast-path host import. The codegen path emits a `call $__wasi_env_get_str`
  // because reconstructing a NativeString from a `KEY=VALUE` byte run inside
  // pure Wasm requires considerable scaffolding; the host-import shortcut keeps
  // the MVP scope tight. The environ_* imports stay declared so a future
  // pure-WASI implementation can swap in without changing the manifest.
  if (needsEnviron) {
    // environ_sizes_get(count_ptr: i32, buf_size_ptr: i32) -> errno (i32)
    const envSizesType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_environ_sizes_get",
    );
    addImport(ctx, "wasi_snapshot_preview1", "environ_sizes_get", { kind: "func", typeIdx: envSizesType });
    ctx.wasiEnvironSizesGetIdx = ctx.funcMap.get("environ_sizes_get")!;

    // environ_get(envPtrs: i32, buf: i32) -> errno (i32)
    const envGetType = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], "$wasi_environ_get");
    addImport(ctx, "wasi_snapshot_preview1", "environ_get", { kind: "func", typeIdx: envGetType });
    ctx.wasiEnvironGetIdx = ctx.funcMap.get("environ_get")!;

    // env::__wasi_env_get_str(key: externref) -> externref
    // JS-polyfill fast path. The polyfill maps this to `process.env[key]`.
    const envGetStrType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$wasi_env_get_str_t");
    addImport(ctx, "env", "__wasi_env_get_str", { kind: "func", typeIdx: envGetStrType });
    ctx.wasiEnvGetStrIdx = ctx.funcMap.get("__wasi_env_get_str")!;
  }

  // (#1483) clock_time_get(clockid: i32, precision: i64, out_ptr: i32) -> errno (i32)
  // Used by Date.now() / performance.now() / new Date() under --target wasi.
  // Registered BEFORE any defined helpers so its late-import-shift discipline
  // matches `random_get` (see CLAUDE.md "addUnionImports" note).
  if (needsClockTimeGet) {
    const clockType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i64" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_clock_time_get",
    );
    addImport(ctx, "wasi_snapshot_preview1", "clock_time_get", { kind: "func", typeIdx: clockType });
    ctx.wasiClockTimeGetIdx = ctx.funcMap.get("clock_time_get")!;
  }

  // path_open(fd: i32, dirflags: i32, path: i32, path_len: i32, oflags: i32,
  //           rights_base: i64, rights_inheriting: i64, fdflags: i32, fd_out: i32) -> i32
  if (needsPathOpen) {
    const pathOpenType = addFuncType(
      ctx,
      [
        { kind: "i32" }, // fd (dirfd)
        { kind: "i32" }, // dirflags
        { kind: "i32" }, // path ptr
        { kind: "i32" }, // path len
        { kind: "i32" }, // oflags
        { kind: "i64" }, // rights_base
        { kind: "i64" }, // rights_inheriting
        { kind: "i32" }, // fdflags
        { kind: "i32" }, // fd_out ptr
      ],
      [{ kind: "i32" }],
      "$wasi_path_open",
    );
    addImport(ctx, "wasi_snapshot_preview1", "path_open", { kind: "func", typeIdx: pathOpenType });
    ctx.wasiPathOpenIdx = ctx.funcMap.get("path_open")!;

    // fd_close(fd: i32) -> i32
    const fdCloseType = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }], "$wasi_fd_close");
    addImport(ctx, "wasi_snapshot_preview1", "fd_close", { kind: "func", typeIdx: fdCloseType });
    ctx.wasiFdCloseIdx = ctx.funcMap.get("fd_close")!;
  }

  // (#1483) Stash pending-helper flags. We emit WASI helper *functions*
  // AFTER `collectExternDeclarations` has registered any lib.es5.d.ts globals
  // (eval / parseInt / etc.) — emitting them earlier would seed funcMap with
  // entries pointing at indices that the subsequent direct `addImport` calls
  // silently shift past, corrupting later lookups (e.g. `__wasi_write_string`
  // referenced by `ensureWasiWriteI32Helper` during user-code compilation).
  // #2524 — the console/stream write helper is emitted whenever the source
  // writes to stdout/stderr, even when the node-process shim diverts the actual
  // syscall (so `needsFdWrite` was recomputed to the file-only need above).
  if (needsFdWrite || needsStreamWriteHelper) {
    ctx.wasiPendingFdWriteHelper = true;
  }
  if (needsConsoleStderr) {
    ctx.wasiPendingConsoleStderrHelper = true;
  }
  if (needsPathOpen) {
    ctx.wasiPendingPathOpenHelper = true;
  }
  if (needsClockTimeGet) {
    ctx.wasiClockHelpersPending = true;
  }
  if (needsPollOneoff) {
    ctx.wasiPendingSleepMsHelper = true;
  }
  // #2632 Phase 1 — defer timer-heap + run-loop registration to
  // emitDeferredWasiHelpers (after __wasi_sleep_ms + clock_time_get are
  // registered, before user bodies compile), so __timer_add / __timer_cancel
  // func indices referenced at timer call sites are final.
  if (needsTimerHeap) {
    ctx.wasiPendingTimerHeap = true;
  }
  // #2632 Phase 2 — activate the fd0 stdin reactor before timer-heap registration
  // (so the run-loop body builds in the fd-reactor shape).
  if (needsStdinReactor) {
    ctx.wasiPendingStdinReactor = true;
  }
}

/**
 * (#1483) Emit deferred WASI helper functions. Called after
 * `collectExternDeclarations` (and any other direct-`addImport` callers)
 * have registered all module imports, so the funcMap entries written here
 * are stable for subsequent lookups by lazily-registered helpers.
 */
export function emitDeferredWasiHelpers(ctx: CodegenContext): void {
  if (!ctx.wasi) return;
  if (ctx.wasiPendingFdWriteHelper && !ctx.funcMap.has("__wasi_write_string")) {
    emitWasiWriteStringHelper(ctx);
    // #1493: also register __wasi_write_string_stderr (fd=2) for console.warn/error.
    if (ctx.wasiPendingConsoleStderrHelper) {
      emitWasiWriteStringStderrHelper(ctx);
    }
  }
  if (ctx.wasiPendingPathOpenHelper && !ctx.funcMap.has("__wasi_write_file_sync")) {
    emitWasiWriteFileSyncHelper(ctx);
  }
  if (ctx.wasiClockHelpersPending && !ctx.funcMap.has("__wasi_date_now")) {
    emitWasiClockHelpers(ctx);
  }

  // #1484 — Register __wasi_sleep_ms(ms: i32) helper that builds a CLOCK
  // subscription and calls poll_oneoff. Currently unused (timer call sites
  // are rejected by rejectTimersUnderWasi); the follow-up issue wires the
  // async scheduler to call this for setTimeout/await sleep().
  if (ctx.wasiPendingSleepMsHelper && !ctx.funcMap.has("__wasi_sleep_ms")) {
    emitWasiSleepMsHelper(ctx);
  }

  // #2632 Phase 2 — activate the fd0 stdin reactor BEFORE ensureTimerHeap so the
  // run-loop body is built in the multi-sub-poll / internal-buffer shape and the
  // Phase-2 globals + helpers (`__rl_stdin_drain`, `__rl_poll_fd0_or_clock`)
  // register at stable func indices ahead of `__run_event_loop`.
  if (ctx.wasiPendingStdinReactor) {
    enableStdinReactor(ctx);
  }

  // #2632 Phase 1 — register the timer heap + run-loop reactor. MUST run after
  // __wasi_sleep_ms (the run loop calls it) and clock_time_get registration
  // (for __rl_now_ns), and BEFORE user bodies compile so the __timer_add /
  // __timer_cancel func indices baked into timer call sites are final.
  if (ctx.wasiPendingTimerHeap && !ctx.funcMap.has("__run_event_loop")) {
    ensureTimerHeap(ctx);
  }
}

/**
 * (#1483) Emit __wasi_date_now() -> f64 and __wasi_performance_now() -> f64
 * helpers. Both wrap `clock_time_get` from wasi_snapshot_preview1.
 *
 * Memory scratch layout (after the path_open / fd_write 0..15 region):
 *   [16..23] = i64 nanosecond timestamp for CLOCK_REALTIME (Date.now)
 *   [24..31] = i64 nanosecond timestamp for CLOCK_MONOTONIC (performance.now)
 */
function emitWasiClockHelpers(ctx: CodegenContext): void {
  const helperTypeIdx = addFuncType(ctx, [], [{ kind: "f64" }]);

  /**
   * Build the body that, after `clock_time_get` has written an i64 LE
   * nanosecond count at `outPtr`, recombines it into a single i64 on the
   * stack via two unsigned i32 loads. (We avoid `i64.load` because the
   * current binary emitter does not support it.)
   *
   * Stack effect: pushes i64 ns.
   */
  function buildI64NsFromMem(outPtr: number): Instr[] {
    return [
      // hi32 << 32
      { op: "i32.const", value: outPtr + 4 },
      { op: "i32.load", align: 2, offset: 0 },
      { op: "i64.extend_i32_u" },
      { op: "i64.const", value: 32n },
      { op: "i64.shl" },
      // | lo32
      { op: "i32.const", value: outPtr },
      { op: "i32.load", align: 2, offset: 0 },
      { op: "i64.extend_i32_u" },
      { op: "i64.or" },
    ];
  }

  // __wasi_date_now() — CLOCK_REALTIME (0). Out-ptr lives at scratch[16..23].
  {
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set("__wasi_date_now", funcIdx);
    const body: Instr[] = [
      // clock_time_get(CLOCK_REALTIME=0, precision=1_000_000ns=1ms, out_ptr=16) -> errno
      { op: "i32.const", value: 0 },
      { op: "i64.const", value: 1000000n },
      { op: "i32.const", value: 16 },
      { op: "call", funcIdx: ctx.wasiClockTimeGetIdx! },
      { op: "drop" }, // ignore errno
      ...buildI64NsFromMem(16),
      // i64 ns → f64 ms (signed convert OK: i64 ns range is good for ~292y past 1970)
      { op: "f64.convert_i64_s" },
      { op: "f64.const", value: 1e6 },
      { op: "f64.div" },
    ];
    ctx.mod.functions.push({
      name: "__wasi_date_now",
      typeIdx: helperTypeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // __wasi_performance_now() — CLOCK_MONOTONIC (1). Out-ptr lives at scratch[24..31].
  {
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set("__wasi_performance_now", funcIdx);
    const body: Instr[] = [
      { op: "i32.const", value: 1 }, // CLOCK_MONOTONIC
      { op: "i64.const", value: 1000n }, // precision = 1us
      { op: "i32.const", value: 24 },
      { op: "call", funcIdx: ctx.wasiClockTimeGetIdx! },
      { op: "drop" },
      ...buildI64NsFromMem(24),
      { op: "f64.convert_i64_s" },
      { op: "f64.const", value: 1e6 },
      { op: "f64.div" },
    ];
    ctx.mod.functions.push({
      name: "__wasi_performance_now",
      typeIdx: helperTypeIdx,
      locals: [],
      body,
      exported: false,
    });
  }
}

/** Emit __wasi_write_string(ptr: i32, len: i32) helper that calls fd_write(1, iov, 1, nwritten) */
function emitWasiWriteStringHelper(ctx: CodegenContext): void {
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_string", funcIdx);

  // Parameters: 0=ptr, 1=len
  // #2633 — under the node shims, delegate to the imported `node:fs`
  // `writeSync(fd=1, ptr, len)` (the shim owns the iovec/syscall); no fd_write
  // import exists in the user module.
  const body: Instr[] = ctx.linkNodeShims
    ? [
        { op: "i32.const", value: 1 }, // fd = stdout
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx },
        { op: "drop" }, // drop bytes-written
      ]
    : [
        // iovec at memory[0]: { buf_ptr: i32, buf_len: i32 }; nwritten at memory[8]
        // Store ptr at memory[0] (iovec.buf)
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 0 },
        { op: "i32.store", align: 2, offset: 0 },
        // Store len at memory[4] (iovec.buf_len)
        { op: "i32.const", value: 4 },
        { op: "local.get", index: 1 },
        { op: "i32.store", align: 2, offset: 0 },
        // Call fd_write(fd=1, iovs=0, iovs_len=1, nwritten=8)
        { op: "i32.const", value: 1 }, // fd = stdout
        { op: "i32.const", value: 0 }, // iovs pointer
        { op: "i32.const", value: 1 }, // iovs_len = 1
        { op: "i32.const", value: 8 }, // nwritten pointer
        { op: "call", funcIdx: ctx.wasiFdWriteIdx },
        { op: "drop" }, // drop the return value (errno)
      ];

  ctx.mod.functions.push({
    name: "__wasi_write_string",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/**
 * #1493: Emit __wasi_write_string_stderr(ptr: i32, len: i32) helper that calls
 * fd_write(2, iov, 1, nwritten). Used by console.warn / console.error so their
 * output lands on stderr (matching Node/V8 semantics and enabling `2>&1` / `2>err`).
 */
function emitWasiWriteStringStderrHelper(ctx: CodegenContext): void {
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_string_stderr", funcIdx);

  // Parameters: 0=ptr, 1=len
  // #2633 — under the node shims, delegate to the imported `node:fs`
  // `writeSync(fd=2, ptr, len)` (returns bytes-written → drop).
  const body: Instr[] = ctx.linkNodeShims
    ? [
        { op: "i32.const", value: 2 }, // fd = stderr
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx },
        { op: "drop" }, // drop bytes-written
      ]
    : [
        // iovec at memory[0]: { buf_ptr: i32, buf_len: i32 }; nwritten at memory[8]
        // Store ptr at memory[0] (iovec.buf)
        { op: "i32.const", value: 0 },
        { op: "local.get", index: 0 },
        { op: "i32.store", align: 2, offset: 0 },
        // Store len at memory[4] (iovec.buf_len)
        { op: "i32.const", value: 4 },
        { op: "local.get", index: 1 },
        { op: "i32.store", align: 2, offset: 0 },
        // Call fd_write(fd=2, iovs=0, iovs_len=1, nwritten=8)
        { op: "i32.const", value: 2 }, // fd = stderr
        { op: "i32.const", value: 0 }, // iovs pointer
        { op: "i32.const", value: 1 }, // iovs_len = 1
        { op: "i32.const", value: 8 }, // nwritten pointer
        { op: "call", funcIdx: ctx.wasiFdWriteIdx },
        { op: "drop" }, // drop the return value (errno)
      ];

  ctx.mod.functions.push({
    name: "__wasi_write_string_stderr",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/**
 * WASI linear-memory layout constants (#1618 collision fix).
 *
 * The iovec lives at memory[0..7] and nwritten at memory[8..11] (shared by all
 * __wasi_write_* helpers). String-literal data segments are bump-allocated in
 * page 0 from offset 1024 (`wasiAllocStringData`). To avoid aliasing those
 * segments, the stdin read buffer and the raw-byte write scratch live in
 * dedicated higher pages:
 *   - WASI_STDIN_BUF_START  = 64KB  (page 1) — fd_read accumulation buffer
 *   - WASI_WRITE_SCRATCH_START = 128KB (page 2) — fd_write staging buffer
 * `registerWasiImports` reserves 3 pages so both always exist.
 */
export const WASI_STDIN_BUF_START = 64 * 1024;
export const WASI_WRITE_SCRATCH_START = 128 * 1024;

/**
 * #2807 — maximum byte length of a SINGLE `fd_write` iovec. wasmtime (verified
 * v46.0.1) rejects a one-iovec `fd_write` whose length is at/above ~128 MiB
 * (empirically the cap is `len <= 0x07FFFFF8`; `len >= 0x07FFFFF9` returns errno
 * 48 / `ENOMEM` with `nwritten = 0`, identically for a redirected file and a
 * pipe — wasmtime bounds the guest→host buffer it stages per write, so this is a
 * fixed structural cap, NOT real memory pressure). Because the `__wasi_write_*`
 * tails mapped a non-zero errno to "0 bytes", a single `process.stdout.write` of
 * a ≥128 MiB Native-Messaging body wrote ZERO bytes and the host exited 0 with
 * no output (the nm_node_process 128-MiB silent-failure of #2807).
 *
 * 64 MiB sits a comfortable 2× below the cap and is confirmed to write fully on
 * both a file and a pipe; the chunk count for even a 256 MiB body is trivial (4),
 * dwarfed by the per-byte GC→scratch staging copy, so there is no perf cost.
 */
export const WASI_FD_WRITE_MAX_CHUNK = 64 * 1024 * 1024;

/**
 * #2655 — DIRECT `readSync` iovec + nread scratch (page 0). The blocking
 * `wasi_snapshot_preview1.fd_read(fd, iovs, iovs_len, nread)` syscall needs a
 * `{ base, len }` iovec (8 bytes) and a `nread` out-slot (4 bytes) in linear
 * memory. These deliberately use DEDICATED page-0 offsets — NOT the async
 * reactor's `RL_FDREAD_IOV_OFFSET` (324) / `RL_FDREAD_NREAD_OFFSET` (332) — so a
 * program that uses BOTH synchronous `readSync` AND the async stdin reactor
 * never has its two iovec scratches alias. They sit above the reactor's
 * 160–336 poll/iovec region and below the 1024 string-literal data base, so
 * they collide with neither the iovec write scratch (0–24), the reactor, nor any
 * string-literal segment. The read DATA lands in the page-1 stdin buffer
 * (`WASI_STDIN_BUF_START`) for the GC-array copy path, or straight into the
 * caller's `ptr+offset` for the linear-backed zero-copy path.
 */
export const WASI_READSYNC_IOV_OFFSET = 340;
export const WASI_READSYNC_NREAD_OFFSET = 348;

/**
 * #2524 Phase 1 — emit the "write `len` bytes starting at linear `srcConst`
 * to fd `fd`, discarding the result" tail used by the GC-buffer / string
 * `__wasi_write_*` helpers. `len` is read from the named local index.
 *
 * Inline (default) path: build the iovec at memory[0..7] pointing at
 * `srcConst`, call `fd_write(fd, iovs=0, iovs_len=1, nwritten=8)`, drop errno.
 *
 * Shim path (`ctx.linkNodeShims`): call the imported `node:fs`
 * `writeSync(fd, srcConst, len)` directly — the shim owns the iovec + syscall
 * over the shared memory. `writeSync` returns bytes-written (dropped). (#2633)
 */
function emitWasiWriteTail(ctx: CodegenContext, fd: number, srcConst: number, lenLocalIdx: number): Instr[] {
  if (ctx.linkNodeShims) {
    return [
      { op: "i32.const", value: fd },
      { op: "i32.const", value: srcConst },
      { op: "local.get", index: lenLocalIdx },
      { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx },
      { op: "drop" }, // drop bytes-written
    ];
  }
  // #2807 — route the direct-WASI write through the chunked `__wasi_fd_write_all`
  // helper so a ≥128 MiB buffer (a large Native-Messaging frame) is written in
  // bounded pieces below wasmtime's single-iovec cap, instead of one oversized
  // fd_write that returns errno 48 and silently drops every byte. The helper is
  // pre-created at the top of each `__wasi_write_*` helper (and by any inline
  // caller), so this lookup never pushes a function mid-body — keeping the
  // outer helper's reserved funcidx stable.
  const writeAllIdx = ensureWasiFdWriteAllHelper(ctx);
  if (writeAllIdx >= 0) {
    return [
      { op: "i32.const", value: fd },
      { op: "i32.const", value: srcConst },
      { op: "local.get", index: lenLocalIdx },
      { op: "call", funcIdx: writeAllIdx },
      { op: "drop" }, // drop total bytes-written
    ];
  }
  return [
    // iovec.buf = srcConst at memory[0]
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: srcConst },
    { op: "i32.store", align: 2, offset: 0 },
    // iovec.buf_len = len at memory[4]
    { op: "i32.const", value: 4 },
    { op: "local.get", index: lenLocalIdx },
    { op: "i32.store", align: 2, offset: 0 },
    // fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
    { op: "i32.const", value: fd },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: 8 },
    { op: "call", funcIdx: ctx.wasiFdWriteIdx },
    { op: "drop" },
  ];
}

/**
 * #2807 — ensure the `__wasi_fd_write_all(fd, ptr, len) -> i32` helper exists and
 * return its function index (lazy). It writes `len` bytes from linear `ptr` to
 * `fd` in bounded chunks of at most {@link WASI_FD_WRITE_MAX_CHUNK}, advancing by
 * the ACTUAL `nwritten` each iteration so a kernel short-write is handled too,
 * until all bytes are written. Stops on a non-zero errno or a zero-progress write
 * (never loops forever). Returns the total bytes written.
 *
 * This is the single point that defeats wasmtime's ~128 MiB single-`fd_write`
 * cap (see {@link WASI_FD_WRITE_MAX_CHUNK}). It is a no-op (`-1`) under the
 * node-shim write path (`ctx.linkNodeShims`) — that path forwards to the shim's
 * own `writeSync` — and when no direct `fd_write` is registered.
 *
 * The iovec at memory[0..7] and nwritten at memory[8..11] are the same page-0
 * scratch slots the inline tail used; callers stage the data into `ptr` and grow
 * memory before calling, so this helper only loops the syscall.
 */
export function ensureWasiFdWriteAllHelper(ctx: CodegenContext): number {
  if (!ctx.wasi || ctx.linkNodeShims || ctx.wasiFdWriteIdx === undefined) return -1;
  const helperName = "__wasi_fd_write_all";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // params: fd(0), ptr(1), len(2); locals: base(3), remaining(4), total(5),
  // chunk(6), errno(7), nw(8)
  const FD = 0;
  const PTR = 1;
  const LEN = 2;
  const BASE = 3;
  const REMAINING = 4;
  const TOTAL = 5;
  const CHUNK = 6;
  const ERRNO = 7;
  const NW = 8;

  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const loopBody: Instr[] = [
    // if (remaining <= 0) break out of the block
    { op: "local.get", index: REMAINING },
    { op: "i32.const", value: 0 },
    { op: "i32.le_s" },
    { op: "br_if", depth: 1 },
    // chunk = min(remaining, MAX_CHUNK) = remaining < MAX ? remaining : MAX
    { op: "local.get", index: REMAINING },
    { op: "i32.const", value: WASI_FD_WRITE_MAX_CHUNK },
    { op: "local.get", index: REMAINING },
    { op: "i32.const", value: WASI_FD_WRITE_MAX_CHUNK },
    { op: "i32.lt_s" },
    { op: "select" },
    { op: "local.set", index: CHUNK },
    // iovec.buf = base at memory[0]
    { op: "i32.const", value: 0 },
    { op: "local.get", index: BASE },
    { op: "i32.store", align: 2, offset: 0 },
    // iovec.buf_len = chunk at memory[4]
    { op: "i32.const", value: 4 },
    { op: "local.get", index: CHUNK },
    { op: "i32.store", align: 2, offset: 0 },
    // errno = fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
    { op: "local.get", index: FD },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: 8 },
    { op: "call", funcIdx: ctx.wasiFdWriteIdx },
    { op: "local.set", index: ERRNO },
    // if (errno != 0) break — return whatever was written so far
    { op: "local.get", index: ERRNO },
    { op: "br_if", depth: 1 },
    // nw = memory[8]
    { op: "i32.const", value: 8 },
    { op: "i32.load", align: 2, offset: 0 },
    { op: "local.set", index: NW },
    // if (nw <= 0) break — no progress, never spin
    { op: "local.get", index: NW },
    { op: "i32.const", value: 0 },
    { op: "i32.le_s" },
    { op: "br_if", depth: 1 },
    // total += nw
    { op: "local.get", index: TOTAL },
    { op: "local.get", index: NW },
    { op: "i32.add" },
    { op: "local.set", index: TOTAL },
    // base += nw
    { op: "local.get", index: BASE },
    { op: "local.get", index: NW },
    { op: "i32.add" },
    { op: "local.set", index: BASE },
    // remaining -= nw
    { op: "local.get", index: REMAINING },
    { op: "local.get", index: NW },
    { op: "i32.sub" },
    { op: "local.set", index: REMAINING },
    // continue
    { op: "br", depth: 0 },
  ];

  const body: Instr[] = [
    // base = ptr
    { op: "local.get", index: PTR },
    { op: "local.set", index: BASE },
    // remaining = len
    { op: "local.get", index: LEN },
    { op: "local.set", index: REMAINING },
    // total = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: TOTAL },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    { op: "local.get", index: TOTAL },
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [
      { name: "base", type: { kind: "i32" } },
      { name: "remaining", type: { kind: "i32" } },
      { name: "total", type: { kind: "i32" } },
      { name: "chunk", type: { kind: "i32" } },
      { name: "errno", type: { kind: "i32" } },
      { name: "nw", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Local-index layout for the shared WTF-16 → UTF-8 encoder. `S` is the AnyString
 * param's index; the ten work-locals (`FLAT`..`LO`) are laid out contiguously
 * starting at `base`. In Wasm, params occupy the low indices then declared
 * locals follow, so a helper with N params declares its work-locals starting at
 * index N. The fixed-fd writer has one param (s=0) ⇒ base 1; the runtime-fd
 * writer has two params (s=0, fd=1) ⇒ base 2 (#2639).
 */
interface WasiStrEncodeLayout {
  S: number;
  FLAT: number;
  LEN: number;
  OFF: number;
  DATA: number;
  I: number;
  O: number;
  NEED_PAGES: number;
  CU: number;
  CP: number;
  LO: number;
}

/** Build the encoder local layout for an AnyString param and work-locals at `base..base+9`. */
function wasiStrEncodeLayout(base: number, stringParam: number = 0): WasiStrEncodeLayout {
  return {
    S: stringParam,
    FLAT: base + 0,
    LEN: base + 1,
    OFF: base + 2,
    DATA: base + 3,
    I: base + 4,
    O: base + 5,
    NEED_PAGES: base + 6,
    CU: base + 7,
    CP: base + 8,
    LO: base + 9,
  };
}

/** The (named, ordered) work-local declarations matching {@link wasiStrEncodeLayout}. */
function wasiStrEncodeLocalDecls(strTypeIdx: number, strDataTypeIdx: number) {
  return [
    { name: "flat", type: { kind: "ref" as const, typeIdx: strTypeIdx } },
    { name: "len", type: { kind: "i32" as const } },
    { name: "off", type: { kind: "i32" as const } },
    { name: "data", type: { kind: "ref" as const, typeIdx: strDataTypeIdx } },
    { name: "i", type: { kind: "i32" as const } },
    { name: "o", type: { kind: "i32" as const } },
    { name: "needPages", type: { kind: "i32" as const } },
    { name: "cu", type: { kind: "i32" as const } },
    { name: "cp", type: { kind: "i32" as const } },
    { name: "lo", type: { kind: "i32" as const } },
  ];
}

/**
 * Build the WTF-16 → UTF-8 encode-to-linear-scratch instruction sequence shared
 * by every WASI write-string helper. Flattens the AnyString param (local `S`)
 * via `__str_flatten`, grows linear memory for the worst-case 3 bytes/code-unit
 * staging region, then encodes the code points into
 * `[WASI_WRITE_SCRATCH_START .. WASI_WRITE_SCRATCH_START + O)`. On return the
 * output-cursor local `O` holds the exact UTF-8 byte count; the caller appends
 * its own write tail (fixed-fd fd_write, or runtime-fd node:fs writeSync). No
 * value is left on the stack. (#2639 factored this out of
 * {@link ensureWasiWriteAnyStringHelper} byte-for-byte so existing fd 1/2 output
 * is unchanged.)
 */
function buildWasiStringEncodeToScratch(
  flattenIdx: number,
  strTypeIdx: number,
  strDataTypeIdx: number,
  layout: WasiStrEncodeLayout,
): Instr[] {
  const { FLAT, LEN, OFF, DATA, I, O, NEED_PAGES, CU, CP, LO, S } = layout;

  const storeByte = (offsetFromO: number, value: Instr[]): Instr[] => [
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
    { op: "local.get", index: O },
    ...(offsetFromO === 0 ? [] : ([{ op: "i32.const", value: offsetFromO }, { op: "i32.add" }] satisfies Instr[])),
    { op: "i32.add" },
    ...value,
    { op: "i32.store8", align: 0, offset: 0 },
  ];

  const advanceOutput = (n: number): Instr[] => [
    { op: "local.get", index: O },
    { op: "i32.const", value: n },
    { op: "i32.add" },
    { op: "local.set", index: O },
  ];

  const encodeCurrentCodePoint: Instr[] = [
    { op: "local.get", index: CP },
    { op: "i32.const", value: 0x80 },
    { op: "i32.lt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [storeByte(0, [{ op: "local.get", index: CP }]), ...advanceOutput(1)].flat(),
      else: [
        { op: "local.get", index: CP },
        { op: "i32.const", value: 0x800 },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...storeByte(0, [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 6 },
              { op: "i32.shr_u" },
              { op: "i32.const", value: 0xc0 },
              { op: "i32.or" },
            ]),
            ...storeByte(1, [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x3f },
              { op: "i32.and" },
              { op: "i32.const", value: 0x80 },
              { op: "i32.or" },
            ]),
            ...advanceOutput(2),
          ],
          else: [
            { op: "local.get", index: CP },
            { op: "i32.const", value: 0x10000 },
            { op: "i32.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...storeByte(0, [
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0xe0 },
                  { op: "i32.or" },
                ]),
                ...storeByte(1, [
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 0x80 },
                  { op: "i32.or" },
                ]),
                ...storeByte(2, [
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 0x80 },
                  { op: "i32.or" },
                ]),
                ...advanceOutput(3),
              ],
              else: [
                ...storeByte(0, [
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 18 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0xf0 },
                  { op: "i32.or" },
                ]),
                ...storeByte(1, [
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 0x80 },
                  { op: "i32.or" },
                ]),
                ...storeByte(2, [
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 0x80 },
                  { op: "i32.or" },
                ]),
                ...storeByte(3, [
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 0x80 },
                  { op: "i32.or" },
                ]),
                ...advanceOutput(4),
              ],
            },
          ],
        },
      ],
    },
  ];

  return [
    // flat = __str_flatten(s)
    { op: "local.get", index: S },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: FLAT },

    // len = flat.len (field 0)
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: LEN },

    // #1723/#1470: grow linear memory if the staging buffer could overflow.
    // UTF-8/WTF-8 needs at most 3 bytes per UTF-16 code unit.
    //   neededPages = ceil((WASI_WRITE_SCRATCH_START + len*3) / 65536)
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
    { op: "local.get", index: LEN },
    { op: "i32.const", value: 3 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "i32.const", value: 65535 },
    { op: "i32.add" },
    { op: "i32.const", value: 16 },
    { op: "i32.shr_u" },
    { op: "local.set", index: NEED_PAGES },
    { op: "local.get", index: NEED_PAGES },
    { op: "memory.size" },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: NEED_PAGES },
        { op: "memory.size" },
        { op: "i32.sub" },
        { op: "memory.grow" },
        { op: "drop" },
      ],
    },

    // off = flat.off (field 1)
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: OFF },

    // data = flat.data (field 2)
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: DATA },

    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    // o = 0 (UTF-8 byte cursor)
    { op: "i32.const", value: 0 },
    { op: "local.set", index: O },

    // while (i < len) decode one WTF-16 code point and encode it as UTF-8.
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // cu = data[off + i]; cp = cu; i++
            { op: "local.get", index: DATA },
            { op: "local.get", index: OFF },
            { op: "local.get", index: I },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: CU },
            { op: "local.get", index: CU },
            { op: "local.set", index: CP },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },

            // Combine a high+low surrogate pair into one scalar.
            { op: "local.get", index: CU },
            { op: "i32.const", value: 0xd800 },
            { op: "i32.ge_u" },
            { op: "local.get", index: CU },
            { op: "i32.const", value: 0xdbff },
            { op: "i32.le_u" },
            { op: "i32.and" },
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.lt_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: DATA },
                { op: "local.get", index: OFF },
                { op: "local.get", index: I },
                { op: "i32.add" },
                { op: "array.get_u", typeIdx: strDataTypeIdx },
                { op: "local.set", index: LO },
                { op: "local.get", index: LO },
                { op: "i32.const", value: 0xdc00 },
                { op: "i32.ge_u" },
                { op: "local.get", index: LO },
                { op: "i32.const", value: 0xdfff },
                { op: "i32.le_u" },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 0x10000 },
                    { op: "local.get", index: CU },
                    { op: "i32.const", value: 0xd800 },
                    { op: "i32.sub" },
                    { op: "i32.const", value: 10 },
                    { op: "i32.shl" },
                    { op: "i32.add" },
                    { op: "local.get", index: LO },
                    { op: "i32.const", value: 0xdc00 },
                    { op: "i32.sub" },
                    { op: "i32.add" },
                    { op: "local.set", index: CP },
                    { op: "local.get", index: I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: I },
                  ],
                },
              ],
            },

            // TextEncoder / Node's UTF-8 filesystem APIs convert unmatched
            // UTF-16 surrogates to U+FFFD. A valid high+low pair was combined
            // above into a scalar > 0xffff, so only unmatched code units remain
            // in the surrogate range here.
            { op: "local.get", index: CP },
            { op: "i32.const", value: 0xd800 },
            { op: "i32.ge_u" },
            { op: "local.get", index: CP },
            { op: "i32.const", value: 0xdfff },
            { op: "i32.le_u" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "i32.const", value: 0xfffd },
                { op: "local.set", index: CP },
              ],
            },

            ...encodeCurrentCodePoint,
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/**
 * #1618: Ensure __wasi_write_any_string(s: ref NativeString) -> void exists and
 * return its function index (lazy, emitted during expression compilation).
 *
 * Writes a *runtime* string (variable, concatenation, template span) to fd=1
 * (stdout) or fd=2 (stderr). Previously these refs fell through to the
 * `[object]` placeholder in emitWasiValueToStdout, corrupting the stream.
 *
 * Strategy: flatten any AnyString (FlatString / ConsString / Utf8String) to a
 * NativeString via the existing __str_flatten helper, then encode the WTF-16
 * code units as UTF-8 bytes directly into linear memory before issuing
 * fd_write. This keeps WASI string output on the pure-Wasm path (#1470) without
 * routing through the JS-host `__str_to_mem` / `TextEncoder` bridge.
 *
 * Param 0 is typed `ref NativeString` so callers can hand us a value compiled
 * as `{ kind: "ref", typeIdx: ctx.nativeStrTypeIdx }` directly; __str_flatten
 * accepts the NativeString supertype (AnyString) and returns the flat form.
 */
export function ensureWasiWriteAnyStringHelper(ctx: CodegenContext, useStderr: boolean = false): number {
  const helperName = useStderr ? "__wasi_write_any_string_stderr" : "__wasi_write_any_string";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // #2524 — node-process shim path needs no fd_write idx (see Uint8Array helper).
  if (!ctx.wasi || (!ctx.linkNodeShims && ctx.wasiFdWriteIdx === undefined) || ctx.nativeStrTypeIdx < 0) return -1;

  // Make sure the native-string runtime (incl. __str_flatten) is emitted.
  ensureNativeStringHelpers(ctx);
  // __str_flatten via funcMap (shift-maintained), not nativeStrHelpers (which can
  // be stale-low after late imports). See the registration in
  // ensureNativeStringHelpers. (#1618)
  const flattenIdx = ctx.funcMap.get("__str_flatten");
  if (flattenIdx === undefined) return -1;

  const fd = useStderr ? 2 : 1;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  // #1723: the param MUST be the AnyString supertype, NOT the concrete
  // NativeString. A runtime concat / template span can be a ConsString (rope),
  // and the caller hands us whatever the expression produced. If the param were
  // typed NativeString, the call site would have to `ref.cast` the argument down
  // to NativeString first — which TRAPS ("illegal cast") for a ConsString. By
  // accepting AnyString here, both NativeString and ConsString pass without any
  // downcast, and `__str_flatten` (which takes AnyString and collapses ropes)
  // does the flattening internally. The original NativeString param + call-site
  // downcast is exactly what made `writeMessage` trap on a multi-segment
  // response in the Native Messaging host (#1723).
  const anyStrTypeIdx = ctx.anyStrTypeIdx >= 0 ? ctx.anyStrTypeIdx : strTypeIdx;

  // #2807 — create the chunked-write helper BEFORE reserving this helper's
  // funcidx, so the `emitWasiWriteTail` lookup in the body below never pushes a
  // function mid-build (which would shift this reserved index).
  ensureWasiFdWriteAllHelper(ctx);

  // One param (s=0) ⇒ work-locals start at index 1.
  const layout = wasiStrEncodeLayout(1);
  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: anyStrTypeIdx }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    ...buildWasiStringEncodeToScratch(flattenIdx, strTypeIdx, strDataTypeIdx, layout),
    // #2524/#2633 — write the staged UTF-8 region (`O` bytes) via fd_write or
    // the node:fs shim's writeSync(fd, …). Result (bytes-written) is dropped.
    ...emitWasiWriteTail(ctx, fd, WASI_WRITE_SCRATCH_START, layout.O),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: wasiStrEncodeLocalDecls(strTypeIdx, strDataTypeIdx),
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * (#2968) Ensure `__wasi_start_print_exn(payload: externref) -> void` exists and
 * return its function index (lazy). Renders an uncaught exception payload to
 * stderr for the WASI `_start` wrapper (addWasiStartExport):
 *   - null payload (e.g. `throw null`) → no-op (no string form).
 *   - else `any.convert_extern` → `__any_to_string` (whose #2962 error arm turns
 *     an `$Error_struct` into a real "TypeError: x") → `__wasi_write_any_string_stderr`
 *     (flatten + WTF-16→UTF-8 encode + fd 2 write) → a trailing newline byte.
 * The caller invokes this from the `$exc` catch, then `proc_exit(1)`s.
 *
 * Valid only for a throwing, native-strings WASI module whose fd_write import is
 * registered (registerWasiImports sets it when the source contains a `throw`);
 * returns -1 otherwise so the caller keeps the plain `_start`.
 *
 * Index-shift safety: every dependency is ensured (each may append functions /
 * a late import) BEFORE this helper's own funcidx is reserved, and the baked
 * funcidx values are read from the authoritative `funcMap` after all ensures.
 */
export function ensureWasiStartExnPrinter(ctx: CodegenContext): number {
  const helperName = "__wasi_start_print_exn";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;
  if (!ctx.wasi || ctx.exnTagIdx < 0 || !ctx.nativeStrings) return -1;
  if (!ctx.linkNodeShims && ctx.wasiFdWriteIdx < 0) return -1;

  // Ensure dependencies first (append functions / possible late import) so this
  // helper's reserved index lands AFTER any shift they cause.
  ensureNativeStringHelpers(ctx);
  ensureAnyToStringHelper(ctx);
  const writeStderrIdx = ensureWasiWriteAnyStringHelper(ctx, /* useStderr */ true);
  // The chunked-write helper backs the newline `emitWasiWriteTail` below; ensure
  // it now (idempotent — ensureWasiWriteAnyStringHelper already did) so the tail
  // lookup never pushes a function after this helper's funcidx is reserved.
  ensureWasiFdWriteAllHelper(ctx);
  // Read baked funcidx values from the authoritative funcMap AFTER all ensures.
  const anyToStrIdx = ctx.funcMap.get("__any_to_string");
  if (writeStderrIdx < 0 || anyToStrIdx === undefined) return -1;

  // param 0 = payload externref; local 1 = the newline write length (=1).
  const NL_LEN = 1;
  const funcTypeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    // A null payload has no string form — skip rendering, still exit via caller.
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    // payload (externref) → anyref → __any_to_string yields ref AnyString → stderr.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: anyToStrIdx },
    { op: "call", funcIdx: writeStderrIdx },
    // Trailing newline: store 0x0A at the shared write scratch and write 1 byte
    // to fd 2 (emitWasiWriteTail handles both the direct-WASI and node-shim path).
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
    { op: "i32.const", value: 0x0a },
    { op: "i32.store8", align: 0, offset: 0 },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: NL_LEN },
    ...emitWasiWriteTail(ctx, 2, WASI_WRITE_SCRATCH_START, NL_LEN),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [{ name: "nlLen", type: { kind: "i32" } }],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #2639: Ensure `__wasi_write_any_string_fd(s: ref AnyString, fd: i32) -> i32`
 * exists and return its function index (lazy). Encodes the string to UTF-8 in
 * the shared linear scratch (the same encoder as the fixed-fd writer) and writes
 * it to the *runtime* fd. This backs the STRING overload of `node:fs`
 * `writeSync(fd, str, position?, encoding?)`, where the fd is an arbitrary
 * integer (not just stdout/stderr). Two modes (#2655):
 *   - shim (`--link node:fs`): `writeSync(fd, ptr, len)` returns the byte count.
 *   - direct (standalone `--target wasi`): build a `{ base=ptr, len }` iovec at
 *     memory[0..7], call `fd_write(fd, iovs=0, 1, nwritten=8)`, load nwritten.
 */
export function ensureWasiWriteAnyStringFdHelper(ctx: CodegenContext): number {
  const helperName = "__wasi_write_any_string_fd";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // Runtime-fd writes need either the node:fs shim funcidx (shim path) or the
  // wasi_snapshot_preview1.fd_write import (direct path).
  const directWrite = !ctx.linkNodeShims;
  if (!ctx.wasi || ctx.nativeStrTypeIdx < 0) return -1;
  if (directWrite ? ctx.wasiFdWriteIdx === undefined : ctx.nodeFsWriteSyncIdx < 0) return -1;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.funcMap.get("__str_flatten");
  if (flattenIdx === undefined) return -1;

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx >= 0 ? ctx.anyStrTypeIdx : strTypeIdx;

  // Two params: s(0), fd(1). The ten encoder work-locals therefore start at
  // index 2; the byte cursor `O` holds the encoded length after the encoder runs.
  const FD = 1;
  const layout = wasiStrEncodeLayout(2);

  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: anyStrTypeIdx }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    ...buildWasiStringEncodeToScratch(flattenIdx, strTypeIdx, strDataTypeIdx, layout),
    // return bytes-written for write(fd, WASI_WRITE_SCRATCH_START, O).
    ...(directWrite
      ? ([
          // iovec.base = scratch at memory[0]; iovec.len = O at memory[4].
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
          { op: "i32.store", align: 2, offset: 0 },
          { op: "i32.const", value: 4 },
          { op: "local.get", index: layout.O },
          { op: "i32.store", align: 2, offset: 0 },
          // errno = fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
          { op: "local.get", index: FD },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.const", value: 8 },
          { op: "call", funcIdx: ctx.wasiFdWriteIdx },
          // errno != 0 → 0 bytes; else load nwritten at memory[8].
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 0 }],
            else: [
              { op: "i32.const", value: 8 },
              { op: "i32.load", align: 2, offset: 0 },
            ],
          },
        ] satisfies Instr[])
      : ([
          // writeSync(fd, WASI_WRITE_SCRATCH_START, O) — bytes written.
          { op: "local.get", index: FD },
          { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
          { op: "local.get", index: layout.O },
          { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx },
        ] satisfies Instr[])),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    // Work-locals follow the two params (s, fd); no extra local for fd.
    locals: wasiStrEncodeLocalDecls(strTypeIdx, strDataTypeIdx),
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #4565 — Ensure the dynamic-string `writeFileSync(path, data)` helper exists.
 * Both JS arguments arrive as AnyString refs, so their expressions are fully
 * evaluated before filesystem effects begin. The helper encodes the path into
 * shared scratch and opens it immediately, then reuses that scratch for data.
 * This sequencing keeps the two byte ranges from aliasing without retaining or
 * leaking a second linear-memory allocation.
 */
export function ensureWasiWriteFileStringsHelper(ctx: CodegenContext): number {
  const helperName = "__wasi_write_file_strings";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  if (
    !ctx.wasi ||
    ctx.nativeStrTypeIdx < 0 ||
    ctx.wasiPathOpenIdx === undefined ||
    ctx.wasiFdWriteIdx === undefined ||
    ctx.wasiFdCloseIdx === undefined
  ) {
    return -1;
  }

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.funcMap.get("__str_flatten");
  if (flattenIdx === undefined) return -1;

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx >= 0 ? ctx.anyStrTypeIdx : strTypeIdx;
  // params: path(0), data(1); encoder work-locals(2..11), openedFd(12).
  const layout = wasiStrEncodeLayout(2, 0);
  const OPENED_FD = 12;
  const funcTypeIdx = addFuncType(
    ctx,
    [
      { kind: "ref", typeIdx: anyStrTypeIdx },
      { kind: "ref", typeIdx: anyStrTypeIdx },
    ],
    [],
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    // Encode and consume the path before the shared scratch is reused.
    ...buildWasiStringEncodeToScratch(flattenIdx, strTypeIdx, strDataTypeIdx, layout),
    ...buildWasiPathOpen(
      ctx,
      [{ op: "i32.const", value: WASI_WRITE_SCRATCH_START }],
      [{ op: "local.get", index: layout.O }],
      OPENED_FD,
    ),
    // Reuse the encoder locals/scratch for data only after path_open consumed it.
    ...buildWasiStringEncodeToScratch(flattenIdx, strTypeIdx, strDataTypeIdx, {
      ...layout,
      S: 1,
    }),
    ...buildWasiWriteAndClose(
      ctx,
      [{ op: "i32.const", value: WASI_WRITE_SCRATCH_START }],
      [{ op: "local.get", index: layout.O }],
      OPENED_FD,
    ),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [...wasiStrEncodeLocalDecls(strTypeIdx, strDataTypeIdx), { name: "openedFd", type: { kind: "i32" } }],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #1617/#1651: Ensure __wasi_write_uint8array(arr: ref __vec_*) -> void
 * exists and return its function index (lazy).
 *
 * Writes raw bytes from a typed-array (Uint8Array) GC object to fd=1 (stdout)
 * or fd=2 (stderr) with NO trailing newline. Backs the
 * `process.stdout.write(new Uint8Array([...]))` path (the standard Node API
 * that supersedes the bespoke `writeStdout` builtin from #1617). A native
 * Uint8Array compiles to a "vec" struct:
 *   field 0: length (i32)
 *   field 1: data    (ref array<i8>) — each element is a byte value
 *
 * Legacy f64-backed typed arrays are still accepted; each element is converted
 * to a byte before staging in linear memory at WASI_WRITE_SCRATCH_START.
 */
export function ensureWasiWriteUint8ArrayHelper(
  ctx: CodegenContext,
  vecTypeIdx: number,
  useStderr: boolean = false,
): number {
  // #2524/#2633 — under the node shims the write is satisfied by the imported
  // `node:fs::writeSync` (no fd_write idx); otherwise it needs the real fd_write.
  if (!ctx.wasi || (!ctx.linkNodeShims && ctx.wasiFdWriteIdx === undefined)) return -1;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return -1;
  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemKind = arrDef?.kind === "array" ? arrDef.element.kind : "f64";
  const helperSuffix = elemKind === "i8" ? "_i8" : elemKind === "i32" ? "_i32" : "_f64";
  const helperName = useStderr
    ? `__wasi_write_uint8array_stderr${helperSuffix}`
    : `__wasi_write_uint8array${helperSuffix}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const fd = useStderr ? 2 : 1;

  // param: arr(0); locals: len(1), data(2), i(3), needPages(4)
  const ARR = 0;
  const LEN = 1;
  const DATA = 2;
  const I = 3;
  const NEED_PAGES = 4;

  // #2807 — pre-create the chunked-write helper before reserving this funcidx
  // (see note in ensureWasiWriteAnyStringHelper).
  ensureWasiFdWriteAllHelper(ctx);

  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: vecTypeIdx }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    // len = arr.length (field 0)
    { op: "local.get", index: ARR },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: LEN },

    // #389/#1723: grow linear memory if the staging buffer
    // [WASI_WRITE_SCRATCH_START .. WASI_WRITE_SCRATCH_START+len) would overflow
    // the current memory size. The module reserves only 3 pages by default, so a
    // ~1 MiB raw-byte write (the Native Messaging large-message case) writes far
    // past page 2 and traps "memory access out of bounds" without this guard —
    // the same fix the string-write helper got in #1723 but that this and the
    // ArrayBuffer-write sibling were missing, which is what corrupted/dropped
    // guest271314's 1 MiB framed message.
    //
    //   neededPages = ceil((WASI_WRITE_SCRATCH_START + len) / 65536)
    //               = (WASI_WRITE_SCRATCH_START + len + 65535) >> 16
    // i32.shr_u keeps the page count non-negative for lengths near 2^31.
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
    { op: "local.get", index: LEN },
    { op: "i32.add" },
    { op: "i32.const", value: 65535 },
    { op: "i32.add" },
    { op: "i32.const", value: 16 },
    { op: "i32.shr_u" },
    { op: "local.set", index: NEED_PAGES },
    // if (needPages > memory.size) memory.grow(needPages - memory.size)
    { op: "local.get", index: NEED_PAGES },
    { op: "memory.size" },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: NEED_PAGES },
        { op: "memory.size" },
        { op: "i32.sub" },
        { op: "memory.grow" },
        { op: "drop" },
      ],
    },

    // data = arr.data (field 1)
    { op: "local.get", index: ARR },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: DATA },

    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },

    // while (i < len) mem[SCRATCH+i] = (u8) trunc(data[i]); i++
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // address = SCRATCH_START + i
            { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
            { op: "local.get", index: I },
            { op: "i32.add" },

            // value = data[i] — low byte kept by i32.store8
            { op: "local.get", index: DATA },
            { op: "local.get", index: I },
            { op: elemKind === "i8" ? "array.get_u" : "array.get", typeIdx: arrTypeIdx },
            ...(elemKind === "f64" ? ([{ op: "i32.trunc_sat_f64_s" }] satisfies Instr[]) : []),

            { op: "i32.store8", align: 0, offset: 0 },

            // i++
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },

            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // #2524 — write the staged scratch region (fd_write inline, or node-process shim)
    ...emitWasiWriteTail(ctx, fd, WASI_WRITE_SCRATCH_START, LEN),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [
      { name: "len", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "needPages", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #1655: Ensure __wasi_write_arraybuffer(buf: ref __vec_i32_byte) -> void
 * exists and return its function index (lazy).
 *
 * Companion to `ensureWasiWriteUint8ArrayHelper` for the ArrayBuffer-backing
 * representation. Under `--target wasi` / `--target standalone`, an
 * `ArrayBuffer` is lowered to a vec struct of packed `i8` bytes (one byte per
 * element, values 0..255 — (#2835), see dataview-native.ts comment block)
 * rather than the Uint8Array f64-element shape. The element read is therefore a
 * packed `array.get_u` (no `i32.trunc_sat_f64_s`).
 */
export function ensureWasiWriteArrayBufferHelper(
  ctx: CodegenContext,
  vecTypeIdx: number,
  useStderr: boolean = false,
): number {
  const helperName = useStderr ? "__wasi_write_arraybuffer_stderr" : "__wasi_write_arraybuffer";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // #2524 — node-process shim path needs no fd_write idx (see Uint8Array helper).
  if (!ctx.wasi || (!ctx.linkNodeShims && ctx.wasiFdWriteIdx === undefined)) return -1;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return -1;

  const fd = useStderr ? 2 : 1;

  // param: buf(0); locals: len(1), data(2), i(3), needPages(4)
  const BUF = 0;
  const LEN = 1;
  const DATA = 2;
  const I = 3;
  const NEED_PAGES = 4;

  // #2807 — pre-create the chunked-write helper before reserving this funcidx
  // (see note in ensureWasiWriteAnyStringHelper).
  ensureWasiFdWriteAllHelper(ctx);

  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: vecTypeIdx }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    // len = buf.length (field 0)
    { op: "local.get", index: BUF },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: LEN },

    // #389/#1723: grow linear memory if the staging buffer would overflow the
    // current memory size (only 3 pages reserved by default). A ~1 MiB
    // ArrayBuffer write to stdout otherwise traps "memory access out of bounds".
    // Mirrors the string-write helper's #1723 guard.
    //   neededPages = (WASI_WRITE_SCRATCH_START + len + 65535) >> 16
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
    { op: "local.get", index: LEN },
    { op: "i32.add" },
    { op: "i32.const", value: 65535 },
    { op: "i32.add" },
    { op: "i32.const", value: 16 },
    { op: "i32.shr_u" },
    { op: "local.set", index: NEED_PAGES },
    { op: "local.get", index: NEED_PAGES },
    { op: "memory.size" },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: NEED_PAGES },
        { op: "memory.size" },
        { op: "i32.sub" },
        { op: "memory.grow" },
        { op: "drop" },
      ],
    },

    // data = buf.data (field 1)
    { op: "local.get", index: BUF },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: DATA },

    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },

    // while (i < len) mem[SCRATCH+i] = (u8) data[i]; i++
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // address = SCRATCH_START + i
            { op: "i32.const", value: WASI_WRITE_SCRATCH_START },
            { op: "local.get", index: I },
            { op: "i32.add" },

            // value = data[i] ((#2835) packed i8 byte → unsigned read; low byte
            // kept by i32.store8)
            { op: "local.get", index: DATA },
            { op: "local.get", index: I },
            { op: "array.get_u", typeIdx: arrTypeIdx },

            { op: "i32.store8", align: 0, offset: 0 },

            // i++
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },

            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // #2524 — write the staged scratch region (fd_write inline, or node-process shim)
    ...emitWasiWriteTail(ctx, fd, WASI_WRITE_SCRATCH_START, LEN),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [
      { name: "len", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "needPages", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/** Build the shared path_open prefix and leave the opened fd in `openedFdLocal`. */
function buildWasiPathOpen(ctx: CodegenContext, pathPtr: Instr[], pathLen: Instr[], openedFdLocal: number): Instr[] {
  return [
    { op: "i32.const", value: 3 }, // dirfd = first preopen
    { op: "i32.const", value: 0 }, // dirflags
    ...pathPtr,
    ...pathLen,
    { op: "i32.const", value: 9 }, // O_CREAT | O_TRUNC
    { op: "i64.const", value: 64n }, // RIGHT_FD_WRITE
    { op: "i64.const", value: 0n }, // rights_inheriting
    { op: "i32.const", value: 0 }, // fdflags
    { op: "i32.const", value: 12 }, // fd_out
    { op: "call", funcIdx: ctx.wasiPathOpenIdx },
    { op: "drop" },
    { op: "i32.const", value: 12 },
    { op: "i32.load", align: 2, offset: 0 },
    { op: "local.set", index: openedFdLocal },
  ];
}

/** Build the shared fd_write + fd_close tail for an already-opened file. */
function buildWasiWriteAndClose(
  ctx: CodegenContext,
  dataPtr: Instr[],
  dataLen: Instr[],
  openedFdLocal: number,
): Instr[] {
  return [
    { op: "i32.const", value: 0 },
    ...dataPtr,
    { op: "i32.store", align: 2, offset: 0 },
    { op: "i32.const", value: 4 },
    ...dataLen,
    { op: "i32.store", align: 2, offset: 0 },
    { op: "local.get", index: openedFdLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: 8 },
    { op: "call", funcIdx: ctx.wasiFdWriteIdx },
    { op: "drop" },
    { op: "local.get", index: openedFdLocal },
    { op: "call", funcIdx: ctx.wasiFdCloseIdx },
    { op: "drop" },
  ];
}

/**
 * Emit __wasi_write_file_sync(pathPtr: i32, pathLen: i32, dataPtr: i32, dataLen: i32) helper.
 * Opens a file via path_open, writes data via fd_write, then closes via fd_close.
 *
 * WASI path_open signature:
 *   path_open(dirfd, dirflags, path, path_len, oflags, rights_base, rights_inheriting, fdflags, fd_out) -> errno
 *
 * Memory layout (scratch area 0-1023):
 *   [0..3]   = iovec.buf (ptr to data)
 *   [4..7]   = iovec.buf_len
 *   [8..11]  = nwritten (output from fd_write)
 *   [12..15] = opened fd (output from path_open)
 */
function emitWasiWriteFileSyncHelper(ctx: CodegenContext): void {
  // params: pathPtr(0), pathLen(1), dataPtr(2), dataLen(3)
  // locals: openedFd(4)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_file_sync", funcIdx);

  const body: Instr[] = [
    ...buildWasiPathOpen(ctx, [{ op: "local.get", index: 0 }], [{ op: "local.get", index: 1 }], 4),
    ...buildWasiWriteAndClose(ctx, [{ op: "local.get", index: 2 }], [{ op: "local.get", index: 3 }], 4),
  ];

  ctx.mod.functions.push({
    name: "__wasi_write_file_sync",
    typeIdx: funcTypeIdx,
    locals: [{ name: "openedFd", type: { kind: "i32" } }],
    body,
    exported: false,
  });
}

/**
 * #1484 — Emit __wasi_sleep_ms(ms: i32) helper.
 *
 * Builds a single CLOCK subscription in the scratch zone and calls poll_oneoff
 * to block for `ms` milliseconds. Synchronous; blocks the wasm thread. Matches
 * wasmtime's single-threaded execution model.
 *
 * Scratch layout (offsets inside the reserved 0..1023 bump zone):
 *   [64..111] = subscription_t (48 bytes)
 *     [64..71]   userdata (u64)            = 0
 *     [72]       tag                       = 0  (EVENTTYPE_CLOCK)
 *     [73..79]   pad                       = 0
 *     [80..83]   clockid                   = 1  (CLOCK_MONOTONIC)
 *     [84..87]   pad to 8-byte align       = 0
 *     [88..95]   timeout (u64 ns)          = ms * 1_000_000
 *     [96..103]  precision (u64)           = 0
 *     [104..105] flags (u16)               = 0  (relative)
 *     [106..111] pad
 *   [112..143] = event_t out buffer (32 bytes; per-spec)
 *   [144..147] = nevents out (u32)
 */
function emitWasiSleepMsHelper(ctx: CodegenContext): void {
  if (ctx.wasiPollOneoffIdx === undefined || ctx.wasiPollOneoffIdx < 0) {
    return; // safety: only emit when poll_oneoff is registered
  }
  const SUB_OFFSET = 64;
  const EVT_OFFSET = 112;
  const NEVENTS_OFFSET = 144;

  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_sleep_ms", funcIdx);

  // Param 0 = ms (i32)
  // Local 1 = timeout_ns (i64) computed once
  const body: Instr[] = [
    // userdata @ 64 = 0 (i64)
    { op: "i32.const", value: SUB_OFFSET },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // tag @ 72 = 0 (i8 EVENTTYPE_CLOCK) — store 0 over 8 bytes covers tag + pad
    { op: "i32.const", value: SUB_OFFSET + 8 },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // clockid @ 80 = 1 (CLOCK_MONOTONIC), pad @ 84 = 0 — combined as i64
    { op: "i32.const", value: SUB_OFFSET + 16 },
    { op: "i64.const", value: 1n },
    { op: "i64.store", align: 3, offset: 0 },

    // timeout @ 88 = (i64) ms * 1_000_000
    { op: "i32.const", value: SUB_OFFSET + 24 },
    { op: "local.get", index: 0 },
    { op: "i64.extend_i32_u" },
    { op: "i64.const", value: 1000000n },
    { op: "i64.mul" },
    { op: "i64.store", align: 3, offset: 0 },

    // precision @ 96 = 0
    { op: "i32.const", value: SUB_OFFSET + 32 },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // flags @ 104 = 0 (u16, relative), plus pad — clear 8 bytes
    { op: "i32.const", value: SUB_OFFSET + 40 },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // poll_oneoff(in=64, out=112, nsubs=1, nevents_out=144) — errno dropped
    { op: "i32.const", value: SUB_OFFSET },
    { op: "i32.const", value: EVT_OFFSET },
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: NEVENTS_OFFSET },
    { op: "call", funcIdx: ctx.wasiPollOneoffIdx },
    { op: "drop" },
  ];

  ctx.mod.functions.push({
    name: "__wasi_sleep_ms",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });
}
