// #2526 — the Native Messaging example host must write each frame (4-byte LE
// length prefix + body) in a SINGLE process.stdout.write / fd_write. Writing the
// prefix and body as separate writes (the pre-#2526 behaviour) lets a streaming
// receiver misalign on pipe-chunk boundaries — loopdive/js2wasm#389, where the
// reporter's harness threw "non-whitespace after JSON" while an atomic-framing
// host (ComponentizeJS) worked with the same harness.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/index.js";
import { buildNodeFsShim } from "../scripts/build-node-fs-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "examples", "native-messaging", "nm_js2wasm_node_fs.ts");
const FRAME_CHUNK = 1024 * 1024;

// WASI shim that records the SIZE of every fd=1 write (not just the bytes).
function runCaptureWrites(binary: Uint8Array, stdin: Uint8Array): { sizes: number[]; out: Uint8Array } {
  const ref: { mem: WebAssembly.Memory | undefined } = { mem: undefined };
  const mv = () => new DataView(ref.mem!.buffer);
  const sizes: number[] = [];
  const chunks: Uint8Array[] = [];
  let pos = 0;
  const wasi = {
    fd_read(_fd: number, iovs: number, n: number, nread: number): number {
      const v = mv();
      let t = 0;
      for (let i = 0; i < n; i++) {
        const p = v.getUint32(iovs + i * 8, true);
        const l = v.getUint32(iovs + i * 8 + 4, true);
        const k = Math.min(l, stdin.length - pos);
        new Uint8Array(ref.mem!.buffer, p, k).set(stdin.subarray(pos, pos + k));
        pos += k;
        t += k;
        if (k < l) break;
      }
      v.setUint32(nread, t, true);
      return 0;
    },
    fd_write(fd: number, iovs: number, n: number, nwritten: number): number {
      const v = mv();
      let t = 0;
      for (let i = 0; i < n; i++) {
        const p = v.getUint32(iovs + i * 8, true);
        const l = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 1) {
          sizes.push(l);
          chunks.push(Uint8Array.from(new Uint8Array(ref.mem!.buffer, p, l)));
        }
        t += l;
      }
      v.setUint32(nwritten, t, true);
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
  // #2631 — the example now uses node:fs readSync/writeSync via the node:fs
  // shim (--link node:fs). Instantiate the shim FIRST (it owns the memory and
  // makes the fd_read/fd_write WASI calls), then the user module importing
  // {memory, readSync, writeSync} from the shim. fd=1 writes are still issued by
  // the shim's writeSync over the shared memory, so the size capture is unchanged.
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
  const out = Uint8Array.from(chunks.flatMap((c) => Array.from(c)));
  return { sizes, out };
}

function frame(jsonBody: string): Uint8Array {
  const body = new TextEncoder().encode(jsonBody);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

describe("#2526 Native Messaging host — atomic frame writes", () => {
  it("writes a small (<=1 MiB) message as one fd_write (no bare 4-byte length write)", async () => {
    const r = await compile(readFileSync(hostPath, "utf-8"), {
      fileName: "nm_js2wasm_node_fs.ts",
      target: "wasi",
      link: ["node:fs"],
    });
    expect(r.success).toBe(true);
    const { sizes } = runCaptureWrites(r.binary, frame(JSON.stringify([1, 2, 3])));
    expect(sizes).not.toContain(4); // no standalone length-prefix write
    expect(sizes.length).toBe(1); // one logical frame → one write
    expect(sizes[0]).toBe(4 + "[1,2,3]".length);
  });

  it("writes each re-chunked frame of a >1 MiB message atomically (writes == frames, none is 4 bytes)", async () => {
    const r = await compile(readFileSync(hostPath, "utf-8"), {
      fileName: "nm_js2wasm_node_fs.ts",
      target: "wasi",
      link: ["node:fs"],
    });
    expect(r.success).toBe(true);
    const N = 209715 * 2; // ~2 MiB → multiple re-chunked frames
    const body = JSON.stringify(Array(N));
    expect(body.length).toBeGreaterThan(FRAME_CHUNK);
    const { sizes, out } = runCaptureWrites(r.binary, frame(body));

    // No write is a bare 4-byte length prefix → length+body are atomic.
    expect(sizes).not.toContain(4);

    // Number of writes == number of frames in the output stream.
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let off = 0;
    let frameCount = 0;
    while (off + 4 <= out.length) {
      const len = dv.getUint32(off, true);
      // each frame is a complete JSON value
      expect(() => JSON.parse(new TextDecoder().decode(out.subarray(off + 4, off + 4 + len)))).not.toThrow();
      off += 4 + len;
      frameCount++;
    }
    expect(frameCount).toBeGreaterThan(1);
    expect(sizes.length).toBe(frameCount); // exactly one fd_write per frame
  });
});
