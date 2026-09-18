// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 6 — `LIB_GLOBALS` missed the lib.es5 `declare function` globals.
//
// `LIB_GLOBALS` / `sourceUsesLibGlobals` is the GATE that decides whether
// `collectDeclaredGlobals` runs at all. A compile unit whose only lib-global
// reference is `eval` / `parseInt` / `isNaN` / … skipped the pass entirely, so
// `ctx.declaredGlobals` never learned the name — and `calleeMayBeHostCallable`
// (via `isDeclaredHostGlobal`) then answered false, which SUPPRESSES the
// `__call_function` host arm at the call site. A first-class read
// (`var s = eval`) holds a real host function while the dispatch has only the
// closure-struct path, so the guarded `ref.test` nulls and `struct.get` TRAPS:
// `dereferencing a null pointer`, uncatchable.
//
// Invisible in the honest test262 lane because the harness prefix shares the
// compilation unit and names `Array`/`Object`/`String` in its first lines, so
// the gate always fired. The linked lane compiles the BODY ALONE, and a
// body-only unit can genuinely reference nothing else — which is why six rows
// (four `variable/12.2.1-*-s.js`, `Function/15.3.5.4_2-14gs.js`,
// `eval-code/indirect/global-env-rec-fun.js`) were in the #3189 TRAP residual.
//
// The `EvalError` note in `LIB_GLOBALS` records the same failure mode for the
// ambient CONSTRUCTORS; this is its `declare function` half.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { sourceUsesLibGlobals } from "../src/codegen/extern-declarations.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import { ts } from "../src/ts-api.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6492-r6-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = "/*---\ndescription: r6\n---*/\n";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("probe.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
}

type Verdict = "pass" | `fail: ${string}` | `compile_error: ${string}`;

async function linkedLane(body: string): Promise<Verdict> {
  const source = HEADER + body;
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

describe("#6492 r6 — the lib-globals gate admits the ambient callable globals", () => {
  it("fires for a unit whose ONLY lib global is an ambient `declare function`", () => {
    // Each of these used to skip `collectDeclaredGlobals` entirely.
    for (const name of [
      "eval",
      "parseInt",
      "parseFloat",
      "isNaN",
      "isFinite",
      "decodeURI",
      "decodeURIComponent",
      "encodeURI",
      "encodeURIComponent",
    ]) {
      expect(sourceUsesLibGlobals(parse(`var f = ${name};\n`)), name).toBe(true);
    }
  });

  it("still declines a unit that references no lib global at all", () => {
    // The gate stays a gate: admitting everything would run the lib scan on
    // every compile and is not what this change does.
    expect(sourceUsesLibGlobals(parse("var a = 1; function f(b) { return b + a; } f(2);\n"))).toBe(false);
    expect(sourceUsesLibGlobals(parse("var notEval = 1; var evaluate = notEval;\n"))).toBe(false);
  });

  it("indirect eval no longer traps in the linked lane", async () => {
    // The exact minimal repro of the six-row trap bucket. `typeof s` already
    // answered "function" before the fix — it is the CALL that trapped.
    expect(
      await linkedLane('var s = eval;\nassert.sameValue(typeof s, "function");\nassert.sameValue(s("1+1"), 2);\n'),
    ).toBe("pass");
  });

  it("an ambient callable global read as a VALUE is not null in the linked lane", async () => {
    expect(
      await linkedLane(
        'var p = parseInt;\nassert.sameValue(p === null, false, "parseInt === null");\nassert.sameValue(p("42"), 42);\n',
      ),
    ).toBe("pass");
  });
});
