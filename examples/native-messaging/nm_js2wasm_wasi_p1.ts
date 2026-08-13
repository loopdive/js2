// Native Messaging host, compiled to standalone WASI by js2wasm — the RAW
// `wasi_snapshot_preview1` variant.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm_wasi_p1.ts --target wasi -o out
//
// This is the MOST honest pure-WASI-Preview-1 expression of the host: it imports
// `fd_read` / `fd_write` DIRECTLY from `wasi_snapshot_preview1` — the real WASI
// P1 core module a runtime such as wasmtime satisfies — with NO `node:fs` surface
// at all (loopdive/js2wasm#389, the reporter is "not chasing Node.js"). The emitted
// module imports ONLY `wasi_snapshot_preview1`, owns + exports its own `memory`,
// and runs directly under wasmtime.
//
// Contrast with the sibling `nm_js2wasm_node_fs.ts`, which uses `node:fs`
// `readSync`/`writeSync(fd, …)` — faithful Node fd-based IO that ALSO runs
// UNMODIFIED under real `node`. This file does NOT run under Node (it speaks raw
// WASI syscalls over linear memory); it is the pure-WASI counterpart.
//
// The raw WASI ABI: `fd_read`/`fd_write` take an **iovec** array in linear memory
// and a result-count pointer. We own linear memory and lay the iovec out
// ourselves with js2wasm's inline linear-memory accessors `store32`/`load32`/
// `store8`/`load8` (no GC roundtrip). Those accessors are NOT WASI host functions
// — no host provides a `store32` syscall — so they are imported from a distinct
// js2wasm INTRINSIC namespace, `"wasm:memory"` (they lower to inline
// `i32.store`/`i32.load`/… over the module's own memory). Only `fd_read`/
// `fd_write` come from `"wasi_snapshot_preview1"`, the real WASI core module, so
// the emitted module's ONLY import is `wasi_snapshot_preview1`.
//
//   fd_read (fd, iovs, iovs_len, nread)    -> errno   reads into iovs[0].{buf,len}
//   fd_write(fd, iovs, iovs_len, nwritten) -> errno   writes from iovs[0].{buf,len}
//
// Native Messaging protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 JSON body, exchanged over fd 0 (stdin) / fd 1 (stdout). See
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// Two hard browser constraints drive the response shape (the same two that drive
// `nm_js2wasm_node_fs.ts`):
//   1. The browser deserializes EVERY host->extension message as JSON, so each
//      frame we write must be a complete, valid JSON value — not an arbitrary byte
//      slice.
//   2. A single host->extension message is capped at 1 MiB.
//
// So this raw variant RE-CHUNKS on the WRITE side (#2814) — it is no longer a
// verbatim echo. It reads the 4-byte LE length prefix, then:
//   - a body that already fits the cap is echoed verbatim (prefix + body), built
//     whole and written in ONE `fd_write`;
//   - a body LARGER than the cap is split into a sequence of valid JSON frames
//     within the cap. Peek the first body byte: `"` → a large JSON string split
//     into `"run"` frames; otherwise a large JSON array `[elem,…]` split into
//     `[run]` frames at comma boundaries. The receiver concatenates the frame
//     interiors (re-inserting one comma between array frames) to reproduce the
//     original body. This mirrors the shared `nm_js2wasm_sync_framing` re-chunker,
//     keeping the raw linear-memory IO (this file's demo value) while bounding the
//     OUTPUT to valid <=cap frames — so NO host echoes a single >1 MiB frame.
//
// The cap here is a 64 KiB linear-memory window, NOT the full 1 MiB: this raw-WASI
// module owns a FIXED 3-page (192 KiB) linear memory and the `"wasm:memory"`
// accessor surface exposes no `memory.grow`, so a full 1 MiB pair of in-memory
// work buffers would not fit. 64 KiB is comfortably <= the 1 MiB browser cap (a
// host may always send SMALLER frames), keeps two work buffers (interior
// read/carry + frame build) well within 3 pages, and still demonstrates the
// re-chunk → valid-JSON-frames behavior the reporter asked for across all four
// hosts. The two node hosts re-chunk to the full 1 MiB; this one to 64 KiB.

import { fd_read, fd_write } from "wasi_snapshot_preview1";
import { store32, load32, store8, load8 } from "wasm:memory";

// js2wasm native i32 annotation — emits i32 locals + i32 arithmetic. The raw WASI
// pointers and lengths are all linear-memory i32 offsets.
type i32 = number;

// ---- linear-memory scratch layout (the module owns + exports `memory`) --------
// The default WASI memory is 3 pages (192 KiB). A small fixed control region sits
// at the base; two CAP-sized work buffers (interior read/carry + frame build) live
// above it, both well clear of the 192 KiB ceiling.
const IOV: i32 = 0; // iovec[0] = { buf: i32 @0, buf_len: i32 @4 } (8 bytes)
const RESULT: i32 = 8; // nread / nwritten result slot (4 bytes)
const HDR: i32 = 16; // 4-byte LE length-prefix read scratch
const ONE: i32 = 20; // 1-byte peek scratch (`[` / `"` / trailing delimiter)

// Per-emitted-frame JSON body cap (see the header note on the 192 KiB budget):
// 64 KiB, comfortably <= the 1 MiB browser per-host->extension-message limit.
const CAP: i32 = 64 * 1024; // max JSON body bytes per emitted frame
const MAXRUN: i32 = CAP - 2; // run bytes per frame, leaving room for `[`/`]` (or two `"`)
const INBUF: i32 = 4096; // interior read + carry buffer  [INBUF, INBUF+CAP)
const OUTBUF: i32 = INBUF + CAP; // frame build buffer       [OUTBUF, OUTBUF+4+CAP)

const COMMA: i32 = 44; // ,
const OPEN_BRACKET: i32 = 91; // [
const CLOSE_BRACKET: i32 = 93; // ]
const DQUOTE: i32 = 34; // "

// Set iovec[0] = { buf, len } and zero the result slot, ready for one fd_read /
// fd_write of a single contiguous run.
function setIovec(buf: i32, len: i32): void {
  store32(IOV, buf);
  store32(IOV + 4, len);
  store32(RESULT, 0);
}

// Read up to `len` bytes from `fd` into linear memory at `buf`. Returns the byte
// count, or 0 on EOF / error (errno != 0). One raw `fd_read` over a 1-iovec list.
function readSome(fd: i32, buf: i32, len: i32): i32 {
  setIovec(buf, len);
  const errno: i32 = fd_read(fd, IOV, 1, RESULT);
  if (errno !== 0) return 0;
  return load32(RESULT);
}

// Read EXACTLY `n` bytes from `fd` into `buf`, looping over short reads. Each
// syscall reads at most the remaining `n - got` bytes, so it never pulls bytes
// past `buf+n` (and thus never into the next message). Returns false on EOF /
// error before `n` bytes arrive.
function readExact(fd: i32, buf: i32, n: i32): boolean {
  let got: i32 = 0;
  while (got < n) {
    const r: i32 = readSome(fd, buf + got, n - got);
    if (r <= 0) return false; // EOF or error
    got = got + r;
  }
  return true;
}

// Write EXACTLY `n` bytes from `buf` to `fd`, looping over partial writes. Returns
// false on error before `n` bytes are written.
function writeExact(fd: i32, buf: i32, n: i32): boolean {
  let put: i32 = 0;
  while (put < n) {
    setIovec(buf + put, n - put);
    const errno: i32 = fd_write(fd, IOV, 1, RESULT);
    if (errno !== 0) return false;
    const w: i32 = load32(RESULT);
    if (w <= 0) return false;
    put = put + w;
  }
  return true;
}

// Decode the little-endian uint32 the browser wrote as the 4 bytes at `p`.
function decodeLength(p: i32): i32 {
  return load8(p) + load8(p + 1) * 256 + load8(p + 2) * 65536 + load8(p + 3) * 16777216;
}

// Build ONE re-chunk frame in OUTBUF — 4-byte LE prefix + `open` + the run
// INBUF[srcOff..srcOff+runLen) + `close` — and write it whole in ONE `fd_write`
// (atomic framing: a streaming receiver must never see a prefix split from its
// body; #2526). `open`/`close` are `[`/`]` for an array body or the two `"` for a
// string body. The declared body length (open + run + close = runLen + 2) stays
// <= CAP because every caller keeps runLen <= MAXRUN. INBUF and OUTBUF never
// overlap, so the copy is safe. The write is best-effort: a broken pipe just makes
// the next read/write fail and the outer loop stop.
function emitFrame(srcOff: i32, runLen: i32, open: i32, close: i32): void {
  const bodyLen: i32 = runLen + 2;
  store8(OUTBUF, bodyLen & 0xff);
  store8(OUTBUF + 1, (bodyLen >> 8) & 0xff);
  store8(OUTBUF + 2, (bodyLen >> 16) & 0xff);
  store8(OUTBUF + 3, (bodyLen >> 24) & 0xff);
  store8(OUTBUF + 4, open);
  let k: i32 = 0;
  while (k < runLen) {
    store8(OUTBUF + 5 + k, load8(INBUF + srcOff + k));
    k = k + 1;
  }
  store8(OUTBUF + 5 + runLen, close);
  writeExact(1, OUTBUF, 4 + bodyLen);
}

// Stream a single large JSON STRING body `"chars…"` into valid <=CAP `"run"`
// frames. The leading `"` has already been consumed; `interiorRemaining` is the
// interior character count (declaredLen - 2). A fixed `MAXRUN` split keeps each
// frame within the cap (no comma boundaries to honor, unlike the array path). The
// caller reads the trailing `"`. Returns false on EOF mid-frame. (The fixed split
// must not bisect a `\`-escape; for the reported workload the body is plain
// printable characters, so a fixed-run split is valid — same caveat as the shared
// core's emitStringRun.)
function streamLargeString(interiorRemaining: i32): boolean {
  let remaining: i32 = interiorRemaining;
  while (remaining > 0) {
    let runLen: i32 = MAXRUN;
    if (remaining < runLen) runLen = remaining;
    if (!readExact(0, INBUF, runLen)) return false;
    emitFrame(0, runLen, DQUOTE, DQUOTE);
    remaining = remaining - runLen;
  }
  return true;
}

// RE-CHUNK port loop: read framed JSON messages off stdin (fd 0) and echo each one
// back on stdout (fd 1) within the CAP-byte per-frame cap, until EOF (or a
// zero-length frame = clean shutdown). A body that already fits is echoed
// verbatim; a larger array/string body is split into valid <=CAP frames. Mirrors
// the shared `nm_js2wasm_sync_framing` re-chunker, in raw linear memory.
function runRechunk(): void {
  while (true) {
    // 4-byte LE length prefix. EOF (or a zero-length frame) = clean shutdown.
    if (!readExact(0, HDR, 4)) return;
    const declaredLen: i32 = decodeLength(HDR);
    if (declaredLen === 0) return;

    if (declaredLen <= CAP) {
      // Already a valid JSON message within the cap — echo VERBATIM, prefix +
      // body in ONE buffer and ONE write. Read the body straight into OUTBUF[4..].
      store8(OUTBUF, declaredLen & 0xff);
      store8(OUTBUF + 1, (declaredLen >> 8) & 0xff);
      store8(OUTBUF + 2, (declaredLen >> 16) & 0xff);
      store8(OUTBUF + 3, (declaredLen >> 24) & 0xff);
      if (!readExact(0, OUTBUF + 4, declaredLen)) return;
      if (!writeExact(1, OUTBUF, 4 + declaredLen)) return;
      continue;
    }

    // Large body > cap. Peek the first byte to pick the re-chunk shape:
    //   `"` → a single large JSON string → `"run"` frames (streamLargeString);
    //   `[` → a large JSON array         → `[run]` frames (below).
    if (!readExact(0, ONE, 1)) return; // the opening `"` or `[`
    const first: i32 = load8(ONE);
    if (first === DQUOTE) {
      // Large JSON string: interior = declaredLen - 2 (excludes the two `"`).
      if (!streamLargeString(declaredLen - 2)) return; // EOF mid-frame
      if (!readExact(0, ONE, 1)) return; // the trailing `"`
      continue;
    }

    // Large JSON array `[elem,...,elem]`: stream the interior, emitting valid
    // `[run]` frames. The leading `[` is already consumed; the trailing `]` is
    // read last. `fill` carries leftover bytes (a partial element, no comma) at
    // INBUF[0..fill) across iterations.
    let interiorRemaining: i32 = declaredLen - 2; // interior bytes (excludes `[` and `]`)
    let fill: i32 = 0;
    let truncated: boolean = false;

    while (interiorRemaining > 0) {
      const need: i32 = CAP - fill; // fill INBUF exactly (over-read-safe)
      if (interiorRemaining >= need) {
        if (!readExact(0, INBUF + fill, need)) {
          truncated = true;
          break;
        }
        fill = CAP;
        interiorRemaining = interiorRemaining - need;
        // Emit one frame up to the last comma within [0, MAXRUN); carry the rest.
        let last: i32 = MAXRUN;
        while (last > 0 && load8(INBUF + last - 1) !== COMMA) last = last - 1;
        let runLen: i32 = 0;
        let consumed: i32 = 0;
        if (last === 0) {
          // No comma in [0, MAXRUN): a single element exceeds the cap — emit
          // MAXRUN raw (degenerate; only for elements > ~CAP bytes).
          runLen = MAXRUN;
          consumed = MAXRUN;
        } else {
          runLen = last - 1; // exclude the comma at last-1
          consumed = last; // skip the comma too
        }
        emitFrame(0, runLen, OPEN_BRACKET, CLOSE_BRACKET);
        // Shift the leftover INBUF[consumed..fill) to the front for the next frame.
        const rem: i32 = fill - consumed;
        let m: i32 = 0;
        while (m < rem) {
          store8(INBUF + m, load8(INBUF + consumed + m));
          m = m + 1;
        }
        fill = rem;
      } else {
        // Final interior batch: read exactly interiorRemaining (over-read-safe),
        // append to the carry, then drain to frames at comma boundaries; the last
        // frame ends exactly at fill (the array has no trailing comma).
        if (!readExact(0, INBUF + fill, interiorRemaining)) {
          truncated = true;
          break;
        }
        fill = fill + interiorRemaining;
        interiorRemaining = 0;
        let startPos: i32 = 0;
        while (startPos < fill) {
          let stop: i32 = startPos + MAXRUN;
          if (stop >= fill) {
            stop = fill;
          } else {
            let c: i32 = stop;
            while (c > startPos && load8(INBUF + c - 1) !== COMMA) c = c - 1;
            if (c > startPos) stop = c - 1;
          }
          emitFrame(startPos, stop - startPos, OPEN_BRACKET, CLOSE_BRACKET);
          startPos = stop;
          if (startPos < fill && load8(INBUF + startPos) === COMMA) startPos = startPos + 1;
        }
        fill = 0;
      }
    }
    if (truncated) return; // EOF mid-frame → stop
    if (!readExact(0, ONE, 1)) return; // the trailing `]`
  }
}

export function main(): void {
  // Long-lived port loop: read framed messages off stdin (fd 0) and echo each one
  // back on stdout (fd 1), re-chunked to valid <=CAP JSON frames, until EOF (or a
  // zero-length frame). All work flows through two fixed linear-memory buffers, so
  // resident memory stays flat regardless of message size.
  runRechunk();
}

// Invoke the entry point. js2wasm compiles a top-level call into the module's
// `_start`, which wasmtime runs.
main();
