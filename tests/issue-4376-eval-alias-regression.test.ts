// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4376 / PR #4664 — first-class `%eval%` aliases remain callable.
 *
 * Deno's primordials bootstrap stores `eval` without invoking the runtime
 * compiler, so #4376 materializes a pure-AOT wrapper for the intrinsic. The
 * wrapper is created from a synthetic SourceFile and can therefore appear
 * after a hoisted function containing `alias(source)` has already been
 * compiled. The generic dynamic-call ladder must know the wrapper signature
 * before that call site is lowered or it falls through to the non-callable
 * path.
 *
 * The first test is an engine-independent positive control over the exact
 * provider ABI. The second matrix pins all 13 ES5 Test262 files that regressed
 * in the PR transition. It self-gates because ordinary unit CI does not build
 * QuickJS; the standalone Test262 lane does and executes the literal upstream
 * harness through runTest262File.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  instantiateRuntimeEvalNamespace,
  selectCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";
import { runTest262File } from "./test262-runner.js";

const REGRESSION_FILES = [
  "test/language/statements/variable/12.2.1-20-s.js",
  "test/built-ins/Function/15.3.5.4_2-14gs.js",
  "test/language/statements/variable/12.2.1-22-s.js",
  "test/language/function-code/10.4.3-1-20gs.js",
  "test/language/eval-code/indirect/global-env-rec.js",
  "test/language/eval-code/indirect/global-env-rec-fun.js",
  "test/language/statements/variable/12.2.1-10-s.js",
  "test/language/statements/variable/12.2.1-21-s.js",
  "test/language/function-code/10.4.3-1-20-s.js",
  "test/language/function-code/10.4.3-1-19-s.js",
  "test/language/function-code/10.4.3-1-19gs.js",
  "test/language/eval-code/indirect/global-env-rec-catch.js",
  "test/language/statements/variable/12.2.1-9-s.js",
] as const;

function stubProviderSource(): string {
  return `
    function result(ok: boolean, value: any): any {
      const envelope: any[] = [ok, __runtime_eval_wrap_result(value)];
      return envelope;
    }
    function refuse(): any { return result(false, new TypeError("unexpected provider entry")); }
    export function __runtime_indirect_eval(source: any, globalObject: any): any {
      return result(true, source === "forty-two" ? 42 : -1);
    }
    export function __runtime_direct_eval(
      source: any, globalObject: any, thisArg: any, activationState: any,
      activationSeedNames: any, activationSeedSlots: any, lexicalNames: any,
      lexicalSlots: any, outerNames: any, outerSlots: any,
      callerStrict: boolean, mappedParamNames: any
    ): any { return refuse(); }
    export function __runtime_new_function(params: any, body: any, globalObject: any): any {
      return refuse();
    }
    export function __runtime_apply_interpreted(
      callable: any, receiver: any, argc: number,
      a0: any, a1: any, a2: any, a3: any,
      a4: any, a5: any, a6: any, a7: any
    ): any { return refuse(); }
  `;
}

describe("#4376 — first-class eval alias dispatch", () => {
  let providerModule: WebAssembly.Module;

  beforeAll(async () => {
    const provider = await compile(stubProviderSource(), {
      ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
      fileName: "issue-4376-eval-alias-provider.ts",
    });
    expect(provider.success, JSON.stringify(provider.errors)).toBe(true);
    providerModule = new WebAssembly.Module(provider.binary);
  }, 120_000);

  it("calls the provider only when a stored eval alias is invoked", { timeout: 120_000 }, async () => {
    const user = await compile(
      `
        var indirectEval: any = eval;
        function source(): string {
          var parts: string[] = ["forty", "-two"];
          return parts[0] + parts[1];
        }
        export function probe(): number { return indirectEval(source()) as number; }
      `,
      { target: "standalone", experimentalIR: false },
    );
    expect(user.success, JSON.stringify(user.errors)).toBe(true);
    const module = new WebAssembly.Module(user.binary);
    expect(WebAssembly.Module.imports(module).map(({ module, name }) => `${module}::${name}`)).toContain(
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_indirect_eval`,
    );
    const instance = new WebAssembly.Instance(module, {
      [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(providerModule),
    });
    expect((instance.exports as { probe(): number }).probe()).toBe(42);
  });
});

let liveQuickjsAvailable = false;
try {
  liveQuickjsAvailable =
    existsSync(resolve("test262", REGRESSION_FILES[0])) && selectCachedRuntimeEvalProvider().engine === "quickjs";
} catch {
  liveQuickjsAvailable = false;
}

describe.skipIf(!liveQuickjsAvailable)("#4376 — ES5 indirect-eval alias Test262 matrix", () => {
  for (const file of REGRESSION_FILES) {
    it(file, { timeout: 120_000 }, async () => {
      const result = await runTest262File(resolve("test262", file), "issue-4376-eval-alias", 120_000, "standalone");
      expect(result.status, result.error).toBe("pass");
    });
  }
});
