// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 6 — a HOST-thrown exception lost its value crossing wasm→wasm.
//
// A wasm `catch_all` cannot see the thrown JS value; it recovers it by calling
// the `caught_exception` import, which reads the runtime's "last host
// exception" latch. That latch was written per IMPORT OBJECT — i.e. by the
// module whose own host import threw. Within one module that is the same
// object, which is why this held for the compiler's entire single-module
// history.
//
// A linked graph has two import objects. The provider calls a consumer
// closure, a throwing host import inside the consumer (`__throw_reference_error`
// and friends) raises a real JS error, and it propagates wasm→wasm as a JS
// exception. The provider's `catch_all` then asked ITS OWN latch, which nothing
// had written, and got `undefined` — so the harness reported
// `Thrown value was not an object!` for a throw the CONSUMER catches perfectly
// (`typeof e === "object"`, `[object Error]`, `name === "ReferenceError"`).
//
// A WASM-thrown error was never affected: it travels in the shared `env.__exn`
// tag (#5226) and the catching module reads the payload off the tag, never off
// this latch. That asymmetry is the whole diagnosis, and the two cases below
// are deliberately the same shape apart from it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-r6c-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

type Verdict = "pass" | `fail: ${string}` | `compile_error: ${string}`;

async function linkedLane(source: string): Promise<Verdict> {
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
  if (!result.success) return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  const importObject = buildImports(result.imports as never, { console }, result.stringPool as never);
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

const HEADER = "/*---\ndescription: r6 cross-module throw\n---*/\n";

describe("#6492 r6 — a host-thrown error keeps its value across the linked boundary", () => {
  it("the provider's assert.throws sees the object for a HOST-thrown error", async () => {
    // `undeclaredXyz` lowers to the throwing host import, and the closure is
    // held in a `var` so the provider reaches it through the closure-value
    // dispatch rather than as an inline callback argument.
    expect(
      await linkedLane(
        `${HEADER}var g = function () { undeclaredXyz; };\nassert.throws(ReferenceError, g, "host-thrown");\n`,
      ),
    ).toBe("pass");
  });

  it("…and the TDZ shape the corpus rows use", async () => {
    // `language/statements/for-{in,of}/scope-{head,body}-lex-{open,close}.js`
    // reduced to three lines.
    expect(
      await linkedLane(
        `${HEADER}var f;\nfor (let x of (f = function () { typeof x; }, [])) ;\nassert.throws(ReferenceError, f, "for-of head TDZ");\n`,
      ),
    ).toBe("pass");
  });

  it("the WASM-thrown twin was already correct and stays correct", async () => {
    // Same shape, different throw mechanism: this one rides the shared
    // `env.__exn` tag and never consulted the latch. It is the control that
    // makes the diagnosis falsifiable.
    expect(
      await linkedLane(
        `${HEADER}var h = function () { throw new ReferenceError("x"); };\nassert.throws(ReferenceError, h, "wasm-thrown");\n`,
      ),
    ).toBe("pass");
  });
});
