// #6440 — `Promise.try` is lowered to a host intrinsic the declared
// `engines: node >=20` floor does not have. It landed in Node 23; on Node
// 20/22 the compiled call threw `TypeError: Promise.try is not a function`
// with no compile-time signal.
//
// This test is host-version-independent (meaningful on CI's Node 24/25 too):
// it forces a `node:vm` sandbox realm whose `Promise.try` has been deleted,
// registered as a coherent builtin realm (so `__get_builtin("Promise")`
// resolves to the sandbox's own Promise, per `resolveImport`'s `builtin()`
// helper), so the polyfill install path (`_installPromiseTryPolyfill`, wired
// through `installAmbientCompatibility`) is exercised regardless of what the
// actual host Node version ships. Pattern: tests/regexp-host-static-inheritance.test.ts.
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, markCoherentBuiltinRealm } from "../src/runtime.js";

/** A sandbox realm whose `Promise.try` is missing, mirroring Node 20/22. */
function makeSandboxWithoutPromiseTry(): Record<string, any> {
  const sandbox = Object.create(null) as Record<string, any>;
  const ctx = createContext(sandbox);
  for (const n of ["Promise", "Array", "Object", "Function", "TypeError"]) {
    sandbox[n] = runInContext(n, ctx);
  }
  sandbox.globalThis = sandbox;
  sandbox.Promise.try = undefined;
  markCoherentBuiltinRealm(sandbox);
  return sandbox;
}

async function compileAndBuild(src: string, sandbox: Record<string, any>): Promise<{ instance: WebAssembly.Instance }> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    deferTopLevelInit: true,
    skipSemanticDiagnostics: true,
  });
  const errors = (result.errors ?? []).filter((e: any) => e.severity === "error");
  expect(errors.map((e: any) => e.message).join("; ")).toBe("");
  const imports: any = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: sandbox });
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  (instance.exports as any).__module_init?.();
  return { instance };
}

async function run(src: string, sandbox: Record<string, any>): Promise<unknown> {
  const { instance } = await compileAndBuild(src, sandbox);
  return (instance.exports as any).test?.();
}

describe("#6440 — Promise.try polyfill for a host below the engine that ships it", () => {
  it("compiled Promise.try(fn) does not throw and runs the callback on a host missing it", async () => {
    const sandbox = makeSandboxWithoutPromiseTry();
    expect(typeof sandbox.Promise.try).toBe("undefined");
    const ret = await run(
      `
        var hits = 0;
        var p = Promise.try(function () { hits = 1; return 7; });
        export function test(): number { return hits; }
      `,
      sandbox,
    );
    expect(ret).toBe(1);
    // The install runs against this sandbox's own Promise (coherent realm).
    expect(typeof sandbox.Promise.try).toBe("function");
  });

  it("Promise.try(fn) that throws yields a rejected promise, not a synchronous throw", async () => {
    const sandbox = makeSandboxWithoutPromiseTry();
    // Trigger the install via a no-op compile, then exercise the sandbox's
    // own Promise.try directly to assert on the returned promise's shape.
    await compileAndBuild(`export function test(): number { return 1; }`, sandbox);

    let threwSynchronously = false;
    let p: any;
    try {
      p = sandbox.Promise.try(() => {
        throw new Error("boom");
      });
    } catch {
      threwSynchronously = true;
    }
    expect(threwSynchronously).toBe(false);
    let rejectedWith: unknown;
    await p.catch((e: unknown) => {
      rejectedWith = e;
    });
    expect((rejectedWith as Error).message).toBe("boom");
  });

  it("Promise.try.call(SubPromise, fn) runs the subclass constructor exactly once (NewPromiseCapability(C))", async () => {
    const sandbox = makeSandboxWithoutPromiseTry();
    await compileAndBuild(`export function test(): number { return 1; }`, sandbox);

    let ctorCallCount = 0;
    class SubPromise extends sandbox.Promise {
      constructor(executor: any) {
        super(executor);
        ctorCallCount += 1;
      }
    }
    const instance = sandbox.Promise.try.call(SubPromise, () => 5);
    expect(ctorCallCount).toBe(1);
    expect(instance).toBeInstanceOf(SubPromise);
    expect(instance.constructor).toBe(SubPromise);
    expect(await instance).toBe(5);
  });

  it("anti-vacuity: an existing Promise.try (spy) is never overwritten by the polyfill", async () => {
    const sandbox = makeSandboxWithoutPromiseTry();
    let spyCallCount = 0;
    const spy = (fn: () => unknown) => {
      spyCallCount += 1;
      return sandbox.Promise.resolve(fn());
    };
    sandbox.Promise.try = spy;

    const ret = await run(
      `
        var hits = 0;
        var p = Promise.try(function () { hits = 1; return 9; });
        export function test(): number { return hits; }
      `,
      sandbox,
    );
    expect(ret).toBe(1);
    expect(sandbox.Promise.try).toBe(spy);
    expect(spyCallCount).toBe(1);
  });

  it("anti-vacuity: on the real (unmocked) global Promise, an already-present try is left as-is", async () => {
    const before = Promise.try;
    // No assertion on `typeof before` — this host may or may not have it
    // natively; the point is the polyfill never disturbs whatever is there
    // once buildImports has run for a non-sandboxed compile.
    const result: any = await compile(
      `
        export function test(): number { return typeof Promise.try; }
      `,
      { fileName: "test.ts", deferTopLevelInit: true, skipSemanticDiagnostics: true },
    );
    const imports: any = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports);
    (instance.exports as any).__module_init?.();
    expect(typeof Promise.try).toBe("function");
    if (typeof before === "function") expect(Promise.try).toBe(before);
  });
});
