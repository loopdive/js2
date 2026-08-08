/*
 * peer.c — stand-in for js2wasm-compiled code (#4236 slice 1, R2/R3/R4).
 *
 * A SEPARATE wasm module that IMPORTS libquickjs.wasm's linear memory and its
 * qjs_* wrapper exports, and drives QuickJS entirely from wasm. No JS in the
 * data path: the only host involvement is instantiation (handing over the
 * Memory object and the export table).
 *
 * Deliberate constraints, mirroring what real codegen must obey:
 *  - no libc, no own memory: linked -nostdlib --import-memory, so this module
 *    defines no memory of its own.
 *  - NO data segments and no statics. Every byte written into the shared heap
 *    is an immediate i32.store into a qjs_malloc_raw()'d buffer. An ACTIVE
 *    data segment would write at a link-time offset straight through QuickJS's
 *    static data (the spike's warning; the same hazard bites codegen). Even a
 *    local `const char[]` would be materialised in .rodata, so string literals
 *    are spelled as packed word immediates instead.
 */

typedef unsigned u32;
typedef unsigned long long u64;

#define IMP(name) __attribute__((import_module("qjs"), import_name(#name))) extern
#define EXP(name) __attribute__((export_name(#name), used)) name

IMP(qjs_malloc_raw) void *qjs_malloc_raw(u32 n);
IMP(qjs_free_raw) void qjs_free_raw(void *p);
IMP(qjs_new_runtime) void *qjs_new_runtime(void);
IMP(qjs_new_context) void *qjs_new_context(void *rt);
IMP(qjs_eval) u32 qjs_eval(void *ctx, const char *src, u32 len);
IMP(qjs_to_f64) double qjs_to_f64(void *ctx, u32 h);
IMP(qjs_new_object) u32 qjs_new_object(void *ctx);
IMP(qjs_global_object) u32 qjs_global_object(void *ctx);
IMP(qjs_get_prop_str) u32 qjs_get_prop_str(void *ctx, u32 obj, const char *name);
IMP(qjs_set_prop_str) int qjs_set_prop_str(void *ctx, u32 obj, const char *name, u32 val);
IMP(qjs_is_equal) int qjs_is_equal(void *ctx, u32 a, u32 b, int strict);
IMP(qjs_free_value) void qjs_free_value(void *ctx, u32 h);
IMP(qjs_dup) u32 qjs_dup(void *ctx, u32 h);
IMP(qjs_tag) int qjs_tag(u32 h);
IMP(qjs_is_exception) int qjs_is_exception(u32 h);
IMP(qjs_noop) int qjs_noop(void);
IMP(qjs_handle_raw) u64 qjs_handle_raw(u32 h);

#define P4(a, b, c, d) ((u32)(a) | ((u32)(b) << 8) | ((u32)(c) << 16) | ((u32)(d) << 24))

static inline void putw(char *p, u32 i, u32 w) { ((u32 *)p)[i] = w; }
static inline char *alloc_str(u32 nwords) {
  return (char *)qjs_malloc_raw(nwords * 4 + 4);
}

/* ---------------------------------------------------------------- R2 ------ */
/* "40+2" authored by this module, evaluated by QuickJS, read back as f64. */
double EXP(r2_roundtrip)(void *ctx) {
  char *s = alloc_str(1);
  if (!s) return -1;
  putw(s, 0, P4('4', '0', '+', '2'));
  s[4] = 0;
  u32 h = qjs_eval(ctx, s, 4);
  qjs_free_raw(s);
  if (qjs_is_exception(h)) { qjs_free_value(ctx, h); return -2; }
  double d = qjs_to_f64(ctx, h);
  qjs_free_value(ctx, h);
  return d;
}

/* ---------------------------------------------------------------- R3 ------ */
/* Object identity across the eval boundary. Returns x*10 + identityBit. */
double EXP(r3_identity)(void *ctx) {
  u32 o = qjs_new_object(ctx);
  u32 g = qjs_global_object(ctx);

  char *so = alloc_str(1);
  putw(so, 0, P4('o', 0, 0, 0));
  /* borrow semantics: the shim dups internally, `o` stays ours */
  qjs_set_prop_str(ctx, g, so, o);
  qjs_free_raw(so);

  /* "globalThis.o.x = 41; globalThis.c = globalThis.o;"  (49 bytes) */
  char *src = alloc_str(13);
  putw(src, 0, P4('g', 'l', 'o', 'b'));
  putw(src, 1, P4('a', 'l', 'T', 'h'));
  putw(src, 2, P4('i', 's', '.', 'o'));
  putw(src, 3, P4('.', 'x', ' ', '='));
  putw(src, 4, P4(' ', '4', '1', ';'));
  putw(src, 5, P4(' ', 'g', 'l', 'o'));
  putw(src, 6, P4('b', 'a', 'l', 'T'));
  putw(src, 7, P4('h', 'i', 's', '.'));
  putw(src, 8, P4('c', ' ', '=', ' '));
  putw(src, 9, P4('g', 'l', 'o', 'b'));
  putw(src, 10, P4('a', 'l', 'T', 'h'));
  putw(src, 11, P4('i', 's', '.', 'o'));
  putw(src, 12, P4(';', 0, 0, 0));
  src[49] = 0;
  u32 r = qjs_eval(ctx, src, 49);
  qjs_free_raw(src);
  if (qjs_is_exception(r)) {
    qjs_free_value(ctx, r);
    qjs_free_value(ctx, o);
    qjs_free_value(ctx, g);
    return -2;
  }
  qjs_free_value(ctx, r);

  /* read the eval-side mutation through the handle we have held all along */
  char *sx = alloc_str(1);
  putw(sx, 0, P4('x', 0, 0, 0));
  u32 hx = qjs_get_prop_str(ctx, o, sx);
  qjs_free_raw(sx);
  double x = qjs_to_f64(ctx, hx);
  qjs_free_value(ctx, hx);

  /* and confirm it is the SAME object eval aliased into globalThis.c */
  char *sc = alloc_str(1);
  putw(sc, 0, P4('c', 0, 0, 0));
  u32 hc = qjs_get_prop_str(ctx, g, sc);
  qjs_free_raw(sc);
  int same = qjs_is_equal(ctx, o, hc, 1);
  qjs_free_value(ctx, hc);
  qjs_free_value(ctx, o);
  qjs_free_value(ctx, g);
  return x * 10 + (double)same;
}

/* Tag of a fresh object, via the wrapper call. */
int EXP(r3_object_tag)(void *ctx) {
  u32 o = qjs_new_object(ctx);
  int t = qjs_tag(o);
  qjs_free_value(ctx, o);
  return t;
}

/* Open-coded tag read: prove codegen can skip the qjs_tag call by loading the
 * high half of the handle cell directly, using the EXTRACTED tagOffset. */
int EXP(r3_open_coded_tag)(void *ctx, u32 tagOffset) {
  u32 o = qjs_new_object(ctx);
  int t = *(int *)(unsigned long)(o + tagOffset);
  qjs_free_value(ctx, o);
  return t;
}

/* ---------------------------------------------------------------- R4 ------ */
int EXP(bench_trampoline)(u32 iters) {
  int acc = 0;
  for (u32 i = 0; i < iters; i++) acc += qjs_noop();
  return acc;
}

/* NOTE: a pure arithmetic baseline loop is USELESS here — LLVM closes it into
 * a formula (measured 0.05 ns/iter, i.e. the loop was deleted). The honest
 * baselines are (a) the same loop shape calling a LOCAL function, which
 * isolates the cost of crossing the module boundary, and (b) a loop with a
 * volatile load, which LLVM cannot delete. */
static __attribute__((noinline)) int local_noop(void) { return 0; }

int EXP(bench_localcall)(u32 iters) {
  int acc = 0;
  for (u32 i = 0; i < iters; i++) acc += local_noop();
  return acc;
}

int EXP(bench_baseline)(u32 iters, volatile const int *p) {
  int acc = 0;
  for (u32 i = 0; i < iters; i++) acc += *p;
  return acc;
}

/* GetProp + ToFloat64 + FreeValue on a live object, per iteration. */
double EXP(bench_getprop)(void *ctx, u32 obj, const char *name, u32 iters) {
  double acc = 0;
  for (u32 i = 0; i < iters; i++) {
    u32 h = qjs_get_prop_str(ctx, obj, name);
    acc += qjs_to_f64(ctx, h);
    qjs_free_value(ctx, h);
  }
  return acc;
}

/* One full parse+execute of a source buffer the harness placed in the heap. */
double EXP(bench_eval_once)(void *ctx, const char *src, u32 len) {
  u32 h = qjs_eval(ctx, src, len);
  if (qjs_is_exception(h)) { qjs_free_value(ctx, h); return -2; }
  double d = qjs_to_f64(ctx, h);
  qjs_free_value(ctx, h);
  return d;
}

/* -------------------------------------------------------------- helpers --- */
void *EXP(peer_new_runtime)(void) { return qjs_new_runtime(); }
void *EXP(peer_new_context)(void *rt) { return qjs_new_context(rt); }
u32 EXP(peer_make_obj_with_x)(void *ctx) {
  char *s = alloc_str(2);
  putw(s, 0, P4('(', '{', 'x', ':'));
  putw(s, 1, P4('4', '1', '}', ')'));
  s[8] = 0;
  u32 h = qjs_eval(ctx, s, 8);
  qjs_free_raw(s);
  return h;
}
u32 EXP(peer_name_x)(void) {
  char *s = alloc_str(1);
  putw(s, 0, P4('x', 0, 0, 0));
  return (u32)(unsigned long)s;
}
u64 EXP(peer_handle_raw)(u32 h) { return qjs_handle_raw(h); }
u32 EXP(peer_dup)(void *ctx, u32 h) { return qjs_dup(ctx, h); }
void EXP(peer_free)(void *ctx, u32 h) { qjs_free_value(ctx, h); }
u32 EXP(peer_alloc)(u32 n) { return (u32)(unsigned long)qjs_malloc_raw(n); }
