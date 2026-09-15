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
