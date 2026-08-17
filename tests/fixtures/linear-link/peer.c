// Freestanding C peer for the #4539 link test. No libc, no WASI: it exists
// only to be a REAL C-compiled wasm module that owns a memory and exports a
// function, so the linear module is proven to link against C rather than
// against JS stubs.
__attribute__((export_name("c_double"))) int c_double(int x) { return x * 2; }

// Touch linear memory so the module genuinely owns one, and give the test a
// way to observe that both modules address the SAME bytes.
__attribute__((export_name("c_poke"))) int c_poke(int addr, int value) {
  *(int *)addr = value;
  return *(int *)addr;
}
