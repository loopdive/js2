// (#6757) Linked lane: a closure minted in one module and called by another
// module's dispatcher used to bounce between the dynamic bridge and that
// dispatcher's host-call terminal until the stack overflowed.
//
// The end-to-end case is the shape of test262's
// `built-ins/RegExp/named-groups/duplicate-names-matchall.js` without its
// duplicate-named-group regexp (which older Node rejects at compile time): the
// test body hands the harness provider closures it minted itself, and the
// provider's `compareIterator` calls each one as `validators[i](value)`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { createLinkedClosureDispatch } from "../src/runtime/linked-closure-dispatch.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";
// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6757-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

async function runLinked(source: string): Promise<string> {
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

describe("#6757 — a body-minted closure called by the linked harness", () => {
  it("runs through the module that minted it instead of overflowing the stack", async () => {
    const source = `/*---
includes: [compareArray.js, compareIterator.js]
---*/
function matchesIterator(iterator, expected) {
  assert.compareIterator(iterator, expected.map(e => {
    return v => assert.compareArray(v, e);
  }));
}
matchesIterator([["b", 1], ["a", 2]][Symbol.iterator](), [["b", 1], ["a", 2]]);
`;
    expect(await runLinked(source)).toBe("pass");
  }, 180_000);

  it("still reports a real mismatch from the body-minted validator", async () => {
    const source = `/*---
includes: [compareArray.js, compareIterator.js]
---*/
var threw = false;
try {
  assert.compareIterator([["b", 1]][Symbol.iterator](), [v => assert.compareArray(v, ["b", 2])]);
} catch (e) {
  threw = e instanceof Test262Error;
}
assert(threw, "the validator's own assertion must reach the body");
`;
    expect(await runLinked(source)).toBe("pass");
  }, 180_000);
});

describe("#6757 — the bounce detector", () => {
  const moduleA = { __closure_arity: () => 1 } as Record<string, Function>;
  const moduleB = { __closure_arity: () => 1 } as Record<string, Function>;
  const receiver = {};

  /**
   * Stand-in for one dispatch through `via`: pick `route`, and when `via` is
   * module A, fall back to the host (A cannot call the closure) and re-enter
   * the bridge, which picks `reentryRoute`.
   */
  function dispatchVia(
    d: ReturnType<typeof createLinkedClosureDispatch>,
    closure: object,
    via: Record<string, Function>,
    reentryRoute: string,
  ): unknown {
    if (d.isRepeat(closure, via, "m1", receiver)) return undefined;
    if (via !== moduleA) return "ran";
    // A's dispatcher hands the callee back; a second export view of the same
    // instance (same functions, new container) must still count as module A.
    d.noteFallback(closure, receiver, { ...moduleA });
    return d.invoke(closure, moduleA, [moduleB], (inner) =>
      d.isRepeat(closure, inner, reentryRoute, receiver) ? undefined : `re-entered via ${reentryRoute}`,
    );
  }

  it("a re-entry through the SAME dispatcher export is a loop: unwind and run the closure in the peer", () => {
    const d = createLinkedClosureDispatch();
    const closure = {};
    expect(d.invoke(closure, moduleA, [moduleB], (via) => dispatchVia(d, closure, via, "m1"))).toBe("ran");
  });

  it("a re-entry through a DIFFERENT dispatcher export is not a loop and keeps its result", () => {
    const d = createLinkedClosureDispatch();
    const closure = {};
    expect(d.invoke(closure, moduleA, [moduleB], (via) => dispatchVia(d, closure, via, "f1"))).toBe(
      "re-entered via f1",
    );
  });

  it("only the dispatching module's fallback of that closure, on its receiver, is noted", () => {
    const d = createLinkedClosureDispatch();
    const closure = {};
    const seen = d.invoke(closure, moduleA, [], () => {
      d.isRepeat(closure, moduleA, "m1", receiver);
      d.noteFallback({}, receiver, moduleA); // another closure
      d.noteFallback(closure, receiver, moduleB); // another module
      d.noteFallback(closure, {}, moduleA); // another receiver
      return d.invoke(closure, moduleA, [], (inner) => d.isRepeat(closure, inner, "m1", receiver));
    });
    expect(seen).toBe(false);
    expect(d.isRepeat(closure, moduleA, "m1", receiver)).toBe(false); // nothing in flight
  });

  it("remembers the module that ran the closure", () => {
    const d = createLinkedClosureDispatch();
    const closure = {};
    const order: string[] = [];
    const through = (via: Record<string, Function>) => {
      order.push(via === moduleA ? "A" : "B");
      return dispatchVia(d, closure, via, "m1");
    };
    expect(d.invoke(closure, moduleA, [moduleB], through)).toBe("ran");
    expect(d.invoke(closure, moduleA, [moduleB], through)).toBe("ran");
    expect(order).toEqual(["A", "B", "B"]);
  });

  it("throws a TypeError when no module of the project can call the closure", () => {
    const d = createLinkedClosureDispatch();
    const closure = {};
    const loopEverywhere = (via: Record<string, Function>): unknown => {
      if (d.isRepeat(closure, via, "m1", receiver)) return undefined;
      d.noteFallback(closure, receiver, via);
      return d.invoke(closure, via, [], (inner) => (d.isRepeat(closure, inner, "m1", receiver) ? undefined : "x"));
    };
    expect(() => d.invoke(closure, moduleA, [moduleB], loopEverywhere)).toThrow(TypeError);
  });

  it("reuses one retry bridge per closure and module", () => {
    const d = createLinkedClosureDispatch();
    const closure = {};
    let built = 0;
    const make = () => {
      built++;
      return () => 0;
    };
    const first = d.bridgeFor(closure, moduleB, make);
    expect(d.bridgeFor(closure, moduleB, make)).toBe(first);
    expect(built).toBe(1);
  });
});
