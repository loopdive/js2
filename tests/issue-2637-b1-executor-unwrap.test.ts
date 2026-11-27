// #2637 Phase B1 — executor unwrap at `super(<builtin Promise>)`.
//
// A `class SubPromise extends Promise { constructor(a) { super(a); … } }` lowers
// the `super(a)` call to `__self = __new_Promise(a)` (class-bodies.ts builtin-
// parent branch). The executor `a` arrives at the `__new_Promise` host import as
// a BOXED wasm closure (an opaque struct, not a raw JS function), so V8's real
// `Promise` constructor throws "Promise resolver [object Object] is not a
// function" and the user constructor body never runs.
//
// B1 (src/runtime.ts, the generic extern-class `new` host handler backing
// `__new_Promise`) unwraps the first argument to a host-callable via
// `_maybeWrapCallable(args[0], 2, callbackState)` when the builtin parent is
// `Promise` — mirroring the `Promise_new` host shim. This is a pure-runtime
// change (no funcidx shift, no codegen change). 0 test262 rows flip on B1 alone
// (every ctx-ctor row goes through the combinator / NewPromiseCapability path,
// addressed by B2); B1 is gated on this unit test + a no-regression sweep.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function instantiate(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src);
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors));
  const instance = await instantiateWithRuntime(r);
  return instance.exports;
}

describe("#2637 B1 — executor unwrap at super(builtin Promise)", () => {
  it("direct `new SubPromise(executor)` runs the user constructor body (callCount=1, no throw)", async () => {
    // The whole point: the user body forwards the executor through super(a) →
    // __new_Promise(a); B1 unwraps it so V8's Promise ctor accepts it and the
    // side effects (callCount += 1) run. Before B1 this threw "Promise resolver
    // [object Object] is not a function".
    const ex = await instantiate(`
      let callCount = 0;
      class SubPromise extends Promise<number> {
        constructor(executor: any) {
          super(executor);
          callCount += 1;
        }
      }
      export function test(): number {
        const p: any = new SubPromise((resolve: any, _reject: any) => { resolve(1); });
        // Returns 1 only when the body ran (callCount) and an instance was built.
        return callCount === 1 && p != null ? 1 : 0;
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("the executor passed to super() is the user's executor (it is actually invoked)", async () => {
    // The host Promise built from the (unwrapped) executor must INVOKE it — i.e.
    // the resolve/reject machinery reaches the user's arrow body. We observe this
    // via a side-effecting flag the executor sets when called.
    const ex = await instantiate(`
      let executorRan = 0;
      class SubPromise extends Promise<number> {
        constructor(executor: any) {
          super(executor);
        }
      }
      export function test(): number {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _p: any = new SubPromise((resolve: any, _reject: any) => {
          executorRan = 1;
          resolve(1);
        });
        return executorRan;
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("regression: a non-Promise builtin subclass (extends Array) is unchanged", async () => {
    // Edge case (b): the unwrap is gated on the Promise parent only. A
    // `class extends Array` super(arg) must still forward its arg verbatim.
    const ex = await instantiate(`
      class SubArr extends Array<number> {
        constructor() {
          super(3);
        }
      }
      export function test(): number {
        const a: any = new SubArr();
        return a.length === 3 ? 1 : 0;
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("regression: a plain `new Promise(fn)` (no subclass) still resolves", async () => {
    // Edge case (a): a raw-function executor must pass through _maybeWrapCallable
    // unchanged. This path does not even touch the extern-class new handler, but
    // we assert it stays green as a guard against any host-shim coupling.
    const ex = await instantiate(`
      export async function main(): Promise<number> {
        const p = new Promise<number>((resolve) => { resolve(7); });
        return await p;
      }
    `);
    expect(await (ex.main as () => Promise<number>)()).toBe(7);
  });
});
