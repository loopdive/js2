/*
 * qjs_shim.c — the js2wasm side of the QuickJS "boxed tier" artifact (#4236).
 *
 * Builds a standalone wasm32-wasip1 REACTOR module that exposes QuickJS to a
 * *peer wasm module* (js2wasm-compiled code) over ONE shared linear memory.
 * There is no JS host and no emscripten glue: the only imports are
 * `wasi_snapshot_preview1.*`.
 *
 * ---------------------------------------------------------------------------
 * ABI contract (this is what js2wasm codegen is allowed to depend on)
 * ---------------------------------------------------------------------------
 *
 * 1. HANDLES, NOT RAW JSValues.  Every JS value crosses the module boundary as
 *    an i32 `handle`, which is a pointer into the shared linear memory to an
 *    8-byte cell holding a QuickJS `JSValue`.  Rationale (design variant C):
 *      - wasm32 QuickJS uses NaN boxing, so a raw JSValue is an i64.  i64 works
 *        wasm->wasm but is a BigInt at any JS boundary; a pointer stays i32
 *        everywhere and keeps the tooling/debugging story uniform.
 *      - a handle is a stable identity the compiled side can hold in a local,
 *        a struct field or a table slot without the codegen having to model
 *        QuickJS's value layout at all.
 *    Handle 0 is the null handle and is always safe to pass to qjs_free_value.
 *
 * 2. BORROW SEMANTICS, NOT MOVE SEMANTICS.  The raw QuickJS C API mixes them
 *    (`JS_SetPropertyStr` *consumes* its value, `JS_GetPropertyStr` *returns*
 *    an owned one), and the #4236 spike showed that is a live footgun: its R3
 *    probe only worked because it hand-inserted a `DupValue`.  Every wrapper
 *    here BORROWS its handle arguments and RETURNS owned handles.  The only
 *    rule codegen must implement is therefore:
 *
 *        every handle a wrapper RETURNS must be released exactly once with
 *        qjs_free_value(); handles you PASS IN are never consumed.
 *
 *    That turns per-callsite refcount knowledge (an open-ended codegen
 *    obligation) into one uniform destructor rule.
 *
 * 3. TAG EXTRACTION IS A BUILD-TIME PRODUCT.  QuickJS's internal encodings are
 *    explicitly NOT a stable ABI (they vary with build flags and version), so
 *    they must never be hardcoded in the compiler.  Instead this artifact
 *    EXPORTS them: `qjs_abi_*()` are leaf functions returning the constants of
 *    the very build you linked.  `scripts/quickjs-artifact/build.sh` reads them
 *    out of the built module and writes `qjs-abi.json` next to it, so js2wasm
 *    codegen learns the immediate encodings from the artifact it will actually
 *    link against.  A version/flag change shows up as different JSON, not as
 *    silent miscompilation.
 *
 *    With those constants, codegen may open-code the hot predicates without a
 *    call: on wasm32 the handle's tag is `i32.load offset=qjs_abi_tag_offset`
 *    and the payload is `i32.load offset=qjs_abi_payload_offset`.
 *
 * 4. THE BOXED TIER ALLOCATES FROM THIS MODULE'S malloc.  `malloc`/`free` are
 *    exported.  js2wasm's own bump arena must live ABOVE this module's heap or
 *    be made dynamic — two independent growers over one memory corrupt it
 *    (#4236 R5 gap 4).
 *
 *    SUPERSEDED IN PART by #4557: the peer may now install ITS allocator here
 *    (`qjs_set_allocator` + `qjs_new_runtime2`), so the direction inverts and
 *    QuickJS's whole heap comes from the peer.  What survives unchanged is the
 *    one-address-space rule: whoever allocates, everyone takes addresses from
 *    that one allocator rather than naming them.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

#define QJS_EXPORT(name) __attribute__((export_name(#name), used)) name

/* A handle is a JSValue* in the shared linear memory. */
typedef uint32_t qjs_handle;

/* #4557 — every scratch allocation in this file goes through these, so that
 * installing the peer's allocator moves the WHOLE artifact onto it rather than
 * leaving a second live heap behind. Defined under "peer allocator" below;
 * declared here because `box` is the first user. */
static void *qjs_shim_malloc(size_t n);
static void qjs_shim_free(void *p);
static void *qjs_shim_realloc(void *p, size_t n);

static qjs_handle box(JSValue v) {
  JSValue *p = (JSValue *)qjs_shim_malloc(sizeof(JSValue));
  if (!p) return 0;
  *p = v;
  return (qjs_handle)(uintptr_t)p;
}

/* Borrow the value behind a handle. Handle 0 reads as undefined so that a
 * failed allocation upstream degrades to a value error rather than a trap. */
static JSValue unbox(qjs_handle h) {
  if (!h) return JS_UNDEFINED;
  return *(JSValue *)(uintptr_t)h;
}

/* ------------------------------------------ peer allocator (#4557) --------
 *
 * ADR-0020 Decision 6, allocator half: the PEER's allocator becomes QuickJS's
 * allocator, via `JS_NewRuntime2(&mf, opaque)`.  Everything the engine
 * allocates — objects, shapes, atoms, bytecode, string data — then comes out of
 * the peer's heap, and `JS_SetMemoryLimit` / `JS_SetGCThreshold` account
 * against numbers the peer controls.
 *
 * ### Why these arrive as TABLE INDICES and not as wasm imports
 *
 * The obvious encoding is `__attribute__((import_module("js2wasm"),
 * import_name("js2wasm_malloc")))`, and that is what #4557 originally
 * specified.  It cannot be used, for a reason that only shows up downstream:
 * a wasm import must be SATISFIED AT INSTANTIATION, so five unconditional
 * imports would make this artifact un-instantiable without a peer that
 * provides an allocator.  Two shipped configurations do exactly that —
 * `extract-abi.mjs` instantiates the artifact alone to read the ABI constants
 * out of it, and the runtime-eval tier instantiates it beside an adapter that
 * imports FROM it and exports no allocator.  Both would have to hand it JS
 * closures, which is precisely what `assertQuickjsArtifactStandalone` exists to
 * forbid ("wasi-stub.mjs is the ONLY JavaScript allowed behind the seam").
 *
 * So this mirrors the #4245 membrane instead, which solved the identical
 * problem: the peer's functions are stored into THIS module's
 * `__indirect_function_table` (exported and growable at link time) and called
 * through it.  On wasm32 a function pointer IS a table index, so each call
 * below lowers to a `call_indirect` whose signature the engine typechecks, the
 * edge stays wasm→wasm with no JS in it, and the artifact still imports ONLY
 * `wasi_snapshot_preview1`.  The cost is one indirect call per allocation
 * instead of a direct one.
 *
 * ### Ordering constraint, enforced rather than documented
 *
 * `qjs_set_allocator` REFUSES (returns 0) once this file has already handed out
 * a libc allocation, because from that point on a pointer minted by dlmalloc
 * could be freed through the peer.  Install first, then create the runtime.
 */

typedef void *(*qjs_alloc_fn)(uint32_t size);
typedef void *(*qjs_calloc_fn)(uint32_t count, uint32_t size);
typedef void (*qjs_free_fn)(void *ptr);
typedef void *(*qjs_realloc_fn)(void *ptr, uint32_t size);
typedef uint32_t (*qjs_usable_fn)(const void *ptr);

static qjs_alloc_fn qjs_peer_malloc;
static qjs_calloc_fn qjs_peer_calloc;
static qjs_free_fn qjs_peer_free;
static qjs_realloc_fn qjs_peer_realloc;
static qjs_usable_fn qjs_peer_usable;

/* Counts allocations this file served from libc (i.e. dlmalloc) rather than
 * from the peer.  Exported because "does anything still allocate outside
 * JSMallocFunctions" is a question #4557 requires answering with a measurement
 * rather than with an argument. */
static uint32_t qjs_libc_allocs;

/* The shim's own scratch allocations (handle cells, eval buffers, argv arrays,
 * rendered strings). They follow the peer allocator once it is installed, so
 * the artifact does not keep a second live heap alongside it. */
static void *qjs_shim_malloc(size_t n) {
  if (qjs_peer_malloc) return qjs_peer_malloc((uint32_t)n);
  qjs_libc_allocs++;
  return malloc(n);
}

static void qjs_shim_free(void *p) {
  if (qjs_peer_free) {
    qjs_peer_free(p);
    return;
  }
  free(p);
}

static void *qjs_shim_realloc(void *p, size_t n) {
  if (qjs_peer_realloc) return qjs_peer_realloc(p, (uint32_t)n);
  qjs_libc_allocs++;
  return realloc(p, n);
}

static void *qjs_mf_calloc(void *opaque, size_t count, size_t size) {
  (void)opaque;
  return qjs_peer_calloc((uint32_t)count, (uint32_t)size);
}
static void *qjs_mf_malloc(void *opaque, size_t size) {
  (void)opaque;
  return qjs_peer_malloc((uint32_t)size);
}
static void qjs_mf_free(void *opaque, void *ptr) {
  (void)opaque;
  qjs_peer_free(ptr);
}
static void *qjs_mf_realloc(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  return qjs_peer_realloc(ptr, (uint32_t)size);
}
static size_t qjs_mf_usable_size(const void *ptr) {
  return (size_t)qjs_peer_usable(ptr);
}

static const JSMallocFunctions qjs_peer_mf = {
    .js_calloc = qjs_mf_calloc,
    .js_malloc = qjs_mf_malloc,
    .js_free = qjs_mf_free,
    .js_realloc = qjs_mf_realloc,
    .js_malloc_usable_size = qjs_mf_usable_size,
};

/**
 * Install the peer's allocator. Arguments are `__indirect_function_table` slot
 * indices, in the order malloc / calloc / free / realloc / usable_size.
 * Returns 1 on success, 0 if refused (already installed, an argument is 0, or a
 * libc allocation has already been handed out by this file).
 */
int QJS_EXPORT(qjs_set_allocator)(uint32_t malloc_idx, uint32_t calloc_idx,
                                  uint32_t free_idx, uint32_t realloc_idx,
                                  uint32_t usable_idx) {
  if (qjs_peer_malloc) return 0;
  if (!malloc_idx || !calloc_idx || !free_idx || !realloc_idx || !usable_idx) {
    return 0;
  }
  if (qjs_libc_allocs) return 0;
  qjs_peer_malloc = (qjs_alloc_fn)(uintptr_t)malloc_idx;
  qjs_peer_calloc = (qjs_calloc_fn)(uintptr_t)calloc_idx;
  qjs_peer_free = (qjs_free_fn)(uintptr_t)free_idx;
  qjs_peer_realloc = (qjs_realloc_fn)(uintptr_t)realloc_idx;
  qjs_peer_usable = (qjs_usable_fn)(uintptr_t)usable_idx;
  return 1;
}

/** How many allocations this file served from libc rather than from the peer. */
uint32_t QJS_EXPORT(qjs_libc_alloc_count)(void) { return qjs_libc_allocs; }

/* ---------------------------------------------------------------- lifecycle */

JSRuntime *QJS_EXPORT(qjs_new_runtime)(void) { return JS_NewRuntime(); }

/**
 * A runtime whose whole heap comes from the peer's allocator (#4557).
 * Returns NULL when no allocator has been installed — a null runtime is a
 * diagnosable failure, whereas silently falling back to `JS_NewRuntime()` would
 * make "the engine allocates through us" quietly untrue.
 */
JSRuntime *QJS_EXPORT(qjs_new_runtime2)(void) {
  if (!qjs_peer_malloc) return NULL;
  return JS_NewRuntime2(&qjs_peer_mf, NULL);
}

/** Bytes QuickJS believes it has allocated — its own accounting, which is
 * driven by `js_malloc_usable_size`. Reported so a wrong `usable_size` shows up
 * as a number rather than as a GC-timing mystery. */
double QJS_EXPORT(qjs_malloc_size)(JSRuntime *rt) {
  JSMemoryUsage u;
  if (!rt) return 0;
  JS_ComputeMemoryUsage(rt, &u);
  return (double)u.malloc_size;
}

/** Live allocation count according to QuickJS's own accounting. */
double QJS_EXPORT(qjs_malloc_count)(JSRuntime *rt) {
  JSMemoryUsage u;
  if (!rt) return 0;
  JS_ComputeMemoryUsage(rt, &u);
  return (double)u.malloc_count;
}

void QJS_EXPORT(qjs_free_runtime)(JSRuntime *rt) {
  if (rt) JS_FreeRuntime(rt);
}

JSContext *QJS_EXPORT(qjs_new_context)(JSRuntime *rt) {
  return rt ? JS_NewContext(rt) : NULL;
}

void QJS_EXPORT(qjs_free_context)(JSContext *ctx) {
  if (ctx) JS_FreeContext(ctx);
}

/* --------------------------------------------------------------- allocation */

/* Re-exported explicitly: the peer module authors source bytes and property
 * names into THIS heap, so it must use THIS allocator. */
void *QJS_EXPORT(qjs_malloc_raw)(uint32_t n) { return malloc(n); }
void QJS_EXPORT(qjs_free_raw)(void *p) { free(p); }

/* -------------------------------------------------------------------- values */

void QJS_EXPORT(qjs_free_value)(JSContext *ctx, qjs_handle h) {
  if (!h) return;
  JSValue *p = (JSValue *)(uintptr_t)h;
  JS_FreeValue(ctx, *p);
  qjs_shim_free(p);
}

qjs_handle QJS_EXPORT(qjs_dup)(JSContext *ctx, qjs_handle h) {
  return box(JS_DupValue(ctx, unbox(h)));
}

/* Raw NaN-boxed JSValue, for codegen that wants to open-code a tag test.
 * i64 crosses a wasm->wasm boundary natively. */
uint64_t QJS_EXPORT(qjs_handle_raw)(qjs_handle h) { return (uint64_t)unbox(h); }

int QJS_EXPORT(qjs_tag)(qjs_handle h) {
  return JS_VALUE_GET_NORM_TAG(unbox(h));
}

int QJS_EXPORT(qjs_is_exception)(qjs_handle h) {
  return JS_IsException(unbox(h)) ? 1 : 0;
}

/* Numbers: i32 values are exact in f64, so one f64 accessor covers both the
 * JS_TAG_INT and JS_TAG_FLOAT64 cases. NaN on a failed conversion. */
double QJS_EXPORT(qjs_to_f64)(JSContext *ctx, qjs_handle h) {
  double d;
  if (JS_ToFloat64(ctx, &d, unbox(h)) < 0) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return __builtin_nan("");
  }
  return d;
}

qjs_handle QJS_EXPORT(qjs_new_f64)(JSContext *ctx, double d) {
  (void)ctx;
  return box(JS_NewFloat64(ctx, d));
}

/* #4238 — the immediate constructors the eval adapter needs to push values INTO
 * QuickJS. `qjs_new_undefined` takes no context on purpose: JS_UNDEFINED is a
 * pure immediate, so there is nothing to allocate against a runtime. */
qjs_handle QJS_EXPORT(qjs_new_undefined)(void) { return box(JS_UNDEFINED); }

/* #4238 — build a QuickJS string from `len` UTF-8 bytes at `buf` in THIS heap
 * (the peer authors them via qjs_malloc_raw + byte stores). Not NUL-terminated
 * by contract, hence the explicit length. Returns an owned handle. */
qjs_handle QJS_EXPORT(qjs_new_string_len)(JSContext *ctx, const char *buf,
                                          uint32_t len) {
  return box(JS_NewStringLen(ctx, buf, (size_t)len));
}

/* #4238 slice 2 — the remaining immediate constructors. `qjs_new_null` takes no
 * context for the same reason `qjs_new_undefined` does not: JS_NULL is a pure
 * immediate with nothing to allocate against a runtime. */
qjs_handle QJS_EXPORT(qjs_new_null)(void) { return box(JS_NULL); }

qjs_handle QJS_EXPORT(qjs_new_bool)(JSContext *ctx, int b) {
  return box(JS_NewBool(ctx, b));
}

/* #4238 slice 2 — callability test. Needed to split the OBJECT tag into the
 * callable carrier arm and the opaque handle-box arm; JS_IsFunction is the only
 * predicate that answers it without a property probe. */
int QJS_EXPORT(qjs_is_function)(JSContext *ctx, qjs_handle h) {
  return JS_IsFunction(ctx, unbox(h)) ? 1 : 0;
}

qjs_handle QJS_EXPORT(qjs_new_object)(JSContext *ctx) {
  return box(JS_NewObject(ctx));
}

qjs_handle QJS_EXPORT(qjs_global_object)(JSContext *ctx) {
  return box(JS_GetGlobalObject(ctx));
}

/* ---------------------------------------------------------------- properties */

qjs_handle QJS_EXPORT(qjs_get_prop_str)(JSContext *ctx, qjs_handle obj,
                                        const char *name) {
  return box(JS_GetPropertyStr(ctx, unbox(obj), name));
}

/* Borrows `val` (see ABI note 2): JS_SetPropertyStr consumes a reference, so
 * we hand it a dup and leave the caller's handle intact. */
int QJS_EXPORT(qjs_set_prop_str)(JSContext *ctx, qjs_handle obj,
                                 const char *name, qjs_handle val) {
  return JS_SetPropertyStr(ctx, unbox(obj), name,
                           JS_DupValue(ctx, unbox(val)));
}

/* strict != 0 -> ===, strict == 0 -> == . Returns 1/0, or -1 on error. */
int QJS_EXPORT(qjs_is_equal)(JSContext *ctx, qjs_handle a, qjs_handle b,
                             int strict) {
  if (strict) return JS_IsStrictEqual(ctx, unbox(a), unbox(b)) ? 1 : 0;
  return JS_IsEqual(ctx, unbox(a), unbox(b));
}

/* --------------------------------------------------------------------- eval */

/* `src` need not be NUL-terminated by the caller; we copy and terminate, which
 * is what JS_Eval requires. Returns an owned handle (possibly an exception). */
qjs_handle QJS_EXPORT(qjs_eval)(JSContext *ctx, const char *src, uint32_t len) {
  char *buf = (char *)qjs_shim_malloc((size_t)len + 1);
  if (!buf) return 0;
  memcpy(buf, src, len);
  buf[len] = '\0';
  JSValue v = JS_Eval(ctx, buf, len, "<qjs_eval>", JS_EVAL_TYPE_GLOBAL);
  qjs_shim_free(buf);
  return box(v);
}

/* #4238 slice 2 — invoke a QuickJS function. `argv` points at `argc`
 * CONSECUTIVE i32 handles in this heap (the peer authors them with
 * qjs_malloc_raw + 4-byte stores). Follows ABI note 2 in both directions:
 * JS_Call borrows its arguments, so none of the caller's handles are consumed,
 * and the returned handle is owned (possibly an exception). */
qjs_handle QJS_EXPORT(qjs_call)(JSContext *ctx, qjs_handle fn,
                                qjs_handle this_val, uint32_t argc,
                                const qjs_handle *argv) {
  JSValue *args = NULL;
  if (argc > 0) {
    if (!argv) return 0;
    args = (JSValue *)qjs_shim_malloc(sizeof(JSValue) * (size_t)argc);
    if (!args) return 0;
    for (uint32_t i = 0; i < argc; i++) args[i] = unbox(argv[i]);
  }
  JSValue r = JS_Call(ctx, unbox(fn), unbox(this_val), (int)argc, args);
  qjs_shim_free(args);
  return box(r);
}

/* Diagnostics: pending exception as an owned handle (undefined if none). */
qjs_handle QJS_EXPORT(qjs_take_exception)(JSContext *ctx) {
  return box(JS_GetException(ctx));
}

/* UTF-8 rendering into a fresh malloc'd NUL-terminated buffer in this heap.
 * Release with qjs_free_raw. Returns 0 on failure. */
char *QJS_EXPORT(qjs_to_cstring)(JSContext *ctx, qjs_handle h) {
  const char *s = JS_ToCString(ctx, unbox(h));
  if (!s) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return NULL;
  }
  size_t n = strlen(s);
  char *out = (char *)qjs_shim_malloc(n + 1);
  if (out) memcpy(out, s, n + 1);
  JS_FreeCString(ctx, s);
  return out;
}

/* #4238 slice 2 — UTF-8 rendering WITH the byte length written to `*len_out`.
 * `qjs_to_cstring` above cannot serve the QuickJS→GC string direction: a JS
 * string may contain U+0000, so a NUL scan would truncate it. The buffer is
 * still NUL-terminated for convenience. Release with qjs_free_raw; returns 0 on
 * failure (and writes 0 to *len_out). */
char *QJS_EXPORT(qjs_to_cstring_len)(JSContext *ctx, qjs_handle h,
                                     uint32_t *len_out) {
  size_t n = 0;
  const char *s = JS_ToCStringLen(ctx, &n, unbox(h));
  if (!s) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    if (len_out) *len_out = 0;
    return NULL;
  }
  char *out = (char *)qjs_shim_malloc(n + 1);
  if (out) {
    memcpy(out, s, n);
    out[n] = '\0';
  }
  JS_FreeCString(ctx, s);
  if (len_out) *len_out = out ? (uint32_t)n : 0;
  return out;
}

/* ------------------------------------------------------- membrane (#4245) --
 *
 * SLICE 1 — INWARD wrappers only: a compiled WasmGC object/function made
 * visible INSIDE evaluated code as a QuickJS exotic object whose property
 * traps call back into the GC adapter.
 *
 * The callback edge is wasm->wasm, NOT a JS closure. `build.sh` links with
 * `--export-table --growable-table`, the harness grows this module's
 * `__indirect_function_table` and stores the adapter's exported functions into
 * fresh slots, then calls `qjs_set_membrane_callbacks` with those slot indices.
 * On wasm32 a function pointer IS a table index, so the casts below lower to
 * `call_indirect` against that table and the signatures are typechecked by the
 * engine. The artifact still imports ONLY wasi_snapshot_preview1.
 *
 * Callback ABI (all i32; see scripts/quickjs-eval-provider.mjs for the peer):
 *   __membrane_get(gc, keyPtr, keyLen)              -> OWNED handle, 0 = absent
 *   __membrane_set(gc, keyPtr, keyLen, h)           -> 1 ok / 0 refused
 *   __membrane_has(gc, keyPtr, keyLen)              -> 1 / 0
 *   __membrane_delete(gc, keyPtr, keyLen)           -> 1 / 0
 *   __membrane_call(gc, thisH, argc, argvPtr)       -> OWNED handle, 0 = error
 *
 * Handle ownership across the callback edge follows ABI note 2 in the SAME
 * direction: handles this file PASSES IN (`h`, `thisH`, every `argvPtr[i]`)
 * are BORROWED and freed here; handles the adapter RETURNS are owned by this
 * file and consumed by `take()`.
 *
 * Property keys travel as (ptr, len) UTF-8 bytes in THIS heap — the very
 * memory the adapter imports — so there is no copy and no second allocator.
 *
 * NOT in this slice (see plan/issues/4245-…): `get_own_property_names`
 * (enumeration of a wrapper is empty), `gc_mark`/edge lists, and releasing the
 * adapter's GC pin from the finalizer. Retention is therefore CONTEXT-LIFETIME
 * on the compiled side; the finalizer only clears the dedup slot so a
 * collected wrapper can never be handed out again.
 */

typedef uint32_t (*qjs_membrane_get_fn)(uint32_t gc, uint32_t key_ptr,
                                        uint32_t key_len);
typedef uint32_t (*qjs_membrane_set_fn)(uint32_t gc, uint32_t key_ptr,
                                        uint32_t key_len, uint32_t val);
typedef uint32_t (*qjs_membrane_probe_fn)(uint32_t gc, uint32_t key_ptr,
                                          uint32_t key_len);
typedef uint32_t (*qjs_membrane_call_fn)(uint32_t gc, uint32_t this_h,
                                         uint32_t argc, uint32_t argv);

static qjs_membrane_get_fn qjs_mb_get;
static qjs_membrane_set_fn qjs_mb_set;
static qjs_membrane_probe_fn qjs_mb_has;
static qjs_membrane_probe_fn qjs_mb_delete;
static qjs_membrane_call_fn qjs_mb_call;

static JSClassID qjs_wrapper_class_id;
static JSClassID qjs_callable_class_id;

/* Non-owning `gc_id -> wrapper` dedup table: the SAME compiled object always
 * surfaces as the SAME QuickJS object within a context (identity across
 * evals). Cleared by the finalizer, so an entry is never dangling. */
static JSValue *qjs_wrap_slots;
static uint8_t *qjs_wrap_live;
static uint32_t qjs_wrap_slots_len;

#define QJS_NO_WRAPPER 0xFFFFFFFFu

/* Consume an adapter-returned handle: move the reference out of the cell and
 * release the cell itself (qjs_free_value would drop the reference too). */
static JSValue qjs_take(qjs_handle h) {
  if (!h) return JS_UNDEFINED;
  JSValue *p = (JSValue *)(uintptr_t)h;
  JSValue v = *p;
  qjs_shim_free(p);
  return v;
}

void QJS_EXPORT(qjs_set_membrane_callbacks)(uint32_t get, uint32_t set,
                                            uint32_t has, uint32_t del,
                                            uint32_t call) {
  qjs_mb_get = (qjs_membrane_get_fn)(uintptr_t)get;
  qjs_mb_set = (qjs_membrane_set_fn)(uintptr_t)set;
  qjs_mb_has = (qjs_membrane_probe_fn)(uintptr_t)has;
  qjs_mb_delete = (qjs_membrane_probe_fn)(uintptr_t)del;
  qjs_mb_call = (qjs_membrane_call_fn)(uintptr_t)call;
}

static uint32_t qjs_wrapper_id_of(JSValueConst v) {
  void *op;
  if (JS_VALUE_GET_TAG(v) != JS_TAG_OBJECT) return QJS_NO_WRAPPER;
  if (qjs_wrapper_class_id == 0) return QJS_NO_WRAPPER;
  op = JS_GetOpaque(v, qjs_wrapper_class_id);
  if (!op) op = JS_GetOpaque(v, qjs_callable_class_id);
  if (!op) return QJS_NO_WRAPPER;
  return (uint32_t)(uintptr_t)op - 1u;
}

/* Symbol keys are DEFERRED (residual): report them as absent rather than
 * stringifying, which would alias distinct symbols onto one string key.
 * Everything else (string atoms and array-index atoms) crosses as UTF-8. */
static const char *qjs_atom_bytes(JSContext *ctx, JSAtom prop, size_t *len) {
  JSValue av = JS_AtomToValue(ctx, prop);
  int is_symbol = JS_IsSymbol(av);
  JS_FreeValue(ctx, av);
  if (is_symbol) return NULL;
  return JS_AtomToCStringLen(ctx, len, prop);
}

static void qjs_wrapper_finalizer(JSRuntime *rt, JSValue val) {
  uint32_t id = qjs_wrapper_id_of(val);
  (void)rt;
  if (id != QJS_NO_WRAPPER && id < qjs_wrap_slots_len) qjs_wrap_live[id] = 0;
  /* The adapter's pin on the compiled object is NOT released here: slice 1
   * keeps compiled-side retention at context lifetime (#4245 slice 3 adds the
   * release protocol together with gc_mark). Calling back into the adapter
   * from a finalizer would also run adapter code during GC, which the slice-3
   * design explicitly confines to one dedicated notification callback. */
}

static JSValue qjs_mb_exotic_get(JSContext *ctx, JSValueConst obj, JSAtom atom,
                                 JSValueConst receiver) {
  uint32_t id = qjs_wrapper_id_of(obj);
  size_t len = 0;
  const char *key;
  uint32_t r;
  (void)receiver;
  if (id == QJS_NO_WRAPPER || !qjs_mb_get) return JS_UNDEFINED;
  key = qjs_atom_bytes(ctx, atom, &len);
  if (!key) return JS_UNDEFINED;
  r = qjs_mb_get(id, (uint32_t)(uintptr_t)key, (uint32_t)len);
  JS_FreeCString(ctx, key);
  return qjs_take(r);
}

static int qjs_mb_exotic_set(JSContext *ctx, JSValueConst obj, JSAtom atom,
                             JSValueConst value, JSValueConst receiver,
                             int flags) {
  uint32_t id = qjs_wrapper_id_of(obj);
  size_t len = 0;
  const char *key;
  qjs_handle vh;
  uint32_t ok;
  (void)receiver;
  if (id == QJS_NO_WRAPPER || !qjs_mb_set) return false;
  key = qjs_atom_bytes(ctx, atom, &len);
  if (!key) return true; /* symbol key: accepted and dropped (residual) */
  /* BORROWED by the adapter — the reference is minted and released here. */
  vh = box(JS_DupValue(ctx, value));
  ok = qjs_mb_set(id, (uint32_t)(uintptr_t)key, (uint32_t)len, vh);
  qjs_free_value(ctx, vh);
  JS_FreeCString(ctx, key);
  if (!ok) {
    if (flags & JS_PROP_THROW) {
      JS_ThrowTypeError(ctx,
                        "cannot write this value into a compiled object from "
                        "evaluated code (#4245)");
      return -1;
    }
    return false;
  }
  return true;
}

static int qjs_mb_exotic_has(JSContext *ctx, JSValueConst obj, JSAtom atom) {
  uint32_t id = qjs_wrapper_id_of(obj);
  size_t len = 0;
  const char *key;
  uint32_t r;
  if (id == QJS_NO_WRAPPER || !qjs_mb_has) return false;
  key = qjs_atom_bytes(ctx, atom, &len);
  if (!key) return false;
  r = qjs_mb_has(id, (uint32_t)(uintptr_t)key, (uint32_t)len);
  JS_FreeCString(ctx, key);
  return r ? true : false;
}

static int qjs_mb_exotic_delete(JSContext *ctx, JSValueConst obj, JSAtom atom) {
  uint32_t id = qjs_wrapper_id_of(obj);
  size_t len = 0;
  const char *key;
  uint32_t r;
  if (id == QJS_NO_WRAPPER || !qjs_mb_delete) return false;
  key = qjs_atom_bytes(ctx, atom, &len);
  if (!key) return true;
  r = qjs_mb_delete(id, (uint32_t)(uintptr_t)key, (uint32_t)len);
  JS_FreeCString(ctx, key);
  return r ? true : false;
}

/* Descriptor FLAGS are synthesized, not preserved (residual): the membrane
 * answers "is there a value" and "what is it", not the compiled object's real
 * attribute bits. */
static int qjs_mb_exotic_gopd(JSContext *ctx, JSPropertyDescriptor *desc,
                              JSValueConst obj, JSAtom prop) {
  uint32_t id = qjs_wrapper_id_of(obj);
  size_t len = 0;
  const char *key;
  uint32_t present;
  if (id == QJS_NO_WRAPPER || !qjs_mb_has) return false;
  key = qjs_atom_bytes(ctx, prop, &len);
  if (!key) return false;
  present = qjs_mb_has(id, (uint32_t)(uintptr_t)key, (uint32_t)len);
  if (!present || !desc) {
    JS_FreeCString(ctx, key);
    return present ? true : false;
  }
  desc->flags = JS_PROP_WRITABLE | JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE;
  desc->getter = JS_UNDEFINED;
  desc->setter = JS_UNDEFINED;
  desc->value = qjs_mb_get
                    ? qjs_take(qjs_mb_get(id, (uint32_t)(uintptr_t)key,
                                          (uint32_t)len))
                    : JS_UNDEFINED;
  JS_FreeCString(ctx, key);
  return true;
}

/* Reflective defineProperty is LOUD rather than approximated: silently
 * degrading it to a plain write would make evaluated code quietly wrong about
 * the attributes it just asked for. Plain assignment does NOT land here — it
 * goes through set_property above. */
static int qjs_mb_exotic_define(JSContext *ctx, JSValueConst this_obj,
                                JSAtom prop, JSValueConst val,
                                JSValueConst getter, JSValueConst setter,
                                int flags) {
  (void)this_obj;
  (void)prop;
  (void)val;
  (void)getter;
  (void)setter;
  (void)flags;
  JS_ThrowTypeError(ctx,
                    "Object.defineProperty on a compiled object inside eval is "
                    "not supported (#4245)");
  return -1;
}

static JSValue qjs_mb_exotic_call(JSContext *ctx, JSValueConst func_obj,
                                  JSValueConst this_val, int argc,
                                  JSValueConst *argv, int flags) {
  uint32_t id = qjs_wrapper_id_of(func_obj);
  qjs_handle *cells = NULL;
  qjs_handle this_h;
  uint32_t r;
  int i;
  if (flags & JS_CALL_FLAG_CONSTRUCTOR) {
    return JS_ThrowTypeError(ctx,
                             "a compiled function cannot be used as a "
                             "constructor inside evaluated code (#4245)");
  }
  if (id == QJS_NO_WRAPPER || !qjs_mb_call) {
    return JS_ThrowTypeError(ctx, "not a compiled callable (#4245)");
  }
  if (argc > 0) {
    cells = (qjs_handle *)qjs_shim_malloc(sizeof(qjs_handle) * (size_t)argc);
    if (!cells) return JS_ThrowTypeError(ctx, "out of memory (#4245)");
    for (i = 0; i < argc; i++) cells[i] = box(JS_DupValue(ctx, argv[i]));
  }
  this_h = box(JS_DupValue(ctx, this_val));
  r = qjs_mb_call(id, this_h, (uint32_t)argc, (uint32_t)(uintptr_t)cells);
  /* Every handle passed IN is released here (borrow-in), on both paths. */
  qjs_free_value(ctx, this_h);
  for (i = 0; i < argc; i++) qjs_free_value(ctx, cells[i]);
  qjs_shim_free(cells);
  if (!r) {
    return JS_ThrowTypeError(
        ctx, "a compiled function could not be called from evaluated code "
             "(#4245)");
  }
  return qjs_take(r);
}

static JSClassExoticMethods qjs_membrane_exotic = {
    .get_own_property = qjs_mb_exotic_gopd,
    .get_own_property_names = NULL, /* slice 2 */
    .delete_property = qjs_mb_exotic_delete,
    .define_own_property = qjs_mb_exotic_define,
    .has_property = qjs_mb_exotic_has,
    .get_property = qjs_mb_exotic_get,
    .set_property = qjs_mb_exotic_set,
};

static JSClassDef qjs_wrapper_class_def = {
    .class_name = "CompiledObject",
    .finalizer = qjs_wrapper_finalizer,
    .gc_mark = NULL, /* slice 3 */
    .call = NULL,
    .exotic = &qjs_membrane_exotic,
};

static JSClassDef qjs_callable_class_def = {
    .class_name = "CompiledFunction",
    .finalizer = qjs_wrapper_finalizer,
    .gc_mark = NULL, /* slice 3 */
    .call = qjs_mb_exotic_call,
    .exotic = &qjs_membrane_exotic,
};

static int qjs_membrane_ensure_classes(JSContext *ctx) {
  JSRuntime *rt = JS_GetRuntime(ctx);
  if (qjs_wrapper_class_id == 0) {
    JS_NewClassID(rt, &qjs_wrapper_class_id);
    JS_NewClassID(rt, &qjs_callable_class_id);
  }
  if (!JS_IsRegisteredClass(rt, qjs_wrapper_class_id) &&
      JS_NewClass(rt, qjs_wrapper_class_id, &qjs_wrapper_class_def) < 0) {
    return 0;
  }
  if (!JS_IsRegisteredClass(rt, qjs_callable_class_id) &&
      JS_NewClass(rt, qjs_callable_class_id, &qjs_callable_class_def) < 0) {
    return 0;
  }
  return 1;
}

static int qjs_wrap_reserve(uint32_t gc_id) {
  uint32_t want, i;
  JSValue *slots;
  uint8_t *live;
  if (gc_id < qjs_wrap_slots_len) return 1;
  want = qjs_wrap_slots_len ? qjs_wrap_slots_len : 16;
  while (want <= gc_id) want *= 2;
  slots = (JSValue *)qjs_shim_realloc(qjs_wrap_slots, sizeof(JSValue) * (size_t)want);
  if (!slots) return 0;
  live = (uint8_t *)qjs_shim_realloc(qjs_wrap_live, (size_t)want);
  if (!live) {
    qjs_wrap_slots = slots;
    return 0;
  }
  for (i = qjs_wrap_slots_len; i < want; i++) {
    slots[i] = JS_UNDEFINED;
    live[i] = 0;
  }
  qjs_wrap_slots = slots;
  qjs_wrap_live = live;
  qjs_wrap_slots_len = want;
  return 1;
}

/**
 * The wrapper for compiled-object registry id `gc_id`, minting it on first use.
 * Returns an OWNED handle. `callable != 0` picks the class whose `call` routes
 * back into compiled code, so `typeof` answers "function" inside eval.
 */
qjs_handle QJS_EXPORT(qjs_new_wrapper)(JSContext *ctx, uint32_t gc_id,
                                       int callable) {
  JSValue v;
  if (!qjs_membrane_ensure_classes(ctx)) return 0;
  if (!qjs_wrap_reserve(gc_id)) return 0;
  if (qjs_wrap_live[gc_id]) return box(JS_DupValue(ctx, qjs_wrap_slots[gc_id]));
  v = JS_NewObjectClass(ctx,
                        callable ? qjs_callable_class_id : qjs_wrapper_class_id);
  if (JS_IsException(v)) return box(v);
  /* +1 so that "no opaque" (NULL) is distinguishable from registry id 0. */
  JS_SetOpaque(v, (void *)(uintptr_t)(gc_id + 1u));
  qjs_wrap_slots[gc_id] = v; /* non-owning; cleared by the finalizer */
  qjs_wrap_live[gc_id] = 1;
  return box(v);
}

/** Registry id behind a wrapper, or 0xFFFFFFFF when `h` is not one of ours. */
uint32_t QJS_EXPORT(qjs_wrapper_gc_handle)(qjs_handle h) {
  return qjs_wrapper_id_of(unbox(h));
}

/* ------------------------------------------------- ABI / tag extraction (3) */

int QJS_EXPORT(qjs_abi_version)(void) { return 1; }
int QJS_EXPORT(qjs_abi_qjs_version_major)(void) { return QJS_VERSION_MAJOR; }
int QJS_EXPORT(qjs_abi_qjs_version_minor)(void) { return QJS_VERSION_MINOR; }
int QJS_EXPORT(qjs_abi_qjs_version_patch)(void) { return QJS_VERSION_PATCH; }

/* 1 = JSValue is a NaN-boxed uint64_t (the wasm32 configuration). */
int QJS_EXPORT(qjs_abi_nan_boxing)(void) {
#if defined(JS_NAN_BOXING) && JS_NAN_BOXING
  return 1;
#else
  return 0;
#endif
}

int QJS_EXPORT(qjs_abi_jsvalue_size)(void) { return (int)sizeof(JSValue); }
int QJS_EXPORT(qjs_abi_handle_size)(void) { return (int)sizeof(void *); }

/* Byte offsets inside the 8-byte handle cell (little-endian wasm32). */
int QJS_EXPORT(qjs_abi_tag_offset)(void) {
#if defined(JS_NAN_BOXING) && JS_NAN_BOXING
  return 4; /* tag = high 32 bits */
#else
  return (int)offsetof(JSValue, tag);
#endif
}
int QJS_EXPORT(qjs_abi_payload_offset)(void) { return 0; }

/* The float64 un-boxing addend: double bits == raw + (addend << 32). */
int64_t QJS_EXPORT(qjs_abi_float64_tag_addend)(void) {
#if defined(JS_NAN_BOXING) && JS_NAN_BOXING
  return (int64_t)JS_FLOAT64_TAG_ADDEND;
#else
  return 0;
#endif
}

int QJS_EXPORT(qjs_abi_tag_first)(void) { return JS_TAG_FIRST; }
int QJS_EXPORT(qjs_abi_tag_big_int)(void) { return JS_TAG_BIG_INT; }
int QJS_EXPORT(qjs_abi_tag_symbol)(void) { return JS_TAG_SYMBOL; }
int QJS_EXPORT(qjs_abi_tag_string)(void) { return JS_TAG_STRING; }
int QJS_EXPORT(qjs_abi_tag_string_rope)(void) { return JS_TAG_STRING_ROPE; }
int QJS_EXPORT(qjs_abi_tag_module)(void) { return JS_TAG_MODULE; }
int QJS_EXPORT(qjs_abi_tag_function_bytecode)(void) {
  return JS_TAG_FUNCTION_BYTECODE;
}
int QJS_EXPORT(qjs_abi_tag_object)(void) { return JS_TAG_OBJECT; }
int QJS_EXPORT(qjs_abi_tag_int)(void) { return JS_TAG_INT; }
int QJS_EXPORT(qjs_abi_tag_bool)(void) { return JS_TAG_BOOL; }
int QJS_EXPORT(qjs_abi_tag_null)(void) { return JS_TAG_NULL; }
int QJS_EXPORT(qjs_abi_tag_undefined)(void) { return JS_TAG_UNDEFINED; }
int QJS_EXPORT(qjs_abi_tag_uninitialized)(void) { return JS_TAG_UNINITIALIZED; }
int QJS_EXPORT(qjs_abi_tag_catch_offset)(void) { return JS_TAG_CATCH_OFFSET; }
int QJS_EXPORT(qjs_abi_tag_exception)(void) { return JS_TAG_EXCEPTION; }
int QJS_EXPORT(qjs_abi_tag_short_big_int)(void) { return JS_TAG_SHORT_BIG_INT; }
int QJS_EXPORT(qjs_abi_tag_float64)(void) { return JS_TAG_FLOAT64; }

/* Leaf export with no work: the cross-module trampoline benchmark subtracts a
 * call-free loop from a loop over this. */
int QJS_EXPORT(qjs_noop)(void) { return 0; }
