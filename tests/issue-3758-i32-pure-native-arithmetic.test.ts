// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3758 — IR-native i32 arithmetic fast path (native i32.add/i32.sub/i32.mul
// for provably-bounded bitwise/arithmetic operands). A prior attempt at this
// (#3745) used `i32.trunc_sat_f64_s` (saturating) as a substitute for
// arithmetic composition, which is unsound: two int32-range operands can sum
// to a value outside int32 range, and ECMA-262 ToInt32 WRAPS such a value
// while trunc_sat SATURATES instead. That attempt landed and was reverted —
// this test suite specifically covers the exact overflow scenario that broke
// it (the `fib` benchmark's accumulator), plus the string-hash build loop.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import fs from "fs";

async function compileRun(src: string, opts: Record<string, unknown> = {}) {
  const r = await compile(src, { fileName: "t.js", ...opts });
  if (!r.success) throw new Error(r.errors.map((e) => e.message).join("\n"));
  if (!WebAssembly.validate(r.binary)) throw new Error(`Invalid Wasm binary\n${r.wat}`);
  const imports = buildImports(r.imports ?? [], undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exportsObj = instance.exports as unknown as Record<string, CallableFunction>;
  const maybeSet = (imports as { setExports?: (e: unknown) => void }).setExports;
  if (maybeSet) maybeSet(exportsObj);
  return { exports: exportsObj, wat: r.wat, irCompiledFuncs: r.irCompiledFuncs };
}

const FIB_SRC = fs.readFileSync("website/public/benchmarks/competitive/programs/fib.js", "utf8");

function fibRef(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = (a + b) | 0;
    a = b;
    b = next;
  }
  return a | 0;
}

describe("#3758 exact fib overflow regression (the #3745 revert repro)", () => {
  it("matches JS reference for inputs that overflow int32 (this exact case broke #3745)", async () => {
    const { exports, irCompiledFuncs } = await compileRun(FIB_SRC, { target: "wasi", nativeStrings: true });
    expect(irCompiledFuncs).toContain("run");
    // The exact revert repro values: expected [0,1,-1846256875,-1821818939], the
    // bug produced [.., 2147483647, 2147483647] (saturation instead of wrap).
    const inputs = [0, 1, 47, 48, 90, 91, 1000, 100000];
    for (const n of inputs) {
      expect(exports.run(n), `run(${n})`).toBe(fibRef(n));
    }
  });

  it("uses native i32.add in the compiled output (fast path actually fires)", async () => {
    const { wat } = await compileRun(FIB_SRC, { target: "wasi", nativeStrings: true, optimize: 0 });
    const runStart = wat.indexOf("(func $run");
    const runEnd = wat.indexOf("(func ", runStart + 1);
    const body = wat.slice(runStart, runEnd === -1 ? undefined : runEnd);
    expect(body).toContain("i32.add");
  });
});

describe("#3758 direct overflow stress (multiply + add near int32 boundary)", () => {
  it("wraps like JS ToInt32, never saturates", async () => {
    const src = `
      export function run(n) {
        let a = 0;
        for (let i = 0; i < n; i++) {
          a = (a + 1000000000) | 0;
        }
        return a | 0;
      }
    `;
    function ref(n: number): number {
      let a = 0;
      for (let i = 0; i < n; i++) {
        a = (a + 1000000000) | 0;
      }
      return a | 0;
    }
    const { exports } = await compileRun(src, { target: "wasi", nativeStrings: true });
    for (const n of [0, 1, 2, 3, 4, 5, 10, 20, 50]) {
      expect(exports.run(n), `run(${n})`).toBe(ref(n));
    }
  });

  it("guarded i32.mul: large multiplication that is NOT small-literal-guarded stays exact via the fallback path", async () => {
    const src = `
      export function f(x: number): number {
        return (x * 2147483647 + 1) | 0;
      }
    `;
    function ref(x: number): number {
      return (x * 2147483647 + 1) | 0;
    }
    const { exports } = await compileRun(src, { fileName: "t.ts" });
    for (const x of [0, 1, 2, 3, 1000, 65535, 0x10000, 0x7fffffff]) {
      expect(exports.f(x), `f(${x})`).toBe(ref(x));
    }
  });
});

describe("#3758 string-hash build-loop correctness", () => {
  const STRING_HASH_SRC = fs.readFileSync("website/public/benchmarks/competitive/programs/string-hash.js", "utf8");
  function runRef(n: number): number {
    const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
    let text = "";
    for (let i = 0; i < n; i++) {
      const a = (i * 13) & 31;
      const b = (a + 7) & 31;
      text += alphabet.charAt(a);
      text += alphabet.charAt(b);
      text += ";";
    }
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return hash | 0;
  }

  it("matches JS reference under default IR", async () => {
    const { exports, irCompiledFuncs } = await compileRun(STRING_HASH_SRC, {
      target: "wasi",
      nativeStrings: true,
      optimize: 3,
    });
    expect(irCompiledFuncs).toContain("run");
    for (const n of [0, 1, 2, 3, 5, 10, 20, 50, 100, 256, 1000, 5000, 20000]) {
      expect(exports.run(n), `run(${n})`).toBe(runRef(n));
    }
  });

  it("build loop uses native i32.mul now (the (i*13)&31 / (a+7)&31 shapes)", async () => {
    const { wat } = await compileRun(STRING_HASH_SRC, { target: "wasi", nativeStrings: true, optimize: 0 });
    const runStart = wat.indexOf("(func $run");
    const runEnd = wat.indexOf("(func ", runStart + 1);
    const body = wat.slice(runStart, runEnd === -1 ? undefined : runEnd);
    expect(body).toContain("i32.mul");
  });
});
