// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6985 — lodash-es `wasm-opt -O4` overran the 600 s npm-compat budget on the
// native-regime lane. `__runtime_eval_pull_globals` (runtime-eval realm ->
// module-global write-back) inlined the realm read, the provider-carrier
// decode, the interpreted-callable adapter and the coercion PER script-global
// binding: 8,989 locals and 546 KB in one function for lodash-es, which
// Binaryen's `coalesce-locals` interference graph handles quadratically. The
// read+decode and each coercion are now shared out-of-line helpers, so the
// pull body is a flat call sequence whose local count does not grow with the
// number of bindings. These tests pin that bound on both lanes that emit it.
//
// The larger share of the overrun was elsewhere: Binaryen's one-caller rule
// inlined every `__module_init_chunk_*` back into `__module_init` (985 KB),
// whose serial re-optimization took 402 s of `inlining-optimizing`. The
// optimizer now marks the chunks no-full-inline; the last test pins that.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { optimizeBinaryAsync } from "../src/optimize.js";

interface FunctionStats {
  name: string;
  size: number;
  locals: number;
}

/** Per-defined-function body size and declared-local count, by debug name. */
function functionStats(bin: Uint8Array): FunctionStats[] {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bin)).filter((i) => i.kind === "function").length;
  let p = 8;
  const leb = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = bin[p++]!;
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  const text = (len: number): string => new TextDecoder().decode(bin.subarray(p, (p += len)));
  const names = new Map<number, string>();
  const bodies: { idx: number; size: number; locals: number }[] = [];
  while (p < bin.length) {
    const id = bin[p++]!;
    const end = leb() + p;
    if (id === 10) {
      for (let i = 0, n = leb(); i < n; i++) {
        const size = leb();
        const start = p;
        let locals = 0;
        for (let groups = leb(); groups > 0; groups--) {
          locals += leb();
          const type = bin[p++]!;
          if (type === 0x63 || type === 0x64) leb();
        }
        bodies.push({ idx: imports + i, size, locals });
        p = start + size;
      }
    } else if (id === 0 && text(leb()) === "name") {
      while (p < end) {
        const sub = bin[p++]!;
        const subEnd = leb() + p;
        if (sub === 1) {
          for (let n = leb(); n > 0; n--) {
            const idx = leb();
            names.set(idx, text(leb()));
          }
        }
        p = subEnd;
      }
    }
    p = end;
  }
  return bodies.map((b) => ({ name: names.get(b.idx) ?? `$${b.idx}`, size: b.size, locals: b.locals }));
}

/** `count` mutable script-global vars plus a dynamic indirect eval, so every
 * var is a module global the runtime-eval pull helper must write back. */
function manyGlobalsSource(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `var g${i} = ${i};`).join("\n");
  const bumps = Array.from({ length: count }, (_, i) => `g${i}++;`).join(" ");
  return (
    `${vars}\nvar typed = 1.5;\nexport function bump() { ${bumps} typed = typed * 2; }\n` +
    `export function run(s) { (0, eval)(s); return typeof Function("return this")() + g0 + typed; }\n`
  );
}

const LANES = {
  "native-first regime": { semanticProviders: "native-first", hostBridge: "always" },
  standalone: { target: "standalone", runtimeEvalProvider: true },
} as const;

async function pullHelpers(count: number, options: object): Promise<Map<string, FunctionStats>> {
  const result = await compile(manyGlobalsSource(count), {
    fileName: "globals.js",
    allowJs: true,
    ...options,
  } as never);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 2))).toBe(true);
  return new Map(
    functionStats(result.binary)
      .filter((f) => f.name.startsWith("__runtime_eval_pull"))
      .map((f) => [f.name, f]),
  );
}

describe("#6985 — runtime-eval pull helper stays flat", () => {
  for (const [lane, options] of Object.entries(LANES)) {
    it(`${lane}: pull locals do not scale with the number of script globals`, { timeout: 120_000 }, async () => {
      const small = await pullHelpers(20, options);
      const large = await pullHelpers(400, options);
      const pullSmall = small.get("__runtime_eval_pull_globals");
      const pullLarge = large.get("__runtime_eval_pull_globals");
      expect(pullSmall).toBeDefined();
      expect(pullLarge).toBeDefined();
      // Base: ~5 locals and ~330 bytes per binding (258 locals at 50 vars).
      expect(pullLarge!.locals).toBeLessThanOrEqual(4);
      expect(pullLarge!.locals).toBe(pullSmall!.locals);
      expect(pullLarge!.size / 400).toBeLessThan(40);
      // The shared read+decode helper carries the per-value work exactly once,
      // and was not inlined back into the pull body.
      const read = large.get("__runtime_eval_pull_read");
      expect(read).toBeDefined();
      expect(read!.size).toBeGreaterThan(100);
      expect(read!.locals).toBe(small.get("__runtime_eval_pull_read")!.locals);
    });
  }

  it("keeps module-init chunks out of Binaryen's one-caller inliner", { timeout: 120_000 }, async () => {
    // 80 top-level statements exceed the 16-entry chunk cap several times over.
    const statements = Array.from({ length: 80 }, (_, i) => `var o${i} = { k: ${i} }; total += o${i}.k;`);
    const result = await compile(`var total = 0;\n${statements.join("\n")}\nexport function f() { return total; }\n`, {
      fileName: "chunks.js",
      allowJs: true,
      target: "standalone",
    } as never);
    expect(result.success).toBe(true);
    const chunkCount = (bin: Uint8Array): number =>
      functionStats(bin).filter((f) => f.name.startsWith("__module_init_chunk_")).length;
    const before = chunkCount(result.binary);
    expect(before).toBeGreaterThan(1);
    const optimized = await optimizeBinaryAsync(result.binary, { level: 4, preserveNames: true });
    if (!optimized.optimized) return; // no wasm-opt in this environment
    // Base: every chunk has one caller, so -O4 inlined all of them (0 left).
    expect(chunkCount(optimized.binary)).toBe(before);
  });

  it("emits no pull helpers for a program without runtime eval", async () => {
    const result = await compile(`var a = 1;\nexport function f() { a++; return a; }\n`, {
      fileName: "plain.js",
      allowJs: true,
      target: "standalone",
    } as never);
    expect(result.success).toBe(true);
    expect(functionStats(result.binary).some((f) => f.name.startsWith("__runtime_eval_pull"))).toBe(false);
  });
});
