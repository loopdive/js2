// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Linked-mode heap and read-only-data placement for the linear backend (#4540).
 *
 * "Linked mode" means the module IMPORTS its linear memory instead of defining
 * one — the ADR-0020 topology, where the engine artifact owns the address
 * space. Everything in this file exists because, in that mode, the linear
 * backend may not name an address: it has to take every one from the owner.
 *
 * See `docs/adr/0022-linked-mode-heap-and-rodata-placement.md`. `runtime.ts`
 * keeps the standalone arena, which is unaffected and emits identical bytes.
 */
import type { Instr, WasmModule } from "../ir/types.js";

/** Wasm page size in bytes (64 KiB). */
const WASM_PAGE_SIZE = 65536;

/**
 * Linked-mode arena configuration.
 *
 * ### Why this exists
 *
 * In the ADR-0020 link topology our module IMPORTS its memory from the engine
 * artifact, so the address space is not ours. Two things then break, and both
 * were measured against the pinned artifact rather than argued:
 *
 * 1. **The base address collides.** `__heap_ptr` initialises to a hard-coded
 *    floor — 1024 by default, 65536 when the Ryū formatter is linked. The
 *    artifact's shadow stack occupies `[0, 65536)` (its `__stack_pointer`
 *    global initialises to 65536 and grows down, `--stack-first`) and its
 *    static data `[65536, 170392)`. So the arena's *first* allocation writes
 *    through the engine's stack, and the Ryū floor lands exactly on the first
 *    byte of its static data.
 *
 * 2. **The top-of-memory claim collides.** The standalone arena treats
 *    everything from `__heap_ptr` to the end of memory as its own and calls
 *    `memory.grow` when it needs more. The engine's `dlmalloc` also grows the
 *    same memory. Growth itself interleaves safely — measured: after an
 *    external grow the engine's next `malloc` lands *above* the grown region
 *    and clobbers nothing — but the arena's *claim* does not: once the engine
 *    has grown, the pages it just took are inside the region the arena
 *    considers free, so the bump pointer walks straight into a live engine
 *    heap.
 *
 * Relocating the base to another constant fixes (1) and not (2), which is why
 * the fixed `--global-base` option is refused (see the ADR): the engine's heap
 * grows, so any constant we pick is only correct until it isn't.
 *
 * ### What this does instead
 *
 * `__malloc` becomes a **chunked** bump arena whose chunks are obtained from
 * the engine's own allocator, and it **never calls `memory.grow`**. The engine
 * is therefore the only component that grows the memory — established by
 * construction (there is no `memory.grow` opcode in our emitted module in this
 * mode) rather than by convention. Typed allocation keeps ADR-0017's
 * zero-metadata bump path *inside* each chunk; only chunk acquisition pays the
 * host allocator's cost, amortised over `chunkBytes`.
 */
export interface LinkedHeapOptions {
  /**
   * Global function index of the imported host allocator, signature
   * `(i32 size) -> i32 ptr`, returning 0 on failure.
   */
  mallocFuncIdx: number;
  /**
   * Bytes requested per chunk. Larger amortises the host-allocator call over
   * more bump allocations; smaller wastes less on the final partial chunk.
   * A single request larger than this gets its own exactly-sized chunk.
   */
  chunkBytes: number;
}

/** Default chunk size for {@link LinkedHeapOptions.chunkBytes} — one Wasm page. */
export const LINKED_ARENA_DEFAULT_CHUNK_BYTES = WASM_PAGE_SIZE;

/** Global holding the end of the currently carved chunk (linked mode only). */
export const ARENA_LIMIT_GLOBAL = "__arena_limit";

/** Global holding `runtimeDataBase - linkTimeDataBase` (linked mode only). */
export const RODATA_BIAS_GLOBAL = "__rodata_bias";

/**
 * Whether this module is in LINKED mode — it imports its memory, so it does not
 * own the address space and may not name an address.
 *
 * Derived from the emitted module rather than threaded through as a flag so
 * every downstream pass agrees with the bytes it will actually serialize.
 *
 * **Not the same question as {@link hasChunkedArena}, and #4557 is what split
 * them.** Until then this predicate read `__arena_limit`, which was an exact
 * proxy only while the chunked arena existed *only* in linked mode. The own
 * allocator (#4557) gives a STANDALONE module a chunked arena too — carved from
 * our own heap — and a standalone module still owns its address space, still
 * emits ACTIVE data segments, and still needs `memory.min` to cover them. Left
 * merged, the two questions would have emitted a passive Ryū table with nothing
 * to copy it in.
 */
export function isLinkedArena(mod: WasmModule): boolean {
  return mod.imports.some((imp) => imp.desc.kind === "memory");
}

/**
 * Whether `__malloc` is a CHUNKED bump arena (carving from some allocator)
 * rather than the monotonic one that owns everything above its pointer.
 *
 * True in linked mode (chunks from the engine, #4540) and under the own
 * allocator (chunks from `__heap_alloc`, #4557). What it buys either way is
 * that no absolute heap floor exists to be lifted.
 */
export function hasChunkedArena(mod: WasmModule): boolean {
  return mod.globals.some((global) => global.name === ARENA_LIMIT_GLOBAL);
}

/**
 * The `__malloc` prologue for linked mode.
 *
 * We own nothing, so "not enough room" means "ask the host allocator for
 * another chunk". There is deliberately NO `memory.grow` on this path — that is
 * what makes "exactly one component grows the memory" a property of the emitted
 * bytes rather than a convention someone has to remember.
 *
 * Leaves `local_ret` = the address to hand back and `local_next` = the new bump
 * position, matching the standalone prologue's contract so the shared tail
 * (commit, zero the record header, return) is identical.
 */
export function linkedMallocPrologue(opts: {
  heapPtrGlobalIdx: number;
  arenaLimitGlobalIdx: number;
  hostMallocIdx: number;
  chunkBytes: number;
  localRet: number;
  localNext: number;
  localChunk: number;
}): Instr[] {
  const { heapPtrGlobalIdx, arenaLimitGlobalIdx, hostMallocIdx, chunkBytes, localRet, localNext, localChunk } = opts;
  return [
    // next = align8(__heap_ptr + size)
    { op: "global.get", index: heapPtrGlobalIdx },
    { op: "local.get", index: 0 }, // size
    { op: "i32.add" },
    { op: "i32.const", value: 7 },
    { op: "i32.add" },
    { op: "i32.const", value: -8 },
    { op: "i32.and" },
    { op: "local.set", index: localNext },
    // Carve when there is no chunk yet (__heap_ptr == 0) or this request would
    // run past the current chunk. The first disjunct is not redundant: a
    // zero-byte request computes next == 0, which is not > the initial limit
    // of 0, and would otherwise hand back the null pointer.
    { op: "global.get", index: heapPtrGlobalIdx },
    { op: "i32.eqz" },
    { op: "local.get", index: localNext },
    { op: "global.get", index: arenaLimitGlobalIdx },
    { op: "i32.gt_u" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // chunk = max(chunkBytes, align8(size)) — an oversized request gets a
        // chunk of its own rather than being refused or silently truncated.
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 7 },
        { op: "i32.add" },
        { op: "i32.const", value: -8 },
        { op: "i32.and" },
        { op: "local.set", index: localChunk },
        { op: "local.get", index: localChunk },
        { op: "i32.const", value: chunkBytes },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: chunkBytes },
            { op: "local.set", index: localChunk },
          ],
          else: [],
        },
        // base = host_malloc(chunk)
        { op: "local.get", index: localChunk },
        { op: "call", funcIdx: hostMallocIdx },
        { op: "local.set", index: localRet },
        // A null return means the host is out of memory. Trap here rather than
        // bump from address 0 — the arena has no way to signal failure to its
        // callers, and writing through null would corrupt the engine's shadow
        // stack, which is exactly the failure this mode exists to remove.
        { op: "local.get", index: localRet },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "unreachable" }],
          else: [],
        },
        { op: "local.get", index: localRet },
        { op: "global.set", index: heapPtrGlobalIdx },
        { op: "local.get", index: localRet },
        { op: "local.get", index: localChunk },
        { op: "i32.add" },
        { op: "global.set", index: arenaLimitGlobalIdx },
        // Recompute the bump position inside the fresh chunk.
        { op: "local.get", index: localRet },
        { op: "local.get", index: 0 },
        { op: "i32.add" },
        { op: "i32.const", value: 7 },
        { op: "i32.add" },
        { op: "i32.const", value: -8 },
        { op: "i32.and" },
        { op: "local.set", index: localNext },
      ],
      else: [],
    },
    // ret = __heap_ptr (after any carve)
    { op: "global.get", index: heapPtrGlobalIdx },
    { op: "local.set", index: localRet },
  ];
}

/**
 * Install the linked-mode read-only data image.
 *
 * ### The hazard this removes
 *
 * An **active** data segment is written by the runtime at instantiation, at the
 * offset baked into the binary, with no code of ours running and nothing to
 * check. In the ADR-0020 topology that offset addresses the *engine's* memory:
 * measured against the pinned artifact, our three default bases — 64 (string
 * literals), 1024 (Ryū tables) and 16384 (literals when Ryū is linked) — all
 * fall inside its 64 KiB shadow stack, and the Ryū heap floor of 65536 lands on
 * the first byte of its static data. The module corrupts the engine *before its
 * first instruction executes*, so no amount of care in our generated code can
 * help.
 *
 * ### What replaces it
 *
 * The literal bytes become one **passive** segment, which is inert at
 * instantiation. A start function allocates a block through `__malloc` (which,
 * in this mode, carves from the engine's own allocator) and `memory.init`s the
 * image into it — so the image lives at an address the engine gave us.
 *
 * Literal *references* are rebased with a single global. Because the image
 * preserves the link-time layout exactly, one bias — `runtimeBase - imageBase`
 * — corrects every offset in it, and each literal site becomes
 * `global.get $__rodata_bias; i32.const <link-time offset>; i32.add`.
 * Rebasing per site rather than inside `__str_from_data` is deliberate: that
 * helper is also called by the C ABI wrappers with a *caller-supplied* pointer,
 * and biasing those would corrupt every string crossing the C boundary.
 *
 * `data.drop` releases the segment afterwards; the start function runs exactly
 * once, so there is no second reader.
 *
 * ### Ordering requirement (stated because it is not enforceable from here)
 *
 * The start function calls the engine's allocator, so the engine must exist and
 * have run its reactor `_initialize` before our module is instantiated. That is
 * the linked topology's normal order.
 *
 * @param imageBase the link-time base the literal offsets were assigned from.
 */
export function finalizeLinkedDataImage(mod: WasmModule, biasGlobalIdx: number, imageBase: number): void {
  // The assertion the acceptance criteria ask for: in linked mode an active
  // segment is not a style problem, it is memory corruption, so refuse to emit
  // one at all rather than lint for it after the fact.
  const active = (mod.dataSegments ?? []).filter((seg) => !seg.passive);
  if (active.length > 0) {
    const where = active.map((seg) => `[${seg.offset}, ${seg.offset + seg.bytes.length})`).join(", ");
    throw new Error(
      `linear runtime: ${active.length} ACTIVE data segment(s) ${where} in linked mode. An active ` +
        "segment is written at its link-time offset into a memory this module does not own, " +
        "straight through the engine's shadow stack or static data. Emit passive segments and " +
        "copy them into an allocated block instead (#4540).",
    );
  }
  const dataIdx = (mod.dataSegments ?? []).findIndex((seg) => seg.passive);
  if (dataIdx < 0) return; // no literal data — nothing to place, bias stays 0

  const imageLen = mod.dataSegments[dataIdx]!.bytes.length;
  const numImportFuncs = mod.imports.filter((imp) => imp.desc.kind === "func").length;
  const mallocPosition = mod.functions.findIndex((fn) => fn.name === "__malloc");
  if (mallocPosition < 0) throw new Error("linear runtime: __malloc missing when placing the linked data image");
  const mallocIdx = numImportFuncs + mallocPosition;

  const typeIdx = mod.types.length;
  mod.types.push({ kind: "func", name: "$type___init_rodata", params: [], results: [] });
  const position = mod.functions.length;
  mod.functions.push({
    name: "__init_rodata",
    typeIdx,
    locals: [{ name: "__rodata_base", type: { kind: "i32" } }],
    body: [
      { op: "i32.const", value: imageLen },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: 0 },
      // memory.init dest=base, src_offset=0, len=imageLen
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: imageLen },
      { op: "memory.init", dataIdx },
      { op: "data.drop", dataIdx },
      // bias = runtimeBase - linkTimeBase
      { op: "local.get", index: 0 },
      { op: "i32.const", value: imageBase },
      { op: "i32.sub" },
      { op: "global.set", index: biasGlobalIdx },
    ],
    exported: false,
  });

  if (mod.startFuncIdx !== undefined) {
    throw new Error(
      "linear runtime: a start function is already installed; the linked data image needs to run " +
        "before any user code and cannot be sequenced behind one (#4540).",
    );
  }
  mod.startFuncIdx = numImportFuncs + position;
}
