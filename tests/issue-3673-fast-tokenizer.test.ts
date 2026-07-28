/**
 * #3673 — the compile-friendly tokenizer's token stream must stay EXACTLY
 * equal to `acorn.tokenizer`'s on the corpus files it claims to cover.
 *
 * The benchmark in `benchmarks/tokenizer/` is only meaningful while this holds:
 * it is the evidence for the round-31 claim that js2wasm-compiled code can
 * outperform node-acorn when the source is written for the compiler. A silent
 * tokenizer divergence would turn that into a comparison of two different
 * computations, so the equality is pinned here rather than left to the
 * benchmark's own report.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { setupAcorn } from "./dogfood/setup-acorn.mjs";
import { tokenize } from "../benchmarks/tokenizer/fast-tokenizer.ts";

/** The corpus files whose streams the tokenizer covers exactly (see its header). */
const COVERED = [
  "arrow-params.js",
  "control-flow.js",
  "destructuring.js",
  "generators-async.js",
  "loops.js",
  "members-calls.js",
  "new-target.js",
  "objects.js",
  "operators.js",
  "optional-nullish.js",
  "regex.js",
  "sequence-misc.js",
  "spread-rest.js",
];

/** Constructs it deliberately simplifies — pinned so the gap stays visible. */
const NOT_COVERED = ["classes.js", "escapes-unicode.js", "literals.js", "templates.js"];

const CORPUS = join(import.meta.dirname, "dogfood", "corpus");

async function acornTokens(src: string): Promise<string[]> {
  const { entryModulePath } = setupAcorn();
  const acorn = (await import(pathToFileURL(entryModulePath).href)) as {
    tokenizer: (s: string, o: unknown) => Iterable<{ start: number; end: number; type: { label: string } }>;
  };
  return [...acorn.tokenizer(src, { ecmaVersion: 2023 })]
    .filter((t) => t.type.label !== "eof")
    .map((t) => `${t.start}:${t.end}`);
}

function ownTokens(src: string): string[] {
  const types = new Int32Array(65536);
  const starts = new Int32Array(65536);
  const ends = new Int32Array(65536);
  const n = tokenize(src, types, starts, ends);
  return Array.from({ length: n }, (_, i) => `${starts[i]}:${ends[i]}`);
}

describe("#3673 — compile-friendly tokenizer vs acorn.tokenizer", () => {
  for (const file of COVERED) {
    it(`matches acorn's token stream exactly on ${file}`, async () => {
      const src = readFileSync(join(CORPUS, file), "utf-8");
      expect(ownTokens(src)).toEqual(await acornTokens(src));
    });
  }

  it("still diverges on the constructs it documents as out of scope", async () => {
    // Not a wish — a pin. If one of these starts matching, the tokenizer grew
    // coverage and belongs in COVERED (and in the benchmark's file list).
    const diverging: string[] = [];
    for (const file of NOT_COVERED) {
      const src = readFileSync(join(CORPUS, file), "utf-8");
      let ref: string[];
      try {
        ref = await acornTokens(src);
      } catch {
        continue; // acorn itself refuses the file — nothing to compare
      }
      if (JSON.stringify(ownTokens(src)) !== JSON.stringify(ref)) diverging.push(file);
    }
    expect(diverging.sort()).toEqual([...NOT_COVERED].sort());
  });
});
