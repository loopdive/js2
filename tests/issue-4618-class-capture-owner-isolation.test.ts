// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: class/capture registries are graph-wide and name-keyed, while the
// declarations they describe are lexical owners. Late callback discovery must
// preserve those owners instead of reusing an earlier same-named entry.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  (globalThis as any).__invoke4618owner = (callback: () => unknown) => callback();
  (globalThis as any).__retain4618owner = (_callback: () => unknown) => undefined;
  (globalThis as any).__construct4618owner = (Ctor: new () => { value(): unknown }) => new Ctor().value();
  const result = await compile(source, {
    fileName: "issue-4618-class-capture-owner-isolation.ts",
    skipSemanticDiagnostics: true,
    testRuntime: true,
  });
  expect(result.success).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, () => unknown>;
  return exports.test();
}

describe("#4618 late class/capture owners stay lexical", () => {
  it("does not reuse an earlier same-named class when a host callback is compiled later", async () => {
    expect(
      await run(`
        export function test(): any {
          class Foo { value(): string { return "outer"; } }
          const callback = () => {
            class Foo { value(): string { return "callback"; } }
            return new Foo().value();
          };
          return (globalThis as any).__invoke4618owner(callback);
        }
      `),
    ).toBe("callback");
  });

  it("does not reuse a foreign same-named boxed capture global", async () => {
    expect(
      await run(`
        export function test(): any {
          const first = () => {
            let shared: any;
            const retained = () => shared;
            (globalThis as any).__retain4618owner(retained);
            shared = { value: "A" };
            class Box { read(): string { return shared.value; } }
            return new Box().read();
          };
          const second = () => {
            let shared: any;
            const retained = () => shared;
            (globalThis as any).__retain4618owner(retained);
            shared = { value: "B" };
            class Box { read(): string { return shared.value; } }
            return new Box().read();
          };
          return String((globalThis as any).__invoke4618owner(first)) +
            String((globalThis as any).__invoke4618owner(second));
        }
      `),
    ).toBe("AB");
  });

  it("resolves a declared class before a foreign same-named capture", async () => {
    expect(
      await run(`
        export function test(): any {
          const retained = () => {
            class Foo { value(): string { return "foreign"; } }
            class Outer { value(): string { return new Foo().value(); } }
            return new Outer().value();
          };
          (globalThis as any).__retain4618owner(retained);
          class Foo { value(): string { return "local"; } }
          return (globalThis as any).__construct4618owner(Foo);
        }
      `),
    ).toBe("local");
  });
});
