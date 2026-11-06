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
//
// (#7089) The JS-synthesized constructor above belonged to the retired
// `host-assisted` profile. The suite now asserts the native regime instead —
// the default profile (native-first in a JavaScript environment) and
// `--target standalone` — where NewPromiseCapability(SubPromise) constructs the
// compiled subclass itself (src/codegen/promise-class-receiver-drive.ts for the
// combinators, src/codegen/promise/receiver-capability.ts for `try` /
// `withResolvers`). The four asserts are unchanged.
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

// `Promise.any.call(SubPromise, [])` settles to a REJECTED promise
// (AggregateError) that the synchronous `test()` does not await — a benign
// test artifact (test262's ctx-ctor.js only inspects synchronous side effects /
// identity, never awaits). Swallow the unhandled rejection so it doesn't fail
// the run; scoped to this suite via beforeAll/afterAll.
const swallowRejection = (): void => {};

type Lane = "default" | "standalone";
const LANES: Lane[] = ["default", "standalone"];

async function instantiate(src: string, lane: Lane): Promise<Record<string, unknown>> {
  const r = await compile(src, lane === "standalone" ? { target: "standalone" } : {});
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors));
  const imports = buildCompiledImports(r) as ReturnType<typeof buildCompiledImports> & {
    setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setInstance?.(instance);
  if (lane === "standalone") expect(WebAssembly.Module.imports(new WebAssembly.Module(r.binary))).toEqual([]);
  return wrapCompiledExports(r, instance) as Record<string, unknown>;
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

describe("#2637 B2 — Promise-subclass capability ctor (ctx-ctor asserts #1-#4)", () => {
  beforeAll(() => {
    process.on("unhandledRejection", swallowRejection);
  });
  afterAll(() => {
    process.off("unhandledRejection", swallowRejection);
  });

  for (const lane of LANES) {
    // Empty-iterable combinators construct the capability exactly once, so
    // callCount === 1 (matching test262 `[]` ctx-ctor rows).
    for (const [label, call] of [
      ["Promise.all", "(Promise.all as any).call(SubPromise, [] as any)"],
      ["Promise.race", "(Promise.race as any).call(SubPromise, [] as any)"],
      ["Promise.any", "(Promise.any as any).call(SubPromise, [] as any)"],
      ["Promise.allSettled", "(Promise.allSettled as any).call(SubPromise, [] as any)"],
      ["Promise.try", "(Promise as any).try.call(SubPromise, function () {})"],
      ["Promise.withResolvers", "(Promise as any).withResolvers.call(SubPromise).promise"],
    ] as Array<[string, string]>) {
      it(`${lane}: ${label}.call(SubPromise, …) runs the user body on the capability promise (asserts #1-#4)`, async () => {
        const ex = await instantiate(srcFor(call), lane);
        // 15 = all four asserts hold (ctor identity + instanceof + callCount===1 + executor is fn).
        expect((ex.test as () => number)()).toBe(15);
      });
    }

    it(`${lane}: a default-ctor subclass (withResolvers/ctx-ctor) keeps identity`, async () => {
      const ex = await instantiate(
        `
        class SubPromise extends Promise<number> {}
        export function test(): number {
          const r: any = (Promise as any).withResolvers.call(SubPromise);
          const ctorOk = r != null && r.promise != null && r.promise.constructor === SubPromise;
          const instofOk = r != null && r.promise instanceof SubPromise;
          return (ctorOk ? 1 : 0) + (instofOk ? 2 : 0);
        }
      `,
        lane,
      );
      expect((ex.test as () => number)()).toBe(3);
    });

    it(`${lane}: direct \`new SubPromise(executor)\` still runs the body exactly once`, async () => {
      const ex = await instantiate(
        `
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
      `,
        lane,
      );
      expect((ex.test as () => number)()).toBe(1);
    });
  }
});
