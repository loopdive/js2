/* #4544 Part A — native driver for the DYNAMIC-TIER binary.
 *
 * This is the hard case for the recommended route. The corpus programs link no
 * engine at all; this one links the whole QuickJS boxed tier (#4236) — a 1 MB
 * wasm32-wasip1 module — through wasm2c into a single native executable, and
 * evaluates JavaScript in it. It exists to answer two questions the corpus
 * cannot:
 *
 *   1. Does the wasm2c route survive a real, large, C-derived module at all?
 *   2. What does a program WITH a dynamic residue weigh natively?
 *
 * The five `wasi_snapshot_preview1` imports are implemented right here, in
 * about forty lines, because that is the whole host surface the artifact needs
 * — no uvwasi, no WASI SDK at run time. `fd_write` is the only one that does
 * real work; the rest are the stubs a reactor module touches on paths QuickJS
 * does not take.
 *
 * NOTE ON THE ABI: under wasm2c a wasm pointer is a u32 offset into the
 * module's linear memory, NOT a C pointer. Every string handed to or taken from
 * QuickJS has to be moved through `qjs_malloc_raw` + the memory base, which is
 * exactly the discipline scripts/quickjs-artifact/README.md describes for the
 * peer module.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "wasm-rt.h"

#include "qjs.h"

/* ------------------------------------------------------- the five imports -- */
/* wasm2c routes host imports through an opaque instance pointer; this module
 * needs no host state, so the struct is empty and the pointer is a token. */
struct w2c_wasi__snapshot__preview1 {
  w2c_qjs *mod;
};

static uint8_t *mem_base(struct w2c_wasi__snapshot__preview1 *w) {
  return w2c_qjs_memory(w->mod)->data;
}

static u32 ld32(struct w2c_wasi__snapshot__preview1 *w, u32 addr) {
  u32 v;
  memcpy(&v, mem_base(w) + addr, 4);
  return v;
}

static void st32(struct w2c_wasi__snapshot__preview1 *w, u32 addr, u32 v) {
  memcpy(mem_base(w) + addr, &v, 4);
}

/* The only import that does real work: gather the iovecs and write them out. */
u32 w2c_wasi__snapshot__preview1_fd_write(struct w2c_wasi__snapshot__preview1 *w, u32 fd, u32 iovs,
                                          u32 iovs_len, u32 nwritten) {
  u32 total = 0;
  FILE *out = fd == 2 ? stderr : stdout;
  for (u32 i = 0; i < iovs_len; i++) {
    u32 buf = ld32(w, iovs + i * 8);
    u32 len = ld32(w, iovs + i * 8 + 4);
    if (len) total += (u32)fwrite(mem_base(w) + buf, 1, len, out);
  }
  st32(w, nwritten, total);
  return 0;
}

u32 w2c_wasi__snapshot__preview1_clock_time_get(struct w2c_wasi__snapshot__preview1 *w, u32 id,
                                                u64 precision, u32 out) {
  (void)id;
  (void)precision;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  u64 ns = (u64)ts.tv_sec * 1000000000ull + (u64)ts.tv_nsec;
  memcpy(mem_base(w) + out, &ns, 8);
  return 0;
}

u32 w2c_wasi__snapshot__preview1_fd_close(struct w2c_wasi__snapshot__preview1 *w, u32 fd) {
  (void)w;
  (void)fd;
  return 0;
}

u32 w2c_wasi__snapshot__preview1_fd_fdstat_get(struct w2c_wasi__snapshot__preview1 *w, u32 fd,
                                                u32 out) {
  (void)fd;
  memset(mem_base(w) + out, 0, 24);
  return 0;
}

u32 w2c_wasi__snapshot__preview1_fd_seek(struct w2c_wasi__snapshot__preview1 *w, u32 fd, u64 off,
                                          u32 whence, u32 out) {
  (void)fd;
  (void)off;
  (void)whence;
  memset(mem_base(w) + out, 0, 8);
  return 0;
}

/* --------------------------------------------------------------- the run -- */

int main(int argc, char **argv) {
  const char *src = argc > 1 ? argv[1] : "1+1";
  const u32 len = (u32)strlen(src);

  wasm_rt_init();
  static w2c_qjs mod;
  struct w2c_wasi__snapshot__preview1 wasi = {&mod};
  wasm2c_qjs_instantiate(&mod, &wasi);
  w2c_qjs_0x5Finitialize(&mod); /* reactor init */

  u32 rt = w2c_qjs_qjs_new_runtime(&mod);
  u32 ctx = w2c_qjs_qjs_new_context(&mod, rt);

  /* Move the source into the module's heap — a wasm "pointer" is an offset. */
  u32 buf = w2c_qjs_qjs_malloc_raw(&mod, len + 1);
  memcpy(w2c_qjs_memory(&mod)->data + buf, src, len + 1);

  u32 val = w2c_qjs_qjs_eval(&mod, ctx, buf, len);
  u32 cstr = w2c_qjs_qjs_to_cstring(&mod, ctx, val);
  printf("%s\n", cstr ? (char *)(w2c_qjs_memory(&mod)->data + cstr) : "(null)");

  wasm_rt_free();
  return 0;
}
