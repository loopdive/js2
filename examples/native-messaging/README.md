# Native Messaging host, compiled by js2wasm to standalone WASI

[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
protocol lets a browser extension talk to a native binary on the user's
machine. The browser launches the host process and exchanges messages over the
process's **stdin** and **stdout**, framing each message as a **4-byte
little-endian length prefix** followed by a **UTF-8 JSON body**.

This is a natural fit for `--target wasi`: compile a TypeScript host to a single
`.wasm`, run it under `wasmtime`/`wasmer`, and point the browser at a thin wrapper
script. This directory contains:

```
examples/native-messaging/
  nm_js2wasm.ts          ← the TypeScript host (compiled with --target wasi)
  README.md        ← this file
  nm_js2wasm.json  ← Native host manifest template
  manifest.json    ← Web extension manifest
  nm_js2wasm.sh    ← wasmtime/wasmer wrapper the browser invokes
  background.js    ← MV3 Web extension background `ServiceWorker` script
```

## Status: a working drop-in host

This host now exercises the **full** Native Messaging loop under `--target
wasi`: read the framed JSON message off stdin (fd=0), route debug to stderr
(fd=2), and write a **correctly framed** JSON response — the binary 4-byte
little-endian length prefix plus the JSON body — to stdout (fd=1) with no
trailing newline. The two stdout gaps that previously blocked this are closed
(#1618, #1651).

| Capability                                            | Status | Detail                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read framed message from stdin                        | works  | `process.stdin.read(buf, offset?)` does a binary, incremental fd=0 read into the caller's buffer, returning the byte count (#1653); read-until loops assemble each frame without blocking on speculative continuation reads |
| Decode the 4-byte LE length prefix                    | works  | byte math on the first 4 bytes of the read header buffer                                                                                                                                                                    |
| Route debug to stderr (fd=2)                          | works  | `console.error` / `console.warn` (#1493) — keeps the stdout protocol stream clean                                                                                                                                           |
| Print a **string literal** to stdout                  | works  | `console.log("…")` emits UTF-8 + `\n` (#1480)                                                                                                                                                                               |
| Print a **runtime/computed string** to stdout         | works  | `console.log(x)` / `process.stdout.write(x)` of a variable, concatenation, or template literal emit the actual content (#1618)                                                                                              |
| Write a **string** to stdout with no newline          | works  | `process.stdout.write(str)` → `fd_write(1, …)`, no `\n` (#1651)                                                                                                                                                             |
| Emit the **binary 4-byte LE length prefix** on stdout | works  | `process.stdout.write(new Uint8Array([…]))` writes raw bytes (incl. NUL) verbatim to fd=1 (#1651)                                                                                                                           |

The response is framed with `process.stdout.write` — a `Uint8Array` for each
binary length prefix, then the body bytes — mirroring the Node.js host API used
by the reference hosts (`nm_assemblyscript.ts`, `nm_javy.js`, `nm_qjs_wasi.js`).
Request bodies larger than 1 MiB can be streamed into the host as successive
<=1 MiB Native Messaging frames, and each frame is echoed independently. It is
a drop-in host for byte-exact request/response framing; the only
external dependency is a WASI preview1 runtime to launch it (see "Run it"
below).
The host also accepts the reported single-frame 64 MiB JSON string shape and
streams it back as <=1 MiB JSON string response chunks, so the compiled module
does not need to allocate the full request body at once.

## The host source

[`nm_js2wasm.ts`](./nm_js2wasm.ts) follows the reference-host shape
guest271314 uses across runtimes:

- **`readMessageLength()` / `readFrameBody()`** — read the 4-byte
  little-endian length header, then exactly that many body bytes via
  `process.stdin.read` read-until loops (a `readExact` helper handles short
  reads). Bodies up to 1 MiB stay raw **`Uint8Array`** values and round-trip
  byte-exactly (#389, #1753).
- **`sendMessage(message)`** — frames a `Uint8Array` body: writes the 4-byte LE
  length prefix, then the body bytes, to stdout with no trailing newline. Bodies
  up to 1 MiB are echoed byte-for-byte.
- **`sendLargeStringChunks(declaredLen)`** — handles the large single-frame
  JSON string stress shape by reading the string body incrementally and writing
  each chunk as its own valid JSON string Native Messaging response frame.
- **`main()`** — the continuous port loop:
  read a length, stream large strings when needed, otherwise
  `sendMessage(readFrameBody(len))`. A full 1 MiB body is a complete Native
  Messaging frame, so the host writes its response immediately instead of
  waiting for a possible continuation header.

Diagnostics go to **stderr** (so they never corrupt the stdout protocol
stream). The application logic — here, a byte-exact echo for one request frame
at a time — lives entirely in the loop body and is the part you'd replace for a
real host that decodes `message`, dispatches on a command field, and frames
structured responses with `sendMessage()`. Carrying the body as bytes (rather
than a string) is also forward-compatible with Chromium's in-progress
`Uint8Array` Native Messaging support — the protocol body is fundamentally a
byte buffer.

## Build to `.wasm`

From the repo root (works immediately after `pnpm install`, no build step):

```bash
mkdir -p examples/native-messaging/out
npx tsx src/cli.ts examples/native-messaging/nm_js2wasm.ts --target wasi -o examples/native-messaging/out
```

(Once the package is built — `pnpm run build` — or installed from npm, you can
use the `js2wasm` bin directly: `npx js2wasm nm_js2wasm.ts --target wasi -o out`.)

This produces `out/nm_js2wasm.wasm`. The module imports only from
`wasi_snapshot_preview1` (`fd_read`, `fd_write`) — no `env.*` imports — so it
runs on any standards-compliant WASI preview1 runtime.

> The `-o` flag is an **output directory**, not a filename. js2wasm names the
> output after the input basename (`nm_js2wasm.wasm`).

### What is `out/nm_js2wasm.imports.js`?

Alongside `nm_js2wasm.wasm`, js2wasm emits **`nm_js2wasm.imports.js`** (plus `nm_js2wasm.d.ts`).
It is the **generated host-imports glue** a compiled module needs when you
instantiate it from a JavaScript host. It re-exports `createImports`,
`instantiateBytes`, and `instantiateFromUrl` from the `js2wasm` runtime package,
wiring up the module's import manifest and string pool:

```js
import { instantiateBytes } from "./out/nm_js2wasm.imports.js";
const { instance } = await instantiateBytes(wasmBytes, deps, options);
instance.exports.main();
```

For **this** example it is **not used at runtime**: the Native Messaging host
is a fully standalone `--target wasi` module whose only imports are the WASI
preview1 syscalls (`fd_read`/`fd_write`), which the runtime — `wasmtime`,
`wasmer`, `wazero`, or Node's WASI — supplies directly. So the `nm_js2wasm.sh`
wrapper launches `nm_js2wasm.wasm` under a WASI runtime and `nm_js2wasm.imports.js` is
never imported.

The glue file is emitted unconditionally by the compiler because the **same
module can also be driven from a JS host** (e.g. instantiated in the browser or
in Node via `WebAssembly.instantiate`), where the import wiring it provides is
required. Treat it as the JS-host on-ramp for the module; for the standalone
WASI path it is a harmless extra artifact you can ignore or delete.

## Run it under a WASI runtime

`nm_js2wasm.sh` wraps the runtime invocation. `wasmtime` is **not bundled** with this
repo — install it from <https://wasmtime.dev> (or use `wasmer` /
[wazero](https://github.com/tetratelabs/wazero); see
[`../wasi/README.md`](../wasi/README.md) for the full runtime matrix and how to
wrap a `.wasm` as a single self-contained native executable).

Once built, exercise the read → decode → respond loop by piping a framed
message. The 4-byte prefix below (`\x0d\x00\x00\x00`) declares a 13-byte body
`{"ping":true}`:

```bash
printf '\x0d\x00\x00\x00{"ping":true}' | ./examples/native-messaging/nm_js2wasm.sh
```

You'll see the host's stderr diagnostic (received-length + decoded body
length) and its stdout response, framed with the binary 4-byte LE length
prefix followed by the JSON body — exactly the bytes browsers expect.

For an automated byte-exact check (build + run under wasmtime, asserting the
stdout frame and a clean stderr), run [`smoke-test.sh`](./smoke-test.sh) —
the same script CI runs (`.github/workflows/native-messaging-smoke.yml`):

```bash
./examples/native-messaging/smoke-test.sh
```

### Manual wasmtime memory stress

For opt-in local memory measurements, use
[`stress-memory.mjs`](./stress-memory.mjs). It builds the WASI host, streams
<=1 MiB Native Messaging request frames into wasmtime, drains framed stdout
without retaining the response body, and samples the wasmtime child RSS. The
default run uses
`JSON.stringify(Array(209715))`, whose body is exactly 1 MiB:

```bash
node examples/native-messaging/stress-memory.mjs
```

To reproduce the reported 64x browser workload shape without adding a heavy CI
test, run the same harness manually:

```bash
node examples/native-messaging/stress-memory.mjs --reported-64mib
```

`--reported-64mib` sends the `Array(209715 * 64)` body split into <=1 MiB
request frames and, by default, kills the wasmtime child if sampled RSS grows
more than 256 MiB above the first sample or if the run exceeds 180 seconds. The
harness streams request bytes, drains framed stdout without retaining response
bodies, and validates that each response frame is <=1 MiB. Because the host now
treats each Native Messaging frame independently, this mode is a memory and
frame-budget stress rather than a logical 64 MiB JSON response assertion.
`--max-request-frame-bytes` and `--max-response-frame-bytes` can tighten the
frame budgets; `--allow-large-response-frame` remains only for measuring older
wasm builds that predate the chunked writer.

The unit tests also cover the single-frame 64 MiB JSON string case. That path
streams the string back as multiple valid JSON string response frames and keeps
the compiled module's linear memory below a 512 MiB cap.

> If you don't have a WASI runtime installed, you can still confirm the module
> is valid the same way the [`../wasi/README.md`](../wasi/README.md) Node
> snippet does — `WebAssembly.compile(readFileSync('out/nm_js2wasm.wasm'))` — and
> drive it against js2wasm's own `buildWasiPolyfill()` for a JS-side
> round-trip.

## Wire it into the browser

1. **Build** `out/nm_js2wasm.wasm` (above) and make sure `nm_js2wasm.sh` is executable
   (`chmod +x nm_js2wasm.sh`).

2. **Edit `nm_js2wasm.json`**:
   - `path` → the **absolute** path to `nm_js2wasm.sh` (browsers require an absolute
     path and does not set a predictable working directory), and make sure the file is
     set to executable.
   - `allowed_origins` → `chrome-extension://YOUR_EXTENSION_ID/` for the
     extension that will connect. Find the ID on `chrome://extensions` with
     Developer mode enabled after installing the unpacked Web extension.

3. **Install the manifest** in the per-platform location Chrome scans:

   | Platform | Manifest location                                                                                                                             |
   | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
   | Linux    | `~/.config/google-chrome/NativeMessagingHosts/nm_js2wasm.json`                                                                                |
   | macOS    | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/nm_js2wasm.json`                                                            |
   | Windows  | a registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\nm_js2wasm` whose default value is the absolute path to the manifest `.json` |

   The manifest **filename** must match the host `name` field
   (`nm_js2wasm`). On Windows, `nm_js2wasm.sh` won't run directly —
   use a `run.bat` (`@echo off` + `wasmtime "%~dp0out\nm_js2wasm.wasm"`) and point
   `path` at the `.bat`.

4. **Connect from the extension.** With the `nativeMessaging` permission in the
   extension manifest:

   ```js
   const port = chrome.runtime.connectNative("nm_js2wasm");
   port.onMessage.addListener((msg) => console.log("from host:", msg));
   port.onDisconnect.addListener((_) => {
     console.log("host disconnected");
     if (chrome.runtime.lastError) {
       console.log(chrome.runtime.lastError);
     }
   }
   port.postMessage({ ping: true });
   ```

   The browser handles the 4-byte length framing on its side; the host sees the
   raw bytes on stdin and produces correctly framed bytes on stdout via
   `process.stdout.write` (a `Uint8Array` prefix + the JSON body).

## Reference hosts in other runtimes

The protocol shape here mirrors the runtime-comparison examples collected at
[guest271314/native-messaging-webassembly](https://github.com/guest271314/native-messaging-webassembly):
`nm_assemblyscript.ts`, `nm_javy.js`, and `nm_qjs_wasi.js`. They are useful for
seeing the full length-prefixed read/write loop in runtimes that already expose
raw-byte stdio.
