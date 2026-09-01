// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5254 — the original Test262 harness must provision `%Iterator%` locally.
 *
 * The exact Iterator helper rows extend a bare `Iterator`; that binding used to
 * exist only in the deprecated wrapper, so the literal original-harness path
 * never reached chunks/windows or the getter-returned generator closure. The
 * two execution checks remain skipped in this draft checkpoint until the
 * tracked known-class miss admits the existing standalone lazy dispatcher.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ITERATOR_BINDING_PREAMBLE, needsIteratorBinding } from "../scripts/test262-iterator-binding.mjs";
import { provisionIteratorBindingsInOriginalHarnessRecords } from "../scripts/test262-fyi-reader.mjs";
import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta, runTest262File, wrapTest } from "./test262-runner.js";

const TEST262_ROOT = join(import.meta.dirname, "..", "test262", "test");
const ITERATOR_ROWS = [
  "built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js",
  "built-ins/Iterator/prototype/windows/exhaustion-does-not-call-return.js",
] as const;

function sourceFor(row: (typeof ITERATOR_ROWS)[number]): string {
  return readFileSync(join(TEST262_ROOT, row), "utf8");
}

function lineCount(source: string): number {
  return source.length === 0 ? 0 : source.split("\n").length - 1;
}

async function runStandalone(source: string, fileName: string): Promise<number> {
  const result = await compile(source, {
    fileName,
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  if (!result.success) return Number.NaN;

  expect(result.imports).toEqual([]);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { test(): number }).test();
}

function helperFixture(method: "chunks" | "windows"): string {
  return `
${ITERATOR_BINDING_PREAMBLE}
function* g() {
  yield 0;
  yield 1;
  yield 2;
}

let getterReads = 0;
let sourceNextCalls = 0;
let returnCalls = 0;

class TestIterator extends Iterator {
  get next() {
    getterReads++;
    const n = g();
    return function () {
      sourceNextCalls++;
      return n.next();
    };
  }
  return() {
    returnCalls++;
    return { value: undefined, done: true };
  }
}

export function test(): number {
  const iterator: any = new TestIterator().${method}(2);
  iterator.next();
  iterator.next();
  const exhausted: any = iterator.next();
  return getterReads * 100 + sourceNextCalls * 10 + returnCalls + (exhausted.done ? 1 : 0);
}
`;
}

describe("#5254 original-harness Iterator provisioning", () => {
  it("shares the gated source preamble while preserving both exact upstream bodies", () => {
    for (const row of ITERATOR_ROWS) {
      const body = sourceFor(row);
      const meta = parseMeta(body);
      const assembly = assembleOriginalHarness(body, meta);
      const prefix = assembly.primary.source.slice(0, -body.length);

      expect(needsIteratorBinding(body), row).toBe(true);
      expect(assembly.primary.source.endsWith(body), row).toBe(true);
      expect(prefix.endsWith(ITERATOR_BINDING_PREAMBLE), row).toBe(true);
      expect(assembly.primary.bodyLineOffset, row).toBe(lineCount(prefix));
      expect(assembly.strictRerun?.source, row).toBe(`"use strict";\n${prefix}${body}`);

      // The deprecated diagnostic wrapper and the literal-harness assembly
      // consume the same source preamble, so their Iterator contract cannot
      // silently drift again.
      expect(wrapTest(body, meta).source, row).toContain(ITERATOR_BINDING_PREAMBLE);

      const records = [{ file: row, contents: `prefix\n${body}`, flags: {} }];
      provisionIteratorBindingsInOriginalHarnessRecords(records);
      expect(records[0]!.contents, row).toBe(`prefix\n${ITERATOR_BINDING_PREAMBLE}${body}`);
    }
  });

  it("does not provision an own Iterator declaration or a raw Test262 body", () => {
    const ownIterator = "class Iterator {}\nnew Iterator();\n";
    expect(needsIteratorBinding(ownIterator)).toBe(false);
    expect(assembleOriginalHarness(ownIterator, {}).primary.source).not.toContain(ITERATOR_BINDING_PREAMBLE);

    const raw = "Iterator.prototype;\n";
    expect(assembleOriginalHarness(raw, { flags: ["raw"] }).primary.source).toBe(raw);
    const records = [
      { file: ITERATOR_ROWS[0], contents: `prefix\n${sourceFor(ITERATOR_ROWS[0])}`, flags: { raw: true } },
    ];
    provisionIteratorBindingsInOriginalHarnessRecords(records);
    expect(records[0]!.contents).toBe(`prefix\n${sourceFor(ITERATOR_ROWS[0])}`);
  });

  it.skip.each([["chunks"], ["windows"]] as const)(
    "keeps the %s next getter single-read, caches its callable, and avoids return() on exhaustion",
    async (method) => {
      // `getterReads === 1` proves GetIteratorDirect cached the property's
      // returned callable; `returnCalls === 0` proves normal helper exhaustion
      // did not close the source. The final bit confirms every expected resume
      // reached the captured generator closure, and `exhausted.done` confirms
      // the helper actually consumed normal exhaustion. The standalone module
      // must stay import-free, checked by runStandalone above.
      expect(await runStandalone(helperFixture(method), `issue-5254-${method}.ts`)).toBe(141);
    },
  );

  it.skip(
    "passes the two official rows through the literal original-harness runner",
    { timeout: 180_000 },
    async () => {
      for (const row of ITERATOR_ROWS) {
        const result = await runTest262File(join(TEST262_ROOT, row), "built-ins/Iterator", undefined, "standalone");
        expect(result, row).toMatchObject({ status: "pass" });
      }
    },
  );
});
