// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface HookExports extends WebAssembly.Exports {
  startThen(): number;
  startExecutor(): number;
  lifecycle(): number;
  __drain_microtasks(): void;
}

async function instantiate(source: string): Promise<HookExports> {
  const result = await compile(source, {
    target: "standalone",
    experimentalIR: false,
    fileName: "deno-promise-hooks.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as HookExports;
}

describe("Deno app-owned Promise hooks", () => {
  it("reports root/child init, resolve, and reaction order", async () => {
    const exports = await instantiate(`
      let events: number = 0;

      // Deliberately private opt-in consumed by JS2's Promise scheduler.
      export function __v8x_dispatch_promise_hook(
        kind: number,
        promise: any,
        parent: any,
      ): void {
        if (promise === undefined) events = -1000000;
        const digit = kind === 0 ? (parent === undefined ? 1 : 2) : kind + 1;
        events = events * 10 + digit;
      }

      export function startThen(): number {
        events = 0;
        const root = Promise.resolve(1);
        root.then((value: number): number => {
          events = events * 10 + 9;
          return value + 1;
        });
        return events;
      }

      export function startExecutor(): number {
        events = 0;
        new Promise<number>((resolve): void => {
          events = events * 10 + 8;
          resolve(1);
        });
        return events;
      }

      export function lifecycle(): number { return events; }
    `);

    // init(root), resolve(root), init(child, parent=root)
    expect(exports.startThen()).toBe(142);
    exports.__drain_microtasks();
    // before(child), handler, resolve(child), after(child)
    expect(exports.lifecycle()).toBe(1422943);

    // `new Promise` initializes before its executor can synchronously settle.
    expect(exports.startExecutor()).toBe(184);
  });

  it("is inert when the private Deno dispatcher is absent", async () => {
    const exports = await instantiate(`
      let value: number = 0;
      export function startThen(): number {
        Promise.resolve(20).then((next: number): number => {
          value = next + 22;
          return value;
        });
        return value;
      }
      export function startExecutor(): number {
        return new Promise<number>((resolve): void => resolve(1)) === undefined ? -1 : 1;
      }
      export function lifecycle(): number { return value; }
    `);
    expect(exports.startThen()).toBe(0);
    exports.__drain_microtasks();
    expect(exports.lifecycle()).toBe(42);
    expect(exports.startExecutor()).toBe(1);
  });
});
