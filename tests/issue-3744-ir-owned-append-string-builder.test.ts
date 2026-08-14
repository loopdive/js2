// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3744 — IR-native fast path for the `let s = ""; for (...) s += <expr>`
// string-builder loop shape.
//
// #3740 found that IR's default `string.concat` lowering has no equivalent
// of the legacy #1210 string-builder / #1761 presize rewrite: every append
// goes through the general `__str_concat` helper (cons-node-or-flatten),
// which is dramatically slower than legacy's growable buffer for this shape.
// #3740 shipped a selector-gate workaround (defer such functions to legacy)
// so the shipped benchmark keeps its best available number.
//
// This is the promised follow-up: a genuine IR-native fast path, now the
// DEFAULT for this shape. IR's front end (`ir/from-ast.ts`'s
// `collectOwnedStringAppendSymbols`) already proves exactly this shape safe
// for in-place mutation ("owned-append" concat mode) — the gap was that
// `ir/integration.ts`'s `emitStringConcat` ignored that mode entirely. It now
// dispatches `owned-append` concats to a new `__str_concat_owned` WasmGC
// helper (`codegen/native-strings-basics.ts`) that grows the backing i16
// array in place (geometric doubling via the existing `__str_buf_next_cap`
// helper) instead of always allocating a fresh array, while still producing
// an ordinary `$NativeString` — every existing string consumer keeps working
// unchanged.
//
// `JS2WASM_IR_STRING_BUILDER=0` is a kill switch (same convention as e.g.
// `JS2WASM_UNION_ANYREP=0`) that forces this shape back to legacy — useful
// for A/B comparison, since legacy remains faster for benchmarks whose index
// arithmetic ALSO uses bitwise ops on untyped `number`s (a *separate*,
// unrelated i32-loop-arithmetic-promotion gap — see #1948).

import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) The fast path is detected by a `;; __str_concat_owned` marker and by
// the presence of `run` in the emitted-function list. The IR inliner (default
// ON since the tuned-set flip) inlines both away. Pin it off.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

function functionBodyWithCallNames(wat: string, name: string): string {
  const lines = wat.split("\n");
  const functionNames: string[] = [];
  for (const line of lines) {
    const imported = /^\s*\(import "[^"]*" "([^"]+)" \(func/.exec(line);
    if (imported) {
      functionNames.push(imported[1]!);
      continue;
    }
    const defined = /^\s*\(func \$([^\s()]+)/.exec(line);
    if (defined) functionNames.push(defined[1]!);
  }
  const start = lines.findIndex((line) => new RegExp(`\\(func \\$${name}[\\s()]`).test(line));
  expect(start, `func $${name} not found`).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  let depth = 0;
  let seen = false;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    const call = /\bcall (\d+)\b/.exec(line);
    body.push(call ? `${line} ;; ${functionNames[Number(call[1])] ?? "?"}` : line);
    for (const character of line) {
      if (character === "(") {
        depth++;
        seen = true;
      } else if (character === ")") {
        depth--;
      }
    }
    if (seen && depth <= 0) break;
  }
  return body.join("\n");
}

async function compileAndInstantiate(src: string, opts: Record<string, unknown>) {
  const r = await compile(src, { fileName: "owned-append.ts", ...opts });
  if (!r.success) {
    throw new Error(`Compile failed:\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  if (!WebAssembly.validate(r.binary)) {
    throw new Error(`Invalid Wasm binary\nWAT:\n${r.wat}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return {
    exports: instance.exports as unknown as Record<string, CallableFunction>,
    irCompiledFuncs: r.irCompiledFuncs,
    wat: r.wat,
  };
}

// Grows past several doubling boundaries (16 -> 32 -> 64 -> ...), exercises
// both the in-place-append fast branch and the grow-a-fresh-array branch
// many times, and reads `s` after the loop (length + charCodeAt) so a wrong
// length/backing-array mixup would surface as a wrong value, not just a trap.
const BUILDER_SRC = `
export function run(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += "ab";
  }
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = hash + s.charCodeAt(i);
  }
  return hash;
}
`;

function runRef(n: number): number {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += "ab";
  }
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = hash + s.charCodeAt(i);
  }
  return hash;
}

describe("#3744 IR owned-append string-builder fast path", () => {
  // biome lint disallows `delete process.env.X`; assigning undefined unsets it.
  const ORIGINAL = process.env.JS2WASM_IR_STRING_BUILDER;
  afterEach(() => {
    process.env.JS2WASM_IR_STRING_BUILDER = ORIGINAL;
  });

  it("default: IR claims this shape and uses the owned-append fast path", async () => {
    process.env.JS2WASM_IR_STRING_BUILDER = undefined;
    const { irCompiledFuncs, wat } = await compileAndInstantiate(BUILDER_SRC, {
      target: "wasi",
      nativeStrings: true,
    });
    expect(irCompiledFuncs ?? []).toContain("run");
    expect(functionBodyWithCallNames(wat, "run")).toContain(";; __str_concat_owned");
  });

  it("JS2WASM_IR_STRING_BUILDER=0: kill switch defers this shape to legacy", async () => {
    process.env.JS2WASM_IR_STRING_BUILDER = "0";
    const r = await compile(BUILDER_SRC, {
      fileName: "owned-append.ts",
      target: "wasi",
      nativeStrings: true,
    });
    expect(r.success).toBe(true);
    expect(r.irCompiledFuncs ?? []).not.toContain("run");
  });

  it("owned-append path matches the JS reference across growth boundaries", async () => {
    const { exports, irCompiledFuncs } = await compileAndInstantiate(BUILDER_SRC, {
      target: "wasi",
      nativeStrings: true,
      optimize: 3,
    });
    expect(irCompiledFuncs ?? []).toContain("run");
    const run = exports.run as (n: number) => number;
    for (const n of [0, 1, 2, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 100, 1000, 5000]) {
      expect(run(n)).toBe(runRef(n));
    }
  });

  it("the actual string-hash benchmark is correct through the owned-append path too", async () => {
    const src = `
/** @param {number} n @returns {number} */
export function run(n) {
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
`;
    function runRefHash(n: number): number {
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
    const { exports, irCompiledFuncs } = await compileAndInstantiate(src, {
      target: "wasi",
      nativeStrings: true,
      optimize: 3,
    });
    expect(irCompiledFuncs ?? []).toContain("run");
    const run = exports.run as (n: number) => number;
    for (const n of [0, 1, 2, 63, 64, 65, 100, 1000, 20000]) {
      expect(run(n)).toBe(runRefHash(n));
    }
  });
});
