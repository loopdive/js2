// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7164 follow-up — `g.length += k` on a binding declared `any[]` whose
// emitted carrier is another vec (only strings pushed: a string vec). #7164's
// length update declines that carrier, and the generic struct compound path
// then read the declared vec layout off the other vec: invalid Wasm on every
// lane (46 programs of the #7164 leak sweep). The path now refuses deliberately
// (sticky, so the expression wrapper cannot swallow it into a default), and
// never emits an invalid module.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "gc", options: {} },
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
];

const REFUSED: Record<string, string> = {
  "clear, then grow": `export function f(): number { const g: any[] = []; g.push("y"); g.push("z"); g.length = 0; g.length += 3; return g.length; }`,
  "shrink, grow, then Array.from": `export function f(): number { const g: any[] = []; g.push("y"); g.push("z"); g.push("w"); g.length = 1; g.length += 2; return Array.from(g).length; }`,
  "Array.of over the grown array": `export function f(): number { const g: any[] = []; g.push("y"); g.push("z"); g.length = 0; g.length += 3; return Array.of(...g).length; }`,
};

const COMPILED: Record<string, { readonly source: string; readonly result: number }> = {
  "a declared string[] grows": {
    source: `export function f(): number { const g: string[] = []; g.push("y"); g.push("z"); g.length = 0; g.length += 3; return g.length; }`,
    result: 3,
  },
  "an any[] shrinks, then grows": {
    source: `export function f(): number { const g: any[] = []; g.push("y"); g.push("z"); g.push("w"); g.length = 1; g.length += 2; return g.length; }`,
    result: 3,
  },
  "a mixed any[] grows": {
    source: `export function f(): number { const g: any[] = []; g.push("y"); g.push(1); g.length += 2; return g.length; }`,
    result: 4,
  },
};

describe("#7164 — compound update on a vec carrier of another type", () => {
  for (const [name, source] of Object.entries(REFUSED)) {
    for (const { name: lane, options } of LANES) {
      it(`refuses, never an invalid module: ${name} / ${lane}`, async () => {
        const result = await compile(source, { fileName: "probe.ts", ...options });
        const messages = result.errors.map((error) => error.message).join("\n");
        expect(result.success, messages).toBe(false);
        expect(messages).toContain("Cannot compound-assign 'length'");
        expect(messages).not.toContain("failed validation");
      });
    }
  }

  for (const [name, { source, result: expected }] of Object.entries(COMPILED)) {
    it(`still compiles and runs on wasi: ${name}`, async () => {
      const result = await compile(source, { fileName: "probe.ts", target: "wasi" });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, {
        wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }),
      });
      expect((instance.exports.f as () => number)()).toBe(expected);
    });
  }
});
