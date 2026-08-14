// Shared, host-INDEPENDENT Native Messaging synchronous framing/streaming core
// (#2778). Both `nm_js2wasm_deno.ts` (Deno `readSync`/`writeSync`) and `nm_js2wasm_node_fs.ts`
// (`node:fs` `readSync`/`writeSync`) are now THIN adapters that inject their
// host's synchronous stdio into the `runNmHost` seam below and call into this one
// core. This file has ZERO host API surface — it touches `Uint8Array` only, so it
// compiles to the SAME pure-WASI-Preview-1 shape regardless of which host adapter
// pulls it in (unblocked by #2771's relative-import bundling for standalone WASI).
//
// THE INJECTION SEAM IS TWO FUNCTION REFERENCES, NOT AN OBJECT (#2778). Passing
// an interface/struct VALUE across the bundled-module boundary currently traps at
// runtime under `--target wasi` (the relative-import bundler does not unify the
// struct's type identity across files, so the cross-file `call_ref` / field read
// faults — a clean compile, but a runtime fault; see the issue file for the
// minimal repro). Passing standalone FUNCTION references across the boundary
// works. So the host adapter injects two named functions — `read` and `write` —
// rather than an `{ read, write }` object. (Follow-up: once the bundler unifies
// cross-file nominal struct types, this can become the originally-specified
// `NmHostIo` object seam.)
//
// Native Messaging protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 (JSON) body, exchanged over fd 0 (stdin) / fd 1 (stdout).
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// Two framing modes, selected by `maxFrameSize`:
//
//   - `maxFrameSize <= 0` → VERBATIM streamer (the `nm_js2wasm_deno` demo): each framed
//     message is echoed back byte-for-byte (prefix + body), streamed through a
//     fixed window so resident memory stays flat regardless of body size.
//
//   - `maxFrameSize > 0`  → browser-cap RE-CHUNK streamer (the `nm_js2wasm_node_fs`
//     demo): a body LARGER than the cap is split into a sequence of valid
//     `<=maxFrameSize` JSON frames (`[run]` for an array body, `"run"` for a
//     string body) whose interiors, concatenated by the receiver, reproduce the
//     original body. A body that already fits in one frame is echoed verbatim.
//     The re-chunk streams through a single reused `maxFrameSize` buffer.
//
// The `read` seam does ONE syscall per call; the read-until-N loops live here in
// the core. EOF is signalled by `read` returning `null` or `<= 0`; a zero-length
// frame (declared length 0) is the protocol's clean-shutdown signal.

/**
 * Read up to `buf.length` bytes into `buf` in ONE syscall. Returns the number of
 * bytes read, or `null` / `<= 0` at end-of-stream. (Deno's `readSync` returns
 * `null` at EOF; `node:fs` `readSync` returns `0` — the core treats both as EOF.)
 */
export type NmRead = (buf: Uint8Array) => number | null;

/** Write the WHOLE of `buf` to fd 1, draining any partial writes internally. */
export type NmWrite = (buf: Uint8Array) => void;

/**
 * Per-frame diagnostics hook (fd 2 telemetry), called once per INPUT message in
 * the re-chunk path with its declared body length. Kept a callback (not string
 * work in this host-independent core) so the adapter owns the message text + its
 * fd-2 writer; the verbatim path never calls it (it emits no telemetry, matching
 * the pre-dedup nm_js2wasm_deno). A no-op is a valid implementation.
 */
export type NmLog = (declaredLen: number) => void;

// 64 KiB streaming window for the verbatim path — the largest body run read /
// written in one step (invisible to the receiver, which concatenates raw bytes).
const VERBATIM_WINDOW = 64 * 1024;

const COMMA = 44; // ,
const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]
const DQUOTE = 34; // "

// Decode the little-endian uint32 the browser wrote as the first 4 bytes.
function decodeLength(header: Uint8Array): number {
  return header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
}

// Read EXACTLY `n` bytes into `buf[start..start+n)`, looping over short reads.
// Over-read-safe: each syscall reads into an exact-size temp of `n - got`, so a
// single read can never pull bytes past `start+n` (and thus never into the next
// message). Returns false on EOF / error mid-fill.
function readFillExact(read: NmRead, buf: Uint8Array, start: number, n: number): boolean {
  let got = 0;
  while (got < n) {
    const tmp = new Uint8Array(n - got);
    const r = read(tmp);
    if (r === null || r <= 0) return false; // EOF or error
    let i = 0;
    while (i < r) {
      buf[start + got + i] = tmp[i];
      i = i + 1;
    }
    got = got + r;
  }
  return true;
}

// Emit one array frame: 4-byte LE length prefix + `[` + src[start..start+runLen)
// + `]`, built whole with an element loop and written in ONE `write` (one
// fd_write). #2526: prefix + body share one buffer so a streaming receiver never
// misaligns on a pipe-chunk boundary (loopdive/js2wasm#389). No subarray / no
// `array.copy` — under wasmtime that is ~14x slower than an element loop on i8 GC
// arrays.
function emitRun(write: NmWrite, src: Uint8Array, start: number, runLen: number): void {
  const bodyLen = runLen + 2; // `[` + run + `]`
  const out = new Uint8Array(4 + bodyLen);
  out[0] = bodyLen & 0xff;
  out[1] = (bodyLen >> 8) & 0xff;
  out[2] = (bodyLen >> 16) & 0xff;
  out[3] = (bodyLen >> 24) & 0xff;
  out[4] = OPEN_BRACKET;
  let k = 0;
  while (k < runLen) {
    out[5 + k] = src[start + k];
    k = k + 1;
  }
  out[4 + runLen + 1] = CLOSE_BRACKET;
  write(out);
}

// Emit one JSON-STRING frame: prefix + `"` + src[start..start+runLen) + `"`,
// built whole and written atomically. Re-chunks a single >cap JSON string body
// (`"aaaa…"`) into valid <=cap string frames; the receiver concatenates the
// interiors to reproduce the original string. (The element loop must not split a
// `\`-escape across frames; for the reported workload the body is plain printable
// characters, so a fixed-run split is valid.)
function emitStringRun(write: NmWrite, src: Uint8Array, start: number, runLen: number): void {
  const bodyLen = runLen + 2; // `"` + run + `"`
  const out = new Uint8Array(4 + bodyLen);
  out[0] = bodyLen & 0xff;
  out[1] = (bodyLen >> 8) & 0xff;
  out[2] = (bodyLen >> 16) & 0xff;
  out[3] = (bodyLen >> 24) & 0xff;
  out[4] = DQUOTE;
  let k = 0;
  while (k < runLen) {
    out[5 + k] = src[start + k];
    k = k + 1;
  }
  out[4 + runLen + 1] = DQUOTE;
  write(out);
}

// Stream a single large JSON string body `"chars…"` into valid <=cap `"run"`
// frames. The leading `"` has already been consumed; `interiorRemaining` counts
// the interior characters (declaredLen - 2), and the trailing `"` is read by the
// caller. Returns false on EOF mid-frame. A fixed `maxRun` split keeps each frame
// within the cap (no comma boundaries to honor, unlike the array path).
function streamLargeString(
  read: NmRead,
  write: NmWrite,
  buf: Uint8Array,
  interiorRemaining: number,
  maxRun: number,
): boolean {
  let remaining = interiorRemaining;
  while (remaining > 0) {
    let runLen = maxRun;
    if (remaining < runLen) runLen = remaining;
    if (!readFillExact(read, buf, 0, runLen)) return false;
    emitStringRun(write, buf, 0, runLen);
    remaining = remaining - runLen;
  }
  return true;
}

// VERBATIM port loop (the `nm_js2wasm_deno` demo): read framed messages and echo each one
// back byte-for-byte until EOF. The body streams through a fixed window; a frame
// larger than the window is echoed in window-sized runs (the receiver
// concatenates raw bytes, so prefix + body are byte-identical to the input).
//
// Reads fill exact-size fresh buffers via `readFillExact` (the same boolean-EOF
// helper the re-chunk path uses) rather than a `Uint8Array | null`-returning
// reader — a shared helper that returns a nullable reference type currently mis-
// lowers when this module is bundled into a `node:fs` entry under `--target wasi`
// (a cross-file function-index shift from the node:fs shim insertion; #2778),
// even though the verbatim path itself never runs in the node:fs variant. Keeping
// every shared reader on the `boolean` form sidesteps that gap for BOTH adapters.
function runVerbatim(read: NmRead, write: NmWrite): void {
  const header = new Uint8Array(4);
  while (true) {
    // 4-byte LE length prefix. EOF (or a zero-length frame) = clean shutdown.
    if (!readFillExact(read, header, 0, 4)) return;
    const declaredLen = decodeLength(header);
    if (declaredLen === 0) return;

    // Echo the prefix back first (synchronous write — safe to reuse `header`).
    write(header);

    // Stream the body through the window: read a run, write it straight back,
    // repeat until the whole declared body is echoed.
    let remaining = declaredLen;
    while (remaining > 0) {
      let run = VERBATIM_WINDOW;
      if (remaining < run) run = remaining;
      const chunk = new Uint8Array(run);
      if (!readFillExact(read, chunk, 0, run)) return; // EOF mid-frame → stop
      write(chunk);
      remaining = remaining - run;
    }
  }
}

// RE-CHUNK port loop (the `nm_js2wasm_node_fs` demo): read framed JSON messages and echo
// each one back as valid JSON within the browser `cap`-byte per-message cap. A
// body that already fits is echoed verbatim; a larger array/string body is split
// into valid <=cap frames. Streams through a single reused `cap` buffer.
function runRechunk(read: NmRead, write: NmWrite, log: NmLog, cap: number): void {
  const maxRun = cap - 2; // leave room for the framing `[`/`]` (or the two `"`)
  const header = new Uint8Array(4);
  const one = new Uint8Array(1);
  const buf = new Uint8Array(cap); // reused read/window buffer

  while (true) {
    // 4-byte LE length prefix. EOF (or a zero-length frame) = clean shutdown.
    if (!readFillExact(read, header, 0, 4)) break;
    const declaredLen = decodeLength(header);
    if (declaredLen === 0) break;
    log(declaredLen); // fd-2 telemetry (one line per input message)

    if (declaredLen <= cap) {
      // Already a single valid JSON message within the cap — echo verbatim.
      // #2526: prefix + body in ONE buffer, ONE write. Read the body straight
      // into the buffer at offset 4.
      const out = new Uint8Array(4 + declaredLen);
      out[0] = declaredLen & 0xff;
      out[1] = (declaredLen >> 8) & 0xff;
      out[2] = (declaredLen >> 16) & 0xff;
      out[3] = (declaredLen >> 24) & 0xff;
      if (!readFillExact(read, out, 4, declaredLen)) break;
      write(out);
      continue;
    }

    // Large body > cap. Peek the first byte to pick the re-chunk shape:
    //   `"` → a single large JSON string → `"run"` frames (streamLargeString);
    //   `[` → a large JSON array         → `[run]` frames (below).
    if (!readFillExact(read, one, 0, 1)) break; // the opening `"` or `[`
    if (one[0] === DQUOTE) {
      // Large JSON string: interior = declaredLen - 2 (excludes the two `"`).
      if (!streamLargeString(read, write, buf, declaredLen - 2, maxRun)) break; // EOF mid-frame
      if (!readFillExact(read, one, 0, 1)) break; // the trailing `"`
      continue;
    }

    // Large JSON array `[elem,...,elem]`: stream the interior, emitting valid
    // `[run]` frames. The leading `[` is already consumed; the trailing `]` is
    // read last.
    let interiorRemaining = declaredLen - 2; // interior bytes (excludes `[` and `]`)
    let fill = 0; // carry bytes held at buf[0..fill) (a partial element, no comma)
    let truncated = false;

    while (interiorRemaining > 0) {
      const need = cap - fill; // fill the buffer exactly (over-read-safe)
      if (interiorRemaining >= need) {
        if (!readFillExact(read, buf, fill, need)) {
          truncated = true;
          break;
        }
        fill = cap;
        interiorRemaining = interiorRemaining - need;
        // Emit one frame up to the last comma within [0, maxRun); carry the rest.
        let last = maxRun;
        while (last > 0 && buf[last - 1] !== COMMA) last = last - 1;
        let runLen: number;
        let consumed: number;
        if (last === 0) {
          // No comma in [0, maxRun): a single element exceeds the cap — emit
          // maxRun raw (degenerate; only for elements > ~cap bytes).
          runLen = maxRun;
          consumed = maxRun;
        } else {
          runLen = last - 1; // exclude the comma at last-1
          consumed = last; // skip the comma too
        }
        emitRun(write, buf, 0, runLen);
        // Shift the leftover buf[consumed..fill) to the front (small for typical
        // element sizes — one element plus the 2 cap bytes).
        const rem = fill - consumed;
        let m = 0;
        while (m < rem) {
          buf[m] = buf[consumed + m];
          m = m + 1;
        }
        fill = rem;
      } else {
        // Final interior batch: read exactly interiorRemaining (exact-size temp,
        // over-read-safe), append to the carry, then drain to frames.
        const tmp = new Uint8Array(interiorRemaining);
        if (!readFillExact(read, tmp, 0, interiorRemaining)) {
          truncated = true;
          break;
        }
        let t = 0;
        while (t < interiorRemaining) {
          buf[fill + t] = tmp[t];
          t = t + 1;
        }
        fill = fill + interiorRemaining;
        interiorRemaining = 0;
        // Drain buf[0..fill) into <=maxRun frames at comma boundaries; the last
        // frame ends exactly at fill (the array has no trailing comma).
        let startPos = 0;
        while (startPos < fill) {
          let stop = startPos + maxRun;
          if (stop >= fill) {
            stop = fill;
          } else {
            let c = stop;
            while (c > startPos && buf[c - 1] !== COMMA) c = c - 1;
            if (c > startPos) stop = c - 1;
          }
          emitRun(write, buf, startPos, stop - startPos);
          startPos = stop;
          if (startPos < fill && buf[startPos] === COMMA) startPos = startPos + 1;
        }
        fill = 0;
      }
    }
    if (truncated) break; // EOF mid-frame → stop
    if (!readFillExact(read, one, 0, 1)) break; // the trailing `]`
  }
}

/**
 * Drive the Native Messaging port loop over the injected host stdio seam.
 *
 * @param read         one host `readSync` (fd 0); returns bytes read, or `null` /
 *                     `<= 0` at EOF. MUST be a standalone function reference (see
 *                     the cross-module-funcref note at the top of this file).
 * @param write        one host `writeSync` (fd 1); writes the whole buffer.
 * @param log          per-frame fd-2 telemetry hook (re-chunk path only); pass a
 *                     no-op when the host emits no diagnostics (e.g. nm_js2wasm_deno).
 * @param maxFrameSize `<= 0` → verbatim echo (no cap); `> 0` → re-chunk bodies
 *                     larger than this many bytes into valid <=`maxFrameSize`
 *                     JSON frames (the browser per-message cap).
 */
export function runNmHost(read: NmRead, write: NmWrite, log: NmLog, maxFrameSize: number): void {
  if (maxFrameSize > 0) {
    runRechunk(read, write, log, maxFrameSize);
  } else {
    runVerbatim(read, write);
  }
}
