// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncTypeDef, GlobalDef, Instr, ValType, WasmModule } from "../ir/types.js";
import { hashProbeAdvanceInstrs } from "./emit-idioms.js";

/** Heap starts at byte offset 1024 (leave low addresses for null/sentinel) */
const HEAP_START = 1024;

/** Wasm page size in bytes (64 KiB) — the unit `memory.grow` operates on. */
const WASM_PAGE_SIZE = 65536;

/**
 * Options for the linear-memory bump/arena allocator (#1856).
 *
 * The linear backend owns allocation. Its allocator is a **bump/arena**:
 * each `__malloc` advances a single heap pointer and **nothing is ever
 * freed** — reclamation happens implicitly when the Wasm instance is
 * dropped (process exit, for standalone/WASI CLI-style programs). This is
 * the smallest-binary, fastest path and is exactly the "allocate-and-exit"
 * mode recommended in R10 of `docs/architecture/compiler-design-lessons.md`.
 *
 * There is intentionally **no pluggable GC abstraction** (see ADR-0017):
 * supporting tracing and reference-counting as swappable strategies is a
 * documented trap. When reclamation is genuinely needed it will be a single
 * fixed strategy added later; the bump arena is the default and only mode
 * today.
 */
export interface ArenaOptions {
  /**
   * Emit the explicit arena-management exports `__arena_reset` and
   * `__arena_used` (#1856). A host/embedder that reuses one instance across
   * many short-lived tasks can call `__arena_reset()` to reclaim the whole
   * arena in O(1) between tasks (it rewinds the bump pointer to
   * `HEAP_START`). Off by default — most programs allocate and exit, so the
   * exports are dead weight and are omitted to keep the binary minimal.
   */
  exposeArenaReset?: boolean;
}

/**
 * Add linear-memory runtime functions to the module.
 * - memory starts at 1 page (64 KiB) and grows on demand up to 256 pages
 * - `__heap_ptr` global (mutable i32, starts at `HEAP_START`)
 * - `__malloc(size: i32) → i32`: bump allocator, 8-byte aligned, grows
 *   memory automatically when the request would overflow the current pages
 *   (#1856 — previously it silently advanced the pointer past the addressable
 *   region, corrupting memory for programs larger than one page)
 * - optionally (`exposeArenaReset`) `__arena_reset()` / `__arena_used() → i32`
 *
 * This is the bump/arena "allocate-and-never-free" allocator — the single
 * fixed strategy for the linear backend. See {@link ArenaOptions} and
 * ADR-0017.
 */
export function addRuntime(mod: WasmModule, opts: ArenaOptions = {}): void {
  // Add memory (1 page = 64 KiB, growable to 256 pages = 16 MiB)
  if (mod.memories.length === 0) {
    mod.memories.push({ min: 1, max: 256 });
    // Export memory so tests can inspect it
    mod.exports.push({
      name: "memory",
      desc: { kind: "memory", index: 0 },
    });
  }

  // Add __heap_ptr global
  const heapPtrGlobalIdx = mod.globals.length;
  const heapPtrGlobal: GlobalDef = {
    name: "__heap_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: HEAP_START }],
  };
  mod.globals.push(heapPtrGlobal);

  // Register __malloc function type
  const mallocTypeIdx = mod.types.length;
  const mallocType: FuncTypeDef = {
    kind: "func",
    name: "$type___malloc",
    params: [{ kind: "i32" }], // size
    results: [{ kind: "i32" }], // pointer
  };
  mod.types.push(mallocType);

  // __malloc implementation (bump allocator with on-demand memory growth):
  // 1. ret  = __heap_ptr (the address handed back to the caller)
  // 2. next = align8(ret + size)            ; new bump position
  // 3. if next > (memory.size * PAGE_SIZE)   ; would overflow current pages?
  //       grow memory by ceil((next - cur_bytes) / PAGE_SIZE) pages
  // 4. __heap_ptr = next
  // 5. return ret
  //
  // The growth check is what makes the arena usable for non-trivial
  // short-lived programs (#1856). `memory.grow` returns -1 on failure; we do
  // not branch on that here — a -1 means the engine's max was hit, and the
  // subsequent store traps cleanly rather than corrupting live data.
  const local_ret = 1; // local 0 is the `size` param
  const local_next = 2;
  const mallocBody: Instr[] = [
    // ret = __heap_ptr
    { op: "global.get", index: heapPtrGlobalIdx },
    { op: "local.set", index: local_ret },
    // next = align8(ret + size) = (ret + size + 7) & ~7
    { op: "local.get", index: local_ret },
    { op: "local.get", index: 0 }, // size
    { op: "i32.add" },
    { op: "i32.const", value: 7 },
    { op: "i32.add" },
    { op: "i32.const", value: -8 }, // ~7 = 0xFFFFFFF8
    { op: "i32.and" },
    { op: "local.set", index: local_next },
    // if (next > memory.size * PAGE_SIZE) grow
    { op: "local.get", index: local_next },
    { op: "memory.size" },
    { op: "i32.const", value: WASM_PAGE_SIZE },
    { op: "i32.mul" },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // pages_needed = ceil((next - cur_bytes) / PAGE_SIZE)
        //              = (next - cur_bytes + PAGE_SIZE - 1) / PAGE_SIZE
        { op: "local.get", index: local_next },
        { op: "memory.size" },
        { op: "i32.const", value: WASM_PAGE_SIZE },
        { op: "i32.mul" },
        { op: "i32.sub" },
        { op: "i32.const", value: WASM_PAGE_SIZE - 1 },
        { op: "i32.add" },
        { op: "i32.const", value: WASM_PAGE_SIZE },
        { op: "i32.div_u" },
        { op: "memory.grow" },
        // discard memory.grow's result (prev page count, or -1 on failure)
        { op: "drop" },
      ],
      else: [],
    },
    // __heap_ptr = next
    { op: "local.get", index: local_next },
    { op: "global.set", index: heapPtrGlobalIdx },
    // return ret
    { op: "local.get", index: local_ret },
  ];

  const mallocFuncIdx = mod.functions.length;
  mod.functions.push({
    name: "__malloc",
    typeIdx: mallocTypeIdx,
    locals: [
      { name: "__malloc_ret", type: { kind: "i32" } },
      { name: "__malloc_next", type: { kind: "i32" } },
    ],
    body: mallocBody,
    exported: false,
  });

  // Note: __malloc is NOT exported; it's internal. Register in a way
  // that codegen can find it. The function index will be:
  // numImportFuncs + mallocFuncIdx (but since we add early, it's just mallocFuncIdx for now)
  void mallocFuncIdx;

  if (opts.exposeArenaReset) {
    addArenaManagementExports(mod, heapPtrGlobalIdx);
  }
}

/**
 * Emit the explicit arena-management exports (#1856):
 * - `__arena_reset()`     — rewind the bump pointer to `HEAP_START`, freeing
 *                           the entire arena in O(1). Lets a host reuse one
 *                           instance across many short-lived tasks.
 * - `__arena_used() → i32` — bytes currently allocated (`__heap_ptr - HEAP_START`),
 *                           for diagnostics / high-water-mark tracking.
 *
 * These are off by default (see {@link ArenaOptions.exposeArenaReset}) so the
 * "allocate-and-exit" common case pays nothing for them.
 */
function addArenaManagementExports(mod: WasmModule, heapPtrGlobalIdx: number): void {
  // __arena_reset() -> void
  const resetTypeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: "$type___arena_reset",
    params: [],
    results: [],
  });
  const resetFuncIdx = mod.functions.length;
  mod.functions.push({
    name: "__arena_reset",
    typeIdx: resetTypeIdx,
    locals: [],
    body: [
      { op: "i32.const", value: HEAP_START },
      { op: "global.set", index: heapPtrGlobalIdx },
    ],
    exported: false,
  });

  // __arena_used() -> i32
  const usedTypeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: "$type___arena_used",
    params: [],
    results: [{ kind: "i32" }],
  });
  const usedFuncIdx = mod.functions.length;
  mod.functions.push({
    name: "__arena_used",
    typeIdx: usedTypeIdx,
    locals: [],
    body: [{ op: "global.get", index: heapPtrGlobalIdx }, { op: "i32.const", value: HEAP_START }, { op: "i32.sub" }],
    exported: false,
  });

  const numImports = mod.imports.filter((i) => i.desc.kind === "func").length;
  mod.exports.push({
    name: "__arena_reset",
    desc: { kind: "func", index: numImports + resetFuncIdx },
  });
  mod.exports.push({
    name: "__arena_used",
    desc: { kind: "func", index: numImports + usedFuncIdx },
  });
}

/**
 * Add Uint8Array runtime functions to the module.
 * Layout: [header 8B][len:u32 at +8][bytes at +12...]
 *
 * Functions added:
 * - __u8arr_new(len: i32) → i32 (pointer)
 * - __u8arr_get(ptr: i32, idx: i32) → i32
 * - __u8arr_set(ptr: i32, idx: i32, val: i32) → void
 * - __u8arr_len(ptr: i32) → i32
 */
export function addUint8ArrayRuntime(mod: WasmModule): void {
  ensureArrayResolveRuntime(mod); // __u8arr_from_arr resolves forwarded arrays (#1977)
  const mallocIdx = findFuncIndex(mod, "__malloc");

  // __u8arr_new: allocate header(8) + len(4) + bytes(len)
  // Tag byte at offset 0: 0x02 = Uint8Array
  // extra locals: local 1 = ptr (result)
  addRuntimeFunc(
    mod,
    "__u8arr_new",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (local1Idx) => [
      // Allocate: 12 + len bytes
      { op: "i32.const", value: 12 },
      { op: "local.get", index: 0 }, // len
      { op: "i32.add" },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: local1Idx },
      // Store tag byte 0x02 (Uint8Array) at ptr+0
      { op: "local.get", index: local1Idx },
      { op: "i32.const", value: 0x02 },
      { op: "i32.store8", align: 0, offset: 0 },
      // Store len at ptr+8
      { op: "local.get", index: local1Idx },
      { op: "local.get", index: 0 }, // len
      { op: "i32.store", align: 2, offset: 8 },
      // Return ptr
      { op: "local.get", index: local1Idx },
    ],
    1,
  );

  // __u8arr_get: load byte at ptr + 12 + idx
  addRuntimeFunc(mod, "__u8arr_get", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: 1 }, // idx
    { op: "i32.add" },
    { op: "i32.load8_u", align: 0, offset: 12 },
  ]);

  // __u8arr_set: store byte at ptr + 12 + idx
  addRuntimeFunc(mod, "__u8arr_set", [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: 1 }, // idx
    { op: "i32.add" },
    { op: "local.get", index: 2 }, // val
    { op: "i32.store8", align: 0, offset: 12 },
  ]);

  // __u8arr_len: load i32 at ptr+8
  addRuntimeFunc(mod, "__u8arr_len", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "i32.load", align: 2, offset: 8 },
  ]);

  // __u8arr_from_raw(rawPtr, len): create a Uint8Array by copying len bytes from rawPtr.
  // This is used for `new Uint8Array(arrayBuffer)` patterns.
  // extra locals: local2 = newPtr, local3 = i
  addRuntimeFunc(
    mod,
    "__u8arr_from_raw",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const newPtrLocal = firstLocalIdx;
      const iLocal = firstLocalIdx + 1;
      return [
        // newPtr = __u8arr_new(len)
        { op: "local.get", index: 1 }, // len
        { op: "call", funcIdx: findFuncIndex(mod, "__u8arr_new") },
        { op: "local.set", index: newPtrLocal },
        // Copy loop
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: 1 }, // len
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // newPtr[12+i] = rawPtr[i]
                { op: "local.get", index: newPtrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "local.get", index: 0 }, // rawPtr
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 0 },
                { op: "i32.store8", align: 0, offset: 12 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: newPtrLocal },
      ];
    },
    2,
  );

  // __u8arr_slice(ptr, start, end) → new_ptr
  // Creates a new Uint8Array from [start, end) of the source.
  // Extra locals: local3 = newLen, local4 = newPtr, local5 = i (loop counter)
  const u8NewIdx = findFuncIndex(mod, "__u8arr_new");
  addRuntimeFunc(
    mod,
    "__u8arr_slice",
    [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (local3Idx) => [
      // newLen = end - start
      { op: "local.get", index: 2 }, // end
      { op: "local.get", index: 1 }, // start
      { op: "i32.sub" },
      { op: "local.set", index: local3Idx }, // local3 = newLen
      // newPtr = __u8arr_new(newLen)
      { op: "local.get", index: local3Idx },
      { op: "call", funcIdx: u8NewIdx },
      { op: "local.set", index: local3Idx + 1 }, // local4 = newPtr
      // Copy loop: i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: local3Idx + 2 }, // local5 = 0
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if (i >= newLen) break
              { op: "local.get", index: local3Idx + 2 }, // i
              { op: "local.get", index: local3Idx }, // newLen
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // newPtr[12 + i] = src[12 + start + i]
              { op: "local.get", index: local3Idx + 1 }, // newPtr
              { op: "local.get", index: local3Idx + 2 }, // i
              { op: "i32.add" },
              // load src byte
              { op: "local.get", index: 0 }, // src ptr
              { op: "local.get", index: 1 }, // start
              { op: "i32.add" },
              { op: "local.get", index: local3Idx + 2 }, // i
              { op: "i32.add" },
              { op: "i32.load8_u", align: 0, offset: 12 },
              // store into newPtr
              { op: "i32.store8", align: 0, offset: 12 },
              // i++
              { op: "local.get", index: local3Idx + 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: local3Idx + 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Return newPtr
      { op: "local.get", index: local3Idx + 1 },
    ],
    3,
  ); // 3 extra locals: newLen, newPtr, i

  // __u8arr_from_arr(arrPtr: i32) → i32
  // Creates a Uint8Array from a number[] array.
  // Array layout: [header 8B][len:u32 +8][cap:u32 +12][elements: 8B(f64)×cap +16...]
  // Each source element is an f64 slot (#1938); truncate to a byte on copy.
  // Extra locals: local1 = len, local2 = newPtr, local3 = i
  addRuntimeFunc(
    mod,
    "__u8arr_from_arr",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (local1Idx) => {
      const lenLocal = local1Idx;
      const newPtrLocal = local1Idx + 1;
      const iLocal = local1Idx + 2;
      return [
        // arrPtr = __arr_resolve(arrPtr) — the source array may have been
        // relocated by a growing push (#1977)
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: findFuncIndex(mod, "__arr_resolve") },
        { op: "local.set", index: 0 },
        // len = arrPtr.len (at +8)
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: lenLocal },
        // newPtr = __u8arr_new(len)
        { op: "local.get", index: lenLocal },
        { op: "call", funcIdx: findFuncIndex(mod, "__u8arr_new") },
        { op: "local.set", index: newPtrLocal },
        // i = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        // Copy loop
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: lenLocal },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // newPtr[12+i] = (u8) arrPtr[16 + i*8]  (f64 slot → byte)
                { op: "local.get", index: newPtrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                // Load f64 element from array: arrPtr + 16 + i*8
                { op: "local.get", index: 0 }, // arrPtr
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "f64.load", align: 3, offset: 16 },
                // Truncate f64 → i32, store low byte
                { op: "i32.trunc_f64_s" },
                { op: "i32.store8", align: 0, offset: 12 },
                // i++
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: newPtrLocal },
      ];
    },
    3,
  );
}

/** Tag byte marking a relocated (grown) array header — see addArrayResolveRuntime (#1977). */
const ARR_FORWARDED_TAG = 0x06;

/**
 * Register the array forwarding resolver (#1977) — idempotent; called by
 * every runtime builder whose functions touch array memory
 * (addUint8ArrayRuntime's __u8arr_from_arr, addArrayRuntime).
 *
 * When __arr_push outgrows capacity it relocates the array to a fresh
 * allocation and rewrites the OLD header into a forwarding record:
 * tag ARR_FORWARDED_TAG at +0, the new pointer at +4. Aliased locals/fields
 * still hold the old pointer, so every accessor first chases the forwarding
 * chain: while (tag == ARR_FORWARDED_TAG) ptr = *(ptr+4).
 */
function ensureArrayResolveRuntime(mod: WasmModule): void {
  if (mod.functions.some((f) => f.name === "__arr_resolve")) return;
  addRuntimeFunc(mod, "__arr_resolve", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if tag != ARR_FORWARDED_TAG, break
            { op: "local.get", index: 0 },
            { op: "i32.load8_u", align: 0, offset: 0 },
            { op: "i32.const", value: ARR_FORWARDED_TAG },
            { op: "i32.ne" },
            { op: "br_if", depth: 1 },
            // ptr = *(ptr+4)
            { op: "local.get", index: 0 },
            { op: "i32.load", align: 2, offset: 4 },
            { op: "local.set", index: 0 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 0 },
  ]);
}

/**
 * Add Array runtime functions to the module.
 * Layout: [header 8B][len:u32 at +8][cap:u32 at +12][elements: 8B×cap at +16...]
 *
 * #1938: element slots are 8 bytes (stride 8), holding a raw bit pattern the
 * runtime never interprets. The runtime element boundary is typed **f64**:
 * a numeric element flows in/out as its IEEE-754 f64 value (zero conversions),
 * while a reference/boolean i32 is shuffled into the low 4 bytes of the slot by
 * codegen (`i64.extend_i32_u` → `f64.reinterpret_i64` on store, inverse on
 * load). Storing f64 slots fixes `[1.5][0]` → 1.5 (was truncated to i32).
 *
 * Functions added:
 * - __arr_new(cap: i32) → i32 (pointer)
 * - __arr_grow(ptr: i32, minCap: i32) → i32 (relocated pointer; forwards old header)
 * - __arr_push(ptr: i32, val: f64) → void
 * - __arr_get(ptr: i32, idx: i32) → f64
 * - __arr_set(ptr: i32, idx: i32, val: f64) → void
 * - __arr_len(ptr: i32) → i32
 * - __arr_from_data(dataPtr: i32, len: i32) → i32 (header ptr)
 */
export function addArrayRuntime(mod: WasmModule): void {
  ensureArrayResolveRuntime(mod); // accessors below resolve forwarded arrays (#1977)
  const mallocIdx = findFuncIndex(mod, "__malloc");

  // __arr_new: allocate header(8) + len(4) + cap(4) + elements(cap*8)
  // Tag byte at offset 0: 0x01 = Array
  // extra locals: local 1 = ptr
  addRuntimeFunc(
    mod,
    "__arr_new",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (local1Idx) => [
      // Allocate: 16 + cap*8
      { op: "i32.const", value: 16 },
      { op: "local.get", index: 0 }, // cap
      { op: "i32.const", value: 8 },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: local1Idx },
      // Store tag byte 0x01 (Array) at ptr+0
      { op: "local.get", index: local1Idx },
      { op: "i32.const", value: 0x01 },
      { op: "i32.store8", align: 0, offset: 0 },
      // Store len=0 at ptr+8
      { op: "local.get", index: local1Idx },
      { op: "i32.const", value: 0 },
      { op: "i32.store", align: 2, offset: 8 },
      // Store cap at ptr+12
      { op: "local.get", index: local1Idx },
      { op: "local.get", index: 0 }, // cap
      { op: "i32.store", align: 2, offset: 12 },
      // Return ptr
      { op: "local.get", index: local1Idx },
    ],
    1,
  );

  const arrResolveIdx = findFuncIndex(mod, "__arr_resolve");

  // __arr_grow(ptr, minCap) → newPtr (#1977)
  // Relocate the array to a fresh allocation with cap = max(cap*2, minCap, 4),
  // copy len elements, and rewrite the old header into a forwarding record
  // (tag ARR_FORWARDED_TAG at +0, newPtr at +4) so stale aliases resolve.
  // Caller must pass an already-resolved ptr.
  addRuntimeFunc(
    mod,
    "__arr_grow",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const lenLocal = firstLocalIdx;
      const newCapLocal = firstLocalIdx + 1;
      const newPtrLocal = firstLocalIdx + 2;
      const iLocal = firstLocalIdx + 3;
      return [
        // len = *(ptr+8)
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: lenLocal },
        // newCap = *(ptr+12) * 2
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "i32.const", value: 2 },
        { op: "i32.mul" },
        { op: "local.set", index: newCapLocal },
        // if newCap < minCap: newCap = minCap
        { op: "local.get", index: newCapLocal },
        { op: "local.get", index: 1 },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "local.set", index: newCapLocal },
          ],
          else: [],
        },
        // if newCap < 4: newCap = 4
        { op: "local.get", index: newCapLocal },
        { op: "i32.const", value: 4 },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 4 },
            { op: "local.set", index: newCapLocal },
          ],
          else: [],
        },
        // newPtr = __malloc(16 + newCap*8)
        { op: "i32.const", value: 16 },
        { op: "local.get", index: newCapLocal },
        { op: "i32.const", value: 8 },
        { op: "i32.mul" },
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: newPtrLocal },
        // Header: tag 0x01 (Array), len, newCap
        { op: "local.get", index: newPtrLocal },
        { op: "i32.const", value: 0x01 },
        { op: "i32.store8", align: 0, offset: 0 },
        { op: "local.get", index: newPtrLocal },
        { op: "local.get", index: lenLocal },
        { op: "i32.store", align: 2, offset: 8 },
        { op: "local.get", index: newPtrLocal },
        { op: "local.get", index: newCapLocal },
        { op: "i32.store", align: 2, offset: 12 },
        // Copy elements: for (i = 0; i < len; i++) newPtr[i] = ptr[i]
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: lenLocal },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // newPtr[i] = ptr[i] (raw 8-byte slot copy; bits opaque)
                { op: "local.get", index: newPtrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.get", index: 0 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "f64.load", align: 3, offset: 16 },
                { op: "f64.store", align: 3, offset: 16 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // Forward the old header: tag ARR_FORWARDED_TAG, newPtr at +4
        { op: "local.get", index: 0 },
        { op: "i32.const", value: ARR_FORWARDED_TAG },
        { op: "i32.store8", align: 0, offset: 0 },
        { op: "local.get", index: 0 },
        { op: "local.get", index: newPtrLocal },
        { op: "i32.store", align: 2, offset: 4 },
        // Return newPtr
        { op: "local.get", index: newPtrLocal },
      ];
    },
    4,
  );

  const arrGrowIdx = findFuncIndex(mod, "__arr_grow");

  // __arr_push: store val (f64 slot) at ptr+16+len*8, increment len.
  // Resolves forwarding and grows when len == cap (#1977 — was an unbounded
  // write into the bump arena that corrupted adjacent allocations).
  addRuntimeFunc(
    mod,
    "__arr_push",
    [{ kind: "i32" }, { kind: "f64" }],
    [],
    [],
    (local2Idx) => [
      // ptr = __arr_resolve(ptr)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: arrResolveIdx },
      { op: "local.set", index: 0 },
      // Load current len
      { op: "local.get", index: 0 }, // ptr
      { op: "i32.load", align: 2, offset: 8 },
      { op: "local.set", index: local2Idx },
      // if len >= cap: ptr = __arr_grow(ptr, len+1)
      { op: "local.get", index: local2Idx },
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 12 },
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: local2Idx },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "call", funcIdx: arrGrowIdx },
          { op: "local.set", index: 0 },
        ],
        else: [],
      },
      // Store val at ptr + 16 + len*8 (f64 slot)
      { op: "local.get", index: 0 }, // ptr
      { op: "local.get", index: local2Idx }, // len
      { op: "i32.const", value: 8 },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "local.get", index: 1 }, // val (f64)
      { op: "f64.store", align: 3, offset: 16 },
      // Increment len: store len+1 at ptr+8
      { op: "local.get", index: 0 }, // ptr
      { op: "local.get", index: local2Idx }, // len
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.store", align: 2, offset: 8 },
    ],
    1,
  );

  // __arr_get: load f64 slot at ptr + 16 + idx*8.
  // Resolves forwarding; OOB (idx >= len, unsigned — covers negative idx)
  // returns 0.0, the backend's undefined representation (#1977 — was a raw
  // load of neighbouring memory). Slot bits are opaque to the runtime (#1938).
  addRuntimeFunc(mod, "__arr_get", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "f64" }], [], () => [
    // ptr = __arr_resolve(ptr)
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: arrResolveIdx },
    { op: "local.set", index: 0 },
    // if idx >= len (unsigned): return 0.0 (undefined)
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: 0 }, { op: "return" }],
      else: [],
    },
    { op: "local.get", index: 0 }, // ptr
    { op: "local.get", index: 1 }, // idx
    { op: "i32.const", value: 8 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "f64.load", align: 3, offset: 16 },
  ]);

  // __arr_set: store f64 slot at ptr + 16 + idx*8.
  // Resolves forwarding; grows when idx >= cap; extends len (zero-filling
  // the gap) when idx >= len, per JS store-beyond-length semantics (#1977).
  // A negative idx is a JS non-index property write — dropped (no-op) rather
  // than corrupting header/neighbour memory. Slot bits are opaque (#1938).
  addRuntimeFunc(
    mod,
    "__arr_set",
    [{ kind: "i32" }, { kind: "i32" }, { kind: "f64" }],
    [],
    [],
    (firstLocalIdx) => {
      const fillLocal = firstLocalIdx;
      return [
        // if idx < 0 (signed): no-op
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "return" }],
          else: [],
        },
        // ptr = __arr_resolve(ptr)
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: arrResolveIdx },
        { op: "local.set", index: 0 },
        // if idx >= cap: ptr = __arr_grow(ptr, idx+1)
        { op: "local.get", index: 1 },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "i32.ge_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "call", funcIdx: arrGrowIdx },
            { op: "local.set", index: 0 },
          ],
          else: [],
        },
        // Zero-fill the gap: for (fill = len; fill < idx; fill++) ptr[fill] = 0
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: fillLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: fillLocal },
                { op: "local.get", index: 1 },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: 0 },
                { op: "local.get", index: fillLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "f64.const", value: 0 },
                { op: "f64.store", align: 3, offset: 16 },
                { op: "local.get", index: fillLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: fillLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // if idx >= len: len = idx + 1
        { op: "local.get", index: 1 },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "i32.ge_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "i32.store", align: 2, offset: 8 },
          ],
          else: [],
        },
        // Store val (f64 slot)
        { op: "local.get", index: 0 }, // ptr
        { op: "local.get", index: 1 }, // idx
        { op: "i32.const", value: 8 },
        { op: "i32.mul" },
        { op: "i32.add" },
        { op: "local.get", index: 2 }, // val (f64)
        { op: "f64.store", align: 3, offset: 16 },
      ];
    },
    1,
  );

  // __arr_len: load i32 at ptr+8 (resolving forwarding, #1977)
  addRuntimeFunc(mod, "__arr_len", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 }, // ptr
    { op: "call", funcIdx: arrResolveIdx },
    { op: "i32.load", align: 2, offset: 8 },
  ]);

  // __arr_from_data(dataPtr: i32, len: i32) → i32 (array header ptr)
  // Build an internal array object from a raw, contiguous block of `len`
  // i32 elements at `dataPtr`. Used by the C ABI wrapper to rehydrate an
  // array parameter passed as a (ptr, len) pair (#1835).
  // Layout written: [header 8B][len:u32 @ +8][cap:u32 @ +12][elems 8B @ +16...]
  // Each incoming i32 is widened into the low 4 bytes of an 8-byte slot
  // (i64.extend_i32_u → f64.reinterpret_i64), matching the codegen ref/bool
  // slot encoding (#1938). Reference/string/handle array params round-trip;
  // number[] params through the C ABI are a separate slice (the host passes
  // raw doubles, not i32 handles).
  // extra locals: local 2 = ptr (result), local 3 = i (loop counter)
  addRuntimeFunc(
    mod,
    "__arr_from_data",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const ptrLocal = firstLocalIdx;
      const iLocal = firstLocalIdx + 1;
      return [
        // Allocate: 16 + len*8
        { op: "i32.const", value: 16 },
        { op: "local.get", index: 1 }, // len
        { op: "i32.const", value: 8 },
        { op: "i32.mul" },
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocal },
        // Tag byte 0x01 (Array) at ptr+0
        { op: "local.get", index: ptrLocal },
        { op: "i32.const", value: 0x01 },
        { op: "i32.store8", align: 0, offset: 0 },
        // len at ptr+8
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: 1 },
        { op: "i32.store", align: 2, offset: 8 },
        // cap = len at ptr+12
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: 1 },
        { op: "i32.store", align: 2, offset: 12 },
        // Copy elements: for i=0; i<len; i++ { slot[i] = widen(mem[dataPtr+i*4]) }
        // The incoming block is packed i32 (4-byte stride); each i32 is widened
        // into the low 4 bytes of the destination's 8-byte slot (#1938).
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // break if i >= len
                { op: "local.get", index: iLocal },
                { op: "local.get", index: 1 }, // len
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // dest addr = ptr + i*8 (offset 16 applied at store)
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                // value = widen(mem[dataPtr + i*4]) : i32 → f64 slot
                { op: "local.get", index: 0 }, // dataPtr
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 4 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "i32.load", align: 2, offset: 0 },
                { op: "i64.extend_i32_u" },
                { op: "f64.reinterpret_i64" },
                // store at dest+16 (f64 slot)
                { op: "f64.store", align: 3, offset: 16 },
                // i++
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // Return ptr
        { op: "local.get", index: ptrLocal },
      ];
    },
    2,
  ); // 2 extra locals

  // __arr_slice(arr: i32, start: i32, end: i32) → i32 (new array)
  // Creates a new array containing elements [start, end) from arr
  // extra locals: newArr, i, len
  const arrNewIdx = findFuncIndex(mod, "__arr_new");
  const arrGetIdx = findFuncIndex(mod, "__arr_get");
  const arrPushIdx = findFuncIndex(mod, "__arr_push");
  addRuntimeFunc(
    mod,
    "__arr_slice",
    [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const newArrLocal = firstLocalIdx;
      const iLocal2 = firstLocalIdx + 1;
      return [
        // newArr = __arr_new(16)
        { op: "i32.const", value: 16 },
        { op: "call", funcIdx: arrNewIdx },
        { op: "local.set", index: newArrLocal },
        // i = start
        { op: "local.get", index: 1 },
        { op: "local.set", index: iLocal2 },
        // loop: while i < end, push arr[i]
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal2 },
                { op: "local.get", index: 2 },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // __arr_push(newArr, __arr_get(arr, i))
                { op: "local.get", index: newArrLocal },
                { op: "local.get", index: 0 },
                { op: "local.get", index: iLocal2 },
                { op: "call", funcIdx: arrGetIdx },
                { op: "call", funcIdx: arrPushIdx },
                // i++
                { op: "local.get", index: iLocal2 },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal2 },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: newArrLocal },
      ];
    },
    2,
  );
}

/** Runtime helper used only by the flag-gated linear-IR vec constructor. */
export const LINEAR_IR_VEC_INIT_F64_FN = "__linear_ir_vec_init_f64";

/**
 * Add the value-first indexed store needed by `LinearEmitter.emitVecNewFixed`.
 *
 * `lower.ts` leaves fixed-vec elements on the operand stack in source order.
 * The emitter therefore consumes them from last to first; this helper accepts
 * `(value, ptr, index)` so the pointer and index can be pushed after the value
 * without a second element scratch local. The array is freshly allocated and
 * cannot be forwarded, so the store intentionally targets its canonical slot
 * directly.
 */
export function addLinearIrVecRuntime(mod: WasmModule): void {
  if (mod.functions.some((fn) => fn.name === LINEAR_IR_VEC_INIT_F64_FN)) return;
  addRuntimeFunc(mod, LINEAR_IR_VEC_INIT_F64_FN, [{ kind: "f64" }, { kind: "i32" }, { kind: "i32" }], [], [], () => [
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 8 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.get", index: 0 },
    { op: "f64.store", align: 3, offset: 16 },
  ]);
}

export const LINEAR_IR_OBJ_NEW_FN = "__linear_ir_obj_new";
export const LINEAR_IR_OBJ_INIT_F64_FN = "__linear_ir_obj_init_f64";

/**
 * (#2956 L2 aggregates) Allocate a fixed-shape anonymous object:
 * `__linear_ir_obj_new(payloadBytes) -> ptr`. Mirrors the direct path's
 * object-literal allocation (`__malloc(8+payload)`, tag byte 0x10, payload
 * size u32 at +4). Field slots are zeroed by the bump allocator.
 *
 * `__linear_ir_obj_init_f64(value, ptr, byteOffset) -> ptr` is the
 * value-first field initializer for `LinearEmitter.emitAggregateNew`:
 * lower.ts leaves field values on the stack in canonical order, and the
 * helper RETURNS the pointer so the emitter can fold the store loop with
 * zero scratch locals (stack: ..., value, ptr -> push offset -> call ->
 * ..., ptr).
 */
export function addLinearIrObjRuntime(mod: WasmModule): void {
  if (!mod.functions.some((fn) => fn.name === LINEAR_IR_OBJ_NEW_FN)) {
    const mallocIdx = findFuncIndex(mod, "__malloc");
    addRuntimeFunc(mod, LINEAR_IR_OBJ_NEW_FN, [{ kind: "i32" }], [{ kind: "i32" }], [{ kind: "i32" }], (first) => [
      // ptr = __malloc(8 + payloadBytes)
      { op: "i32.const", value: 8 },
      { op: "local.get", index: 0 },
      { op: "i32.add" },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: first },
      // tag byte 0x10 (anonymous object), same as the direct literal path.
      { op: "local.get", index: first },
      { op: "i32.const", value: 0x10 },
      { op: "i32.store8", align: 0, offset: 0 },
      // payload size u32 at +4.
      { op: "local.get", index: first },
      { op: "local.get", index: 0 },
      { op: "i32.store", align: 2, offset: 4 },
      { op: "local.get", index: first },
    ]);
  }
  if (!mod.functions.some((fn) => fn.name === LINEAR_IR_OBJ_INIT_F64_FN)) {
    addRuntimeFunc(
      mod,
      LINEAR_IR_OBJ_INIT_F64_FN,
      [{ kind: "f64" }, { kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      [],
      () => [
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "i32.add" },
        { op: "local.get", index: 0 },
        { op: "f64.store", align: 3, offset: 0 },
        { op: "local.get", index: 1 },
      ],
    );
  }
}

/**
 * Add String runtime functions to the module.
 * Layout: [header 8B][len:u32 at +8][utf8 bytes at +12...]
 *
 * Functions added:
 * - __str_from_data(offset: i32, len: i32) → i32 (pointer)
 * - __str_eq(a: i32, b: i32) → i32 (boolean)
 * - __str_hash(ptr: i32) → i32 (FNV-1a hash)
 * - __str_len(ptr: i32) → i32
 * - __str_concat(a: i32, b: i32) → i32 (new string pointer)
 */
export function addStringRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");

  // __str_from_data: copy `len` bytes from data segment at `offset` into a new string
  // extra locals: local 2 = ptr (result), local 3 = i (loop counter)
  addRuntimeFunc(
    mod,
    "__str_from_data",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const ptrLocal = firstLocalIdx;
      const iLocal = firstLocalIdx + 1;
      return [
        // Allocate: 12 + len
        { op: "i32.const", value: 12 },
        { op: "local.get", index: 1 }, // len
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocal },
        // Store len at ptr+8
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: 1 }, // len
        { op: "i32.store", align: 2, offset: 8 },
        // Copy bytes: for i=0; i<len; i++ { mem[ptr+12+i] = mem[offset+i] }
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // break if i >= len
                { op: "local.get", index: iLocal },
                { op: "local.get", index: 1 }, // len
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // Store byte: mem[ptr+12+i] = mem[offset+i]
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                // Load source byte
                { op: "local.get", index: 0 }, // offset
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 0 },
                // Store at dest
                { op: "i32.store8", align: 0, offset: 12 },
                // i++
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // Return ptr
        { op: "local.get", index: ptrLocal },
      ];
    },
    2,
  ); // 2 extra locals

  // __str_len: load i32 at ptr+8 — the stored UTF-8 **byte** count. This is the
  // internal primitive used by slice/indexOf/concat/eq, which all index by byte
  // offset. It is NOT the JS `.length` (UTF-16 code units) — see
  // __str_length_utf16 below.
  addRuntimeFunc(mod, "__str_len", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);

  // __str_length_utf16: JS `String.prototype.length` = number of UTF-16 code
  // units (#1976). Linear strings are stored as UTF-8 bytes, so walk the leading
  // bytes and count code units: a leading byte 0xxxxxxx/110xxxxx/1110xxxx starts
  // a 1/2/3-byte sequence encoding a BMP code point (1 code unit), while
  // 11110xxx starts a 4-byte sequence for an astral code point (a surrogate
  // pair → 2 code units). ASCII strings count == byte length, matching the old
  // behaviour. Continuation bytes (10xxxxxx) are skipped by advancing past the
  // whole sequence.
  // locals: byteLen(1), i(2 = byte cursor), count(3), b(4 = leading byte)
  addRuntimeFunc(
    mod,
    "__str_length_utf16",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const byteLen = firstLocalIdx;
      const i = firstLocalIdx + 1;
      const count = firstLocalIdx + 2;
      const b = firstLocalIdx + 3;
      return [
        // byteLen = mem[ptr+8]
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: byteLen },
        // i = 0; count = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: i },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: count },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // break if i >= byteLen
                { op: "local.get", index: i },
                { op: "local.get", index: byteLen },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // b = mem[ptr+12+i]
                { op: "local.get", index: 0 },
                { op: "local.get", index: i },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "local.set", index: b },
                // Decide sequence length (advance i) and code units (advance
                // count) by the leading byte's high bits. The `if` condition is
                // taken from the stack, so push it just before each `if`.
                // cond: b < 0x80  (1-byte ASCII)
                { op: "local.get", index: b },
                { op: "i32.const", value: 0x80 },
                { op: "i32.lt_u" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // 1-byte ASCII: i += 1, count += 1
                    { op: "local.get", index: i },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: i },
                    { op: "local.get", index: count },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: count },
                  ],
                  else: [
                    // cond: b < 0xF0  (2- or 3-byte BMP sequence → 1 code unit;
                    // else 4-byte astral sequence → 2 code units / surrogate pair)
                    { op: "local.get", index: b },
                    { op: "i32.const", value: 0xf0 },
                    { op: "i32.lt_u" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        // BMP: count += 1; i += (b < 0xE0 ? 2 : 3)
                        { op: "local.get", index: count },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: count },
                        { op: "local.get", index: i },
                        { op: "local.get", index: b },
                        { op: "i32.const", value: 0xe0 },
                        { op: "i32.lt_u" },
                        {
                          op: "if",
                          blockType: { kind: "val", type: { kind: "i32" } },
                          then: [{ op: "i32.const", value: 2 }],
                          else: [{ op: "i32.const", value: 3 }],
                        },
                        { op: "i32.add" },
                        { op: "local.set", index: i },
                      ],
                      else: [
                        // Astral 4-byte: count += 2; i += 4
                        { op: "local.get", index: count },
                        { op: "i32.const", value: 2 },
                        { op: "i32.add" },
                        { op: "local.set", index: count },
                        { op: "local.get", index: i },
                        { op: "i32.const", value: 4 },
                        { op: "i32.add" },
                        { op: "local.set", index: i },
                      ],
                    },
                  ],
                },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: count },
      ];
    },
    4,
  );

  // __str_eq: compare two strings byte-by-byte
  // extra locals: local 2 = lenA, local 3 = i
  addRuntimeFunc(
    mod,
    "__str_eq",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const lenALocal = firstLocalIdx;
      const iLocal = firstLocalIdx + 1;
      return [
        // Load lenA
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: lenALocal },
        // If lenA != lenB, return 0
        { op: "local.get", index: lenALocal },
        { op: "local.get", index: 1 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        // Compare bytes
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // break if i >= lenA
                { op: "local.get", index: iLocal },
                { op: "local.get", index: lenALocal },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // Compare bytes
                { op: "local.get", index: 0 },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "local.get", index: 1 },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "i32.ne" },
                { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
                // i++
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // All bytes match
        { op: "i32.const", value: 1 },
      ];
    },
    2,
  );

  // __str_cmp: lexicographic comparison → -1 / 0 / 1 (#1976).
  // Compares byte-by-byte up to min(lenA, lenB); the first differing (unsigned)
  // byte decides; if one is a prefix of the other, the shorter is "less". For
  // ASCII this matches JS's UTF-16 code-unit ordering. (Multi-byte UTF-8 orders
  // by byte, which can differ from UTF-16 order for astral/supplementary code
  // points — tracked with the UTF-8↔UTF-16 storage decision in this issue.)
  // locals: lenA(2), lenB(3), n(4 = min), i(5), ca(6), cb(7)
  addRuntimeFunc(
    mod,
    "__str_cmp",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const lenA = firstLocalIdx;
      const lenB = firstLocalIdx + 1;
      const n = firstLocalIdx + 2;
      const i = firstLocalIdx + 3;
      const ca = firstLocalIdx + 4;
      const cb = firstLocalIdx + 5;
      return [
        // lenA = a.len; lenB = b.len
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: lenA },
        { op: "local.get", index: 1 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: lenB },
        // n = min(lenA, lenB)
        { op: "local.get", index: lenA },
        { op: "local.get", index: lenB },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "local.get", index: lenA }],
          else: [{ op: "local.get", index: lenB }],
        },
        { op: "local.set", index: n },
        // i = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: i },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // break if i >= n
                { op: "local.get", index: i },
                { op: "local.get", index: n },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // ca = a.bytes[i]; cb = b.bytes[i]
                { op: "local.get", index: 0 },
                { op: "local.get", index: i },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "local.set", index: ca },
                { op: "local.get", index: 1 },
                { op: "local.get", index: i },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "local.set", index: cb },
                // if ca < cb → return -1 ; if ca > cb → return 1
                { op: "local.get", index: ca },
                { op: "local.get", index: cb },
                { op: "i32.lt_u" },
                { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: -1 }, { op: "return" }] },
                { op: "local.get", index: ca },
                { op: "local.get", index: cb },
                { op: "i32.gt_u" },
                { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
                // i++
                { op: "local.get", index: i },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: i },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // Common prefix equal: shorter string is "less".
        { op: "local.get", index: lenA },
        { op: "local.get", index: lenB },
        { op: "i32.lt_u" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: -1 }, { op: "return" }] },
        { op: "local.get", index: lenA },
        { op: "local.get", index: lenB },
        { op: "i32.gt_u" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
        { op: "i32.const", value: 0 },
      ];
    },
    6,
  );

  // __str_hash: FNV-1a hash
  // FNV offset basis = 2166136261 (0x811c9dc5)
  // FNV prime = 16777619 (0x01000193)
  // extra locals: local 1 = hash, local 2 = len, local 3 = i
  addRuntimeFunc(
    mod,
    "__str_hash",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const lenLocal = firstLocalIdx + 1;
      const iLocal = firstLocalIdx + 2;
      return [
        // hash = FNV offset basis
        { op: "i32.const", value: 0x811c9dc5 | 0 }, // sign-extend to i32
        { op: "local.set", index: hashLocal },
        // len = str.len
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: lenLocal },
        // i = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // break if i >= len
                { op: "local.get", index: iLocal },
                { op: "local.get", index: lenLocal },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // hash ^= byte[i]
                { op: "local.get", index: hashLocal },
                { op: "local.get", index: 0 }, // ptr
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "i32.xor" },
                // hash *= FNV prime
                { op: "i32.const", value: 16777619 },
                { op: "i32.mul" },
                { op: "local.set", index: hashLocal },
                // i++
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: hashLocal },
      ];
    },
    3,
  );

  // __str_concat: concatenate two strings
  // extra locals: local 2 = lenA, local 3 = lenB, local 4 = ptr, local 5 = i
  addRuntimeFunc(
    mod,
    "__str_concat",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const lenALocal = firstLocalIdx;
      const lenBLocal = firstLocalIdx + 1;
      const ptrLocal = firstLocalIdx + 2;
      const iLocal = firstLocalIdx + 3;
      return [
        // lenA
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: lenALocal },
        // lenB
        { op: "local.get", index: 1 },
        { op: "i32.load", align: 2, offset: 8 },
        { op: "local.set", index: lenBLocal },
        // Allocate: 12 + lenA + lenB
        { op: "i32.const", value: 12 },
        { op: "local.get", index: lenALocal },
        { op: "i32.add" },
        { op: "local.get", index: lenBLocal },
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocal },
        // Store total len at ptr+8
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: lenALocal },
        { op: "local.get", index: lenBLocal },
        { op: "i32.add" },
        { op: "i32.store", align: 2, offset: 8 },
        // Copy first string bytes
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: lenALocal },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "local.get", index: 0 },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "i32.store8", align: 0, offset: 12 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // Copy second string bytes
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: lenBLocal },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // dest: ptr + 12 + lenA + i
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: lenALocal },
                { op: "i32.add" },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                // src byte
                { op: "local.get", index: 1 },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "i32.store8", align: 0, offset: 12 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: ptrLocal },
      ];
    },
    4,
  );

  // __str_from_u8arr: create a string from a Uint8Array.
  // Since string and Uint8Array have the same layout ([header 8B][len at +8][bytes at +12]),
  // this just allocates a new string and copies the u8arr bytes.
  // extra locals: local 1 = len, local 2 = newPtr, local 3 = i
  const u8LenIdx = findFuncIndex(mod, "__u8arr_len");
  addRuntimeFunc(
    mod,
    "__str_from_u8arr",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const lenLocal = firstLocalIdx;
      const ptrLocalFu = firstLocalIdx + 1;
      const iLocalFu = firstLocalIdx + 2;
      return [
        // len = __u8arr_len(u8arr)
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: u8LenIdx },
        { op: "local.set", index: lenLocal },
        // newPtr = malloc(12 + len)
        { op: "i32.const", value: 12 },
        { op: "local.get", index: lenLocal },
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocalFu },
        // Store tag byte 0x02 (Uint8Array) at newPtr+0
        { op: "local.get", index: ptrLocalFu },
        { op: "i32.const", value: 0x02 },
        { op: "i32.store8", align: 0, offset: 0 },
        // Store len at newPtr+8
        { op: "local.get", index: ptrLocalFu },
        { op: "local.get", index: lenLocal },
        { op: "i32.store", align: 2, offset: 8 },
        // Copy bytes
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocalFu },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocalFu },
                { op: "local.get", index: lenLocal },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // newPtr[12+i] = u8arr[12+i]
                { op: "local.get", index: ptrLocalFu },
                { op: "local.get", index: iLocalFu },
                { op: "i32.add" },
                { op: "local.get", index: 0 }, // u8arr ptr
                { op: "local.get", index: iLocalFu },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "i32.store8", align: 0, offset: 12 },
                { op: "local.get", index: iLocalFu },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocalFu },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: ptrLocalFu },
      ];
    },
    3,
  );

  // __str_starts_with(str: i32, prefix: i32) → i32 (boolean)
  // Checks if str starts with prefix by comparing bytes.
  // extra locals: strLen, prefixLen, i, result
  const strLenIdx = findFuncIndex(mod, "__str_len");
  addRuntimeFunc(
    mod,
    "__str_starts_with",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const strLenLocal = firstLocalIdx;
      const prefixLenLocal = firstLocalIdx + 1;
      const iLocal = firstLocalIdx + 2;
      const resultLocal = firstLocalIdx + 3;
      return [
        // strLen = __str_len(str)
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: strLenIdx },
        { op: "local.set", index: strLenLocal },
        // prefixLen = __str_len(prefix)
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strLenIdx },
        { op: "local.set", index: prefixLenLocal },
        // result = 1 (assume true)
        { op: "i32.const", value: 1 },
        { op: "local.set", index: resultLocal },
        // if strLen < prefixLen, result = 0
        { op: "local.get", index: strLenLocal },
        { op: "local.get", index: prefixLenLocal },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: resultLocal },
          ],
          else: [
            // Compare prefix bytes: i = 0
            { op: "i32.const", value: 0 },
            { op: "local.set", index: iLocal },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    // if i >= prefixLen, break (result stays 1)
                    { op: "local.get", index: iLocal },
                    { op: "local.get", index: prefixLenLocal },
                    { op: "i32.ge_u" },
                    { op: "br_if", depth: 1 },
                    // if str[12+i] != prefix[12+i], result = 0 and break
                    { op: "local.get", index: 0 },
                    { op: "local.get", index: iLocal },
                    { op: "i32.add" },
                    { op: "i32.load8_u", align: 0, offset: 12 },
                    { op: "local.get", index: 1 },
                    { op: "local.get", index: iLocal },
                    { op: "i32.add" },
                    { op: "i32.load8_u", align: 0, offset: 12 },
                    { op: "i32.ne" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "i32.const", value: 0 },
                        { op: "local.set", index: resultLocal },
                        { op: "br", depth: 2 }, // break to outer block
                      ],
                    },
                    // i++
                    { op: "local.get", index: iLocal },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: iLocal },
                    { op: "br", depth: 0 }, // continue loop
                  ],
                },
              ],
            },
          ],
        },
        // return result
        { op: "local.get", index: resultLocal },
      ];
    },
    4,
  );

  // __str_slice(str: i32, start: i32, end: i32) → i32
  // Extract substring [start, end) from str. Returns new string pointer.
  // extra locals: newLen, ptr, i
  addRuntimeFunc(
    mod,
    "__str_slice",
    [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const newLenLocal = firstLocalIdx;
      const ptrLocal = firstLocalIdx + 1;
      const iLocal = firstLocalIdx + 2;
      return [
        // newLen = end - start
        { op: "local.get", index: 2 },
        { op: "local.get", index: 1 },
        { op: "i32.sub" },
        { op: "local.set", index: newLenLocal },
        // Clamp: if newLen < 0, set to 0
        { op: "local.get", index: newLenLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: newLenLocal },
          ],
        },
        // ptr = malloc(12 + newLen)
        { op: "i32.const", value: 12 },
        { op: "local.get", index: newLenLocal },
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocal },
        // store length at ptr+8
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: newLenLocal },
        { op: "i32.store", align: 2, offset: 8 },
        // copy bytes: for i = 0; i < newLen; i++
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: newLenLocal },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // dest: ptr + 12 + i
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                // src: str + 12 + start + i
                { op: "local.get", index: 0 },
                { op: "local.get", index: 1 },
                { op: "i32.add" },
                { op: "local.get", index: iLocal },
                { op: "i32.add" },
                { op: "i32.load8_u", align: 0, offset: 12 },
                { op: "i32.store8", align: 0, offset: 12 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: ptrLocal },
      ];
    },
    3,
  );

  // __str_index_of(str: i32, sep: i32, fromIdx: i32) → i32 (-1 if not found)
  // Find first occurrence of sep in str starting from fromIdx
  // extra locals: strLen, sepLen, i, j, match
  addRuntimeFunc(
    mod,
    "__str_index_of",
    [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const strLenLocal = firstLocalIdx;
      const sepLenLocal = firstLocalIdx + 1;
      const iLocal2 = firstLocalIdx + 2;
      const jLocal = firstLocalIdx + 3;
      const matchLocal = firstLocalIdx + 4;
      return [
        // strLen = str.length
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: strLenIdx },
        { op: "local.set", index: strLenLocal },
        // sepLen = sep.length
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strLenIdx },
        { op: "local.set", index: sepLenLocal },
        // for i = fromIdx; i <= strLen - sepLen; i++
        { op: "local.get", index: 2 },
        { op: "local.set", index: iLocal2 },
        {
          op: "block",
          blockType: { kind: "val", type: { kind: "i32" } },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // if i > strLen - sepLen, return -1
                { op: "local.get", index: iLocal2 },
                { op: "local.get", index: strLenLocal },
                { op: "local.get", index: sepLenLocal },
                { op: "i32.sub" },
                { op: "i32.gt_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: -1 },
                    { op: "br", depth: 3 }, // return -1 (break out of block)
                  ],
                },
                // match = true
                { op: "i32.const", value: 1 },
                { op: "local.set", index: matchLocal },
                // for j = 0; j < sepLen; j++
                { op: "i32.const", value: 0 },
                { op: "local.set", index: jLocal },
                {
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        { op: "local.get", index: jLocal },
                        { op: "local.get", index: sepLenLocal },
                        { op: "i32.ge_u" },
                        { op: "br_if", depth: 1 },
                        // compare str[i+j] with sep[j]
                        { op: "local.get", index: 0 },
                        { op: "local.get", index: iLocal2 },
                        { op: "i32.add" },
                        { op: "local.get", index: jLocal },
                        { op: "i32.add" },
                        { op: "i32.load8_u", align: 0, offset: 12 },
                        { op: "local.get", index: 1 },
                        { op: "local.get", index: jLocal },
                        { op: "i32.add" },
                        { op: "i32.load8_u", align: 0, offset: 12 },
                        { op: "i32.ne" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "i32.const", value: 0 },
                            { op: "local.set", index: matchLocal },
                            { op: "br", depth: 2 }, // break inner loop
                          ],
                        },
                        { op: "local.get", index: jLocal },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: jLocal },
                        { op: "br", depth: 0 },
                      ],
                    },
                  ],
                },
                // if match, return i
                { op: "local.get", index: matchLocal },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: iLocal2 },
                    { op: "br", depth: 2 }, // return i
                  ],
                },
                // i++
                { op: "local.get", index: iLocal2 },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal2 },
                { op: "br", depth: 0 },
              ],
            },
            // Loop fallthrough (unreachable in practice): return -1
            { op: "i32.const", value: -1 },
          ],
        },
      ];
    },
    5,
  );

  // __str_split(str: i32, sep: i32) → i32 (array of string pointers)
  // extra locals: result, strLen, sepLen, start, pos
  const strSliceIdx = findFuncIndex(mod, "__str_slice");
  const strIndexOfIdx = findFuncIndex(mod, "__str_index_of");
  const arrNewIdx = findFuncIndex(mod, "__arr_new");
  const arrPushIdx = findFuncIndex(mod, "__arr_push");
  addRuntimeFunc(
    mod,
    "__str_split",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const resultLocal = firstLocalIdx;
      const strLenLocal2 = firstLocalIdx + 1;
      const startLocal = firstLocalIdx + 2;
      const posLocal = firstLocalIdx + 3;
      const sepLenLocal2 = firstLocalIdx + 4;
      return [
        // result = __arr_new(16)
        { op: "i32.const", value: 16 },
        { op: "call", funcIdx: arrNewIdx },
        { op: "local.set", index: resultLocal },
        // strLen
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: strLenIdx },
        { op: "local.set", index: strLenLocal2 },
        // sepLen
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strLenIdx },
        { op: "local.set", index: sepLenLocal2 },
        // start = 0
        { op: "i32.const", value: 0 },
        { op: "local.set", index: startLocal },
        // loop: find sep, push substring, advance
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // pos = __str_index_of(str, sep, start)
                { op: "local.get", index: 0 },
                { op: "local.get", index: 1 },
                { op: "local.get", index: startLocal },
                { op: "call", funcIdx: strIndexOfIdx },
                { op: "local.set", index: posLocal },
                // if pos == -1, break
                { op: "local.get", index: posLocal },
                { op: "i32.const", value: -1 },
                { op: "i32.eq" },
                { op: "br_if", depth: 1 },
                // push substring [start, pos) — encode the string i32 pointer
                // into the low 4 bytes of the f64 element slot (#1938).
                { op: "local.get", index: resultLocal },
                { op: "local.get", index: 0 },
                { op: "local.get", index: startLocal },
                { op: "local.get", index: posLocal },
                { op: "call", funcIdx: strSliceIdx },
                { op: "i64.extend_i32_u" },
                { op: "f64.reinterpret_i64" },
                { op: "call", funcIdx: arrPushIdx },
                // start = pos + sepLen
                { op: "local.get", index: posLocal },
                { op: "local.get", index: sepLenLocal2 },
                { op: "i32.add" },
                { op: "local.set", index: startLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // push final substring [start, strLen) — encode the string i32 pointer
        // into the f64 element slot (#1938).
        { op: "local.get", index: resultLocal },
        { op: "local.get", index: 0 },
        { op: "local.get", index: startLocal },
        { op: "local.get", index: strLenLocal2 },
        { op: "call", funcIdx: strSliceIdx },
        { op: "i64.extend_i32_u" },
        { op: "f64.reinterpret_i64" },
        { op: "call", funcIdx: arrPushIdx },
        // return result
        { op: "local.get", index: resultLocal },
      ];
    },
    5,
  );
}

/**
 * Add Map runtime functions (open-addressing hash table with string keys).
 * Layout: [header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]
 * Entry: [hash:u32][key:i32][val:i32] = 12 bytes each
 * Empty entry: hash=0
 *
 * Functions added:
 * - __map_new(cap: i32) → i32
 * - __map_set(map: i32, key: i32, val: i32) → void
 * - __map_get(map: i32, key: i32) → i32
 * - __map_has(map: i32, key: i32) → i32
 * - __map_size(map: i32) → i32
 */
export function addMapRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");
  const strHashIdx = findFuncIndex(mod, "__str_hash");
  const strEqIdx = findFuncIndex(mod, "__str_eq");

  // __map_new: allocate map with given capacity
  // extra locals: local 1 = ptr, local 2 = totalSize, local 3 = i
  addRuntimeFunc(
    mod,
    "__map_new",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const ptrLocal = firstLocalIdx;
      const totalSizeLocal = firstLocalIdx + 1;
      const iLocal = firstLocalIdx + 2;
      return [
        // totalSize = 16 + cap * 12
        { op: "i32.const", value: 16 },
        { op: "local.get", index: 0 }, // cap
        { op: "i32.const", value: 12 },
        { op: "i32.mul" },
        { op: "i32.add" },
        { op: "local.set", index: totalSizeLocal },
        // Allocate
        { op: "local.get", index: totalSizeLocal },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocal },
        // Store count=0
        { op: "local.get", index: ptrLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.store", align: 2, offset: 8 },
        // Store cap
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: 0 }, // cap
        { op: "i32.store", align: 2, offset: 12 },
        // Zero out entries (hash=0 means empty)
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: 0 }, // cap
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                // Zero out hash at entry[i]
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 12 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "i32.const", value: 0 },
                { op: "i32.store", align: 2, offset: 16 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: ptrLocal },
      ];
    },
    3,
  );

  // __map_set: insert or update key-value pair using linear probing
  // extra locals: local 3-7 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(
    mod,
    "__map_set",
    [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
    [],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        // hash = __str_hash(key) | ensure non-zero by OR with 1
        { op: "local.get", index: 1 }, // key
        { op: "call", funcIdx: strHashIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.or" }, // ensure hash != 0 (0 = empty sentinel)
        { op: "local.set", index: hashLocal },
        // cap = map.cap
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        // idx = hash % cap (unsigned)
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        // Linear probe loop
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // entryAddr = map + 16 + idx * 12
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 12 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                // entryHash = load hash at entryAddr+16
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                // If empty slot (hash=0): insert here
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // Store hash
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: hashLocal },
                    { op: "i32.store", align: 2, offset: 16 },
                    // Store key
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: 1 },
                    { op: "i32.store", align: 2, offset: 20 },
                    // Store val
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: 2 },
                    { op: "i32.store", align: 2, offset: 24 },
                    // Increment count
                    { op: "local.get", index: 0 },
                    { op: "local.get", index: 0 },
                    { op: "i32.load", align: 2, offset: 8 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "i32.store", align: 2, offset: 8 },
                    { op: "return" },
                  ],
                },
                // If same hash AND keys equal: update value
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // Check string equality
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 }, // existing key
                    { op: "local.get", index: 1 }, // new key
                    { op: "call", funcIdx: strEqIdx },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        // Update value
                        { op: "local.get", index: entryAddrLocal },
                        { op: "local.get", index: 2 },
                        { op: "i32.store", align: 2, offset: 24 },
                        { op: "return" },
                      ],
                    },
                  ],
                },
                // Advance: idx = (idx + 1) % cap
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ];
    },
    5,
  );

  // __map_get: look up value by key (returns 0 if not found)
  // extra locals: local 2-6 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(
    mod,
    "__map_get",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strHashIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 12 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                // Empty slot → not found
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                },
                // Check hash + key equality
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "call", funcIdx: strEqIdx },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: entryAddrLocal },
                        { op: "i32.load", align: 2, offset: 24 },
                        { op: "return" },
                      ],
                    },
                  ],
                },
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 0 },
      ];
    },
    5,
  );

  // __map_has: check if key exists (returns 0 or 1)
  // extra locals: local 2-6 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(
    mod,
    "__map_has",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strHashIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 12 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                },
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "call", funcIdx: strEqIdx },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                    },
                  ],
                },
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 0 },
      ];
    },
    5,
  );

  // __map_size: load count at offset 8
  addRuntimeFunc(mod, "__map_size", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);
}

/**
 * Add Set runtime functions (open-addressing hash set with string keys).
 * Layout: [header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]
 * Entry: [hash:u32][key:i32] = 8 bytes each
 *
 * Functions added:
 * - __set_new(cap: i32) → i32
 * - __set_add(set: i32, key: i32) → void
 * - __set_has(set: i32, key: i32) → i32
 * - __set_size(set: i32) → i32
 */
export function addSetRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");
  const strHashIdx = findFuncIndex(mod, "__str_hash");
  const strEqIdx = findFuncIndex(mod, "__str_eq");

  // __set_new
  // extra locals: local 1 = ptr, local 2 = i
  addRuntimeFunc(
    mod,
    "__set_new",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const ptrLocal = firstLocalIdx;
      const iLocal = firstLocalIdx + 1;
      return [
        // Allocate: 16 + cap * 8
        { op: "i32.const", value: 16 },
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 8 },
        { op: "i32.mul" },
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocal },
        // count = 0
        { op: "local.get", index: ptrLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.store", align: 2, offset: 8 },
        // cap
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: 0 },
        { op: "i32.store", align: 2, offset: 12 },
        // Zero entries
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: 0 },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "i32.const", value: 0 },
                { op: "i32.store", align: 2, offset: 16 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: ptrLocal },
      ];
    },
    2,
  );

  // __set_add
  // extra locals: local 2-6 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(
    mod,
    "__set_add",
    [{ kind: "i32" }, { kind: "i32" }],
    [],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strHashIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                // Empty slot → insert
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: hashLocal },
                    { op: "i32.store", align: 2, offset: 16 },
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: 1 },
                    { op: "i32.store", align: 2, offset: 20 },
                    // Increment count
                    { op: "local.get", index: 0 },
                    { op: "local.get", index: 0 },
                    { op: "i32.load", align: 2, offset: 8 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "i32.store", align: 2, offset: 8 },
                    { op: "return" },
                  ],
                },
                // Same hash → check equality
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "call", funcIdx: strEqIdx },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "return" }, // already in set
                      ],
                    },
                  ],
                },
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ];
    },
    5,
  );

  // __set_has
  // extra locals: local 2-6 = hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(
    mod,
    "__set_has",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: strHashIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                },
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "call", funcIdx: strEqIdx },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                    },
                  ],
                },
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 0 },
      ];
    },
    5,
  );

  // __set_size
  addRuntimeFunc(mod, "__set_size", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);
}

/**
 * Add numeric-key Map runtime functions (open-addressing hash table with i32 keys).
 * Layout: [header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]
 * Entry: [hash:u32][key:i32][val:i32] = 12 bytes each
 * Empty entry: hash=0, key uses (key | 1) as hash to avoid zero sentinel.
 *
 * Functions added:
 * - __nmap_new(cap: i32) → i32
 * - __nmap_set(map: i32, key: i32, val: i32) → void
 * - __nmap_get(map: i32, key: i32) → i32
 * - __nmap_has(map: i32, key: i32) → i32
 * - __nmap_size(map: i32) → i32
 */
export function addNumericMapRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");

  // __nmap_new: identical to __map_new
  addRuntimeFunc(
    mod,
    "__nmap_new",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const ptrLocal = firstLocalIdx;
      const iLocal = firstLocalIdx + 1;
      return [
        // totalSize = 16 + cap * 12
        { op: "i32.const", value: 16 },
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 12 },
        { op: "i32.mul" },
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocal },
        // count = 0
        { op: "local.get", index: ptrLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.store", align: 2, offset: 8 },
        // cap
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: 0 },
        { op: "i32.store", align: 2, offset: 12 },
        // Zero out entries
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: 0 },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 12 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "i32.const", value: 0 },
                { op: "i32.store", align: 2, offset: 16 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: ptrLocal },
      ];
    },
    2,
  );

  // __nmap_set: insert/update using numeric key directly
  // hash = (key * 2654435761) | 1  (Knuth multiplicative hash, ensure non-zero)
  // extra locals: hash, cap, idx, entryAddr, entryHash
  addRuntimeFunc(
    mod,
    "__nmap_set",
    [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
    [],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        // hash = (key * 2654435761) | 1
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0x9e3779b1 | 0 },
        { op: "i32.mul" },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        // cap
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        // idx = hash % cap
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // entryAddr = map + idx * 12
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 12 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                // entryHash
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                // Empty slot → insert
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: hashLocal },
                    { op: "i32.store", align: 2, offset: 16 },
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: 1 },
                    { op: "i32.store", align: 2, offset: 20 },
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: 2 },
                    { op: "i32.store", align: 2, offset: 24 },
                    // Increment count
                    { op: "local.get", index: 0 },
                    { op: "local.get", index: 0 },
                    { op: "i32.load", align: 2, offset: 8 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "i32.store", align: 2, offset: 8 },
                    { op: "return" },
                  ],
                },
                // Same hash → check key equality (numeric)
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        // Update value
                        { op: "local.get", index: entryAddrLocal },
                        { op: "local.get", index: 2 },
                        { op: "i32.store", align: 2, offset: 24 },
                        { op: "return" },
                      ],
                    },
                  ],
                },
                // Advance
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ];
    },
    5,
  );

  // __nmap_get
  addRuntimeFunc(
    mod,
    "__nmap_get",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0x9e3779b1 | 0 },
        { op: "i32.mul" },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 12 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                // Empty → not found
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                },
                // Check hash + key
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: entryAddrLocal },
                        { op: "i32.load", align: 2, offset: 24 },
                        { op: "return" },
                      ],
                    },
                  ],
                },
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 0 },
      ];
    },
    5,
  );

  // __nmap_has
  addRuntimeFunc(
    mod,
    "__nmap_has",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0x9e3779b1 | 0 },
        { op: "i32.mul" },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 12 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                },
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                    },
                  ],
                },
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 0 },
      ];
    },
    5,
  );

  // __nmap_size: same as __map_size
  addRuntimeFunc(mod, "__nmap_size", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);
}

/**
 * Add numeric-key Set runtime functions (open-addressing hash set with i32 keys).
 * Layout: [header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]
 * Entry: [hash:u32][key:i32] = 8 bytes each
 *
 * Functions added:
 * - __nset_new(cap: i32) → i32
 * - __nset_add(set: i32, key: i32) → void
 * - __nset_has(set: i32, key: i32) → i32
 * - __nset_size(set: i32) → i32
 */
export function addNumericSetRuntime(mod: WasmModule): void {
  const mallocIdx = findFuncIndex(mod, "__malloc");

  // __nset_new
  addRuntimeFunc(
    mod,
    "__nset_new",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const ptrLocal = firstLocalIdx;
      const iLocal = firstLocalIdx + 1;
      return [
        // 16 + cap * 8
        { op: "i32.const", value: 16 },
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 8 },
        { op: "i32.mul" },
        { op: "i32.add" },
        { op: "call", funcIdx: mallocIdx },
        { op: "local.set", index: ptrLocal },
        { op: "local.get", index: ptrLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.store", align: 2, offset: 8 },
        { op: "local.get", index: ptrLocal },
        { op: "local.get", index: 0 },
        { op: "i32.store", align: 2, offset: 12 },
        // Zero entries
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: iLocal },
                { op: "local.get", index: 0 },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: ptrLocal },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "i32.const", value: 0 },
                { op: "i32.store", align: 2, offset: 16 },
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: ptrLocal },
      ];
    },
    2,
  );

  // __nset_add
  addRuntimeFunc(
    mod,
    "__nset_add",
    [{ kind: "i32" }, { kind: "i32" }],
    [],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0x9e3779b1 | 0 },
        { op: "i32.mul" },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                // Empty → insert
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: hashLocal },
                    { op: "i32.store", align: 2, offset: 16 },
                    { op: "local.get", index: entryAddrLocal },
                    { op: "local.get", index: 1 },
                    { op: "i32.store", align: 2, offset: 20 },
                    { op: "local.get", index: 0 },
                    { op: "local.get", index: 0 },
                    { op: "i32.load", align: 2, offset: 8 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "i32.store", align: 2, offset: 8 },
                    { op: "return" },
                  ],
                },
                // Same hash → check key
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "return" }, // already in set
                      ],
                    },
                  ],
                },
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ];
    },
    5,
  );

  // __nset_has
  addRuntimeFunc(
    mod,
    "__nset_has",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    (firstLocalIdx) => {
      const hashLocal = firstLocalIdx;
      const capLocal = firstLocalIdx + 1;
      const idxLocal = firstLocalIdx + 2;
      const entryAddrLocal = firstLocalIdx + 3;
      const entryHashLocal = firstLocalIdx + 4;
      return [
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0x9e3779b1 | 0 },
        { op: "i32.mul" },
        { op: "i32.const", value: 1 },
        { op: "i32.or" },
        { op: "local.set", index: hashLocal },
        { op: "local.get", index: 0 },
        { op: "i32.load", align: 2, offset: 12 },
        { op: "local.set", index: capLocal },
        { op: "local.get", index: hashLocal },
        { op: "local.get", index: capLocal },
        { op: "i32.rem_u" },
        { op: "local.set", index: idxLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 8 },
                { op: "i32.mul" },
                { op: "i32.add" },
                { op: "local.set", index: entryAddrLocal },
                { op: "local.get", index: entryAddrLocal },
                { op: "i32.load", align: 2, offset: 16 },
                { op: "local.set", index: entryHashLocal },
                { op: "local.get", index: entryHashLocal },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                },
                { op: "local.get", index: entryHashLocal },
                { op: "local.get", index: hashLocal },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entryAddrLocal },
                    { op: "i32.load", align: 2, offset: 20 },
                    { op: "local.get", index: 1 },
                    { op: "i32.eq" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                    },
                  ],
                },
                ...hashProbeAdvanceInstrs(idxLocal, capLocal),
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "i32.const", value: 0 },
      ];
    },
    5,
  );

  // __nset_size
  addRuntimeFunc(mod, "__nset_size", [{ kind: "i32" }], [{ kind: "i32" }], [], () => [
    { op: "local.get", index: 0 },
    { op: "i32.load", align: 2, offset: 8 },
  ]);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Find a function's absolute index by name */
function findFuncIndex(mod: WasmModule, name: string): number {
  const numImports = mod.imports.filter((i) => i.desc.kind === "func").length;
  for (let i = 0; i < mod.functions.length; i++) {
    if (mod.functions[i].name === name) {
      return numImports + i;
    }
  }
  throw new Error(`Runtime function not found: ${name}`);
}

/**
 * Helper to add a runtime function to the module.
 * @param extraLocalsCount how many extra locals (beyond params) the function needs
 */
function addRuntimeFunc(
  mod: WasmModule,
  name: string,
  params: ValType[],
  results: ValType[],
  _extraLocalPlaceholders: unknown[],
  bodyFn: (firstExtraLocalIdx: number) => Instr[],
  extraLocalsCount?: number,
): void {
  const typeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: `$type_${name}`,
    params,
    results,
  });

  const numExtraLocals = extraLocalsCount ?? _extraLocalPlaceholders.length;
  const locals = [];
  for (let i = 0; i < numExtraLocals; i++) {
    locals.push({ name: `$l${i}`, type: { kind: "i32" as const } });
  }

  const firstExtraLocalIdx = params.length;
  const body = bodyFn(firstExtraLocalIdx);

  mod.functions.push({
    name,
    typeIdx,
    locals,
    body,
    exported: false,
  });
}

/** Reserved name for the linear-backend f64 remainder helper (#2144). */
export const FMOD_FN = "__fmod";

/**
 * (#2144) Add the Wasm-native IEEE-754 remainder (`fmod`) helper to the linear
 * backend, mirroring the WasmGC `src/codegen/fmod.ts` work (#2056).
 *
 * The linear `%` arm previously emitted the naive `a - trunc(a/b)*b` formula
 * that the GC backend explicitly retired: it drifts by ULPs, collapses to 0
 * when `trunc(a/b)*b` rounds back to `a`, and produces `±Infinity` when `a/b`
 * overflows f64 (ratio ≳ 1e308). This is the textbook cross-backend divergence
 * flagged in docs/architecture/codegen-axes.md — both backends must agree on
 * `%`.
 *
 * Algorithm (exact, no host import — dual-mode standalone): classic binary
 * long-division remainder operating purely in f64. All intermediates stay
 * ≤ |a|, so nothing overflows, and every step is an exact f64 op, so there is
 * zero rounding drift. See fmod.ts for the full derivation and the verified
 * edge-case set (`x % Inf`, `-0 % x`, `Inf % x`, `x % 0`, `NaN % x`, …).
 *
 * Signature: `(f64 a, f64 b) -> f64`. Idempotent — a second call is a no-op.
 */
export function addFmodRuntime(mod: WasmModule): void {
  if (mod.functions.some((f) => f.name === FMOD_FN)) return;

  const typeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: "$type___fmod",
    params: [{ kind: "f64" }, { kind: "f64" }],
    results: [{ kind: "f64" }],
  });

  // Locals: 0=a, 1=b (params); 2=x (|a|, running remainder), 3=y (|b|), 4=t.
  const A = 0;
  const B = 1;
  const X = 2;
  const Y = 3;
  const T = 4;
  const INF = Infinity;

  const body: Instr[] = [
    // if (b == 0) return NaN
    { op: "local.get", index: B },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "f64.const", value: NaN }, { op: "return" }] },
    // if (|a| == Inf) return NaN  (Inf % x)
    { op: "local.get", index: A },
    { op: "f64.abs" },
    { op: "f64.const", value: INF },
    { op: "f64.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "f64.const", value: NaN }, { op: "return" }] },
    // if (a != a) return NaN  (NaN dividend)
    { op: "local.get", index: A },
    { op: "local.get", index: A },
    { op: "f64.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "f64.const", value: NaN }, { op: "return" }] },
    // if (b != b) return NaN  (NaN divisor)
    { op: "local.get", index: B },
    { op: "local.get", index: B },
    { op: "f64.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "f64.const", value: NaN }, { op: "return" }] },
    // if (|b| == Inf) return a  (a finite → remainder is a itself)
    { op: "local.get", index: B },
    { op: "f64.abs" },
    { op: "f64.const", value: INF },
    { op: "f64.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: A }, { op: "return" }] },

    // x = |a|; y = |b|
    { op: "local.get", index: A },
    { op: "f64.abs" },
    { op: "local.set", index: X },
    { op: "local.get", index: B },
    { op: "f64.abs" },
    { op: "local.set", index: Y },

    // if (x < y) return copysign(x, a)  (covers x == 0 → ±0)
    { op: "local.get", index: X },
    { op: "local.get", index: Y },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: X }, { op: "local.get", index: A }, { op: "f64.copysign" }, { op: "return" }],
    },

    // t = y; while (t * 2 <= x) t *= 2
    { op: "local.get", index: Y },
    { op: "local.set", index: T },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: T },
            { op: "f64.const", value: 2 },
            { op: "f64.mul" },
            { op: "local.get", index: X },
            { op: "f64.le" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: T },
            { op: "f64.const", value: 2 },
            { op: "f64.mul" },
            { op: "local.set", index: T },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // while (t >= y) { if (x >= t) x -= t; t *= 0.5 }
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: T },
            { op: "local.get", index: Y },
            { op: "f64.ge" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: X },
            { op: "local.get", index: T },
            { op: "f64.ge" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: X },
                { op: "local.get", index: T },
                { op: "f64.sub" },
                { op: "local.set", index: X },
              ],
            },
            { op: "local.get", index: T },
            { op: "f64.const", value: 0.5 },
            { op: "f64.mul" },
            { op: "local.set", index: T },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return copysign(x, a)
    { op: "local.get", index: X },
    { op: "local.get", index: A },
    { op: "f64.copysign" },
  ];

  mod.functions.push({
    name: FMOD_FN,
    typeIdx,
    locals: [
      { name: "$x", type: { kind: "f64" } }, // X
      { name: "$y", type: { kind: "f64" } }, // Y
      { name: "$t", type: { kind: "f64" } }, // T
    ],
    body,
    exported: false,
  });
}
