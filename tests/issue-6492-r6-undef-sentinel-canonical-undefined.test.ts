// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 6 — an UNDEF-SENTINEL f64 boxed to `null` instead of `undefined`.
//
// `coerceType`'s f64→externref arm resolves the lane's canonical `undefined`
// through `canonicalUndefinedExternInstrs`, which is READ-ONLY by design (it
// must not register an import mid-body and shift func indices under the
// emitter) and therefore falls back to `ref.null.extern` when
// `__get_undefined` is not registered yet. On the JS-host lane that fallback
// is not a fallback — it changes the VALUE: a null externref surfaces as JS
// `null`, and `null !== undefined`.
//
// Invisible in the honest test262 lane because the harness prefix shares the
// compilation unit and imports `__get_undefined` long before any body site.
// The linked lane compiles the BODY ALONE, so a small body whose only need for
// a canonical `undefined` is this one read-back got `ref.null.extern`:
//
//   for await (let { w: [x, y, z] = [4, 5, 6] } of [{ w: [7, undefined, ] }])
//
// bound `y` and `z` to `null` (`typeof y === "object"`) where the honest lane
// bound `undefined` — 8 corpus rows under `language/statements/for-await-of/`,
// all reporting `Expected SameValue(«null», «undefined»)`.
//
// `ensureCanonicalUndefinedExtern` (#6419) already existed for exactly this;
// it just was not called from the coercion engine. It must run BEFORE
// `__box_number`'s index is read — `flushLateImportShifts` remaps emitted
// instructions, not an index already captured in a local.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-r6b-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: true,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

type Verdict = "pass" | `fail: ${string}` | `compile_error: ${string}`;
type Compiled = { verdict: Verdict; wat: string };

/**
 * Compile one body against a freshly built harness provider and RUN it.
 *
 * The WAT is returned alongside the verdict because the verdict alone is not a
 * reliable witness here: this in-process seam is not the runner's lane, and a
 * body that reads a bare `undefined` anywhere in an externref context registers
 * `__get_undefined` on its own, which repairs the very lookup under test. The
 * WAT shows the lowering directly — pre-fix the sentinel site is present and
 * the import is not.
 */
async function linkedLane(source: string): Promise<Compiled> {
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await buildHarnessProvider({
    harnessPrefix: assembly.harnessPrefix,
    cacheDir: CACHE,
    compileOptions: OPTIONS,
  });
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  const wat = (result as { wat?: string }).wat ?? "";
  if (!result.success) return { verdict: `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`, wat };
  const runtime = await import("../src/runtime.js");
  const importObject = runtime.buildImports(result.imports as never, { console }, result.stringPool as never);
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    });
    return { verdict: "pass", wat };
  } catch (error) {
    return { verdict: `fail: ${String((error as { message?: string })?.message ?? error)}`, wat };
  }
}

/** The `UNDEF_F64_BITS` pattern the sentinel arm compares against. */
const UNDEF_F64_BITS_TEXT = "9218868440963334366";

describe("#6492 r6 — an UNDEF-SENTINEL f64 boxes to `undefined`, not `null`", () => {
  // Regression guard, not a witness: this shape already resolved the import on
  // the pre-fix tree (a top-level `var` destructure registers it by another
  // route). It is kept so a future change cannot take the producer away here.
  it("resolves the real `undefined` producer at an explicit-undefined element read", async () => {
    const { verdict, wat } = await linkedLane(
      "/*---\ndescription: r6 sentinel\n---*/\n" +
        "var a = [7, undefined, ];\n" +
        "var [p, q, r] = a;\n" +
        'assert.sameValue(typeof q, "undefined", "explicit undefined element");\n' +
        'assert.sameValue(typeof r, "undefined", "missing element");\n',
    );
    expect(verdict).toBe("pass");
    // The sentinel arm is really on this path…
    expect(wat).toContain(UNDEF_F64_BITS_TEXT);
    // …and it resolves the host lane's canonical `undefined`, not the
    // `ref.null.extern` fallback (which surfaces as JS `null`).
    expect(wat).toContain("__get_undefined");
  });

  it("does the same through a for-await destructuring head (the corpus shape)", async () => {
    const { verdict, wat } = await linkedLane(
      "/*---\ndescription: r6 for-await\nfeatures: [destructuring-binding, async-iteration]\nflags: [async]\n---*/\n" +
        "async function fn() {\n" +
        "  for await (let { w: [x, y, z] = [4, 5, 6] } of [{ w: [7, undefined, ] }]) {\n" +
        '    assert.sameValue(typeof x + ":" + typeof y + ":" + typeof z, "number:undefined:undefined", "typeofs");\n' +
        "  }\n" +
        "}\n" +
        "fn().then($DONE, $DONE);\n",
    );
    expect(verdict).toBe("pass");
    expect(wat).toContain(UNDEF_F64_BITS_TEXT);
    expect(wat).toContain("__get_undefined");
  });
});
