// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4309 — a sloppy direct `eval` in a `let`/`const` loop's per-iteration scope
 * was routed to the INDIRECT provider entry.
 *
 * `directEvalRunsAtScriptGlobal` (`src/codegen/expressions/calls.ts`) decides
 * whether a sloppy direct eval's LexicalEnvironment is already the realm global
 * record; when it is, the call is lowered to `__runtime_indirect_eval` instead
 * of manufacturing an empty AOT activation record (#2929 — the private record
 * would hide B.3.3 global properties). It answers that by walking to the script
 * root and stopping at every node that installs a LexicalEnvironment.
 *
 * The stopping set listed `ts.isBlock`, so `for (let i = 0; …) { eval(s) }` was
 * classified correctly — but §14.7.4.2 CreatePerIterationEnvironment /
 * §14.7.5.6 ForIn/OfBodyEvaluation install that record around the WHOLE
 * statement, head included, and independently of whether the body is braced.
 * So `for (let i = 0; …) eval(s)` (and a call in the head/test/increment, and
 * the `for-in`/`for-of` forms) walked past a real declarative record to the
 * source file and was mis-lowered to indirect eval.
 *
 * A `var` head is deliberately NOT in the set: it installs no record, and
 * re-routing it would move a B.3.3 global publication into the provider-private
 * record the shim exists to avoid.
 *
 * The tests link a js2wasm-compiled STUB provider over the frozen 4-import
 * `js2wasm:runtime-eval` seam, so the assertion is on the LOWERING and needs no
 * engine: the direct entry answers 111, the indirect entry answers 222. Both
 * the module's import list and the observed answer are checked, so a case
 * cannot pass by folding the eval away — every source is composed at runtime
 * (`tryStaticEvalInline` folds a literal argument and never reaches a provider).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { RUNTIME_EVAL_IMPORT_MODULE, instantiateRuntimeEvalNamespace } from "../scripts/runtime-eval-provider.mjs";

/** Script goal, sloppy — the lane every `language/eval-code/` test compiles in. */
const COMPILE_OPTIONS = {
  target: "standalone",
  experimentalIR: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const DIRECT_ANSWER = 111;
const INDIRECT_ANSWER = 222;

async function compileStandalone(source: string, fileName: string): Promise<Uint8Array> {
  const result = await compile(source, { ...COMPILE_OPTIONS, fileName });
  if (!result.success || !result.binary) {
    throw new Error(`compile failed for ${fileName}: ${JSON.stringify((result.errors ?? []).slice(0, 5))}`);
  }
  return result.binary;
}

/** Two distinguishable entries over the frozen seam — no engine, no parser. */
const STUB_PROVIDER_SOURCE = `
  function runtimeEvalResult(ok: boolean, value: any): any {
    const result: any[] = [ok, __runtime_eval_wrap_result(value)];
    return result;
  }
  function refuse(): any { return runtimeEvalResult(false, new TypeError("stub refusal (#4309)")); }
  export function __runtime_direct_eval(
    source: any, globalObject: any, thisArg: any, activationState: any,
    activationSeedNames: any, activationSeedSlots: any, lexicalNames: any,
    lexicalSlots: any, outerNames: any, outerSlots: any,
    callerStrict: boolean, mappedParamNames: any
  ): any { return runtimeEvalResult(true, ${DIRECT_ANSWER}); }
  export function __runtime_indirect_eval(source: any, globalObject: any): any {
    return runtimeEvalResult(true, ${INDIRECT_ANSWER});
  }
  export function __runtime_new_function(p: any, b: any, g: any): any { return refuse(); }
  export function __runtime_apply_interpreted(
    callable: any, receiver: any, argc: number,
    a0: any, a1: any, a2: any, a3: any, a4: any, a5: any, a6: any, a7: any
  ): any { return refuse(); }
`;

/** A literal argument is folded by `tryStaticEvalInline` and never reaches the
 *  provider, so every eval source below is assembled at runtime. */
const PRELUDE = `
  function makeSource(p: string[]): string { var o = ""; for (var i = 0; i < p.length; i += 1) o = o + p[i]; return o; }
  var slot: number = 0;
`;
const EPILOGUE = `export function slotValue(): number { return slot; }`;
const EVAL_CALL = `eval(makeSource(["1"]))`;

interface RoutingCase {
  readonly name: string;
  readonly body: string;
  readonly expected: typeof DIRECT_ANSWER | typeof INDIRECT_ANSWER;
}

const CASES: readonly RoutingCase[] = [
  // ── the regression: a `let`/`const` per-iteration record, body unbraced ──
  {
    name: "for (let …) with an UNBRACED body is direct",
    body: `for (let i = 0; i < 1; i += 1) slot = ${EVAL_CALL} as number;`,
    expected: DIRECT_ANSWER,
  },
  {
    name: "for-of (const …) with an UNBRACED body is direct",
    body: `for (const v of [1]) slot = ${EVAL_CALL} as number;`,
    expected: DIRECT_ANSWER,
  },
  {
    name: "for-in (const …) with an UNBRACED body is direct",
    body: `for (const k in { a: 1 }) slot = ${EVAL_CALL} as number;`,
    expected: DIRECT_ANSWER,
  },
  {
    name: "a call in the head of a for (let …) is direct",
    // `n` drives the single iteration so the loop does not depend on the value
    // the stub answers with — `i` only carries it out to `slot`.
    body: `for (let i = ${EVAL_CALL} as number, n = 0; n < 1; n += 1) slot = i;`,
    expected: DIRECT_ANSWER,
  },

  // ── already correct before the fix; locked so the walk stays precise ──
  {
    name: "for (let …) with a BRACED body is direct",
    body: `for (let i = 0; i < 1; i += 1) { slot = ${EVAL_CALL} as number; }`,
    expected: DIRECT_ANSWER,
  },
  {
    name: "inside a function is direct",
    body: `function f(): void { slot = ${EVAL_CALL} as number; }\n  f();`,
    expected: DIRECT_ANSWER,
  },

  // ── the #2929 shim itself — must NOT be widened by the fix ──
  {
    name: "a bare top-level statement stays indirect (#2929 script-global shim)",
    body: `slot = ${EVAL_CALL} as number;`,
    expected: INDIRECT_ANSWER,
  },
  {
    name: "an unbraced `if` consequent stays indirect (no record is installed)",
    body: `if (1 === 1) slot = ${EVAL_CALL} as number;`,
    expected: INDIRECT_ANSWER,
  },
  {
    name: "a `var`-headed loop stays indirect (no record; B.3.3 publication)",
    body: `for (var i = 0; i < 1; i += 1) slot = ${EVAL_CALL} as number;`,
    expected: INDIRECT_ANSWER,
  },
  {
    // A head-less loop installs no per-iteration record — but its BRACED body
    // still installs a Block one, so this stays direct via the pre-existing arm.
    name: "a head-less loop with a braced body is direct (Block record)",
    body: `for (;;) { slot = ${EVAL_CALL} as number; break; }`,
    expected: DIRECT_ANSWER,
  },
];

describe("#4309 — direct eval routing at script global scope", () => {
  let stub: WebAssembly.Module;

  beforeAll(async () => {
    stub = new WebAssembly.Module(await compileStandalone(STUB_PROVIDER_SOURCE, "stub-provider-4309.ts"));
  }, 600_000);

  for (const testCase of CASES) {
    it(testCase.name, { timeout: 600_000 }, async () => {
      const source = `${PRELUDE}\n${testCase.body}\n${EPILOGUE}`;
      const module = new WebAssembly.Module(await compileStandalone(source, "user-4309.ts"));
      const importNames = WebAssembly.Module.imports(module).map((entry) => entry.name);
      const wanted = testCase.expected === DIRECT_ANSWER ? "__runtime_direct_eval" : "__runtime_indirect_eval";
      const other = testCase.expected === DIRECT_ANSWER ? "__runtime_indirect_eval" : "__runtime_direct_eval";
      // Liveness: the eval must actually reach a provider entry, and exactly one.
      expect(importNames).toContain(wanted);
      expect(importNames).not.toContain(other);

      const instance = new WebAssembly.Instance(module, {
        [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(stub),
      });
      (instance.exports as Record<string, () => void>)._start?.();
      expect((instance.exports as Record<string, () => number>).slotValue!()).toBe(testCase.expected);
    });
  }
});
