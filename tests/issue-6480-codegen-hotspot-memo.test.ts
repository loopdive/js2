// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6480 — per-compile codegen hotspots.
//
// Two mechanical memos, both of which must be OUTPUT-NEUTRAL:
//
//  1. the lib declaration scan (`collectExternDeclarations` on the lib.*.d.ts
//     path) is replayed from a recorded effect list instead of re-walking every
//     ambient declaration through `mapLibTypeNodeToWasm` on each compile;
//  2. `buildLibDeclIndex` is cached on the lib `SourceFile` identity list.
//
// Both are keyed on per-process-stable inputs, so the pin that matters is that
// a SECOND compile in the same process — the pooled-worker case the memo exists
// for — produces byte-identical output to the first, including after the caches
// are dropped, and across target profiles that share the process.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { analyzeSource } from "../src/checker/index.ts";
import { buildLibDeclIndex, clearLibDeclIndexCacheForTests } from "../src/codegen/lib-decl-index.ts";
import { clearExternLibScanMemoForTests } from "../src/codegen/lib-extern-scan-memo.ts";

const LIB_HEAVY_SRC = `
  var d = new Date();
  var re = /a(b)c/g;
  var m = "abc".match(re);
  var u = new Uint8Array(4);
  console.log(d.getTime(), m ? m[1] : "", u.length);
`;

async function binaryOf(src: string, options?: Parameters<typeof compile>[1]): Promise<string> {
  const r = await compile(src, { fileName: "t.ts", ...options });
  expect(r.success).toBe(true);
  if (!r.success) throw new Error("compile failed");
  return Buffer.from(r.binary).toString("base64");
}

describe("#6480 lib-scan memo is output-neutral", () => {
  it("second compile in the same process is byte-identical to the first", async () => {
    clearExternLibScanMemoForTests();
    clearLibDeclIndexCacheForTests();
    const first = await binaryOf(LIB_HEAVY_SRC); // records the memo
    const second = await binaryOf(LIB_HEAVY_SRC); // replays it
    const third = await binaryOf(LIB_HEAVY_SRC);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("dropping the caches reproduces the same bytes", async () => {
    const warm = await binaryOf(LIB_HEAVY_SRC);
    clearExternLibScanMemoForTests();
    clearLibDeclIndexCacheForTests();
    const cold = await binaryOf(LIB_HEAVY_SRC);
    expect(cold).toBe(warm);
  });

  it("does not leak across target profiles compiled in one process", async () => {
    // The memo key carries the profile booleans the collectors read
    // (nativeStrings / standalone / wasi), so interleaving profiles must not
    // let one profile's extern classes be replayed into another's.
    const hostA = await binaryOf(LIB_HEAVY_SRC);
    const nativeA = await binaryOf(LIB_HEAVY_SRC, { nativeStrings: true });
    const hostB = await binaryOf(LIB_HEAVY_SRC);
    const nativeB = await binaryOf(LIB_HEAVY_SRC, { nativeStrings: true });
    expect(hostB).toBe(hostA);
    expect(nativeB).toBe(nativeA);
    expect(nativeA).not.toBe(hostA);
  });

  // Lever 2 reshaped the two hot index-shift walks (the late-import funcIdx
  // walk in expressions/late-imports.ts and the module-global walk in
  // registry/imports.ts) into indexed loops with direct property reads. Both
  // are shape-only changes, so the pin is the property the walks exist for: a
  // body that mints SEVERAL distinct late imports interleaved with string
  // constants — each mint shifting every already-emitted defined-function
  // index, each string constant shifting every module-global index — must
  // still produce a module that validates, and must do so identically on a
  // repeat compile in the same process.
  const SHIFT_HEAVY_SRC = `
    function mix(xs: any[], k: any): string {
      let acc = "start:";
      for (let i = 0; i < xs.length; i++) {
        const v = xs[i];
        if (typeof v === "number") acc += "n" + (v + 1);
        else if (typeof v === "string") acc += "s" + v;
        else if (typeof v === "boolean") acc += "b" + (v ? "T" : "F");
        else acc += "o";
      }
      try {
        if (k === undefined) throw new TypeError("no key");
        acc += "|k=" + k;
      } catch (e) {
        acc += "|caught";
      }
      return acc + "|end";
    }
    export function run(): string {
      return mix([1, "a", true, {}], "z") + ";" + mix([2], undefined);
    }
  `;

  it("shift-heavy body still compiles to a valid module, identically on repeat", async () => {
    const r = await compile(SHIFT_HEAVY_SRC, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(() => new WebAssembly.Module(r.binary)).not.toThrow();
    const again = await binaryOf(SHIFT_HEAVY_SRC);
    expect(again).toBe(Buffer.from(r.binary).toString("base64"));
  });

  it("buildLibDeclIndex returns a cached index for the same source files", () => {
    clearLibDeclIndexCacheForTests();
    const ast = analyzeSource("var d = new Date();", "t.ts");
    const libSfs = ast.program.getSourceFiles().filter((sf) => {
      const b = sf.fileName.split("/").pop() ?? sf.fileName;
      return b.startsWith("lib.") && b.endsWith(".d.ts");
    });
    const a = buildLibDeclIndex(libSfs);
    const b = buildLibDeclIndex(libSfs);
    expect(b).toBe(a);
    clearLibDeclIndexCacheForTests();
    const c = buildLibDeclIndex(libSfs);
    expect(c).not.toBe(a);
    expect([...c.interfaces.keys()]).toEqual([...a.interfaces.keys()]);
    expect([...c.vars.keys()]).toEqual([...a.vars.keys()]);
  });
});
