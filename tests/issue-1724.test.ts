// #1724 — string-constant backing-store corruption via WASI number formatting.
//
// Reported by guest271314 against the Native Messaging host (parent #389). The
// debug line `[host] received ${n} chars` mutated its OWN literal across
// iterations: "received" -> "re60ived" -> "re61ived" ... The digits of the
// previously-formatted number overwrote the "ce" inside the "received" literal.
//
// ROOT CAUSE: the WASI integer-formatting helper (__wasi_write_i32) wrote its
// itoa scratch digits at `global.get $__wasi_bump_ptr`, which initialises to
// 1024 — the SAME offset where string-literal data segments begin
// (wasiAllocStringData starts at 1024 and grows up). So formatting a number
// clobbered bytes 1024..1035 of the first literal. The fix anchors the itoa
// scratch to the reserved low-scratch region (offset 16), which never aliases
// the data segments.
//
// These tests drive the compiled module through a custom fd_write capture
// (separating fd=1/fd=2) and assert the literal text survives interleaved
// number formatting byte-for-byte.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

/** Run a WASI module's `main`, capturing fd=1 (stdout) and fd=2 (stderr) bytes. */
async function runWasi(source: string): Promise<{ stdout: string; stderr: string }> {
  const result = await compile(source, { target: "wasi" });
  expect(result.success).toBe(true);
  const stdoutBytes: number[] = [];
  const stderrBytes: number[] = [];
  const ref: { mem?: WebAssembly.Memory } = {};
  const wasi = buildWasiPolyfill();
  const imports = {
    wasi_snapshot_preview1: new Proxy(wasi as unknown as Record<string, unknown>, {
      get(target, prop) {
        if (prop === "fd_write") {
          return (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
            const dv = new DataView(ref.mem!.buffer);
            let total = 0;
            const sink = fd === 2 ? stderrBytes : stdoutBytes;
            for (let i = 0; i < iovsLen; i++) {
              const ptr = dv.getUint32(iovs + i * 8, true);
              const len = dv.getUint32(iovs + i * 8 + 4, true);
              for (let j = 0; j < len; j++) sink.push(dv.getUint8(ptr + j));
              total += len;
            }
            dv.setUint32(nwritten, total, true);
            return 0;
          };
        }
        return (target as Record<string, unknown>)[prop as string];
      },
    }),
  };
  const module = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(module, imports);
  ref.mem = (instance.exports as Record<string, unknown>).memory as WebAssembly.Memory;
  wasi.setMemory(ref.mem);
  (instance.exports as Record<string, () => void>).main?.();
  const dec = (b: number[]) => Buffer.from(b).toString("latin1");
  return { stdout: dec(stdoutBytes), stderr: dec(stderrBytes) };
}

describe("#1724 — WASI number formatting must not corrupt string constants", () => {
  it("the 'received' literal survives interleaved number formatting (the #389 repro)", async () => {
    const { stderr } = await runWasi(`
      export function main(): void {
        let i = 0;
        while (i < 5) {
          const n = 60 + i;
          console.error(\`[host] received \${n} chars\`);
          i = i + 1;
        }
      }
    `);
    // Before the fix this was
    //   "[host] received 60 chars\n[host] re60ived 61 chars\n[host] re61ived ..."
    // console.error appends a trailing newline per call.
    expect(stderr).toBe(
      "[host] received 60 chars\n" +
        "[host] received 61 chars\n" +
        "[host] received 62 chars\n" +
        "[host] received 63 chars\n" +
        "[host] received 64 chars\n",
    );
    // Strong invariant: the substring "received" must appear once per line and
    // never the corrupted "re<digits>ived" form.
    expect(stderr).not.toMatch(/re\d/);
    expect(stderr.match(/received/g)?.length).toBe(5);
  });

  it("formats zero, negatives, and large ints without touching the surrounding literal", async () => {
    const { stderr } = await runWasi(`
      export function main(): void {
        console.error(\`A=\${0} B=\${-17} C=\${2147483647} D=\${1234567890} done\`);
        console.error(\`literal stays clean\`);
      }
    `);
    expect(stderr).toBe("A=0 B=-17 C=2147483647 D=1234567890 done\n" + "literal stays clean\n");
  });

  it("a number written between two literals leaves both literals intact", async () => {
    const { stdout } = await runWasi(`
      export function main(): void {
        console.log(\`prefix-\${42}-suffix\`);
      }
    `);
    // console.log appends a trailing newline; the body must be exact.
    expect(stdout).toBe("prefix-42-suffix\n");
  });
});
