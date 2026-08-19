/* #4544 Part A — native driver for the wasm2c route.
 *
 * wasm2c emits a translation unit per module plus a header declaring the
 * instance struct and the exports; it does NOT emit a `main`. This is that
 * `main`: instantiate, call the exported `run`, print, free.
 *
 * One template serves every corpus program — the build script passes MOD_NAME
 * (the wasm2c module prefix, derived from the output filename) and MOD_HEADER,
 * and defines ARITY0 for the one program whose `run` takes no argument.
 *
 * Note what is NOT here: no WASI shim, no host imports, no runtime lookup. The
 * linear backend's modules import nothing, so the whole native binary is this
 * file plus the translated module plus wabt's ~15 KB wasm-rt.
 */
#include <stdio.h>
#include <stdlib.h>

#include "wasm-rt.h"

#include MOD_HEADER

#define CAT_(a, b) a##b
#define CAT(a, b) CAT_(a, b)
#define INSTANTIATE CAT(CAT(wasm2c_, MOD_NAME), _instantiate)
#define FREEFN CAT(CAT(wasm2c_, MOD_NAME), _free)
#define RUNFN CAT(CAT(w2c_, MOD_NAME), _run)
#define INSTTYPE CAT(w2c_, MOD_NAME)

int main(int argc, char **argv) {
  double arg = argc > 1 ? atof(argv[1]) : 0.0;
  (void)arg;

  wasm_rt_init();
  struct INSTTYPE inst;
  INSTANTIATE(&inst);

#ifdef ARITY0
  double r = RUNFN(&inst);
#else
  double r = RUNFN(&inst, arg);
#endif

  printf("%.0f\n", r);

  FREEFN(&inst);
  wasm_rt_free();
  return 0;
}
