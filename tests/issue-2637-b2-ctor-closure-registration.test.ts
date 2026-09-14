// #2637 Phase B2 — Promise-subclass run-on-host-`this` constructor body.
//
// When a `class SubPromise extends Promise { constructor(a){ super(a); … } }` is
// used as the receiver of a combinator (`Promise.all.call(SubPromise, …)`), V8's
// `NewPromiseCapability(SubPromise)` performs `Construct(C, «executor»)` where
// `C = __promise_subclass_ctor(name)` is a synthesized JS subclass. B2 wires the
// user constructor body to run under that construction:
//
//   - B2.1 (codegen): at every combinator / value-read site, emit
//     `__register_promise_subclass_ctor(name, <closure over $Class_new__onhost>)`
//     before `__promise_subclass_ctor(name)`. The closure materializes the
//     pre-registered run-on-host body.
//   - B2.2 (runtime, banked): the synthesized `C`'s ctor runs the registered
//     body on `this` (the capability promise) after `super(exec)`.
//   - B2.3 (codegen): `$Class_new__onhost` binds `$__self` to `__current_this`
//     (the host-provided promise) instead of allocating its own via
//     `__new_Promise`, and does NOT re-point the prototype/brand (V8 already set
//     `C.prototype` — re-pointing breaks identity). The direct-new
//     `$Class_new` body (B1) is left untouched.
//
// Acceptance: test262 `built-ins/Promise/{all,race,any,allSettled,try}/ctx-ctor.js`
// reach `callCount === 1` (assert #3) and `typeof executor === 'function'`
// (assert #4), with identity (`instance.constructor === SubPromise`,
// `instance instanceof SubPromise`, asserts #1/#2) still green. The only true
// signal is the merge_group test262 floor; these unit tests exercise the same
// four asserts in JS-host mode as a fast regression guard.
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// `Promise.any.call(SubPromise, [])` settles to a REJECTED promise
// (AggregateError) that the synchronous `test()` does not await — a benign
// test artifact (test262's ctx-ctor.js only inspects synchronous side effects /
// identity, never awaits). Swallow the unhandled rejection so it doesn't fail
// the run; scoped to this suite via beforeAll/afterAll.
const swallowRejection = (): void => {};

async function instantiate(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src);
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const m = await WebAssembly.instantiate(r.binary, imports);
  const setExports = (imports as unknown as { setExports?: (e: WebAssembly.Exports) => void }).setExports;
  if (typeof setExports === "function") setExports(m.instance.exports);
  return m.instance.exports;
}

// Mirror test262 ctx-ctor.js: the combinator is invoked on the receiver
// `SubPromise`; the four asserts are bit-encoded:
//   1 = instance.constructor === SubPromise  (#1)
//   2 = instance instanceof SubPromise       (#2)
//   4 = callCount === 1                       (#3)
//   8 = typeof executor === 'function'        (#4)
function srcFor(call: string): string {
  return `
    let executorWasFunction = 0;
    let callCount = 0;
    let ctorMatches = 0;
    let instofMatches = 0;
    class SubPromise extends Promise<number> {
      constructor(a: any) {
        super(a);
        if (typeof a === "function") { executorWasFunction = 1; }
        callCount += 1;
      }
    }
    export function test(): number {
      callCount = 0;
      executorWasFunction = 0;
      ctorMatches = 0;
      instofMatches = 0;
      const instance: any = ${call};
      if (instance != null && instance.constructor === SubPromise) { ctorMatches = 1; }
      if (instance instanceof SubPromise) { instofMatches = 1; }
      return (ctorMatches ? 1 : 0) + (instofMatches ? 2 : 0) + (callCount === 1 ? 4 : 0) + (executorWasFunction ? 8 : 0);
    }
  `;
}

describe("#2637 B2 — Promise-subclass run-on-host ctor (ctx-ctor asserts #1-#4)", () => {
  beforeAll(() => {
    process.on("unhandledRejection", swallowRejection);
  });
  afterAll(() => {
    process.off("unhandledRejection", swallowRejection);
  });

  // (#6419) `Promise.try` is a HOST intrinsic on this lane — the compiler
  // lowers the call, the host supplies the method. It landed in V8 13.x /
  // Node 23; `package.json` still declares `engines: node >=20`, so on Node 22
  // the row fails with `Promise.try is not a function` and has nothing to do
  // with the ctor-registration behaviour under test. CI runs Node 24/25, which
  // is why this file is green there and red locally. Skip the row where the
  // host cannot provide it rather than assert a host capability.
  const hostHasPromiseTry = typeof (Promise as unknown as { try?: unknown }).try === "function";

  // Empty-iterable combinators construct the capability exactly once, so
  // callCount === 1 (matching test262 `[]` ctx-ctor rows).
  for (const [label, call, needsHostPromiseTry] of [
    ["Promise.all", "(Promise.all as any).call(SubPromise, [] as any)", false],
    ["Promise.race", "(Promise.race as any).call(SubPromise, [] as any)", false],
    ["Promise.any", "(Promise.any as any).call(SubPromise, [] as any)", false],
    ["Promise.allSettled", "(Promise.allSettled as any).call(SubPromise, [] as any)", false],
    ["Promise.try", "(Promise as any).try.call(SubPromise, function () {})", true],
  ] as Array<[string, string, boolean]>) {
    it.skipIf(needsHostPromiseTry && !hostHasPromiseTry)(
      `${label}.call(SubPromise, …) runs the user body on the capability promise (asserts #1-#4)`,
      async () => {
        const ex = await instantiate(srcFor(call));
        // 15 = all four asserts hold (ctor identity + instanceof + callCount===1 + executor is fn).
        expect((ex.test as () => number)()).toBe(15);
      },
    );
  }

  it("regression: a default-ctor subclass (withResolvers/ctx-ctor) keeps identity, no body to run", async () => {
    // `class SubPromise extends Promise {}` has no user ctor — the #1977
    // identity-only path. B2 must NOT register a body for it (no `__onhost`),
    // so the runtime's bare forwarder runs and identity holds.
    const ex = await instantiate(`
      class SubPromise extends Promise<number> {}
      export function test(): number {
        const r: any = (Promise as any).withResolvers.call(SubPromise);
        const ctorOk = r != null && r.promise != null && r.promise.constructor === SubPromise;
        const instofOk = r != null && r.promise instanceof SubPromise;
        return (ctorOk ? 1 : 0) + (instofOk ? 2 : 0);
      }
    `);
    expect((ex.test as () => number)()).toBe(3);
  });

  it("regression: direct `new SubPromise(executor)` still runs the body exactly once (B1 path untouched)", async () => {
    const ex = await instantiate(`
      let callCount = 0;
      class SubPromise extends Promise<number> {
        constructor(executor: any) {
          super(executor);
          callCount += 1;
        }
      }
      export function test(): number {
        callCount = 0;
        const p: any = new SubPromise((resolve: any, _reject: any) => { resolve(1); });
        return callCount === 1 && p != null ? 1 : 0;
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });
});
