// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3451 slice 3, P1 — the compile-once Test262 harness provider.
//
// The one property this asserts that nothing else can: EVERY top-level harness
// binding crosses the module boundary as a GETTER. A non-getter boundary is a
// direct function import, which hands the consumer something callable but not
// the VALUE — `Test262Error` imported that way could be called but never used
// as a constructor, compared for identity, or passed to `assert.throws`. The
// provider builder throws on that, and this test is what proves the assertion
// is reachable on the real `assert.js + sta.js` prefix rather than only on a
// synthetic one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildHarnessProvider,
  harnessBindingPrelude,
  harnessExportAlias,
  harnessProviderCacheKey,
  harnessTopLevelNames,
} from "../src/test262-harness-provider.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-harness-provider-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

/**
 * The authoritative default prefix (runner shim + `assert.js` + `sta.js`),
 * taken from the runner's OWN split rather than reassembled here — including
 * its top-level-function dedupe, which changes the text and therefore the key.
 */
const PREFIX = assembleLinkedHarness("assert.sameValue(1, 1);", parseMeta("assert.sameValue(1, 1);")).harnessPrefix;

describe("#3451 P1 — harness provider", () => {
  it("publishes every top-level harness binding as a getter boundary", async () => {
    const provider = await buildHarnessProvider({ harnessPrefix: PREFIX, cacheDir: CACHE });
    const names = harnessTopLevelNames(PREFIX);
    expect(names.length).toBeGreaterThan(0);
    // `assert` and `Test262Error` are the two the whole corpus depends on; if
    // the set ever silently shrinks to nothing this keeps the test honest.
    expect(names).toContain("assert");
    expect(names).toContain("Test262Error");
    // The builder throws on a non-getter boundary, so reaching here already
    // proves it — asserted explicitly so a future relaxation of the builder
    // does not quietly weaken the contract.
    const missing = names.filter((name) => !provider.getters.has(name));
    expect(missing).toEqual([]);
    for (const name of names) {
      expect(provider.artifact.exportBoundaries?.[harnessExportAlias(name)]?.kind).toBe("getter");
    }
  }, 180_000);

  it("serves the second build from the memory cache under one key", async () => {
    const key = harnessProviderCacheKey({ harnessPrefix: PREFIX });
    const again = await buildHarnessProvider({ harnessPrefix: PREFIX, cacheDir: CACHE });
    expect(again.cacheHit).toBe(true);
    expect(again.buildMs).toBe(0);
    // A different prefix must not collide with it — the key is content-addressed.
    expect(harnessProviderCacheKey({ harnessPrefix: `${PREFIX}\nvar extra = 1;` })).not.toBe(key);
  }, 180_000);

  it("binds only the harness names a body actually references", async () => {
    const provider = await buildHarnessProvider({ harnessPrefix: PREFIX, cacheDir: CACHE });
    const sloppy = harnessBindingPrelude(provider, "assert.sameValue(1, 1);", false);
    expect(sloppy.names).toContain("assert");
    // `compareArray` is not referenced, so paying an import + getter call for
    // it would be waste on every one of ~43k rows.
    expect(sloppy.names).not.toContain("compareArray");
    expect(sloppy.prelude.startsWith("import ")).toBe(true);

    // The strict directive must lead — a `"use strict"` after the import is
    // not a directive prologue at all, so the strict variant would silently
    // run sloppy.
    const strict = harnessBindingPrelude(provider, "assert.sameValue(1, 1);", true);
    expect(strict.prelude.startsWith('"use strict";\n')).toBe(true);
    expect(strict.preludeLines).toBe(sloppy.preludeLines + 1);
  }, 180_000);
});
