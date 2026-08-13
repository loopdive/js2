// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { deduplicateLocals } from "../src/codegen/context/locals.js";
import type { FunctionContext } from "../src/codegen/context/types.js";
import type { Instr } from "../src/ir/types.js";

it("remaps a shared instruction fragment only once during local compaction", () => {
  const shared: Instr = { op: "local.get", index: 3 };
  const fctx = {
    params: [],
    locals: [
      { name: "__keep", type: { kind: "i32" } },
      { name: "__dup", type: { kind: "i32" } },
      { name: "__dup", type: { kind: "i32" } },
      { name: "payload", type: { kind: "i32" } },
    ],
    body: [
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [shared],
        else: [shared],
      },
    ],
  } as unknown as FunctionContext;

  deduplicateLocals(fctx);

  expect(fctx.locals).toHaveLength(3);
  expect(shared).toEqual({ op: "local.get", index: 2 });
});

it("keeps a contextual tuple return consistent with its concise closure body", async () => {
  const result = await compile(
    `
      const options = { name: "indent" };
      const plugins = [{ name: "demo", defaultOptions: { indent: 7 } }];
      export function test() {
        const values = Object.fromEntries(
          plugins
            .filter((plugin) => plugin.defaultOptions?.[options.name] !== undefined)
            .map((plugin) => [plugin.name, plugin.defaultOptions[options.name]])
        );
        return values.demo;
      }
    `,
    { allowJs: true, fileName: "prettier-shape.js", skipSemanticDiagnostics: true },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  expect(() => (instance.exports.test as () => unknown)()).not.toThrow();
});

it("uses nested-function capture types for destructured async-frame spills", async () => {
  const result = await compile(
    `
      function renderEmbedded(path, print, options, recurse) {
        return recurse(path, print, options);
      }

      async function formatEmbedded(path, print, options, recurse, output) {
        if (options.embeddedLanguageFormatting !== "auto") return;
        const { printer } = options;
        const { embed } = printer;
        if (!embed) return;
        const { hasIgnore } = printer;
        const work = [];
        visit();
        const oldStack = path.stack;
        for (const { printEmbedded, node, pathStack } of work) {
          try {
            path.stack = pathStack;
            const result = await printEmbedded(render, print, path, options);
            if (result) output.set(node, result);
          } catch (error) {
            if (globalThis.PRETTIER_DEBUG) throw error;
          }
        }
        path.stack = oldStack;

        function render(child, text) {
          return renderEmbedded(child, text, options, recurse);
        }

        function visit() {
          const { node } = path;
          if (node === null || typeof node !== "object" || hasIgnore?.(path)) return;
          const embedded = embed(path, options);
          if (typeof embedded === "function") {
            work.push({ printEmbedded: embedded, node, pathStack: [...path.stack] });
          } else if (embedded) {
            output.set(node, embedded);
          }
        }
      }

      export function test() {
        return typeof formatEmbedded;
      }
    `,
    { allowJs: true, fileName: "prettier-async-frame-shape.js", skipSemanticDiagnostics: true },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
});

it("keeps ordinary numeric async spills on the declared resume representation", async () => {
  const result = await compile(`
    export async function test() {
      let value = 1;
      await Promise.resolve(0);
      value = -value;
      return value;
    }
  `);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
});

it("remaps nested-function captures to the synthetic async resume frame", async () => {
  const result = await compile(`
    export async function test() {
      const values: number[] = [];
      function append() {
        values.push(1);
      }
      append();
      await Promise.resolve(0);
      return values.length;
    }
  `);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  expect(await Promise.resolve((instance.exports.test as () => Promise<number> | number)())).toBe(1);
});

it("keeps read-only arrow captures on their by-value resume ABI", async () => {
  const result = await compile(`
    export async function test() {
      const values: number[] = [];
      const append = () => values.push(1);
      append();
      await Promise.resolve(0);
      return values.length;
    }
  `);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  expect(await Promise.resolve((instance.exports.test as () => Promise<number> | number)())).toBe(1);
});

it("keeps nested async-generator captures on their by-value host ABI", async () => {
  const result = await compile(
    `
      export async function test() {
        const expected = [0, 1, 2];
        async function* generateInput() {
          yield* expected;
        }
        const output = await Array.fromAsync(generateInput());
        return output.length;
      }
    `,
    { allowJs: true, fileName: "array-from-async-capture.js", skipSemanticDiagnostics: true },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  expect(await Promise.resolve((instance.exports.test as () => Promise<number> | number)())).toBe(3);
});

it("keeps reused nested function values off assignment-await frames until their memo is spillable", async () => {
  const result = await compile(
    `
      export function test() {
        return (async function () {
          function Factory() {
            return {};
          }
          let value = await Promise.resolve(Factory);
          value = await Promise.resolve(Factory);
          return value === Factory;
        })();
      }
    `,
    { emitWat: true },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(result.wat).not.toContain("__async_resume_fanon");
});
