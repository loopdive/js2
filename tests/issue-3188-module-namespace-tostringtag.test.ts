// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3188 slice 3 — a materialized module namespace owns the immutable
// `Symbol.toStringTag` data property required by §10.4.6.2.

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

type Target = "gc" | "standalone";

const EMPTY_NAMESPACE_MODULE = `export {};`;

const EMPTY_NAMESPACE_ENTRY = `
  import * as ns from "./empty.js";

  export function test() {
    const namespace = ns;
    const tag = Symbol.toStringTag;
    const descriptor = Object.getOwnPropertyDescriptor(namespace, tag);
    const unrelated = Symbol("Symbol.toStringTag");
    const plain = {};
    const sameNamespace = ns;
    let bits = 0;

    if (namespace[tag] === "Module") bits |= 1;
    if (
      descriptor !== undefined &&
      descriptor.value === "Module" &&
      descriptor.writable === false &&
      descriptor.enumerable === false &&
      descriptor.configurable === false
    ) bits |= 2;
    if (
      tag in namespace &&
      Reflect.has(namespace, tag) &&
      Object.prototype.hasOwnProperty.call(namespace, tag)
    ) bits |= 4;
    if (
      !Reflect.has(namespace, unrelated) &&
      Object.getOwnPropertyDescriptor(namespace, unrelated) === undefined
    ) bits |= 8;
    if (sameNamespace === namespace) bits |= 16;
    if (plain[tag] === undefined && !Reflect.has(plain, tag)) bits |= 32;

    return bits;
  }
`;

const STRING_NAMED_EXPORT_MODULE = `
  export const toStringTag = "ordinary-string-export";
`;

const STRING_NAMED_EXPORT_ENTRY = `
  import * as ns from "./named.js";

  export function test() {
    const namespace = ns;
    const descriptor = Object.getOwnPropertyDescriptor(namespace, Symbol.toStringTag);
    let bits = 0;

    if (namespace.toStringTag === "ordinary-string-export") bits |= 1;
    if (namespace[Symbol.toStringTag] === "Module") bits |= 2;
    if (
      descriptor !== undefined &&
      descriptor.value === "Module" &&
      descriptor.writable === false &&
      descriptor.enumerable === false &&
      descriptor.configurable === false
    ) bits |= 4;

    return bits;
  }
`;

const FUNCTION_EXPORT_MODULE = `
  export function answer() { return 42; }
`;

const FUNCTION_EXPORT_ENTRY = `
  import * as ns from "./function.js";

  export function test() {
    const namespace = ns;
    const descriptor = Object.getOwnPropertyDescriptor(namespace, Symbol.toStringTag);
    let bits = 0;

    if (namespace.answer() === 42) bits |= 1;
    if (namespace.answer === namespace.answer) bits |= 2;
    if (namespace[Symbol.toStringTag] === "Module") bits |= 4;
    if (
      descriptor !== undefined &&
      descriptor.value === "Module" &&
      descriptor.writable === false &&
      descriptor.enumerable === false &&
      descriptor.configurable === false
    ) bits |= 8;

    return bits;
  }
`;

// This is deliberately a TypeScript runtime namespace rather than an ESM
// `import * as ns` binding. The finite computed write admits the bounded
// runtime-namespace projection, and the computed read proves its exported
// callable is materialized without relying on the unrelated method-`this`
// bridge.
const RUNTIME_NAMESPACE_PROJECTION_ENTRY = `
  namespace RuntimeNs {
    export function inspect(): number {
      return 3;
    }

    // This finite computed write is the established admission shape for a
    // materialized runtime-namespace function surface.
    const key: "inspect" = "inspect";
    RuntimeNs[key] = inspect;
  }

  export function test(): number {
    const key: "inspect" = "inspect";
    const exportedCallable = RuntimeNs[key];
    return typeof exportedCallable === "function" && exportedCallable() === 3 ? 3 : 0;
  }
`;

async function runModule(
  target: Target,
  entrySource: string,
  modules: Readonly<Record<string, string>>,
  entry = "./entry.js",
): Promise<number> {
  const result = await compileMulti({ [entry]: entrySource, ...modules }, entry, {
    target,
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return 0;

  const module = new WebAssembly.Module(result.binary);
  if (target === "standalone") expect(WebAssembly.Module.imports(module)).toHaveLength(0);
  const imports = (result.importObject ?? {}) as Record<string, unknown>;
  const instance = await WebAssembly.instantiate(module, imports as WebAssembly.Imports);
  const setExports = imports.__setExports ?? imports.setExports;
  if (typeof setExports === "function") (setExports as (exports: WebAssembly.Exports) => void)(instance.exports);
  const setInstance = imports.__setInstance ?? imports.setInstance;
  if (typeof setInstance === "function") (setInstance as (instance: WebAssembly.Instance) => void)(instance);
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
  return (instance.exports as Record<string, () => number>).test();
}

describe("#3188 module namespace Symbol.toStringTag", () => {
  it.each(["gc", "standalone"] as const)(
    "materializes the immutable Module tag for an empty namespace (%s)",
    async (target) => {
      await expect(runModule(target, EMPTY_NAMESPACE_ENTRY, { "./empty.js": EMPTY_NAMESPACE_MODULE })).resolves.toBe(
        63,
      );
    },
  );

  it.each(["gc", "standalone"] as const)(
    "keeps a string-named toStringTag export distinct from the symbol key (%s)",
    async (target) => {
      await expect(
        runModule(target, STRING_NAMED_EXPORT_ENTRY, { "./named.js": STRING_NAMED_EXPORT_MODULE }),
      ).resolves.toBe(7);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "preserves an admitted function export while seeding the tag (%s)",
    async (target) => {
      await expect(runModule(target, FUNCTION_EXPORT_ENTRY, { "./function.js": FUNCTION_EXPORT_MODULE })).resolves.toBe(
        15,
      );
    },
  );

  it.each(["gc", "standalone"] as const)(
    "materializes the bounded TypeScript runtime namespace callable projection (%s)",
    async (target) => {
      await expect(runModule(target, RUNTIME_NAMESPACE_PROJECTION_ENTRY, {}, "./runtime-namespace.ts")).resolves.toBe(
        3,
      );
    },
  );
});
