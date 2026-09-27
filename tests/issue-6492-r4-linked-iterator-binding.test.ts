// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 4 — the linked lane dropped the `%Iterator%` binding stratum.
//
// `assembleVariant` (honest) appends `ITERATOR_BINDING_PREAMBLE` — a local
// `function Iterator() {}` whose `.prototype` is %IteratorPrototype% — whenever
// the body mentions `Iterator` without declaring it, because js2 exposes no
// global `Iterator` constructor. `assembleLinkedVariant` never did, so in the
// linked lane `typeof Iterator` was `undefined` and every `class T extends
// Iterator` / `Iterator.prototype.<helper>` row failed in a way the honest lane
// never sees. Measured with the real runner over `built-ins/Iterator/` (654
// rows, both lanes): 124 honest-pass/linked-fail before, 4 after; honest lane
// unchanged (0 verdict differences over the same 654 rows).
//
// The stratum belongs to the BODY unit, not the harness prefix: the prefix is
// the provider's cache key, so putting it there would fork the provider
// per-test and destroy the compile-once property the linked lane exists for.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { assembleLinkedHarness, assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-r4-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = "/*---\ndescription: r4\nfeatures: [iterator-helpers]\n---*/\n";

type Verdict = "pass" | `fail: ${string}` | `compile_error: ${string}`;

async function run(result: {
  success: boolean;
  errors?: { message: string }[];
  binary?: Uint8Array;
  imports?: unknown;
  stringPool?: unknown;
  linkedModules?: unknown[];
}): Promise<Verdict> {
  if (!result.success) return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  const runtime = await import("../src/runtime.js");
  const importObject = runtime.buildImports(result.imports as never, { console }, result.stringPool as never);
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error)}`;
  }
}

/**
 * The LINKED verdict for one body.
 *
 * Deliberately no honest column here: this file's instantiate seam is not the
 * runner's honest lane (no per-row sandbox realm), and in it the preamble's own
 * `[][Symbol.iterator]()` read fails — the honest column would report
 * `[object Object] is not iterable` for bodies the real honest lane passes.
 * Honest parity for this change is measured where it is real, with the runner:
 * `built-ins/Iterator/`, 654 rows, 342 honest passes before AND after, 0
 * verdict differences.
 */
async function linkedLane(body: string): Promise<Verdict> {
  const source = HEADER + body;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await buildHarnessProvider({
    harnessPrefix: assembly.harnessPrefix,
    cacheDir: CACHE,
    compileOptions: OPTIONS,
  });
  return run(
    await compileHarnessLinkedBody(provider, assembly.primary.body, {
      ...OPTIONS,
      strict: assembly.primary.strict,
    }),
  );
}

describe("#6492 r4 — linked lane carries the %Iterator% binding stratum", () => {
  it("adds the binding to the linked body exactly when the honest assembly adds it", () => {
    const needs = `${HEADER}var it = Object.create(Iterator.prototype);\n`;
    const declares = `${HEADER}class Iterator {}\nvar it = new Iterator();\n`;
    const absent = `${HEADER}assert.sameValue(1, 1);\n`;

    for (const [source, expected] of [
      [needs, true],
      [declares, false],
      [absent, false],
    ] as const) {
      const meta = parseMeta(source);
      const linked = assembleLinkedHarness(source, meta);
      const honest = assembleOriginalHarness(source, meta);
      // Same gate, same direction, in both assemblers.
      expect(/function Iterator\(\) \{\}/.test(linked.primary.bodySource)).toBe(expected);
      expect(/function Iterator\(\) \{\}/.test(honest.primary.source)).toBe(expected);
      // The untouched upstream body is still the tail of the compile unit.
      expect(linked.primary.bodySource.endsWith(source)).toBe(true);
    }
  });

  it("keeps bodyLineOffset exact so body error lines still map", () => {
    const source = `${HEADER}var it = Object.create(Iterator.prototype);\n`;
    const { primary } = assembleLinkedHarness(source, parseMeta(source));
    // `bodyLineOffset` counts every line the compile unit puts BEFORE the
    // untouched upstream body — the directive and the binding stratum alike —
    // which is what the worker's body error-line mapping subtracts.
    const prepended = primary.bodySource.slice(0, primary.bodySource.length - source.length);
    expect(prepended).toContain("function Iterator() {}");
    expect(primary.bodyLineOffset).toBe(prepended.split("\n").length - 1);
  });

  it("`typeof Iterator` is 'function' in the linked lane (was 'undefined')", async () => {
    const linked = await linkedLane(
      `if (typeof Iterator !== "function") { throw new Error("no Iterator: " + typeof Iterator); }`,
    );
    expect(linked).toBe("pass");
  }, 600_000);

  it("`class T extends Iterator` subclasses the intrinsic in the linked lane", async () => {
    // `built-ins/Iterator/subclassable.js` verbatim shape. Without the stratum
    // the linked consumer extends `undefined`, which is where the bucket's
    // `(new SubIterator() instanceof Iterator) is false` and the downstream
    // `reading 'next' of null` rows came from.
    const linked = await linkedLane(
      `class SubIterator extends Iterator {}\n` +
        `if (!(new SubIterator() instanceof Iterator)) { throw new Error("not an Iterator"); }`,
    );
    expect(linked).toBe("pass");
  }, 600_000);
});
