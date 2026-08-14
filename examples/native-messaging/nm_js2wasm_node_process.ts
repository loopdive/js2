// Native Messaging host, compiled to standalone WASI by js2wasm — the
// **`node:process` async-stream** variant.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm_node_process.ts --target wasi -o out
//
// This is the faithful Node `process.stdin` / `process.stdout` expression of the
// host. Where the sibling `nm_js2wasm_node_fs.ts` uses the SYNCHRONOUS `node:fs`
// `readSync`/`writeSync(fd, …)` primitives, and `nm_js2wasm_wasi_p1.ts` speaks RAW
// `wasi_snapshot_preview1` syscalls over linear memory, THIS variant uses the
// real Node **streaming** stdio surface:
//
//   - `process.stdin`  is an async **Readable** stream (#2632): you subscribe to
//     `'data'` chunks and an `'end'` event — there is NO synchronous, blocking
//     `read` that fills a caller buffer. js2wasm injects a faithful Readable
//     source-prelude (`src/process-stdin-prelude.ts`) so the public Node API
//     compiles under `--target wasi`; each `'data'` chunk is delivered as a
//     **string** whose char codes are the raw incoming bytes (one char per byte,
//     built via `String.fromCharCode`). The fd0 reactor reads at most ONE 64 KiB
//     page per tick (`RL_STDIN_BUF_CAP` in `src/codegen/async-scheduler.ts`), so
//     each `'data'` chunk is itself bounded (~64 KiB) regardless of frame size.
//   - `process.stdout.write(bytes)` writes to fd 1 (#1651). We hand it a
//     **`Uint8Array`** so the framed response goes out as RAW bytes — a string
//     argument would be UTF-8 re-encoded, which would corrupt the binary 4-byte
//     length prefix (its bytes are not all ASCII) and any high body byte. The
//     `Uint8Array` overload bypasses string encoding and writes the bytes verbatim.
//
// READ-SIDE STREAMING — bounded resident memory (#2832). An earlier version
// BUFFERED THE WHOLE INPUT FRAME: it concatenated every `'data'` chunk into one
// growing `Uint8Array` and only echoed a frame once the entire body had arrived
// (`drain` required `tail - head >= 4 + len`). That made the read side's peak RSS
// scale ~8x the frame size (≈530 MB at 64 MiB, ≈2 GB at 256 MiB) — exactly the
// loopdive/js2wasm#389 reporter's "node_process climbed to ~98% memory on a 64 MiB
// frame". #2814 re-chunked only the WRITE side; the read side still held the full
// frame. The sibling SYNCHRONOUS hosts (`nm_js2wasm_node_fs`, `nm_js2wasm_deno` via
// the shared `nm_js2wasm_sync_framing` core, and `nm_js2wasm_wasi_p1`) stay flat
// (tens of MB) because their `readSync` seam lets them pull the body in a fixed
// window and re-chunk on the fly, never holding the whole frame.
//
// This variant now does the SAME, push-driven against the async `'data'` reactor:
// an incremental STATE MACHINE consumes each bounded `'data'` chunk and re-frames
// the protocol WITHOUT ever buffering a whole multi-MiB frame. The only resident
// buffers are (a) a single reused `FRAME_CAP` re-chunk window, (b) the per-output
// frame buffer (<= FRAME_CAP), and (c) for a body that already fits the cap, one
// verbatim frame buffer (<= FRAME_CAP). Peak resident is therefore ~a couple of
// MiB — flat across 64/128/256 MiB, matching the other three hosts. This mirrors
// the streaming/re-chunk logic of the shared `nm_js2wasm_sync_framing` core
// (`runRechunk`), turned inside-out: instead of PULLING exact-size reads, the
// reactor PUSHES <=64 KiB chunks and the state machine advances across them.
//
// CODEGEN CONSTRAINT — module-global Uint8Array reads (#2832). A js2wasm quirk
// shapes the structure below: a module-scope `Uint8Array` that is *read* (by
// element) DIRECTLY inside a function it was not assigned in compiles to a
// throwing null-guard ("Cannot access property on null or undefined"), and the
// same array *passed through TWO function-parameter levels* degrades to an
// externref whose element reads lower to a host `__extern_get` import (which is
// absent under standalone WASI). Both miscompile the read side. The pattern that
// compiles correctly: WRITE the module-global window directly in the chunk handler
// (`onData`), and do every window READ inside a ONE-LEVEL helper that takes the
// window as a parameter and copies inline — never reading the global directly and
// never calling a second window-reading helper. That is why the 4-byte length
// prefix is decoded with a running NUMBER accumulator (no header array) and why
// the array re-chunk helpers inline their output-frame copy instead of sharing
// one `emitFrame`. (The string path can call `emitFrame` because it is reached at
// exactly one level from `onData`.)
//
// On the WRITE side the echo is re-chunked to the 1 MiB browser cap (#2810): a
// body within the cap is echoed verbatim — prefix + body — as one
// `process.stdout.write`; a body LARGER than the cap is split into a sequence of
// valid <=1 MiB JSON frames (`[run]` for an array body, `"run"` for a string
// body) whose interiors, concatenated by the receiver, reproduce the original
// body. This matches the sibling `nm_js2wasm_node_fs` re-chunker, keeps every
// host->extension message within the real Chrome 1 MiB cap, and bounds resident
// memory on the write side.
//
// Native Messaging protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 JSON body, exchanged over stdin (fd 0) / stdout (fd 1). See
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// This variant echoes a framed message back, re-chunked to the 1 MiB browser cap
// (verbatim when it already fits). NOTE: `process`
// is referenced as the Node **global** (not `import process from "node:process"`).
// The prelude injection that backs `process.stdin` deliberately leaves a
// user-declared/-imported `process` binding alone, so the faithful global surface
// is what compiles to the async Readable here.
//
// Clean shutdown WITHOUT stdin EOF (#2735): a real Native-Messaging port keeps
// stdin OPEN for the lifetime of the connection and signals end-of-conversation
// IN BAND — here, with a zero-length frame (a 4-byte prefix declaring length 0).
// The fd0 reactor that drives the async `'data'` callbacks only terminates on
// stdin EOF, so an open-stdin peer would make `_start` block forever. On the
// shutdown frame we therefore call `process.stdin.destroy()`, which drops the
// reactor's fd0 subscription so the run loop falls through and the program exits
// cleanly. (`process.exit(0)` is the alternative — it routes to WASI `proc_exit`
// after the same subscription drop.) Feeding the host a bounded buffer that hits
// EOF still exits via the `'end'` path, exactly as before.

// Browser per-host->extension-message cap: 1 MiB (#2810). A real Chrome Native-
// Messaging host may send AT MOST 1 MiB per host->extension message, so a body
// larger than this isn't even valid on that surface. Like the sibling
// `nm_js2wasm_node_fs.ts` re-chunker, a >1 MiB response body is split on the
// WRITE side into a sequence of valid <=1 MiB JSON frames whose interiors,
// concatenated by the receiver, reproduce the original body; a body that already
// fits is echoed verbatim.
const FRAME_CAP: number = 1024 * 1024;
// Largest re-chunk run: leave room for the framing `[`/`]` (or the two `"`), so a
// re-chunked frame body (`open` + run + `close`) stays within FRAME_CAP.
const MAX_RUN: number = FRAME_CAP - 2;
const COMMA: number = 44; // ,
const OPEN_BRACKET: number = 91; // [
const CLOSE_BRACKET: number = 93; // ]
const DQUOTE: number = 34; // "

// ── Incremental read-side state machine ──────────────────────────────────────
// The reactor PUSHES <=64 KiB `'data'` chunks; this state machine advances across
// frame boundaries that may fall anywhere within (or across) a chunk. None of its
// buffers grow with the frame size — `win` is a fixed FRAME_CAP window, `vbuf` is
// a per-frame verbatim buffer (<= FRAME_CAP), and the remaining state is counters.
const ST_HEADER: number = 0; // filling the 4-byte length prefix
const ST_VERBATIM: number = 1; // body <= cap: filling vbuf[4..], then one write
const ST_PEEK: number = 2; // body > cap: read the opening `[`/`"` to pick the shape
const ST_ARRAY: number = 3; // body > cap, array: stream interior → `[run]` frames
const ST_STRING: number = 4; // body > cap, string: stream interior → `"run"` frames
const ST_TRAILER: number = 5; // body > cap: discard the closing `]`/`"` byte

let st: number = ST_HEADER;
// Set once a zero-length frame (clean shutdown) is seen, matching the sibling
// variants which treat a declared length of 0 as end-of-stream.
let stopped: boolean = false;

// 4-byte LE length prefix decoded with a running NUMBER accumulator across chunk
// boundaries (NOT a `header` Uint8Array — see the "CODEGEN CONSTRAINT" note: a
// module-global array read directly inside a function miscompiles to a throwing
// null-guard). `headerMul` is 256^headerFill; little-endian byte k contributes
// `byte * 256^k`. js2wasm numbers are f64, so the max prefix value (~4.29e9) is
// exact.
let headerAcc: number = 0;
let headerMul: number = 1;
let headerFill: number = 0;

// Verbatim path (body <= cap): one per-frame buffer holding prefix + body; emitted
// in ONE write once full. Sized per frame (<= 4 + FRAME_CAP), allocated then
// released — bounded at ~1 MiB. `vbuf` is read only as a whole value (passed to
// `process.stdout.write`) and element-WRITTEN in `onData`, so it is exempt from
// the element-read miscompile.
let vbuf: Uint8Array = new Uint8Array(4);
let vfill: number = 0; // bytes written into vbuf so far (includes the 4 prefix bytes)
let vneed: number = 0; // total bytes = 4 + body length

// Re-chunk path (body > cap): a single reused FRAME_CAP window the interior is
// streamed through, plus the count of interior bytes not yet pushed into it.
// `onData` only ever WRITES `win` (element writes are safe); every READ of `win`
// happens inside a one-level helper that receives it as a parameter.
const win: Uint8Array = new Uint8Array(FRAME_CAP);
let fill: number = 0; // live bytes in win[0..fill)
let interiorRemaining: number = 0; // interior input bytes not yet consumed

// Emit ONE re-chunked JSON frame from a window passed by parameter: 4-byte LE
// length prefix + `open` + `w[srcStart..srcStart+runLen)` + `close`, built whole
// and written in ONE process.stdout.write (atomic framing — a streaming receiver
// must never see a prefix split from its body; #2526). `open`/`close` are `[`/`]`
// for an array body or `"`/`"` for a string body. The 4-byte prefix declares the
// JSON body length (`open` + run + `close`), which stays <= FRAME_CAP because
// `runLen <= MAX_RUN`. Used by the STRING path (reached at one level from
// `onData`); the array path inlines this copy to stay within one read level.
function emitFrame(w: Uint8Array, srcStart: number, runLen: number, open: number, close: number): void {
  const bodyLen = runLen + 2; // delimiter + run + delimiter
  const out = new Uint8Array(4 + bodyLen);
  out[0] = bodyLen & 0xff;
  out[1] = (bodyLen >> 8) & 0xff;
  out[2] = (bodyLen >> 16) & 0xff;
  out[3] = (bodyLen >> 24) & 0xff;
  out[4] = open;
  let k = 0;
  while (k < runLen) {
    out[5 + k] = w[srcStart + k];
    k = k + 1;
  }
  out[4 + runLen + 1] = close;
  process.stdout.write(out);
}

// Window full (fill === FRAME_CAP) mid-array: emit ONE `[run]` frame ending at the
// last comma within [0, MAX_RUN) so the frame holds whole elements, then shift the
// leftover (a partial trailing element) to the front. Mirrors the per-buffer step
// of the shared core's `runRechunk` array path. The output-frame copy is INLINED
// (not delegated to `emitFrame`) so `w` is read at exactly one level — see the
// "CODEGEN CONSTRAINT" note.
function emitArrayWindow(w: Uint8Array): void {
  let last = MAX_RUN;
  while (last > 0 && w[last - 1] !== COMMA) last = last - 1;
  let runLen: number;
  let consumed: number;
  if (last === 0) {
    // No comma in [0, MAX_RUN): a single element exceeds the cap — emit MAX_RUN raw
    // (degenerate; only for elements > ~FRAME_CAP bytes), matching the shared core.
    runLen = MAX_RUN;
    consumed = MAX_RUN;
  } else {
    runLen = last - 1; // exclude the comma at last-1
    consumed = last; // skip the comma too
  }
  const bodyLen = runLen + 2;
  const out = new Uint8Array(4 + bodyLen);
  out[0] = bodyLen & 0xff;
  out[1] = (bodyLen >> 8) & 0xff;
  out[2] = (bodyLen >> 16) & 0xff;
  out[3] = (bodyLen >> 24) & 0xff;
  out[4] = OPEN_BRACKET;
  let k = 0;
  while (k < runLen) {
    out[5 + k] = w[k];
    k = k + 1;
  }
  out[4 + runLen + 1] = CLOSE_BRACKET;
  process.stdout.write(out);
  // Shift the leftover w[consumed..fill) to the front for the next window fill.
  const rem = fill - consumed;
  let m = 0;
  while (m < rem) {
    w[m] = w[consumed + m];
    m = m + 1;
  }
  fill = rem;
}

// Final array batch: the whole interior has been streamed into `w[0..fill)` (the
// last frame ends exactly at `fill` — a JSON array has no trailing comma). Drain it
// into <=MAX_RUN `[run]` frames at comma boundaries. Mirrors the final-batch drain
// of the shared core's `runRechunk`. Output-frame copy is INLINED (one read level).
function drainArrayFinal(w: Uint8Array): void {
  let startPos = 0;
  while (startPos < fill) {
    let stop = startPos + MAX_RUN;
    if (stop >= fill) {
      stop = fill;
    } else {
      let c = stop;
      while (c > startPos && w[c - 1] !== COMMA) c = c - 1;
      if (c > startPos) stop = c - 1;
    }
    const runLen = stop - startPos;
    const bodyLen = runLen + 2;
    const out = new Uint8Array(4 + bodyLen);
    out[0] = bodyLen & 0xff;
    out[1] = (bodyLen >> 8) & 0xff;
    out[2] = (bodyLen >> 16) & 0xff;
    out[3] = (bodyLen >> 24) & 0xff;
    out[4] = OPEN_BRACKET;
    let k = 0;
    while (k < runLen) {
      out[5 + k] = w[startPos + k];
      k = k + 1;
    }
    out[4 + runLen + 1] = CLOSE_BRACKET;
    process.stdout.write(out);
    startPos = stop;
    if (startPos < fill && w[startPos] === COMMA) startPos = startPos + 1;
  }
  fill = 0;
}

// Process one bounded `'data'` chunk through the state machine. Each loop iteration
// performs ONE state step over `chunk[ci..]`; body states (VERBATIM/ARRAY/STRING)
// consume a SPAN at a time (not byte-by-byte) so a 64 KiB chunk is handled in a
// handful of steps. The chunk is a FLAT string (one char per byte), so
// `charCodeAt` is O(1).
function onData(chunk: string): void {
  if (stopped) return;
  const n = chunk.length;
  let ci = 0;
  while (ci < n && !stopped) {
    if (st === ST_HEADER) {
      while (headerFill < 4 && ci < n) {
        headerAcc = headerAcc + (chunk.charCodeAt(ci) & 0xff) * headerMul;
        headerMul = headerMul * 256;
        headerFill = headerFill + 1;
        ci = ci + 1;
      }
      if (headerFill < 4) return; // prefix split across chunks — wait for more
      const len = headerAcc;
      headerAcc = 0;
      headerMul = 1;
      headerFill = 0;
      if (len === 0) {
        stopped = true; // zero-length frame = clean shutdown
        // #2735: in-band shutdown. The peer keeps stdin OPEN — `.destroy()` drops
        // the fd0 reactor subscription so `_start` returns cleanly.
        process.stdin.destroy();
        return;
      }
      if (len <= FRAME_CAP) {
        // Body already within the cap — accumulate prefix + body, emit once full.
        vneed = 4 + len;
        vbuf = new Uint8Array(vneed);
        vbuf[0] = len & 0xff;
        vbuf[1] = (len >> 8) & 0xff;
        vbuf[2] = (len >> 16) & 0xff;
        vbuf[3] = (len >> 24) & 0xff;
        vfill = 4;
        st = ST_VERBATIM;
      } else {
        // Interior excludes the outer `[`/`]` (or the two `"`): the opening byte is
        // consumed in ST_PEEK, the closing byte in ST_TRAILER.
        interiorRemaining = len - 2;
        fill = 0;
        st = ST_PEEK;
      }
    } else if (st === ST_VERBATIM) {
      let avail = n - ci;
      const space = vneed - vfill;
      if (avail > space) avail = space;
      let k = 0;
      while (k < avail) {
        vbuf[vfill + k] = chunk.charCodeAt(ci + k) & 0xff;
        k = k + 1;
      }
      vfill = vfill + avail;
      ci = ci + avail;
      if (vfill === vneed) {
        process.stdout.write(vbuf);
        st = ST_HEADER;
      }
    } else if (st === ST_PEEK) {
      // First interior byte picks the re-chunk shape: `"` → JSON string, else array.
      const b = chunk.charCodeAt(ci) & 0xff;
      ci = ci + 1;
      if (b === DQUOTE) {
        st = ST_STRING;
      } else {
        st = ST_ARRAY;
      }
    } else if (st === ST_ARRAY) {
      // Stream interior into the window up to FRAME_CAP (or until the interior is
      // exhausted), emitting `[run]` frames as the window fills.
      let avail = n - ci;
      const space = FRAME_CAP - fill;
      if (avail > space) avail = space;
      if (avail > interiorRemaining) avail = interiorRemaining;
      let k = 0;
      while (k < avail) {
        win[fill + k] = chunk.charCodeAt(ci + k) & 0xff;
        k = k + 1;
      }
      fill = fill + avail;
      ci = ci + avail;
      interiorRemaining = interiorRemaining - avail;
      if (interiorRemaining === 0) {
        drainArrayFinal(win);
        st = ST_TRAILER;
      } else if (fill === FRAME_CAP) {
        emitArrayWindow(win);
      }
    } else if (st === ST_STRING) {
      // Stream interior into the window up to MAX_RUN, emitting `"run"` frames at a
      // fixed run (no comma boundaries to honor, unlike the array path). The fixed
      // split must not bisect a `\`-escape; for the reported workload the body is
      // plain printable characters, so a fixed split is valid — same caveat as the
      // shared core's emitStringRun.
      let avail = n - ci;
      const space = MAX_RUN - fill;
      if (avail > space) avail = space;
      if (avail > interiorRemaining) avail = interiorRemaining;
      let k = 0;
      while (k < avail) {
        win[fill + k] = chunk.charCodeAt(ci + k) & 0xff;
        k = k + 1;
      }
      fill = fill + avail;
      ci = ci + avail;
      interiorRemaining = interiorRemaining - avail;
      if (fill === MAX_RUN) {
        emitFrame(win, 0, MAX_RUN, DQUOTE, DQUOTE);
        fill = 0;
      }
      if (interiorRemaining === 0) {
        if (fill > 0) {
          emitFrame(win, 0, fill, DQUOTE, DQUOTE);
          fill = 0;
        }
        st = ST_TRAILER;
      }
    } else if (st === ST_TRAILER) {
      // Discard the closing `]`/`"` byte; the frame is fully echoed.
      ci = ci + 1;
      st = ST_HEADER;
    }
  }
}

// NOTE: `main` is intentionally NOT exported. An exported no-arg `main` becomes
// the WASI `_start` target AND is *also* invoked by the top-level `main()` call
// captured in module-init — running it twice. A synchronous host masks that (the
// second run hits EOF immediately), but this async host registers its stdin
// listeners in `main`, so a double-run would subscribe — and thus echo — every
// frame twice. Keeping `main` non-exported makes `_start` wrap module-init, which
// calls `main()` exactly once (the `main()`-calls-itself convention).
function main(): void {
  // Long-lived port loop, async-stream style: feed each stdin chunk through the
  // incremental state machine, which echoes complete frames (re-chunked to the
  // 1 MiB cap) as their bytes arrive, until EOF (or a zero-length frame). The
  // reactor injected for `process.stdin` drives the `'data'`/`'end'` callbacks
  // after `_start` returns.
  //
  // setEncoding("latin1") — node-runnability (#2834). Under REAL node a stream with
  // NO explicit encoding delivers each `'data'` chunk as a `Buffer`, which has no
  // `.charCodeAt` — so the state machine's `chunk.charCodeAt(...)` byte reads threw
  // `TypeError: chunk.charCodeAt is not a function` when this source was run as
  // plain JS under node (loopdive/js2wasm#389). Declaring the "latin1" encoding makes
  // node deliver one-char-per-byte STRING chunks instead, so `charCodeAt` recovers
  // the raw byte exactly as it does for the js2wasm prelude's string chunks. Under
  // `--target wasi` the injected `process.stdin` prelude already materialises every
  // chunk as a one-char-per-byte string, so `setEncoding` is a faithful no-op there
  // (the SAME source now runs unchanged under both node and wasmtime).
  process.stdin.setEncoding("latin1");
  process.stdin.on("data", (chunk: string) => {
    onData(chunk);
  });
  process.stdin.on("end", () => {
    // EOF: anything mid-frame in the state machine is an incomplete frame and is
    // dropped, matching the sibling variants which stop on a short/truncated read.
  });
}

// Invoke the entry point. js2wasm compiles the top-level call into the module's
// `_start`; the injected fd0 reactor then pumps stdin until EOF.
main();
