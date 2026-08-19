// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * A real allocator for the linear lane — `malloc`, `calloc`, `free`, `realloc`,
 * `malloc_usable_size` — so that the QuickJS artifact can allocate through US
 * (#4557, ADR-0020 Decision 6, allocator half).
 *
 * ### Why this exists at all
 *
 * ADR-0017 chose a bump arena and deferred reclamation, while explicitly
 * reserving "one fixed strategy, chosen and recorded then, not abstracted now".
 * This is that choice arriving, and the trigger is concrete: QuickJS's
 * `JS_NewRuntime2` takes a `JSMallocFunctions` whose members include a real
 * `free`, `realloc` and `usable_size`. A bump arena has no honest
 * implementation of any of the three, so the ownership inversion is gated on
 * writing an allocator rather than on wiring one up. #4540 shipped the mirror
 * image — our arena carved from the ENGINE's `malloc` — and kept it as the
 * documented fallback; this module is the other direction.
 *
 * ### Layout — boundary tags, the classic Knuth/dlmalloc shape
 *
 * Every block carries a 4-byte header at its base; the payload starts at
 * `base + 4`. Block bases are therefore ≡ 4 (mod 8) and payloads ≡ 0 (mod 8),
 * which is the 8-byte alignment the rest of the linear backend already assumes.
 *
 * ```text
 *   allocated:  [ size | PINUSE | INUSE ][ payload … ]
 *   free:       [ size | PINUSE         ][ next ][ prev ][ … ][ size (footer) ]
 * ```
 *
 * `size` is the WHOLE block including the header and is always a multiple of 8,
 * so the low three bits are free for flags. The footer exists only in free
 * blocks, which is what lets `free()` coalesce BACKWARD: a block whose PINUSE
 * bit is clear knows its predecessor is free and can read that predecessor's
 * size out of the 4 bytes immediately below its own header. Forward coalescing
 * needs no footer — the next header is at `base + size`.
 *
 * Each region ends with an **epilogue**: a 4-byte header with size 0 and INUSE
 * set. It is never allocatable (size 0 fails every fit test) and it makes
 * "walk forward and coalesce" terminate without a bounds check on the hot path.
 *
 * ### Where the metadata lives (this is the part that is NOT textbook)
 *
 * A textbook allocator puts its bin array at a link-time address. This backend
 * may not name an address at all in linked mode — see ADR-0022 — so the control
 * block is carved out of the FIRST region the allocator acquires, and one
 * mutable global (`__heap_ctl`) points at it. Everything else is reached
 * through that pointer.
 *
 * ### Where the memory comes from
 *
 * Region acquisition is a parameter, not a decision baked in here:
 *
 * - **linked mode** — regions come from the imported host `malloc`. The module
 *   still contains no `memory.grow`, so #4540's "the memory's owner is the only
 *   grower" property is preserved by construction rather than traded away for
 *   reclamation.
 * - **standalone** — regions come from `memory.grow`, and the allocator uses
 *   ONLY pages it grew itself. That is the substantive difference from the
 *   pre-#4540 arena, which claimed everything from its bump pointer to the end
 *   of memory whether or not it had obtained it.
 *
 * ### Bins
 *
 * 32 exact-size small bins (16, 24, … 264 bytes) give O(1) allocation for the
 * sizes a JS engine actually allocates, then 16 power-of-two large bins that
 * are scanned for the first fit. dlmalloc is tuned for precisely this
 * workload; see #4557 for the measured comparison, which is the number that
 * decides whether this path or the #4540 fallback is the default.
 */
import type { FuncTypeDef, Instr, ValType, WasmModule } from "../ir/types.js";

/** Wasm page size in bytes — the unit `memory.grow` operates on. */
const WASM_PAGE_SIZE = 65536;

/** Bytes of block header. The payload begins immediately after it. */
const HDR = 4;
/** Smallest block: header + next + prev + footer. Nothing smaller can be free. */
const MIN_BLOCK = 16;
/** Header bit 0 — this block is allocated. */
const INUSE = 1;
/** Header bit 1 — the PHYSICALLY PRECEDING block is allocated. */
const PINUSE = 2;
/** `hdr & SIZE_MASK` is the block size; sizes are always multiples of 8. */
const SIZE_MASK = -8;

/** Exact-size bins, covering 16, 24, … 264 bytes. */
const NSMALL = 32;
/** Power-of-two bins above that, the last one unbounded. */
const NLARGE = 16;
const NBINS = NSMALL + NLARGE;
/** Largest size served by an exact-size bin. */
const SMALL_MAX = MIN_BLOCK + 8 * (NSMALL - 1); // 264

/** Control-block field offsets, in bytes from `__heap_ctl`. */
const CTL_BINS = 0;
const CTL_NEXT_REGION = CTL_BINS + NBINS * 4; // 192
const CTL_TOTAL_BYTES = CTL_NEXT_REGION + 4; // 196
const CTL_REGION_COUNT = CTL_TOTAL_BYTES + 4; // 200
/**
 * Request-size histogram, 16 log2 buckets: bucket `b` counts requests in
 * `[2^(b+3), 2^(b+4))`, with `b = 0` catching everything below 16 bytes and
 * `b = 15` everything from 256 KiB up.
 *
 * Not decoration. #4557 assumed the engine would hand this allocator "many
 * small, short-lived objects" — the pattern dlmalloc is tuned for and the
 * stated risk of losing on. Measured, quickjs-ng v0.16.1 does NOT: it has its
 * own 4 KiB size-class arena (`JSArenaState`) between the interpreter and
 * `JSMallocFunctions`, so what reaches us is a few hundred mid-sized blocks,
 * not tens of thousands of tiny ones. A benchmark is only honest if it is run
 * on the distribution that actually arrives, so the distribution is measurable.
 */
const CTL_HIST = 208;
const HIST_BUCKETS = 16;
const CTL_BYTES = CTL_HIST + HIST_BUCKETS * 4; // 272

/** Region size cap — beyond this, asking for more just fragments harder. */
const MAX_REGION_BYTES = 8 * 1024 * 1024;

/** Global holding the control-block address; 0 until the first allocation. */
export const HEAP_CTL_GLOBAL = "__heap_ctl";

/**
 * Per-entry-point call counters, read back through `__heap_stats(4..7)`.
 *
 * They exist because #4557's acceptance criterion is that the engine reaches
 * this allocator **proven by counting calls, not inferred from the wiring**.
 * Counting on the JS side would mean putting a JS closure on the allocation
 * path, which both changes what is being measured and violates the artifact's
 * no-JS-behind-the-seam rule; counting here counts the calls that actually
 * happened, in the module that served them.
 */
const COUNTER_GLOBALS = ["__heap_n_alloc", "__heap_n_free", "__heap_n_realloc", "__heap_n_calloc"] as const;

/**
 * Export names the QuickJS artifact installs as its `JSMallocFunctions`.
 *
 * They are **exports, not the far side of imports**: the artifact must stay
 * instantiable with no peer at all (`extract-abi.mjs` instantiates it alone),
 * so `qjs_set_allocator` takes `__indirect_function_table` slot indices the way
 * the #4245 membrane does, and a harness stores these functions into that
 * table. The ORDER in `qjs_set_allocator`'s signature is part of the ABI.
 */
export const ENGINE_ALLOC_EXPORTS = {
  malloc: "js2wasm_malloc",
  calloc: "js2wasm_calloc",
  free: "js2wasm_free",
  realloc: "js2wasm_realloc",
  usableSize: "js2wasm_usable_size",
} as const;

/** Options for {@link addHeapAllocatorRuntime}. */
export interface HeapAllocatorOptions {
  /**
   * Function index of the region source, signature `(i32 bytes) -> i32 ptr`,
   * returning 0 on failure. When omitted the allocator grows the memory itself
   * (`memory.grow`) and uses only the pages it obtained that way.
   *
   * In the ADR-0020 link topology this is the ENGINE's `malloc`, which keeps
   * "the memory's owner is its only grower" true while still giving us a real
   * allocator on top.
   */
  regionSourceFuncIdx?: number;
  /** Bytes in the first region, and the floor for every later one. */
  regionBytes?: number;
  /** Export the five engine-facing entry points (default true). */
  exportForEngine?: boolean;
}

/** Default first-region size: one Wasm page. */
export const HEAP_DEFAULT_REGION_BYTES = WASM_PAGE_SIZE;

// ─────────────────────────── instruction shorthands ──────────────────────────
// The bodies below are long enough that spelled-out object literals bury the
// algorithm. These are the same literals, named.

const i32c = (value: number): Instr => ({ op: "i32.const", value });
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const tee = (index: number): Instr => ({ op: "local.tee", index });
const gget = (index: number): Instr => ({ op: "global.get", index });
const gset = (index: number): Instr => ({ op: "global.set", index });
const load = (offset = 0): Instr => ({ op: "i32.load", align: 2, offset });
const store = (offset = 0): Instr => ({ op: "i32.store", align: 2, offset });
const call = (funcIdx: number): Instr => ({ op: "call", funcIdx });
const add: Instr = { op: "i32.add" };
const sub: Instr = { op: "i32.sub" };
const mul: Instr = { op: "i32.mul" };
const and: Instr = { op: "i32.and" };
const or: Instr = { op: "i32.or" };
const shl: Instr = { op: "i32.shl" };
const shrU: Instr = { op: "i32.shr_u" };
const eqz: Instr = { op: "i32.eqz" };
const eq: Instr = { op: "i32.eq" };
const ne: Instr = { op: "i32.ne" };
const ltU: Instr = { op: "i32.lt_u" };
const leU: Instr = { op: "i32.le_u" };
const gtU: Instr = { op: "i32.gt_u" };
const geU: Instr = { op: "i32.ge_u" };
const gtS: Instr = { op: "i32.gt_s" };
const clz: Instr = { op: "i32.clz" };
const ret: Instr = { op: "return" };
const EMPTY = { kind: "empty" } as const;
const I32 = { kind: "val", type: { kind: "i32" } } as const;

const iff = (then: Instr[], els: Instr[] = []): Instr => ({ op: "if", blockType: EMPTY, then, else: els });
const iffI32 = (then: Instr[], els: Instr[]): Instr => ({ op: "if", blockType: I32, then, else: els });

/** `hdr(b) & SIZE_MASK` — the block size behind an address already on the stack. */
const sizeOfLoaded: Instr[] = [load(0), i32c(SIZE_MASK), and];

// ─────────────────────────────── module builder ──────────────────────────────

interface Ctx {
  mod: WasmModule;
  ctlGlobalIdx: number;
  /** Index of the first counter global; the four are consecutive. */
  counterBaseIdx: number;
  regionSourceFuncIdx?: number;
  regionBytes: number;
  /** Resolved indices of the functions emitted so far. */
  idx: Map<string, number>;
}

/** `++counter[n]`, four instructions on the entry point's hot path. */
const bump = (ctx: Ctx, n: number): Instr[] => [
  gget(ctx.counterBaseIdx + n),
  i32c(1),
  add,
  gset(ctx.counterBaseIdx + n),
];

function emit(
  ctx: Ctx,
  name: string,
  params: ValType[],
  results: ValType[],
  extraLocals: number,
  body: (l: (n: number) => number) => Instr[],
): void {
  const typeIdx = ctx.mod.types.length;
  const type: FuncTypeDef = { kind: "func", name: `$type_${name}`, params, results };
  ctx.mod.types.push(type);
  const locals = [];
  for (let i = 0; i < extraLocals; i++) locals.push({ name: `${name}_l${i}`, type: { kind: "i32" as const } });
  const first = params.length;
  const position = ctx.mod.functions.length;
  ctx.mod.functions.push({
    name,
    typeIdx,
    locals,
    body: body((n) => first + n),
    exported: false,
  });
  const numImportFuncs = ctx.mod.imports.filter((imp) => imp.desc.kind === "func").length;
  ctx.idx.set(name, numImportFuncs + position);
}

const fn = (ctx: Ctx, name: string): number => {
  const found = ctx.idx.get(name);
  if (found === undefined) throw new Error(`heap allocator: ${name} referenced before it was emitted`);
  return found;
};

/**
 * Add the linear-lane allocator (#4557).
 *
 * Emits, in dependency order so every index is resolved by the time it is
 * referenced: `__heap_bin`, `__heap_insert`, `__heap_unlink`, `__heap_install`,
 * `__heap_init`, `__heap_more`, `__heap_find`, `__heap_alloc`, `__heap_free`,
 * `__heap_usable`, `__heap_calloc`, `__heap_realloc`, `__heap_stats`.
 *
 * Must be called BEFORE `__malloc` is created: in this mode `__malloc` becomes
 * a bump arena carved from `__heap_alloc`, so it needs this allocator's index.
 */
export function addHeapAllocatorRuntime(mod: WasmModule, opts: HeapAllocatorOptions = {}): void {
  if (mod.globals.some((g) => g.name === HEAP_CTL_GLOBAL)) {
    throw new Error("heap allocator: already installed on this module (#4557)");
  }
  const ctlGlobalIdx = mod.globals.length;
  mod.globals.push({
    name: HEAP_CTL_GLOBAL,
    type: { kind: "i32" },
    mutable: true,
    init: [i32c(0)],
  });
  const counterBaseIdx = mod.globals.length;
  for (const name of COUNTER_GLOBALS) {
    mod.globals.push({ name, type: { kind: "i32" }, mutable: true, init: [i32c(0)] });
  }
  const ctx: Ctx = {
    mod,
    ctlGlobalIdx,
    counterBaseIdx,
    regionSourceFuncIdx: opts.regionSourceFuncIdx,
    regionBytes: opts.regionBytes ?? HEAP_DEFAULT_REGION_BYTES,
    idx: new Map(),
  };

  emitBin(ctx);
  emitInsert(ctx);
  emitUnlink(ctx);
  emitInstall(ctx);
  emitAcquire(ctx);
  emitInit(ctx);
  emitMore(ctx);
  emitFind(ctx);
  emitAlloc(ctx);
  emitFree(ctx);
  emitUsable(ctx);
  emitCalloc(ctx);
  emitRealloc(ctx);
  emitStats(ctx);

  if (opts.exportForEngine !== false) {
    const exportPairs: [string, string][] = [
      [ENGINE_ALLOC_EXPORTS.malloc, "__heap_alloc"],
      [ENGINE_ALLOC_EXPORTS.calloc, "__heap_calloc"],
      [ENGINE_ALLOC_EXPORTS.free, "__heap_free"],
      [ENGINE_ALLOC_EXPORTS.realloc, "__heap_realloc"],
      [ENGINE_ALLOC_EXPORTS.usableSize, "__heap_usable"],
    ];
    for (const [exportName, funcName] of exportPairs) {
      mod.exports.push({ name: exportName, desc: { kind: "func", index: fn(ctx, funcName) } });
    }
    // Not part of the engine ABI; exported so a test can assert the heap is
    // BOUNDED rather than infer it from the absence of a crash.
    mod.exports.push({ name: "__heap_stats", desc: { kind: "func", index: fn(ctx, "__heap_stats") } });
  }
}

/** Index of the raw allocator entry point, for the bump arena to carve from. */
export function heapAllocFuncIndex(mod: WasmModule): number {
  const numImportFuncs = mod.imports.filter((imp) => imp.desc.kind === "func").length;
  const position = mod.functions.findIndex((f) => f.name === "__heap_alloc");
  if (position < 0) throw new Error("heap allocator: __heap_alloc not found (#4557)");
  return numImportFuncs + position;
}

// ───────────────────────────────── the bodies ────────────────────────────────

/**
 * `__heap_bin(size) -> bin` — the free list a block of `size` belongs in.
 *
 * Small sizes get an EXACT bin, which is what makes allocation O(1) for the
 * many-small-objects pattern a JS engine actually produces: any non-empty bin
 * at or above the requested index is guaranteed to fit, with no list walk.
 * Above `SMALL_MAX` the bins are power-of-two ranges and the caller must check
 * each candidate's size.
 */
function emitBin(ctx: Ctx): void {
  emit(ctx, "__heap_bin", [{ kind: "i32" }], [{ kind: "i32" }], 1, (l) => {
    const t = l(0);
    return [
      get(0),
      i32c(SMALL_MAX),
      leU,
      iffI32(
        [get(0), i32c(3), shrU, i32c(MIN_BLOCK / 8), sub],
        [
          // floor(log2(size)) - 8, clamped into the large-bin range.
          i32c(31),
          get(0),
          clz,
          sub,
          i32c(8),
          sub,
          set(t),
          i32c(NLARGE - 1),
          get(t),
          get(t),
          i32c(NLARGE - 1),
          gtS,
          { op: "select" },
          i32c(NSMALL),
          add,
        ],
      ),
    ];
  });
}

/** `__heap_insert(b, size)` — push a free block onto the head of its bin. */
function emitInsert(ctx: Ctx): void {
  const binIdx = fn(ctx, "__heap_bin");
  emit(ctx, "__heap_insert", [{ kind: "i32" }, { kind: "i32" }], [], 2, (l) => {
    const slot = l(0);
    const head = l(1);
    return [
      // slot = ctl + bin(size) * 4
      gget(ctx.ctlGlobalIdx),
      get(1),
      call(binIdx),
      i32c(4),
      mul,
      add,
      tee(slot),
      load(CTL_BINS),
      set(head),
      get(0),
      get(head),
      store(4), // b.next = head
      get(0),
      i32c(0),
      store(8), // b.prev = 0
      get(head),
      iff([get(head), get(0), store(8)]), // head.prev = b
      get(slot),
      get(0),
      store(CTL_BINS), // bin head = b
    ];
  });
}

/** `__heap_unlink(b)` — remove a free block from whichever bin holds it. */
function emitUnlink(ctx: Ctx): void {
  const binIdx = fn(ctx, "__heap_bin");
  emit(ctx, "__heap_unlink", [{ kind: "i32" }], [], 2, (l) => {
    const nxt = l(0);
    const prv = l(1);
    return [
      get(0),
      load(4),
      set(nxt),
      get(0),
      load(8),
      set(prv),
      get(prv),
      iff(
        [get(prv), get(nxt), store(4)],
        // No predecessor: this block IS the bin head, so the bin slot moves.
        [gget(ctx.ctlGlobalIdx), get(0), ...sizeOfLoaded, call(binIdx), i32c(4), mul, add, get(nxt), store(CTL_BINS)],
      ),
      get(nxt),
      iff([get(nxt), get(prv), store(8)]),
    ];
  });
}

/**
 * `__heap_install(p, n) -> ok` — turn a raw `[p, p+n)` region into one free
 * block plus its epilogue, and file it.
 *
 * The arithmetic exists to keep block bases ≡ 4 (mod 8), so that payloads come
 * out 8-aligned: `base` is the first such address at or above `p`, and the
 * epilogue sits at the last such address whose 4 header bytes still fit.
 */
function emitInstall(ctx: Ctx): void {
  const insertIdx = fn(ctx, "__heap_insert");
  emit(ctx, "__heap_install", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], 3, (l) => {
    const base = l(0);
    const epi = l(1);
    const size = l(2);
    return [
      get(1),
      i32c(MIN_BLOCK + 16),
      ltU,
      iff([i32c(0), ret]),
      // base = align8(p) + 4
      get(0),
      i32c(7),
      add,
      i32c(-8),
      and,
      i32c(HDR),
      add,
      set(base),
      // epi = align8down(p + n - 8) + 4  (so epi + 4 <= p + n, epi ≡ 4 mod 8)
      get(0),
      get(1),
      add,
      i32c(8),
      sub,
      i32c(-8),
      and,
      i32c(HDR),
      add,
      set(epi),
      get(epi),
      get(base),
      leU,
      iff([i32c(0), ret]),
      get(epi),
      get(base),
      sub,
      tee(size),
      i32c(MIN_BLOCK),
      ltU,
      iff([i32c(0), ret]),
      // The sole free block: PINUSE set so backward coalescing stops here.
      get(base),
      get(size),
      i32c(PINUSE),
      or,
      store(0),
      get(base),
      get(size),
      add,
      i32c(HDR),
      sub,
      get(size),
      store(0), // footer at base + size - 4
      // Epilogue: size 0, allocated, preceded by a free block.
      get(epi),
      i32c(INUSE),
      store(0),
      get(base),
      get(size),
      call(insertIdx),
      i32c(1),
    ];
  });
}

/**
 * `__heap_acquire(bytes) -> ptr` — one region from the configured source.
 *
 * Standalone grows the memory and hands back the pages it just obtained, which
 * is the whole difference from the pre-#4540 arena: those pages are ours
 * because we asked for them, not because they were above a bump pointer.
 */
function emitAcquire(ctx: Ctx): void {
  const source = ctx.regionSourceFuncIdx;
  emit(ctx, "__heap_acquire", [{ kind: "i32" }], [{ kind: "i32" }], 1, (l) => {
    if (source !== undefined) return [get(0), call(source)];
    const prev = l(0);
    return [
      // pages = ceil(bytes / 65536)
      get(0),
      i32c(WASM_PAGE_SIZE - 1),
      add,
      i32c(16),
      shrU,
      { op: "memory.grow" },
      tee(prev),
      i32c(-1),
      eq,
      iff([i32c(0), ret]),
      get(prev),
      i32c(16),
      shl,
    ];
  });
}

/**
 * `__heap_init() -> ok` — acquire the first region and carve the control block
 * out of its head.
 *
 * The control block cannot live at a link-time address (ADR-0022: in linked
 * mode this module may not name one), so it is the first thing allocated and
 * `__heap_ctl` is the only fixed thing about the heap.
 */
function emitInit(ctx: Ctx): void {
  const acquireIdx = fn(ctx, "__heap_acquire");
  const installIdx = fn(ctx, "__heap_install");
  const first = Math.max(ctx.regionBytes, CTL_BYTES + MIN_BLOCK + 32);
  emit(ctx, "__heap_init", [], [{ kind: "i32" }], 2, (l) => {
    const p = l(0);
    const ctl = l(1);
    return [
      gget(ctx.ctlGlobalIdx),
      iff([i32c(1), ret]),
      i32c(first),
      call(acquireIdx),
      tee(p),
      eqz,
      iff([i32c(0), ret]),
      get(p),
      i32c(7),
      add,
      i32c(-8),
      and,
      tee(ctl),
      i32c(0),
      i32c(CTL_BYTES),
      { op: "memory.fill" },
      get(ctl),
      gset(ctx.ctlGlobalIdx),
      get(ctl),
      i32c(Math.min(first * 2, MAX_REGION_BYTES)),
      store(CTL_NEXT_REGION),
      get(ctl),
      i32c(first),
      store(CTL_TOTAL_BYTES),
      get(ctl),
      i32c(1),
      store(CTL_REGION_COUNT),
      // Whatever is left of the first region after the control block is heap.
      get(ctl),
      i32c(CTL_BYTES),
      add,
      get(p),
      i32c(first),
      add,
      get(ctl),
      sub,
      i32c(CTL_BYTES),
      sub,
      call(installIdx),
    ];
  });
}

/**
 * `__heap_more(need) -> ok` — acquire another region big enough for a `need`
 * byte block.
 *
 * The region size grows geometrically so a long-running workload does not pay
 * a host-allocator call per page, and is capped so a single huge region cannot
 * strand most of itself. On failure it retries once at the minimum size: under
 * memory pressure the difference between "the heap is full" and "the
 * geometric next step was too greedy" is worth one extra call.
 */
function emitMore(ctx: Ctx): void {
  const acquireIdx = fn(ctx, "__heap_acquire");
  const installIdx = fn(ctx, "__heap_install");
  emit(ctx, "__heap_more", [{ kind: "i32" }], [{ kind: "i32" }], 3, (l) => {
    const want = l(0);
    const p = l(1);
    const floor = l(2);
    return [
      gget(ctx.ctlGlobalIdx),
      load(CTL_NEXT_REGION),
      set(want),
      get(0),
      i32c(CTL_BYTES),
      add,
      tee(floor),
      get(want),
      gtU,
      iff([get(floor), set(want)]),
      get(want),
      call(acquireIdx),
      set(p),
      get(p),
      eqz,
      iff([
        get(want),
        get(floor),
        gtU,
        iff([get(floor), tee(want), call(acquireIdx), set(p)]),
        get(p),
        eqz,
        iff([i32c(0), ret]),
      ]),
      get(p),
      get(want),
      call(installIdx),
      eqz,
      iff([i32c(0), ret]),
      gget(ctx.ctlGlobalIdx),
      gget(ctx.ctlGlobalIdx),
      load(CTL_TOTAL_BYTES),
      get(want),
      add,
      store(CTL_TOTAL_BYTES),
      gget(ctx.ctlGlobalIdx),
      gget(ctx.ctlGlobalIdx),
      load(CTL_REGION_COUNT),
      i32c(1),
      add,
      store(CTL_REGION_COUNT),
      // Next region is twice this one, capped.
      gget(ctx.ctlGlobalIdx),
      i32c(MAX_REGION_BYTES),
      get(want),
      i32c(1),
      shl,
      get(want),
      i32c(1),
      shl,
      i32c(MAX_REGION_BYTES),
      gtU,
      { op: "select" },
      store(CTL_NEXT_REGION),
      i32c(1),
    ];
  });
}

/**
 * `__heap_find(blk) -> b` — first free block of at least `blk` bytes, or 0.
 *
 * Small bins are exact-size, so the first non-empty bin at or above the
 * requested index fits without inspection. Large bins hold a range, so their
 * lists are walked. Both are first-fit; best-fit was not chosen because the
 * exact-size small bins already make the common case exact.
 */
function emitFind(ctx: Ctx): void {
  const binIdx = fn(ctx, "__heap_bin");
  emit(ctx, "__heap_find", [{ kind: "i32" }], [{ kind: "i32" }], 2, (l) => {
    const i = l(0);
    const b = l(1);
    return [
      get(0),
      call(binIdx),
      set(i),
      {
        op: "block",
        blockType: EMPTY,
        body: [
          {
            op: "loop",
            blockType: EMPTY,
            body: [
              get(i),
              i32c(NBINS),
              geU,
              { op: "br_if", depth: 1 },
              gget(ctx.ctlGlobalIdx),
              get(i),
              i32c(4),
              mul,
              add,
              load(CTL_BINS),
              set(b),
              get(i),
              i32c(NSMALL),
              ltU,
              iff(
                // Exact-size bin: non-empty means it fits.
                [get(b), iff([get(b), ret])],
                // Range bin: walk for the first that fits.
                [
                  {
                    op: "block",
                    blockType: EMPTY,
                    body: [
                      {
                        op: "loop",
                        blockType: EMPTY,
                        body: [
                          get(b),
                          eqz,
                          { op: "br_if", depth: 1 },
                          get(b),
                          ...sizeOfLoaded,
                          get(0),
                          geU,
                          iff([get(b), ret]),
                          get(b),
                          load(4),
                          set(b),
                          { op: "br", depth: 0 },
                        ],
                      },
                    ],
                  },
                ],
              ),
              get(i),
              i32c(1),
              add,
              set(i),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      i32c(0),
    ];
  });
}

/**
 * `__heap_alloc(size) -> payload` — the allocator proper. Returns 0 on failure
 * rather than trapping, because that is what `JSMallocFunctions` expects: the
 * engine turns a NULL into a JS out-of-memory error, which is a far better
 * outcome than a trap inside foreign code.
 */
function emitAlloc(ctx: Ctx): void {
  const initIdx = fn(ctx, "__heap_init");
  const moreIdx = fn(ctx, "__heap_more");
  const findIdx = fn(ctx, "__heap_find");
  const unlinkIdx = fn(ctx, "__heap_unlink");
  const insertIdx = fn(ctx, "__heap_insert");
  emit(ctx, "__heap_alloc", [{ kind: "i32" }], [{ kind: "i32" }], 5, (l) => {
    const blk = l(0);
    const b = l(1);
    const s = l(2);
    const rem = l(3);
    const bucket = l(4);
    /** `++hist[clamp(floor(log2(size)) - 3, 0, 15)]`, after ctl exists. */
    const recordSize: Instr[] = [
      i32c(31),
      get(0),
      i32c(1),
      or,
      clz,
      sub,
      i32c(3),
      sub,
      tee(bucket),
      i32c(0),
      gtS,
      iff([], [i32c(0), set(bucket)]),
      get(bucket),
      i32c(HIST_BUCKETS - 1),
      gtS,
      iff([i32c(HIST_BUCKETS - 1), set(bucket)]),
      gget(ctx.ctlGlobalIdx),
      get(bucket),
      i32c(4),
      mul,
      add,
      gget(ctx.ctlGlobalIdx),
      get(bucket),
      i32c(4),
      mul,
      add,
      load(CTL_HIST),
      i32c(1),
      add,
      store(CTL_HIST),
    ];
    return [
      ...bump(ctx, 0),
      // A request that overflows the block-size arithmetic is a failure, not a
      // wrap-around into a tiny allocation.
      get(0),
      i32c(0x7ffffff0),
      gtU,
      iff([i32c(0), ret]),
      get(0),
      i32c(HDR + 7),
      add,
      i32c(-8),
      and,
      tee(blk),
      i32c(MIN_BLOCK),
      ltU,
      iff([i32c(MIN_BLOCK), set(blk)]),
      gget(ctx.ctlGlobalIdx),
      eqz,
      iff([call(initIdx), eqz, iff([i32c(0), ret])]),
      ...recordSize,
      get(blk),
      call(findIdx),
      tee(b),
      eqz,
      iff([
        get(blk),
        call(moreIdx),
        eqz,
        iff([i32c(0), ret]),
        get(blk),
        call(findIdx),
        tee(b),
        eqz,
        iff([i32c(0), ret]),
      ]),
      get(b),
      ...sizeOfLoaded,
      set(s),
      get(b),
      call(unlinkIdx),
      get(s),
      get(blk),
      sub,
      tee(rem),
      i32c(MIN_BLOCK),
      geU,
      iff(
        [
          // Split. The remainder's PINUSE is set (we are allocated); the block
          // after the remainder already has PINUSE clear, because the block we
          // just split was free.
          get(b),
          get(blk),
          get(b),
          load(0),
          i32c(PINUSE),
          and,
          or,
          i32c(INUSE),
          or,
          store(0),
          get(b),
          get(blk),
          add,
          get(rem),
          i32c(PINUSE),
          or,
          store(0),
          get(b),
          get(s),
          add,
          i32c(HDR),
          sub,
          get(rem),
          store(0), // remainder footer at b + s - 4
          get(b),
          get(blk),
          add,
          get(rem),
          call(insertIdx),
        ],
        [
          // Too small to split: hand out the whole block and tell the physical
          // successor that its predecessor is now in use.
          get(b),
          get(s),
          get(b),
          load(0),
          i32c(PINUSE),
          and,
          or,
          i32c(INUSE),
          or,
          store(0),
          get(b),
          get(s),
          add,
          get(b),
          get(s),
          add,
          load(0),
          i32c(PINUSE),
          or,
          store(0),
        ],
      ),
      get(b),
      i32c(HDR),
      add,
    ];
  });
}

/**
 * `__heap_free(payload)` — coalesce both ways and file the result.
 *
 * Freeing something this allocator did not hand out TRAPS rather than
 * corrupting the heap. The alternative — silently ignoring it — would turn a
 * caller bug into a leak plus a later mystery, and this allocator's callers
 * include an engine whose heap we would be corrupting.
 */
function emitFree(ctx: Ctx): void {
  const unlinkIdx = fn(ctx, "__heap_unlink");
  const insertIdx = fn(ctx, "__heap_insert");
  emit(ctx, "__heap_free", [{ kind: "i32" }], [], 3, (l) => {
    const b = l(0);
    const s = l(1);
    const nb = l(2);
    return [
      ...bump(ctx, 1),
      get(0),
      eqz,
      iff([ret]),
      get(0),
      i32c(HDR),
      sub,
      set(b),
      // Not an allocated block of ours: fail loudly.
      get(b),
      load(0),
      i32c(INUSE),
      and,
      eqz,
      iff([{ op: "unreachable" }]),
      get(b),
      ...sizeOfLoaded,
      tee(s),
      i32c(MIN_BLOCK),
      ltU,
      iff([{ op: "unreachable" }]),
      // Forward coalesce.
      get(b),
      get(s),
      add,
      tee(nb),
      load(0),
      i32c(INUSE),
      and,
      eqz,
      iff([get(nb), call(unlinkIdx), get(s), get(nb), ...sizeOfLoaded, add, set(s)]),
      // Backward coalesce, through the predecessor's footer.
      get(b),
      load(0),
      i32c(PINUSE),
      and,
      eqz,
      iff([
        get(s),
        get(b),
        i32c(HDR),
        sub,
        load(0),
        add,
        set(s),
        get(b),
        get(b),
        i32c(HDR),
        sub,
        load(0),
        sub,
        tee(b),
        call(unlinkIdx),
      ]),
      get(b),
      get(s),
      get(b),
      load(0),
      i32c(PINUSE),
      and,
      or,
      store(0),
      get(b),
      get(s),
      add,
      i32c(HDR),
      sub,
      get(s),
      store(0), // footer at b + s - 4
      // Tell the physical successor its predecessor is free.
      get(b),
      get(s),
      add,
      get(b),
      get(s),
      add,
      load(0),
      i32c(-3),
      and,
      store(0),
      get(b),
      get(s),
      call(insertIdx),
    ];
  });
}

/**
 * `__heap_usable(payload) -> bytes` — the TRUE reserved payload size.
 *
 * This is deliberately not "what the caller asked for". QuickJS drives
 * `JS_SetMemoryLimit` and `JS_SetGCThreshold` off this number, so reporting the
 * request rather than the reservation would under-count the heap and delay
 * collection — a footprint mystery with no visible connection to its cause. A
 * block that was too small to split carries its whole remainder here.
 */
function emitUsable(ctx: Ctx): void {
  emit(ctx, "__heap_usable", [{ kind: "i32" }], [{ kind: "i32" }], 0, () => [
    get(0),
    eqz,
    iff([i32c(0), ret]),
    get(0),
    i32c(HDR),
    sub,
    ...sizeOfLoaded,
    i32c(HDR),
    sub,
  ]);
}

/** `__heap_calloc(count, size) -> payload`, with an overflow-safe product. */
function emitCalloc(ctx: Ctx): void {
  const allocIdx = fn(ctx, "__heap_alloc");
  emit(ctx, "__heap_calloc", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], 2, (l) => {
    const total = l(0);
    const p = l(1);
    return [
      ...bump(ctx, 3),
      get(0),
      eqz,
      iff(
        [i32c(0), set(total)],
        [get(0), get(1), mul, tee(total), get(0), { op: "i32.div_u" }, get(1), ne, iff([i32c(0), ret])],
      ),
      get(total),
      call(allocIdx),
      tee(p),
      eqz,
      iff([i32c(0), ret]),
      get(total),
      iff([get(p), i32c(0), get(total), { op: "memory.fill" }]),
      get(p),
    ];
  });
}

/**
 * `__heap_realloc(payload, size) -> payload`.
 *
 * In-place first, in both directions: shrinking splits and frees the tail,
 * growing absorbs the physically-next block when it is free and big enough.
 * Only when neither works does it allocate-copy-free. Growing a buffer by
 * repeated append — which is what a JS engine's arrays and string builders do —
 * therefore usually costs no copy at all.
 */
function emitRealloc(ctx: Ctx): void {
  const allocIdx = fn(ctx, "__heap_alloc");
  const freeIdx = fn(ctx, "__heap_free");
  const unlinkIdx = fn(ctx, "__heap_unlink");
  emit(ctx, "__heap_realloc", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], 5, (l) => {
    const b = l(0);
    const s = l(1);
    const blk = l(2);
    const nb = l(3);
    const q = l(4);
    /** Split `b` (size `s`) down to `blk` and release the tail. */
    const shrinkTail: Instr[] = [
      get(s),
      get(blk),
      sub,
      i32c(MIN_BLOCK),
      geU,
      iff([
        get(b),
        get(blk),
        get(b),
        load(0),
        i32c(PINUSE),
        and,
        or,
        i32c(INUSE),
        or,
        store(0),
        // Mark the tail allocated, then free it: that reuses the coalescing and
        // bookkeeping in __heap_free instead of restating it here.
        get(b),
        get(blk),
        add,
        get(s),
        get(blk),
        sub,
        i32c(PINUSE | INUSE),
        or,
        store(0),
        get(b),
        get(blk),
        add,
        i32c(HDR),
        add,
        call(freeIdx),
      ]),
    ];
    return [
      ...bump(ctx, 2),
      get(0),
      eqz,
      iff([get(1), call(allocIdx), ret]),
      get(1),
      eqz,
      iff([get(0), call(freeIdx), i32c(0), ret]),
      get(1),
      i32c(0x7ffffff0),
      gtU,
      iff([i32c(0), ret]),
      get(0),
      i32c(HDR),
      sub,
      set(b),
      get(b),
      ...sizeOfLoaded,
      set(s),
      get(1),
      i32c(HDR + 7),
      add,
      i32c(-8),
      and,
      tee(blk),
      i32c(MIN_BLOCK),
      ltU,
      iff([i32c(MIN_BLOCK), set(blk)]),
      get(blk),
      get(s),
      leU,
      iff([...shrinkTail, get(0), ret]),
      // Grow in place by absorbing a free physical successor.
      get(b),
      get(s),
      add,
      tee(nb),
      load(0),
      i32c(INUSE),
      and,
      eqz,
      iff([
        get(s),
        get(nb),
        ...sizeOfLoaded,
        add,
        get(blk),
        geU,
        iff([
          get(nb),
          call(unlinkIdx),
          get(s),
          get(nb),
          ...sizeOfLoaded,
          add,
          set(s),
          get(b),
          get(s),
          get(b),
          load(0),
          i32c(PINUSE),
          and,
          or,
          i32c(INUSE),
          or,
          store(0),
          get(b),
          get(s),
          add,
          get(b),
          get(s),
          add,
          load(0),
          i32c(PINUSE),
          or,
          store(0),
          ...shrinkTail,
          get(0),
          ret,
        ]),
      ]),
      get(1),
      call(allocIdx),
      tee(q),
      eqz,
      iff([i32c(0), ret]),
      get(q),
      get(0),
      get(s),
      i32c(HDR),
      sub,
      { op: "memory.copy" },
      get(0),
      call(freeIdx),
      get(q),
    ];
  });
}

/**
 * `__heap_stats(which) -> i32` — 0 total region bytes, 1 region count, 2 bytes
 * currently on the free lists, 3 the control-block address.
 *
 * Exported so a bounded-heap claim can be MEASURED. "It did not crash" is not
 * evidence that a free/realloc loop reclaims; total region bytes staying flat
 * across a million allocations is.
 */
function emitStats(ctx: Ctx): void {
  emit(ctx, "__heap_stats", [{ kind: "i32" }], [{ kind: "i32" }], 3, (l) => {
    const i = l(0);
    const b = l(1);
    const acc = l(2);
    return [
      // The call counters answer "did the engine reach us" and must therefore
      // be readable BEFORE any allocation has happened — otherwise a zero could
      // mean either "never called" or "heap not initialised", which is exactly
      // the ambiguity the criterion exists to remove.
      get(0),
      i32c(4),
      geU,
      get(0),
      i32c(8),
      ltU,
      and,
      iff([
        get(0),
        i32c(4),
        eq,
        iff([gget(ctx.counterBaseIdx), ret]),
        get(0),
        i32c(5),
        eq,
        iff([gget(ctx.counterBaseIdx + 1), ret]),
        get(0),
        i32c(6),
        eq,
        iff([gget(ctx.counterBaseIdx + 2), ret]),
        gget(ctx.counterBaseIdx + 3),
        ret,
      ]),
      gget(ctx.ctlGlobalIdx),
      eqz,
      iff([i32c(0), ret]),
      // 16..31 — the request-size histogram.
      get(0),
      i32c(16),
      geU,
      get(0),
      i32c(16 + HIST_BUCKETS),
      ltU,
      and,
      iff([gget(ctx.ctlGlobalIdx), get(0), i32c(16), sub, i32c(4), mul, add, load(CTL_HIST), ret]),
      get(0),
      i32c(3),
      eq,
      iff([gget(ctx.ctlGlobalIdx), ret]),
      get(0),
      eqz,
      iff([gget(ctx.ctlGlobalIdx), load(CTL_TOTAL_BYTES), ret]),
      get(0),
      i32c(1),
      eq,
      iff([gget(ctx.ctlGlobalIdx), load(CTL_REGION_COUNT), ret]),
      get(0),
      i32c(2),
      ne,
      iff([i32c(0), ret]),
      {
        op: "block",
        blockType: EMPTY,
        body: [
          {
            op: "loop",
            blockType: EMPTY,
            body: [
              get(i),
              i32c(NBINS),
              geU,
              { op: "br_if", depth: 1 },
              gget(ctx.ctlGlobalIdx),
              get(i),
              i32c(4),
              mul,
              add,
              load(CTL_BINS),
              set(b),
              {
                op: "block",
                blockType: EMPTY,
                body: [
                  {
                    op: "loop",
                    blockType: EMPTY,
                    body: [
                      get(b),
                      eqz,
                      { op: "br_if", depth: 1 },
                      get(acc),
                      get(b),
                      ...sizeOfLoaded,
                      add,
                      set(acc),
                      get(b),
                      load(4),
                      set(b),
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              get(i),
              i32c(1),
              add,
              set(i),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      get(acc),
    ];
  });
}
