// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4527 — the reference-preserving dynamic-call bridge (`__call_dyn_<n>`).
//
// A call on an `any`-typed KNOWN variable whose closure wrapper candidates
// were not registered when the calling body compiled — the cross-module case:
// `cb.mjs`'s `callIt(cb) { return cb(2, 3); }` compiles before `main.ts`'s
// arrow argument exists — used to lower to a graceful `ref.null.extern`, so
// the callee was silently never invoked (diff-sequences' isCommon /
// foundSubsequence shape). The bridge routes the call through the host with
// every argument crossing as externref: numbers boxed (and unboxed host-side),
// reference args passed LIVE.

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

async function run(files: Record<string, string>, entry: string) {
  const result = await compileMulti(files, entry, { allowJs: true, skipSemanticDiagnostics: true });
  expect(result.success, result.errors?.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as Record<string, Function>).__module_init?.();
  return wrapExports(instance.exports as Record<string, Function>) as Record<string, () => unknown>;
}

describe("issue #4527: cross-module dynamic callback invocation", () => {
  it("invokes an arrow passed into another module's untyped callback param", async () => {
    const w = await run(
      {
        "./cb.mjs": `
          export function callIt(cb) { return '' + cb(2, 3); }
          export function callBool(cb) { return cb(0, 0) ? 'T' : 'F'; }
        `,
        "./main.ts": `
          import { callIt, callBool } from './cb.mjs';
          export function t(): string {
            const r1 = callIt((x, y) => x + y);
            const r2 = callBool((a, b) => a === b);
            const s = 'ab';
            const r3 = callBool((ai, bi) => s[ai] === s[bi]);
            return [r1, r2, r3].join('|');
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("5|T|T");
  });

  it("threads live index arguments through a diff-sequences-shaped loop", async () => {
    const w = await run(
      {
        "./diffseq.mjs": `
          export default function diff(aLength, bLength, isCommon, foundSubsequence) {
            let n = 0;
            for (let a = 0; a < aLength; a++) {
              for (let b = 0; b < bLength; b++) {
                if (isCommon(a, b)) { n += 1; foundSubsequence(1, a, b); }
              }
            }
            return n;
          }
        `,
        "./main.ts": `
          import diff from './diffseq.mjs';
          export function t(): string {
            const a = 'abc', b = 'abd';
            const found: string[] = [];
            const n = diff(a.length, b.length,
              (ai, bi) => a[ai] === b[bi],
              (nCommon, ai, bi) => { found.push(nCommon + ':' + ai + ',' + bi); });
            return n + '|' + found.join(' ');
          }
        `,
      },
      "./main.ts",
    );
    expect(w.t()).toBe("2|1:0,0 1:1,1");
  });
});
