// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1470 — WASI/native-string output must not round-trip through JS-host string
// bridge imports and must encode runtime strings as UTF-8, not by truncating
// UTF-16 code units to their low byte.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PROCESS_DECL = `declare const process: {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};`;

async function runWasi(source: string): Promise<{
  stdout: Uint8Array;
  stderr: Uint8Array;
  imports: string[];
  wat: string;
}> {
  const result = await compile(source, { fileName: "issue-1470.ts", target: "wasi" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  const ref: { mem?: WebAssembly.Memory } = {};
  const stdout: number[] = [];
  const stderr: number[] = [];

  const wasi = {
    fd_read(): number {
      return 0;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = new DataView(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        const sink = fd === 2 ? stderr : fd === 1 ? stdout : undefined;
        if (sink) {
          for (const byte of new Uint8Array(ref.mem!.buffer, ptr, len)) sink.push(byte);
        }
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(): void {},
    random_get(): number {
      return 0;
    },
    clock_time_get(): number {
      return 0;
    },
  };

  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  ref.mem = (instance.exports as { memory: WebAssembly.Memory }).memory;
  (instance.exports as { main?: () => void }).main?.();

  return {
    stdout: Uint8Array.from(stdout),
    stderr: Uint8Array.from(stderr),
    imports,
    wat: result.wat,
  };
}

describe("#1470 WASI runtime string output uses pure-Wasm UTF-8", () => {
  it("writes non-ASCII runtime strings without JS-host string bridge imports", async () => {
    const out = await runWasi(`
      ${PROCESS_DECL}
      export function main(): void {
        const accent = "\\u00e9";
        const face = "\\ud83d\\ude42";
        const msg = \`x=\${accent}\${face}\`;
        process.stdout.write(msg);
        process.stderr.write(msg + "\\n");
      }
    `);

    const expected = Buffer.from("x=\u00e9\ud83d\ude42", "utf8");
    expect(Array.from(out.stdout)).toEqual(Array.from(expected));
    expect(Array.from(out.stderr)).toEqual(Array.from(Buffer.concat([expected, Buffer.from("\n")])));

    expect(out.imports).not.toContain("env::__str_from_mem");
    expect(out.imports).not.toContain("env::__str_to_mem");
    expect(out.imports).not.toContain("env::__str_extern_len");
    expect(out.imports.some((i) => i.startsWith("wasm:js-string::"))).toBe(false);
    expect(out.wat).toContain("__wasi_write_any_string");
  });
});
