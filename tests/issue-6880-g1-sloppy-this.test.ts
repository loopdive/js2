// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6880 group 1 (#5385 S3-j) — `.call` / `.apply` / `.bind` install the receiver
// of a named function declaration even when a live direct `eval` makes every
// top-level function binding eval-rebindable.
//
// Every test262 row carries the harness `$262.evalScript` shim, whose direct
// `eval` puts the whole module into runtime-eval mode on the native regime
// (the dead-binding elision that removes the shim runs only for host-free
// environments). In that mode each top-level function declaration became a
// live binding, the named `.call` receiver trampoline refused live bindings,
// and the fallback called the same static function with the receiver
// DROPPED: `f.apply(o)` saw `this === undefined`, `foo.call(1)` reported
// `typeof this === "undefined"`. Standalone had the same defect whenever the
// eval stayed reachable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
beforeAll(() => {
  process.env.JS2WASM_NATIVE_REGIME_JS = "1";
});
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
  else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
});

type Lane = "regime" | "standalone";

/** The eval is never executed; its provider imports only need to link. */
function stubRuntimeEval(binary: Uint8Array, imports: Record<string, any>): void {
  const stub: Record<string, () => never> = {};
  for (const entry of WebAssembly.Module.imports(new WebAssembly.Module(binary))) {
    if (entry.module !== "js2wasm:runtime-eval") continue;
    stub[entry.name] = () => {
      throw new Error(`unexpected runtime-eval call: ${entry.name}`);
    };
  }
  if (Object.keys(stub).length > 0) imports["js2wasm:runtime-eval"] = stub;
}

async function run(lane: Lane, source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-6880.ts",
    ...(lane === "regime" ? { semanticProviders: "native-first" as const } : { target: "standalone" as const }),
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(result.targetProfile?.nativeRegime).toBe(true);
  const imports = buildCompiledImports(result) as Record<string, any>;
  stubRuntimeEval(result.binary, imports);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setInstance?: (instance: WebAssembly.Instance) => void }).setInstance?.(instance);
  return (instance.exports as { run(): number }).run();
}

const LIVE_EVAL = `
var evalSink: any = function (text: any): any { return eval(text); };
export function evalIt(text: any): any { return evalSink(text); }
`;

describe("#6880 g1 — receiver of .call/.apply/.bind under a live direct eval", () => {
  for (const lane of ["regime", "standalone"] as const) {
    it(`${lane}: strict target sees the object receiver`, async () => {
      const value = await run(
        lane,
        `${LIVE_EVAL}
        var o: any = {};
        function f(): any { "use strict"; return this === o; }
        export function run(): number {
          return (f.apply(o) ? 1 : 0) + (f.call(o) ? 2 : 0) + (f.bind(o)() ? 4 : 0);
        }`,
      );
      expect(value).toBe(7);
    });

    it(`${lane}: strict target sees a primitive receiver unboxed`, async () => {
      const value = await run(
        lane,
        `${LIVE_EVAL}
        function kind(): any { "use strict"; return typeof this; }
        export function run(): number {
          return (kind.call(1) === "number" ? 1 : 0) + (kind.call(true) === "boolean" ? 2 : 0) +
            (kind.call("s") === "string" ? 4 : 0);
        }`,
      );
      expect(value).toBe(7);
    });
  }

  it("regime: a statically reassigned function still calls its current value", async () => {
    const value = await run(
      "regime",
      `${LIVE_EVAL}
      function g(): any { return 1; }
      export function run(): number {
        const before = g.call({});
        g = function (): any { return 2; };
        return before * 10 + g.call({});
      }`,
    );
    expect(value).toBe(12);
  });
});
