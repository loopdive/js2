// Native Messaging host, compiled to standalone WASI by js2wasm — the **Deno**
// synchronous-stdio variant.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm_deno.ts --target wasi -o out
//
// `--target wasi` emits a SELF-CONTAINED WASI Preview-1 command module: it
// imports ONLY `wasi_snapshot_preview1` (fd_read / fd_write), owns + exports its
// own `memory`, and runs directly under a WASI host such as wasmtime — no Deno
// runtime, no JS host (#2684). This is the loopdive/js2wasm#389 reporter's exact use
// case: a host that runs under a WASI host, explicitly "not chasing Node.js".
//
// This source uses REAL Deno synchronous fd-based IO — `Deno.stdin.readSync` /
// `Deno.stdout.writeSync` — so the SAME file ALSO runs UNMODIFIED under real
// `deno` (which provides the `Deno` namespace):
//
//   deno run --allow-read --allow-write examples/native-messaging/nm_js2wasm_deno.ts
//
// Deno's stdio primitives are fd-based and synchronous, mapping 1:1 to WASI:
//
//   Deno.stdin.readSync(p: Uint8Array): number | null   // bytes read, null @EOF
//   Deno.stdout.writeSync(p: Uint8Array): number         // bytes written (fd 1)
//
// `readSync` returns `null` at end-of-stream — the faithful EOF signal the shared
// core uses to terminate the port loop. js2wasm lowers the `number | null` result
// to the compiler's native nullable representation (no JS host needed), so
// `=== null` works in the standalone module exactly as it does under real Deno.
//
// The Native Messaging FRAMING + browser-cap re-chunk streaming itself lives in
// the shared, host-independent core `nm_js2wasm_sync_framing.ts` (#2778) — this file is
// just the thin Deno adapter that injects `Deno.stdin.readSync` /
// `Deno.stdout.writeSync` into the `runNmHost` seam and runs it with a **1 MiB
// re-chunk cap** (#2814), exactly like `nm_js2wasm_node_fs.ts`. A body larger than
// the browser 1 MiB per-host->extension-message cap is split into a sequence of
// valid <=1 MiB JSON frames (`[run]` for an array body, `"run"` for a string body)
// whose interiors, concatenated by the receiver, reproduce the original body; a
// body that already fits is echoed verbatim. This keeps every host->extension
// message within the real Chrome cap and bounds resident memory on the write side.
// `nm_js2wasm_wasi_p1.ts` is the raw `wasi_snapshot_preview1` `fd_read`/`fd_write`
// form (it re-chunks too, in linear memory). All compile to the SAME pure-WASI-P1
// shape; they differ only in which runtime's source-level API they additionally
// run under, unmodified. NO Native-Messaging host echoes a single >1 MiB frame
// (#2814 — re-chunking is not optional; loopdive/js2wasm#389).
//
// The seam is two FUNCTION references (`denoRead` / `denoWrite`), not an object:
// passing a struct value across the bundled-module boundary traps at runtime
// under `--target wasi` today, while function references cross cleanly (#2778 —
// see the note atop `nm_js2wasm_sync_framing.ts`).
//
// Native Messaging protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 JSON body, exchanged over fd 0 (stdin) / fd 1 (stdout). See
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

import { runNmHost } from "./nm_js2wasm_sync_framing.ts";

// ONE Deno `readSync`: fills the whole buffer it is handed and returns the count,
// or `null` at EOF (the core treats `null` / `<= 0` as EOF).
function denoRead(buf: Uint8Array): number | null {
  return Deno.stdin.readSync(buf);
}

// Drain the WHOLE of `buf` to fd 1. Deno writes the entire buffer it is handed and
// returns the count, so on a partial write we continue with an exact-size copy of
// the unwritten tail (no subarray).
function denoWrite(buf: Uint8Array): void {
  let rest = buf;
  while (rest.length > 0) {
    const w = Deno.stdout.writeSync(rest);
    if (w <= 0) return; // error; nothing more we can do on this frame
    if (w >= rest.length) return; // whole buffer written
    const tail = new Uint8Array(rest.length - w);
    let i = 0;
    while (i < tail.length) {
      tail[i] = rest[w + i];
      i = i + 1;
    }
    rest = tail;
  }
}

// No fd-2 telemetry in the Deno variant (the fd-2 diagnostics line is the
// `nm_js2wasm_node_fs` demo's deliberate extra; this thin Deno adapter keeps the
// no-op to stay focused on the stdio seam). The shared core's re-chunk path calls
// this once per input message with the declared body length; a no-op is a valid
// implementation of the `log` hook.
function denoNoLog(declaredLen: number): void {
  // intentionally empty; `declaredLen` is referenced so strict typecheck is happy
  void declaredLen;
}

export function main(): void {
  // Largest body the browser Native-Messaging implementation accepts in one
  // host->extension message — the shared core's re-chunk cap (#2814). A body
  // larger than this is split into valid <=1 MiB JSON frames; a smaller body is
  // echoed verbatim. Streams to EOF / a zero-length shutdown frame.
  //
  // Kept a LOCAL const (not module-level) on purpose: a module-level const lowers
  // to a Wasm GLOBAL, and passing that global as the cap argument across the
  // bundled-module call into the shared core mis-lowers under `--target wasi` → a
  // runtime fault (a clean compile, but a fault) — the same multi-file
  // index-shift gap noted in `nm_js2wasm_node_fs.ts` (#2778). A local const (or an
  // inline literal) compiles to a plain `i32.const` operand and is unaffected.
  const frameChunk = 1024 * 1024;
  runNmHost(denoRead, denoWrite, denoNoLog, frameChunk);
}

// Invoke the entry point. js2wasm compiles a top-level call into the module's
// `_start` (which wasmtime runs); under real `deno` this runs the host loop
// directly.
main();
