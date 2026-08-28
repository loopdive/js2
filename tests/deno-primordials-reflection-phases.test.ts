// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const NAMESPACE_NAMES = ["JSON", "Math", "Proxy", "Reflect"] as const;

const INTRINSIC_NAMES = [
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Float32Array",
  "Float64Array",
  "Function",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Map",
  "Number",
  "Object",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakRef",
  "WeakSet",
] as const;

const ABSTRACT_INTRINSIC_NAMES = [
  "TypedArray",
  "ArrayIterator",
  "SetIterator",
  "MapIterator",
  "StringIterator",
  "Generator",
  "AsyncGenerator",
] as const;

const MAKE_SAFE_NAMES = [
  "Map",
  "WeakMap",
  "Set",
  "WeakSet",
  "RegExp",
  "FinalizationRegistry",
  "WeakRef",
  "Promise",
] as const;

const TARGET_LABELS = [
  ...NAMESPACE_NAMES.map((name) => `globalThis.${name}`),
  ...INTRINSIC_NAMES.flatMap((name) => [`globalThis.${name}`, `globalThis.${name}.prototype`]),
  "globalThis.Promise",
  "globalThis.Promise.prototype",
  ...ABSTRACT_INTRINSIC_NAMES.flatMap((name) => [`%${name}% original`, `%${name}% original.prototype`]),
  ...MAKE_SAFE_NAMES.flatMap((name) => [
    `${name}.prototype (makeSafe unsafe prototype)`,
    `Safe${name}.prototype (makeSafe safe prototype)`,
    `${name} (makeSafe unsafe constructor)`,
    `Safe${name} (makeSafe safe constructor)`,
  ]),
] as const;

const EXNREF_RUNNER = String.raw`
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const module = new WebAssembly.Module(Buffer.concat(chunks));
  const imports = WebAssembly.Module.imports(module);
  const calls = [];
  const importObject = {};
  for (const descriptor of imports) {
    importObject[descriptor.module] ??= {};
    importObject[descriptor.module][descriptor.name] = (...args) => {
      calls.push(descriptor.module + "::" + descriptor.name + "(" + args.length + ")");
      return null;
    };
  }
  const instance = await WebAssembly.instantiate(module, importObject);
  let initThrew = false;
  try {
    instance.exports.__module_init();
  } catch {
    initThrew = true;
  }
  process.stdout.write(JSON.stringify({
    value: instance.exports.test(),
    target: instance.exports.failureTarget(),
    operation: instance.exports.failureOperation(),
    key: instance.exports.failureKey(),
    activeTarget: instance.exports.activeTarget(),
    activeOperation: instance.exports.activeOperation(),
    activeKey: instance.exports.activeKey(),
    initThrew,
    imports,
    calls,
  }));
`;

interface ProbeReport {
  value: number;
  target: number;
  operation: number;
  key: number;
  activeTarget: number;
  activeOperation: number;
  activeKey: number;
  initThrew: boolean;
  imports: WebAssembly.ModuleImportDescriptor[];
  calls: string[];
}

const SOURCE = `
  let failedTarget = -1;
  let failedOperation = 0;
  let failedKey = -1;
  let nextTarget = 0;
  let currentTarget = -1;
  let currentOperation = 0;
  let currentKey = -1;

  const {
    getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
    ownKeys: ReflectOwnKeys,
  } = Reflect;

  function recordFailure(target: number, operation: number, key: number): void {
    if (failedTarget !== -1) return;
    failedTarget = target;
    failedOperation = operation;
    failedKey = key;
  }

  function getKeys(target: any, targetIndex: number): any {
    currentTarget = targetIndex;
    currentOperation = 1;
    currentKey = -1;
    try {
      return ReflectOwnKeys(target);
    } catch {
      recordFailure(targetIndex, 1, -1);
      return [];
    }
  }

  function getDescriptor(target: any, key: any, targetIndex: number, keyIndex: number): any {
    currentTarget = targetIndex;
    currentOperation = 2;
    currentKey = keyIndex;
    try {
      const descriptor = ReflectGetOwnPropertyDescriptor(target, key);
      if (descriptor === undefined) recordFailure(targetIndex, 3, keyIndex);
      return descriptor;
    } catch {
      recordFailure(targetIndex, 2, keyIndex);
      return undefined;
    }
  }

  // Mirrors copyPropsRenamed/copyPropsRenamedBound/copyPrototype's reflective
  // traversal. The omitted descriptor copying cannot affect target admission.
  function probeCopyTarget(target: any): void {
    const targetIndex = nextTarget++;
    if (failedTarget !== -1) return;
    const keys: any = getKeys(target, targetIndex);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      getDescriptor(target, keys[keyIndex], targetIndex, keyIndex);
      if (failedTarget !== -1) return;
    }
  }

  /** @type {any} */
  const realm = globalThis;

  // Namespace copyPropsRenamed phase.
  ["JSON", "Math", "Proxy", "Reflect"].forEach((name) => {
    probeCopyTarget(realm[name]);
  });

  // Intrinsic constructor copyPropsRenamed + copyPrototype phase.
  [
    "AggregateError", "Array", "ArrayBuffer", "BigInt", "BigInt64Array",
    "BigUint64Array", "Boolean", "DataView", "Date", "Error", "EvalError",
    "FinalizationRegistry", "Float32Array", "Float64Array", "Function",
    "Int16Array", "Int32Array", "Int8Array", "Map", "Number", "Object",
    "RangeError", "ReferenceError", "RegExp", "Set", "String", "Symbol",
    "SyntaxError", "TypeError", "URIError", "Uint16Array", "Uint32Array",
    "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet",
  ].forEach((name) => {
    const original = realm[name];
    probeCopyTarget(original);
    probeCopyTarget(original.prototype);
  });

  // Promise copyPropsRenamedBound + copyPrototype phase.
  const originalPromise = realm.Promise;
  probeCopyTarget(originalPromise);
  probeCopyTarget(originalPromise.prototype);

  function probeAbstract(original: any): void {
    probeCopyTarget(original);
    probeCopyTarget(original.prototype);
  }

  // Abstract intrinsic copyPrototype phases. The wrapper objects for iterator
  // intrinsics are intentional: this is the exact shape used by Deno.
  probeAbstract(Reflect.getPrototypeOf(Uint8Array));
  probeAbstract({
    prototype: Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]()),
  });
  probeAbstract({
    prototype: Reflect.getPrototypeOf(new Set()[Symbol.iterator]()),
  });
  probeAbstract({
    prototype: Reflect.getPrototypeOf(new Map()[Symbol.iterator]()),
  });
  probeAbstract({
    prototype: Reflect.getPrototypeOf(String.prototype[Symbol.iterator]()),
  });
  probeAbstract(Reflect.getPrototypeOf(function* () {}));
  probeAbstract(Reflect.getPrototypeOf(async function* () {}));

  // Mirrors makeSafe's two copyProps passes. In each pass Deno takes the keys
  // from the unsafe source, probes the safe destination descriptor, and then
  // reads the unsafe source descriptor.
  function probeCopyProps(src: any, dest: any, srcIndex: number, destIndex: number): void {
    if (failedTarget !== -1) return;
    const keys: any = getKeys(src, srcIndex);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      getDescriptor(dest, keys[keyIndex], destIndex, keyIndex);
      if (failedTarget !== -1 && failedOperation !== 3) return;
      // A missing destination descriptor is the normal reason makeSafe copies
      // a property, so do not retain operation 3 for that lookup.
      if (failedTarget === destIndex && failedOperation === 3) {
        failedTarget = -1;
        failedOperation = 0;
        failedKey = -1;
      }
      getDescriptor(src, keys[keyIndex], srcIndex, keyIndex);
      if (failedTarget !== -1) return;
    }
  }

  function probeMakeSafe(unsafe: any, safe: any): void {
    const unsafePrototypeIndex = nextTarget++;
    const safePrototypeIndex = nextTarget++;
    const unsafeConstructorIndex = nextTarget++;
    const safeConstructorIndex = nextTarget++;
    probeCopyProps(
      unsafe.prototype,
      safe.prototype,
      unsafePrototypeIndex,
      safePrototypeIndex,
    );
    probeCopyProps(unsafe, safe, unsafeConstructorIndex, safeConstructorIndex);
  }

  class SafeMap extends Map {
    constructor(i: any) {
      if (i == null) {
        super();
        return;
      }
      super(i);
    }
  }
  class SafeWeakMap extends WeakMap {}
  class SafeSet extends Set {}
  class SafeWeakSet extends WeakSet {}
  class SafeRegExp extends RegExp {}
  class SafeFinalizationRegistry extends FinalizationRegistry {}
  class SafeWeakRef extends WeakRef {}
  class SafePromise extends Promise {
    constructor(executor: any) {
      super(executor);
    }
  }

  probeMakeSafe(Map, SafeMap);
  probeMakeSafe(WeakMap, SafeWeakMap);
  probeMakeSafe(Set, SafeSet);
  probeMakeSafe(WeakSet, SafeWeakSet);
  probeMakeSafe(RegExp, SafeRegExp);
  probeMakeSafe(FinalizationRegistry, SafeFinalizationRegistry);
  probeMakeSafe(WeakRef, SafeWeakRef);
  probeMakeSafe(Promise, SafePromise);

  export function test(): number {
    return failedTarget === -1 ? 42 : 0;
  }
  export function failureTarget(): number { return failedTarget; }
  export function failureOperation(): number { return failedOperation; }
  export function failureKey(): number { return failedKey; }
  export function activeTarget(): number { return currentTarget; }
  export function activeOperation(): number { return currentOperation; }
  export function activeKey(): number { return currentKey; }
`;

// Keep the exact class-expression carrier shape from Deno's first makeSafe
// call independently runnable even when an earlier intrinsic-copy phase fails.
const MAKE_SAFE_MAP_SOURCE = `
  let failedTarget = -1;
  let failedOperation = 0;
  let failedKey = -1;
  let currentTarget = -1;
  let currentOperation = 0;
  let currentKey = -1;

  const {
    getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
    ownKeys: ReflectOwnKeys,
  } = Reflect;

  function getKeys(target: any, targetIndex: number): any {
    currentTarget = targetIndex;
    currentOperation = 1;
    currentKey = -1;
    try {
      return ReflectOwnKeys(target);
    } catch {
      failedTarget = targetIndex;
      failedOperation = 1;
      return [];
    }
  }

  function getDescriptor(target: any, key: any, targetIndex: number, keyIndex: number): any {
    currentTarget = targetIndex;
    currentOperation = 2;
    currentKey = keyIndex;
    try {
      return ReflectGetOwnPropertyDescriptor(target, key);
    } catch {
      failedTarget = targetIndex;
      failedOperation = 2;
      failedKey = keyIndex;
      return undefined;
    }
  }

  function copyProps(src: any, dest: any, srcIndex: number, destIndex: number): void {
    const keys: any = getKeys(src, srcIndex);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      // A missing safe descriptor is expected: makeSafe copies that property.
      getDescriptor(dest, keys[keyIndex], destIndex, keyIndex);
      if (failedTarget !== -1) return;
      getDescriptor(src, keys[keyIndex], srcIndex, keyIndex);
      if (failedTarget !== -1) return;
    }
  }

  function makeSafe(unsafe: any, safe: any): void {
    copyProps(unsafe.prototype, safe.prototype, 0, 1);
    if (failedTarget !== -1) return;
    copyProps(unsafe, safe, 2, 3);
  }

  makeSafe(
    Map,
    class SafeMap extends Map {
      constructor(i: any) {
        if (i == null) {
          super();
          return;
        }
        super(i);
      }
    },
  );

  export function test(): number { return failedTarget === -1 ? 42 : 0; }
  export function failureTarget(): number { return failedTarget; }
  export function failureOperation(): number { return failedOperation; }
  export function failureKey(): number { return failedKey; }
  export function activeTarget(): number { return currentTarget; }
  export function activeOperation(): number { return currentOperation; }
  export function activeKey(): number { return currentKey; }
`;

// `makeSafe` does not merely inspect the subclass prototype: every descriptor
// missing from it is copied with the extracted Reflect.defineProperty value.
// Keep that write/read-back seam isolated so admitting the target cannot hide
// a no-op descriptor applier for legacy builtin-subclass prototype carriers.
const INSTANCE_PROTOTYPE_DEFINE_SOURCE = `
  const {
    defineProperty: ReflectDefineProperty,
    getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
  } = Reflect;

  class SafeMap extends Map {}
  const prototype: any = SafeMap.prototype;

  export function test(): number {
    if (ReflectGetOwnPropertyDescriptor(prototype, "get") !== undefined) return 7;
    const source: any = ReflectGetOwnPropertyDescriptor(Map.prototype, "get");
    if (source === undefined) return 1;
    const accepted = ReflectDefineProperty(prototype, "get", source);
    const descriptor: any = ReflectGetOwnPropertyDescriptor(prototype, "get");
    if (!accepted) return 1;
    if (descriptor === undefined) return 2;
    if (descriptor.value !== source.value) return 3;
    if (source.writable !== true) return 14;
    if (descriptor.writable !== true) return 24;
    if (source.enumerable !== false) return 15;
    if (descriptor.enumerable === true) return 251;
    if (descriptor.enumerable === undefined) return 252;
    if (descriptor.enumerable === null) return 253;
    if (descriptor.enumerable !== false) return 254;
    if (source.configurable !== true) return 16;
    if (descriptor.configurable !== true) return 26;
    return 42;
  }

  export function failureTarget(): number { return -1; }
  export function failureOperation(): number { return 0; }
  export function failureKey(): number { return -1; }
  export function activeTarget(): number { return -1; }
  export function activeOperation(): number { return 0; }
  export function activeKey(): number { return -1; }
`;

function describeFailure(report: ProbeReport): string {
  const targetIndex = report.target === -1 ? report.activeTarget : report.target;
  const operationIndex = report.target === -1 ? report.activeOperation : report.operation;
  const keyIndex = report.target === -1 ? report.activeKey : report.key;
  const target = TARGET_LABELS[targetIndex] ?? `unknown target ${targetIndex}`;
  const operation =
    operationIndex === 1
      ? "Reflect.ownKeys"
      : operationIndex === 2
        ? "Reflect.getOwnPropertyDescriptor threw"
        : operationIndex === 3
          ? "Reflect.getOwnPropertyDescriptor returned undefined"
          : `unknown operation ${operationIndex}`;
  return `${operation} for ${target} at key index ${keyIndex}; module init threw: ${report.initThrew}`;
}

async function runProbe(source: string): Promise<ProbeReport> {
  const result = await compile(source, {
    target: "standalone",
    platform: "deno",
    fileName: "deno-primordials-reflection-phases.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

  const child = spawnSync(
    process.execPath,
    ["--experimental-wasm-exnref", "--input-type=module", "--eval", EXNREF_RUNNER],
    { input: result.binary, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  expect(child.status, child.stderr || child.stdout).toBe(0);
  return JSON.parse(child.stdout) as ProbeReport;
}

describe("Deno primordials reflection phases", () => {
  it("admits every namespace, intrinsic, abstract intrinsic, and makeSafe target", async () => {
    const report = await runProbe(SOURCE);
    expect(report.value, describeFailure(report)).toBe(42);
    expect(report.calls).toEqual([]);
    expect(report.target).toBe(-1);
  }, 180_000);

  it("admits the exact SafeMap class-expression prototype passed to makeSafe", async () => {
    const report = await runProbe(MAKE_SAFE_MAP_SOURCE);
    const labels = [
      "Map.prototype (makeSafe unsafe prototype)",
      "SafeMap.prototype (makeSafe safe prototype)",
      "Map (makeSafe unsafe constructor)",
      "SafeMap (makeSafe safe constructor)",
    ];
    const targetIndex = report.target === -1 ? report.activeTarget : report.target;
    const operation = report.target === -1 ? report.activeOperation : report.operation;
    const target = labels[targetIndex] ?? `unknown target ${targetIndex}`;
    expect(report.value, `Reflect operation ${operation} rejected ${target} at key index ${report.key}`).toBe(42);
    expect(report.calls).toEqual([]);
  }, 180_000);

  it("copies descriptors onto a builtin-subclass prototype through extracted Reflect methods", async () => {
    const report = await runProbe(INSTANCE_PROTOTYPE_DEFINE_SOURCE);
    expect(report.value, `descriptor write stage ${report.value}`).toBe(42);
    expect(report.calls).toEqual([]);
  }, 180_000);
});
