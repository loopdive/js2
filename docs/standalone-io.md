# Standalone I/O (STDIN / STDOUT / STDERR)

When you compile with `--target wasi` (or `--standalone` with WASI imports),
the output is a pure-Wasm module with no JavaScript host. It talks to the
outside world through WASI Preview 1 file descriptors. This page shows the
idiomatic patterns for reading STDIN and writing STDOUT/STDERR, plus the command
to run the result.

All examples assume a WASI-capable runtime (Wasmtime 44+). Compile with:

```bash
js2wasm program.ts --target wasi -O2
```

and run with the proposal flags WasmGC output needs:

```bash
wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y program.wasm
```

> Use this targeted flag set, **not** `-W all-proposals=y`: all-proposals also
> enables the stack-switching proposal, which Wasmtime 44/45 rejects at module
> load (`the wasm_stack_switching feature is not supported on this compiler
> configuration`), so the module exits before running anything.

## Writing STDOUT

`console.log` is routed to file descriptor 1 (stdout) via WASI `fd_write`:

```ts
export function main(): void {
  console.log("hello from wasm");
}
```

```bash
$ wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y program.wasm
hello from wasm
```

## Writing STDERR

`console.warn` and `console.error` are routed to file descriptor 2 (stderr):

```ts
export function main(): void {
  console.error("this goes to stderr");
}
```

```bash
$ wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y program.wasm 2>err.txt
$ cat err.txt
this goes to stderr
```

## Reading STDIN

STDIN is read with the `readStdin()` builtin. Declare it (it is provided by the
compiler under `--target wasi`, not a value you implement) and call it to drain
all of standard input as a string:

```ts
declare function readStdin(): string;

export function main(): void {
  const input = readStdin();
  // ... process input ...
  console.log(input);
}
```

Pipe input to the module on the command line:

```bash
$ echo "some input" | wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y program.wasm
```

`readStdin()` reads until EOF and returns the entire stream as one string. It
compiles to a WASI `fd_read` loop on file descriptor 0; the `fd_read` import is
only added to the module when `readStdin()` is actually used.

> **Known caveat:** the end-to-end `readStdin()` → `console.log()` round-trip
> can currently print a boxed string representation in some cases because the
> WASI string-return path goes through the externref boxing helper. The
> `fd_read` / `fd_write` plumbing and import registration are validated; the
> string-boxing edge is tracked separately. If you hit it, process the input
> into a non-string result (e.g. a count) as a workaround.

## Writing arbitrary files

`writeFileSync` opens a path with WASI `path_open` and writes via `fd_write`.
The runtime must grant directory access with `--dir`:

```ts
export function main(): void {
  writeFileSync("out.txt", "file contents");
}
```

```bash
$ wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y --dir . program.wasm
$ cat out.txt
file contents
```

## Summary

| Operation | JS you write | WASI mechanism |
| --- | --- | --- |
| Read all of STDIN | `readStdin()` | `fd_read` on fd 0 |
| Write STDOUT | `console.log(...)` | `fd_write` on fd 1 |
| Write STDERR | `console.warn` / `console.error` | `fd_write` on fd 2 |
| Write a file | `writeFileSync(path, data)` | `path_open` + `fd_write` |
