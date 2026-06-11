// Native Messaging host, compiled to standalone WASI by js2wasm.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm.ts --target wasi -o out
//
// Native Messaging protocol frames each message as a 4-byte
// little-endian length prefix followed by a UTF-8 **JSON** body, exchanged over
// the host process's stdin (fd=0) and stdout (fd=1). See:
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// Two hard browser constraints drive the response shape:
//   1. Browser deserializes EVERY host->extension message as JSON, so each frame
//      we write must be a complete, valid JSON value — not an arbitrary byte
//      slice. (A non-JSON frame is rejected with "The sender sent an invalid
//      JSON message; message ignored.")
//   2. A single host->extension message is capped at 1 MiB.
//
// So a large message — e.g. `port.postMessage(Array(209715*64))`, ~64 MiB of
// `[null,null,...]` — is re-chunked into a sequence of <=1 MiB valid JSON arrays
// whose elements, concatenated by the receiver, reproduce the original array.
// A message that already fits in one frame is echoed verbatim.
//
// This host STREAMS the re-chunk through a single reused 1 MiB buffer: it never
// holds the whole body, so resident memory stays flat (~a couple MiB) regardless
// of message size or count. It also never calls `Uint8Array.prototype.subarray`
// — under wasmtime that lowers to a native `array.copy` that is ~14x slower than
// an element loop on i8 GC arrays — each frame is built with an element loop into
// an exact-size buffer and written whole. Reads fill the buffer to its exact
// capacity (or use an exact-size buffer for the final partial batch), so a read
// can never pull bytes past the current message into the next one.
//
// js2wasm support today:
//   - stdin  : process.stdin.read(buf, offset?) does one binary, incremental
//              fd=0 read into the caller's typed buffer at `offset`, returning
//              the byte count (#1653). A read-until loop assembles exactly N.
//   - stdout : process.stdout.write(bytes|str) writes raw bytes to fd=1 with NO
//              trailing newline (#1651).
//   - stderr : process.stderr.write writes to fd=2, off the protocol stream.

declare const process: {
  stdin: { read(buf: Uint8Array | ArrayBuffer, offset?: number): number };
  stdout: { write(chunk: Uint8Array | ArrayBuffer | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
};

// Largest body browser Native Messaging implementation accepts in one host->extension message, and the size of
// the single scratch buffer the whole stream flows through.
const FRAME_CHUNK = 1024 * 1024;
const MAX_RUN = FRAME_CHUNK - 2; // leave room for the framing `[` and `]`
const COMMA = 44; // ,
const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]

// Read exactly `n` bytes into buf[0..n). Over-read-safe only when buf.length
// === n (the read can't exceed the buffer; caller guarantees the stream has at
// least `n` bytes left for this message).
/** @param {Uint8Array} buf @param {number} n @returns {boolean} */
function readExact(buf: Uint8Array, n: number): boolean {
  let got = 0;
  while (got < n) {
    const r = process.stdin.read(buf, got);
    if (r <= 0) return false; // EOF or error
    got = got + r;
  }
  return true;
}

// Read exactly `n` bytes into buf[start..start+n). Over-read-safe only when
// (buf.length - start) === n, so a single read can never pull bytes past `n`
// (and thus never into the next message).
/** @param {Uint8Array} buf @param {number} start @param {number} n @returns {boolean} */
function readAt(buf: Uint8Array, start: number, n: number): boolean {
  let got = 0;
  while (got < n) {
    const r = process.stdin.read(buf, start + got);
    if (r <= 0) return false;
    got = got + r;
  }
  return true;
}

// Decode the little-endian uint32 length browser wrote as the first 4 bytes.
/** @param {Uint8Array} header @returns {number} */
function decodeLength(header: Uint8Array): number {
  return header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
}

// Write a 4-byte little-endian frame length prefix to stdout (#1651).
/** @param {number} len */
function writeLength(len: number): void {
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
}

// Debug telemetry to stderr (fd=2) so it never pollutes the stdout protocol
// stream. The frame is the 4-byte prefix plus the declared body.
/** @param {number} declaredLen */
function logFrameBodyRead(declaredLen: number): void {
  process.stderr.write(`[host] received ${4 + declaredLen} chars, declared body length ${declaredLen}\n`);
}

// Emit one frame: `[` + src[start..start+runLen) + `]`, built whole with an
// element loop and written in one go (no subarray / no array.copy).
/** @param {Uint8Array} src @param {number} start @param {number} runLen */
function emitRun(src: Uint8Array, start: number, runLen: number): void {
  const frame = new Uint8Array(runLen + 2);
  frame[0] = OPEN_BRACKET;
  let k = 0;
  while (k < runLen) {
    frame[k + 1] = src[start + k];
    k = k + 1;
  }
  frame[runLen + 1] = CLOSE_BRACKET;
  writeLength(runLen + 2);
  process.stdout.write(frame);
}

export function main(): void {
  // Long-lived port loop: read framed JSON messages off stdin until EOF and
  // echo each one back as valid JSON within the browser 1 MiB per-message cap.
  const header = new Uint8Array(4);
  const one = new Uint8Array(1);
  const buf = new Uint8Array(FRAME_CHUNK); // reused read/window buffer

  while (true) {
    // 4-byte LE length prefix. EOF (or a zero-length frame) = clean shutdown.
    if (!readExact(header, 4)) break;
    const declaredLen = decodeLength(header);
    if (declaredLen === 0) break;
    logFrameBodyRead(declaredLen);

    if (declaredLen <= FRAME_CHUNK) {
      // Already a single valid JSON message within the cap — echo verbatim.
      const small = new Uint8Array(declaredLen);
      if (!readExact(small, declaredLen)) break;
      writeLength(declaredLen);
      process.stdout.write(small);
      continue;
    }

    // Large JSON array `[elem,...,elem]`: stream the interior, emitting valid
    // `[run]` frames. Consume the leading `[`; the trailing `]` is read last.
    if (!readExact(one, 1)) break; // the `[`
    let interiorRemaining = declaredLen - 2; // interior bytes (excludes `[` and `]`)
    let fill = 0; // carry bytes held at buf[0..fill) (a partial element, no comma)
    let truncated = false;

    while (interiorRemaining > 0) {
      const need = FRAME_CHUNK - fill; // fill the buffer exactly (over-read-safe)
      if (interiorRemaining >= need) {
        if (!readAt(buf, fill, need)) {
          truncated = true;
          break;
        }
        fill = FRAME_CHUNK;
        interiorRemaining = interiorRemaining - need;
        // Emit one frame up to the last comma within [0, MAX_RUN); carry the rest.
        let last = MAX_RUN;
        while (last > 0 && buf[last - 1] !== COMMA) last = last - 1;
        let runLen: number;
        let consumed: number;
        if (last === 0) {
          // No comma in [0, MAX_RUN): a single element exceeds the cap — emit
          // MAX_RUN raw (degenerate; only for elements > ~1 MiB).
          runLen = MAX_RUN;
          consumed = MAX_RUN;
        } else {
          runLen = last - 1; // exclude the comma at last-1
          consumed = last; // skip the comma too
        }
        emitRun(buf, 0, runLen);
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
        if (!readExact(tmp, interiorRemaining)) {
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
        // Drain buf[0..fill) into <=MAX_RUN frames at comma boundaries; the last
        // frame ends exactly at fill (the array has no trailing comma).
        let startPos = 0;
        while (startPos < fill) {
          let stop = startPos + MAX_RUN;
          if (stop >= fill) {
            stop = fill;
          } else {
            let c = stop;
            while (c > startPos && buf[c - 1] !== COMMA) c = c - 1;
            if (c > startPos) stop = c - 1;
          }
          emitRun(buf, startPos, stop - startPos);
          startPos = stop;
          if (startPos < fill && buf[startPos] === COMMA) startPos = startPos + 1;
        }
        fill = 0;
      }
    }
    if (truncated) break; // EOF mid-frame → stop
    if (!readExact(one, 1)) break; // the trailing `]`
  }
}
