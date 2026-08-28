// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Deno's primordials use a forwarding Promise subclass:
//
//   class SafePromise extends Promise {
//     constructor(executor) { super(executor); }
//   }
//
// In standalone mode `super(executor)` must construct the same native
// `$Promise` carrier as `new Promise(executor)`.  An identity-only subclass
// carrier does not run the executor and cannot participate in native `.then`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instantiate(source: string): Promise<WebAssembly.Exports> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "deno-safe-promise-constructor.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : JSON.stringify(result.errors?.slice(0, 3))).toBe(true);

  const module = new WebAssembly.Module(result.binary!);
  const imports = WebAssembly.Module.imports(module);
  expect(imports.filter(({ name }) => name === "__new_Promise" || name === "Promise_new")).toEqual([]);
  expect(imports).toEqual([]);

  const instance = new WebAssembly.Instance(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

describe("Deno SafePromise standalone construction", () => {
  it("runs an inline super executor synchronously and settles through native then", async () => {
    const exports = await instantiate(`
      declare function __drain_microtasks(): void;
      let sync = 0;
      let settled = 0;

      class InlinePromise extends Promise<number> {
        constructor() {
          super((resolve: any) => {
            sync = 1;
            resolve(41);
          });
        }
      }

      export function test(): number {
        const promise = new InlinePromise();
        const beforeDrain = sync;
        promise.then((value: number) => { settled = value; });
        __drain_microtasks();
        return beforeDrain + settled;
      }
    `);

    expect((exports.test as () => number)()).toBe(42);
  });

  it("forwards inline and identifier executor values through Deno's constructor shape", async () => {
    const exports = await instantiate(`
      declare function __drain_microtasks(): void;

      class SafePromise<T> extends Promise<T> {
        constructor(executor: any) {
          super(executor);
        }
      }

      function makeSafe<T>(executor: any): SafePromise<T> {
        return new SafePromise<T>(executor);
      }

      let sync = 0;
      let settled = 0;
      export function test(): number {
        const first = makeSafe<number>((resolve: any) => {
          sync = sync + 1;
          resolve(20);
        });
        const executor = (resolve: any): void => {
          sync = sync + 10;
          resolve(21);
        };
        const second = makeSafe<number>(executor);
        const beforeDrain = sync;
        first.then((value: number) => { settled = settled + value; });
        second.then((value: number) => { settled = settled + value; });
        __drain_microtasks();
        return beforeDrain + settled;
      }
    `);

    expect((exports.test as () => number)()).toBe(52);
  });

  it("runs Deno's direct new SafePromise(...).finally(...).then(...) chain natively", async () => {
    const exports = await instantiate(`
      declare function __drain_microtasks(): void;

      class SafePromise<T> extends Promise<T> {
        constructor(executor: any) {
          super(executor);
        }
      }

      let sync = 0;
      let finalized = 0;
      let settled = 0;
      export function test(): number {
        new SafePromise<number>((resolve: any) => {
          sync = 1;
          resolve(40);
        }).finally(() => {
          finalized = 1;
        }).then((value: number) => {
          settled = value;
        });
        const beforeDrain = sync;
        __drain_microtasks();
        return beforeDrain + finalized + settled;
      }
    `);

    expect((exports.test as () => number)()).toBe(42);
  });
});
