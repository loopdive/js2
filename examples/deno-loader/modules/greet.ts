// A plain TypeScript module. Nothing here is Wasm-specific — the loader
// compiles it to a WasmGC module on import and the exports below become
// directly callable Wasm functions.

export function add(a: number, b: number): number {
  return a + b;
}

export function fib(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

export function greet(name: string): string {
  return "Hello, " + name + "!";
}
