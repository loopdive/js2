/* #4544 Part A — the native floor denominator.
 *
 * The same loop as website/public/benchmarks/competitive/programs/fib.js,
 * hand-written in C and compiled by the same clang at the same -O2 -fwrapv.
 * This is the number the AOT routes are measured AGAINST: what a native binary
 * costs in size and startup when no Wasm was ever in the picture.
 *
 * -fwrapv is not decoration: JS `|0` wraps and signed overflow in C is
 * undefined, which ADR-0021 lists as a semantic requirement of any C target.
 */
#include <stdio.h>
#include <stdlib.h>

static int run(int n) {
  int a = 0;
  int b = 1;
  for (int i = 0; i < n; i++) {
    int next = a + b;
    a = b;
    b = next;
  }
  return a;
}

int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 0;
  printf("%d\n", run(n));
  return 0;
}
