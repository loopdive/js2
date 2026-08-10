// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4305 — `RuntimeError: illegal cast` when a catch clause READS its parameter
 * after a direct `eval` has run in the same function.
 *
 * Root cause (caller-side codegen, engine-independent):
 * `fctx.boxedCaptures` is keyed by NAME but describes one specific SLOT — "this
 * local holds a `(mut externref)` ref cell, deref field 0 to read the value".
 * A direct-eval call site promotes every eval-visible binding to such a cell
 * (`reifyCurrentDirectEvalBindings`), and `collectDirectEvalBindingNames`
 * counts catch-clause parameters among them. A catch clause then rebinds that
 * name to a FRESH plain externref local holding the raw exception payload, but
 * used to leave the stale cell entry in place — so `identifiers.ts` emitted
 * `ref.cast $cell` + `struct.get` against a `TypeError`, which traps.
 *
 * `saveBlockScopedShadows` already performs exactly this save/delete/restore
 * for block-scoped `let`/`const` shadows; the catch parameter was the one
 * binding form that did not.
 *
 * The tests below use a js2wasm-compiled STUB provider for the frozen 4-import
 * `js2wasm:runtime-eval` seam, so no interpreter / QuickJS artifact is needed
 * and the reproduction is engine-independent by construction. Liveness of the
 * provider route is asserted two ways: the compiled user module must carry the
 * `__runtime_direct_eval` import, and the expected values are only reachable if
 * the provider's `[ok, value]` envelope actually surfaced (a statically folded
 * or stubbed-to-`undefined` eval produces a different number).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  instantiateRuntimeEvalNamespace,
} from "../scripts/runtime-eval-provider.mjs";

type AnyExports = Record<string, () => number>;

async function compileStandalone(source: string, fileName: string): Promise<Uint8Array> {
  const result = await compile(source, { ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS, fileName });
  if (!result.success || !result.binary) {
    throw new Error(`compile failed for ${fileName}: ${JSON.stringify((result.errors ?? []).slice(0, 5))}`);
  }
  return result.binary;
}

/**
 * Six-line direct-eval body over the same envelope ABI as the real provider.
 * `succeedFirst` picks whether entry #1 answers `[true, 10]` (the issue's
 * succeeded-then-threw sequence) or refuses like every later entry.
 */
function stubProviderSource(succeedFirst: boolean): string {
  return `
    function runtimeEvalResult(ok: boolean, value: any): any {
      const result: any[] = [ok, __runtime_eval_wrap_result(value)];
      return result;
    }
    function refuse(): any {
      return runtimeEvalResult(false, new TypeError("stub refusal (#4305)"));
    }
    var directCalls = 0;
    export function __runtime_direct_eval(
      source: any, globalObject: any, thisArg: any, activationState: any,
      activationSeedNames: any, activationSeedSlots: any, lexicalNames: any,
      lexicalSlots: any, outerNames: any, outerSlots: any,
      callerStrict: boolean, mappedParamNames: any
    ): any {
      directCalls = directCalls + 1;
      if (directCalls === 1 && ${succeedFirst ? "true" : "false"}) return runtimeEvalResult(true, 10);
      return refuse();
    }
    export function __runtime_indirect_eval(source: any, globalObject: any): any { return refuse(); }
    export function __runtime_new_function(p: any, b: any, g: any): any { return refuse(); }
    export function __runtime_apply_interpreted(
      callable: any, receiver: any, argc: number,
      a0: any, a1: any, a2: any, a3: any, a4: any, a5: any, a6: any, a7: any
    ): any { return refuse(); }
  `;
}

/** A literal eval argument is constant-folded by `tryStaticEvalInline` and
 *  never reaches the provider, so every source below is composed at runtime. */
const PRELUDE = `
  function makeSource(n: number): string {
    let s = "";
    for (let i = 0; i < n; i = i + 1) s = s + "1";
    return s;
  }
`;

const CASES: { name: string; succeedFirst: boolean; needsProvider: boolean; body: string; expected: number }[] = [
  {
    // The reported shape: a succeeding direct eval, then a throwing one whose
    // catch tests `instanceof`. Traps with `illegal cast` before the fix.
    name: "succeeding direct eval, then a throwing one caught with instanceof",
    succeedFirst: true,
    needsProvider: true,
    body: `
      let r = 0;
      try { r = eval(makeSource(1)); } catch (e) { r = -1; }
      try { eval(makeSource(2)); r = r + 1000; } catch (e) { if (e instanceof TypeError) r = r + 100; else r = r + 500; }
      return r;`,
    expected: 110,
  },
  {
    // Minimal root-cause shape: ONE direct eval, between two catches of the
    // same name, the second of which reads its parameter. No second eval and
    // no eval result involved — isolates the stale cell metadata.
    name: "catch, then a direct eval, then a catch that reads its parameter",
    succeedFirst: true,
    needsProvider: true,
    body: `
      let r = 0;
      try { r = 1; } catch (e) { r = -1; }
      eval(makeSource(1));
      try { throw new TypeError("boom"); } catch (e) { if (e instanceof TypeError) r = r + 100; else r = r + 500; }
      return r;`,
    expected: 101,
  },
  {
    // Refusal path: EVERY eval throws. Both catches must still observe a
    // typed, catchable TypeError.
    name: "refusal path — both direct evals throw, both catches read the parameter",
    succeedFirst: false,
    needsProvider: true,
    body: `
      let r = 0;
      try { eval(makeSource(1)); r = r + 1000; } catch (e) { if (e instanceof TypeError) r = r + 10; }
      try { eval(makeSource(2)); r = r + 1000; } catch (e) { if (e instanceof TypeError) r = r + 100; }
      return r;`,
    expected: 110,
  },
  {
    // A direct eval INSIDE a catch body legitimately promotes the parameter to
    // a cell; the read after it must go through that cell, not the raw slot.
    name: "direct eval inside a catch body, parameter read afterwards",
    succeedFirst: true,
    needsProvider: true,
    body: `
      let r = 0;
      try {
        throw new TypeError("boom");
      } catch (e) {
        try { eval(makeSource(1)); } catch (inner) { r = r + 7; }
        if (e instanceof TypeError) r = r + 100; else r = r + 500;
      }
      return r;`,
    expected: 100,
  },
  {
    // Control: the same two-catch shape with NO eval anywhere. Proves the fix
    // leaves the ordinary no-eval path alone (and that the failure above is
    // not "two catches reading their parameter" on its own).
    name: "no-eval control — two catches reading their parameter",
    succeedFirst: true,
    needsProvider: false,
    body: `
      let r = 0;
      try { throw new RangeError("a"); } catch (e) { if (e instanceof RangeError) r = r + 10; }
      try { throw new TypeError("b"); } catch (e) { if (e instanceof TypeError) r = r + 100; }
      return r;`,
    expected: 110,
  },
];

describe("#4305 — catch parameter read after a direct eval", () => {
  const stubs: Record<string, WebAssembly.Module> = {};

  beforeAll(async () => {
    for (const succeedFirst of [true, false]) {
      const key = String(succeedFirst);
      stubs[key] = new WebAssembly.Module(
        await compileStandalone(stubProviderSource(succeedFirst), `stub-provider-4305-${key}.ts`),
      );
    }
  }, 600_000);

  for (const testCase of CASES) {
    it(testCase.name, { timeout: 600_000 }, async () => {
      const source = `${PRELUDE}\nexport function probe(): number {${testCase.body}\n}`;
      const module = new WebAssembly.Module(await compileStandalone(source, "user-4305.ts"));
      const importNames = WebAssembly.Module.imports(module).map((entry) => entry.name);
      // Liveness: without this the case could "pass" through a statically
      // inlined eval that never consults the provider at all.
      if (testCase.needsProvider) expect(importNames).toContain("__runtime_direct_eval");
      else expect(importNames).not.toContain("__runtime_direct_eval");

      const instance = new WebAssembly.Instance(module, {
        [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(stubs[String(testCase.succeedFirst)]!),
      });
      expect((instance.exports as AnyExports).probe()).toBe(testCase.expected);
    });
  }
});
