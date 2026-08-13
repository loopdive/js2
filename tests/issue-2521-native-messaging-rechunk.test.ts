// #2521 — runtime coverage for the Native Messaging example host's behaviour on
// the cases the reporter exercises in loopdive/js2wasm#389: a >1 MiB message (which
// the host re-chunks into multiple <=1 MiB frames) and a multi-message sequence
// (a large message followed by small ones).
//
// The pre-existing round-trip test (#1618/#1651 in issue-1530.test.ts) only drove
// a *toy* single-message host with a 7-byte body, so the real example host's
// emitRun / re-chunk loop and any multi-message sequence were untested — which is
// why #389 slipped through. These tests drive the ACTUAL example host.
//
// They assert the host's current, correct-per-contract behaviour: <=1 MiB
// messages echo verbatim in one frame; >1 MiB messages are split into a sequence
// of <=1 MiB valid-JSON-array frames whose elements, concatenated, reproduce the
// original (the documented contract). A receiver that reassembles to the expected
// size round-trips the whole sequence with no desync — demonstrating the stream
// is correct and the #389 failure is the harness's 1:1 assumption, not the host.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compileProject } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "examples", "native-messaging", "nm_js2wasm_node_fs.ts");
const FRAME_CHUNK = 1024 * 1024;

// Minimal raw-byte WASI shim (mirrors issue-1530.test.ts): fd_read drains a
// preloaded stdin buffer; fd_write captures the fd=1 byte stream in order.
function runWasiRaw(binary: Uint8Array, stdin: Uint8Array): Uint8Array {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const memView = () => new DataView(ref.mem!.buffer);
  const writes: Array<[number, Uint8Array]> = [];
  let pos = 0;
  const wasi = {
    fd_read(_fd: number, iovs: number, iovsLen: number, nread: number): number {
      const view = memView();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const n = Math.min(len, stdin.length - pos);
        new Uint8Array(ref.mem!.buffer, ptr, n).set(stdin.subarray(pos, pos + n));
        pos += n;
        total += n;
        if (n < len) break;
      }
      view.setUint32(nread, total, true);
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = memView();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        writes.push([fd, Uint8Array.from(new Uint8Array(ref.mem!.buffer, ptr, len))]);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(code: number): void {
      throw new Error(`proc_exit(${code})`);
    },
    random_get(): number {
      return 0;
    },
    clock_time_get(): number {
      return 0;
    },
  };
  // #2631 — node:fs shim: instantiate it first (owns memory + WASI fd_*), then
  // the user module importing {memory, readSync, writeSync} from the shim.
  const shim = new WebAssembly.Instance(new WebAssembly.Module(buildNodeFsShim()), {
    wasi_snapshot_preview1: wasi,
  });
  ref.mem = shim.exports.memory as WebAssembly.Memory;
  const inst = new WebAssembly.Instance(new WebAssembly.Module(binary), {
    "node:fs": {
      memory: shim.exports.memory,
      readSync: shim.exports.readSync,
      writeSync: shim.exports.writeSync,
    },
    env: {},
  });
  (inst.exports.main as () => void)();
  const fd1 = writes.filter(([fd]) => fd === 1).flatMap(([, b]) => Array.from(b));
  return Uint8Array.from(fd1);
}

// One Native Messaging frame: 4-byte LE length prefix + UTF-8 JSON body.
function frame(jsonBody: string): Uint8Array {
  const body = new TextEncoder().encode(jsonBody);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Split a stdout byte stream into its framed bodies (4-byte LE length + body)*.
function parseFrames(bytes: Uint8Array): string[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: string[] = [];
  let off = 0;
  while (off + 4 <= bytes.length) {
    const len = dv.getUint32(off, true);
    off += 4;
    frames.push(new TextDecoder().decode(bytes.subarray(off, off + len)));
    off += len;
  }
  return frames;
}

describe("#2521 Native Messaging host — >1 MiB re-chunking + multi-message sequence", () => {
  it("echoes a <=1 MiB message verbatim in a single frame", async () => {
    // nm_js2wasm_node_fs now imports the shared `./nm_js2wasm_sync_framing` core (#2778), so it
    // must compile through the multi-file bundler (mirrors the CLI's #2771
    // routing); single-source `compile()` would strip the relative import.
    const result = await compileProject(hostPath, {
      target: "wasi",
      link: ["node:fs"],
      skipSemanticDiagnostics: true,
    });
    expect(result.success).toBe(true);
    const frames = parseFrames(runWasiRaw(result.binary, frame(JSON.stringify([1, 2, 3]))));
    expect(frames).toEqual(["[1,2,3]"]);
  });

  it("re-chunks a >1 MiB array into multiple <=1 MiB JSON-array frames that reassemble to the original", async () => {
    // nm_js2wasm_node_fs now imports the shared `./nm_js2wasm_sync_framing` core (#2778), so it
    // must compile through the multi-file bundler (mirrors the CLI's #2771
    // routing); single-source `compile()` would strip the relative import.
    const result = await compileProject(hostPath, {
      target: "wasi",
      link: ["node:fs"],
      skipSemanticDiagnostics: true,
    });
    expect(result.success).toBe(true);
    const N = 209715 * 2; // ~2 MiB JSON body — strictly above the 1 MiB cap
    const big = Array(N); // sparse → JSON renders as [null, null, …]
    const body = JSON.stringify(big);
    expect(body.length).toBeGreaterThan(FRAME_CHUNK);

    const frames = parseFrames(runWasiRaw(result.binary, frame(body)));
    // The host MUST split it (Chrome caps a host→extension message at 1 MiB).
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(f.length).toBeLessThanOrEqual(FRAME_CHUNK); // every frame within the cap
      expect(() => JSON.parse(f)).not.toThrow(); // every frame is a complete JSON value
    }
    // Concatenating the chunk elements reproduces the original array.
    const reassembled = frames.flatMap((f) => JSON.parse(f) as unknown[]);
    expect(reassembled.length).toBe(N);
    expect(reassembled.every((x) => x === null)).toBe(true);
  });

  it("processes the reporter's multi-message sequence (big then small) with no desync", async () => {
    // nm_js2wasm_node_fs now imports the shared `./nm_js2wasm_sync_framing` core (#2778), so it
    // must compile through the multi-file bundler (mirrors the CLI's #2771
    // routing); single-source `compile()` would strip the relative import.
    const result = await compileProject(hostPath, {
      target: "wasi",
      link: ["node:fs"],
      skipSemanticDiagnostics: true,
    });
    expect(result.success).toBe(true);
    const N = 209715 * 2; // ~2 MiB
    const big = Array(N);
    // The reporter's sequence: a large message followed by small ones.
    // (Uint8Array([97]) JSON-stringifies to {"0":97}, matching the harness.)
    const stdin = concatBytes([
      frame(JSON.stringify(big)),
      frame(JSON.stringify("test")),
      frame(JSON.stringify("")),
      frame(JSON.stringify(1)),
      frame(JSON.stringify({ "0": 97 })),
    ]);
    const frames = parseFrames(runWasiRaw(result.binary, stdin));

    // Reassemble per the documented contract: for an echo the receiver knows the
    // expected size, so it concatenates the big message's chunk frames until the
    // element count matches, then the four small echoes follow verbatim and in
    // order — with no leftover/extra frames (i.e. the stream is correctly framed).
    let i = 0;
    let bigCount = 0; // track element count only (avoids spreading huge arrays)
    while (bigCount < N) {
      const chunk = JSON.parse(frames[i++]) as unknown[];
      expect(chunk.every((x) => x === null)).toBe(true);
      bigCount += chunk.length;
    }
    expect(bigCount).toBe(N);
    expect(frames[i++]).toBe('"test"');
    expect(frames[i++]).toBe('""');
    expect(frames[i++]).toBe("1");
    expect(frames[i++]).toBe('{"0":97}');
    expect(i).toBe(frames.length); // every frame accounted for — no desync
  });
});
