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
 */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

#define QJS_EXPORT(name) __attribute__((export_name(#name), used)) name

/* A handle is a JSValue* in the shared linear memory. */
typedef uint32_t qjs_handle;

static qjs_handle box(JSValue v) {
  JSValue *p = (JSValue *)malloc(sizeof(JSValue));
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

/* ---------------------------------------------------------------- lifecycle */

JSRuntime *QJS_EXPORT(qjs_new_runtime)(void) { return JS_NewRuntime(); }

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
  free(p);
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
  char *buf = (char *)malloc((size_t)len + 1);
  if (!buf) return 0;
  memcpy(buf, src, len);
  buf[len] = '\0';
  JSValue v = JS_Eval(ctx, buf, len, "<qjs_eval>", JS_EVAL_TYPE_GLOBAL);
  free(buf);
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
    args = (JSValue *)malloc(sizeof(JSValue) * (size_t)argc);
    if (!args) return 0;
    for (uint32_t i = 0; i < argc; i++) args[i] = unbox(argv[i]);
  }
  JSValue r = JS_Call(ctx, unbox(fn), unbox(this_val), (int)argc, args);
  free(args);
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
  char *out = (char *)malloc(n + 1);
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
  char *out = (char *)malloc(n + 1);
  if (out) {
    memcpy(out, s, n);
    out[n] = '\0';
  }
  JS_FreeCString(ctx, s);
  if (len_out) *len_out = out ? (uint32_t)n : 0;
  return out;
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
