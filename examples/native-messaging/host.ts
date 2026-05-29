// Chrome Native Messaging host, compiled to standalone WASI by js2wasm.
//
//   npx js2wasm examples/native-messaging/host.ts --target wasi -o out
//
// Chrome's Native Messaging protocol frames each message as a 4-byte
// little-endian length prefix followed by a UTF-8 JSON body, exchanged over
// the host process's stdin (fd=0) and stdout (fd=1). See:
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// js2wasm support today:
//   - stdin  : process.stdin.read(buf, offset?) does one binary, incremental
//              fd=0 read into the caller's typed buffer at `offset`, returning
//              the byte count (#1653) — the standard Node API. A read-until
//              loop assembles exactly N bytes from possibly-short reads, so a
//              continuous `while (true)` port loop can read the 4-byte LE
//              header then exactly the declared body length.
//   - stdout : process.stdout.write(bytes|str) writes raw bytes / a string to
//              fd=1 with NO trailing newline (#1651) — used for the binary
//              4-byte length prefix and the body. Large bodies (≥1 MiB, the
//              #389 case) now write byte-exact: the fd_write staging buffer
//              grows linear memory on demand rather than overflowing the
//              default 3-page reserve and corrupting the stream into nulls.
//   - stderr : console.error / console.warn write to fd=2 (#1493) — use these
//              for debug output so they never corrupt the stdout protocol stream
//
// This is a drop-in Chrome host built around the cross-language 3-symbol
// pattern guest271314 uses for Native Messaging hosts:
//
//   getMessage()       — read the 4-byte LE header, then exactly N body bytes
//                        off stdin; return the raw body bytes (Uint8Array).
//   sendMessage(body)  — frame `body` with a 4-byte LE length prefix and write
//                        the prefix + body to stdout, no trailing newline.
//   main()             — the long-lived `while (true)` port loop:
//                        getMessage -> sendMessage, until stdin EOF.
//
// The body flows as raw **bytes** (Uint8Array) end to end — never lossily
// stringified — so it is binary-safe at any size and forward-compatible with
// Chromium's in-progress Uint8Array-over-Native-Messaging support
// (https://issues.chromium.org/issues/497341241). The loop is a strict
// verbatim echo (#930): what the extension sends in comes back out byte-for-
// byte. A real host would parse the body, dispatch on a command field, and
// build a structured response inside `main` between getMessage and sendMessage.

declare const process: {
  stdin: { read(buf: Uint8Array, offset?: number): number };
  stdout: { write(chunk: Uint8Array | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
};

// Read exactly `n` bytes into the first `n` slots of `buf` via a read-until
// loop, handling short reads (fd_read may return fewer bytes than requested).
// Returns false on EOF (a read of <= 0 bytes before `n` were assembled) so the
// caller can cleanly terminate the port loop.
function readExact(buf: Uint8Array, n: number): boolean {
  let got = 0;
  while (got < n) {
    const r = process.stdin.read(buf, got);
    if (r <= 0) return false; // EOF or error
    got = got + r;
  }
  return true;
}

// getMessage — read one framed Native Messaging message off stdin and return
// its raw body bytes, or an empty Uint8Array on EOF / clean shutdown.
//
// The frame is a 4-byte little-endian uint32 length prefix followed by exactly
// that many body bytes. The body is returned as a `Uint8Array` (raw bytes), not
// a string, so binary payloads and large (≥1 MiB) bodies are preserved exactly.
// EOF on the header read is a clean shutdown signal; a truncated body (EOF
// mid-frame) returns empty too. The port loop distinguishes "message" from
// "EOF" by the returned length.
function getMessage(): Uint8Array {
  const header = new Uint8Array(4);
  if (!readExact(header, 4)) return new Uint8Array(0); // EOF at frame boundary
  // Little-endian uint32 length Chrome wrote as the first 4 bytes.
  const declaredLen = header[0] + header[1] * 256 + header[2] * 65536 + header[3] * 16777216;
  const body = new Uint8Array(declaredLen);
  if (declaredLen > 0 && !readExact(body, declaredLen)) return new Uint8Array(0); // truncated
  return body;
}

// sendMessage — write a framed Native Messaging response: the 4-byte little-
// endian length prefix followed by the body bytes, both on stdout (fd=1), no
// newline. `message` is raw bytes; its byte length is the prefix, so the frame
// is binary-exact regardless of content or size.
function sendMessage(message: Uint8Array): void {
  const len = message.length;
  // Binary 4-byte LE length prefix via raw-byte stdout (#1651).
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]));
  // Body — raw bytes, written verbatim with no trailing newline. The stdout
  // helper grows linear memory for large bodies so ≥1 MiB writes are byte-exact
  // (#389).
  process.stdout.write(message);
}

export function main(): void {
  // Long-lived port loop: read framed messages off stdin until EOF. A short
  // read inside readExact is retried; a header read returning EOF (empty body)
  // means the peer closed stdin, so we break and exit.
  while (true) {
    const message = getMessage();
    if (message.length === 0) break; // EOF / clean shutdown

    // Debug telemetry goes to stderr (fd=2) so it never pollutes the stdout
    // protocol stream. Chrome ignores the host's stderr. The frame consumed is
    // the 4-byte LE prefix plus the body, so total bytes = 4 + message.length.
    console.error(`[host] received ${4 + message.length} bytes, body length ${message.length}`);

    // Strict verbatim echo (#930): send the received body back byte-for-byte,
    // no wrapper and no added bytes — a true round-trip proof that the WASI
    // build's stdin->stdout fidelity holds at any size (including the 1 MiB
    // #389 case). A real host would build a structured response here instead.
    sendMessage(message);
  }
}
