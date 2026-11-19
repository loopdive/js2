// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 B2a — the global object's population (`native-realm-globals.ts`) against node 22's `globalThis`:
// attributes, typeof tag, `length`, `name` and constructibility for every entry node has. `Float16Array`
// (ES2025) is absent in node 22; its row is checked by the spec values written there.
import { describe, expect, it } from "vitest";
import { NATIVE_REALM_CATALOG } from "../src/runtime/contracts/native-realm-catalog.js";
import {
  NATIVE_REALM_GLOBALS,
  nativeRealmGlobalSurface,
  nativeRealmGlobalTypeof,
} from "../src/runtime/contracts/native-realm-globals.js";

const isConstructor = (value: unknown): boolean => {
  try {
    Reflect.construct(String, [], value as new () => unknown);
    return true;
  } catch {
    return false;
  }
};

const NODE_ABSENT = new Set(["Float16Array"]);

/** node 22's own globals that ECMA-262 does not define (ECMA-402's `Intl`, the web platform, node, CommonJS). */
const NODE_HOST_GLOBALS = new Set(
  `Intl console process global Buffer clearImmediate setImmediate URL URLSearchParams DOMException AbortController
  AbortSignal Event EventTarget TextEncoder TextDecoder TransformStream TransformStreamDefaultController
  WritableStream WritableStreamDefaultController WritableStreamDefaultWriter ReadableStream
  ReadableStreamDefaultReader ReadableStreamBYOBReader ReadableStreamBYOBRequest ReadableByteStreamController
  ReadableStreamDefaultController ByteLengthQueuingStrategy CountQueuingStrategy TextEncoderStream
  TextDecoderStream CompressionStream DecompressionStream clearInterval clearTimeout setInterval setTimeout
  queueMicrotask structuredClone atob btoa BroadcastChannel MessageChannel MessagePort Blob File Performance
  PerformanceEntry PerformanceMark PerformanceMeasure PerformanceObserver PerformanceObserverEntryList
  PerformanceResourceTiming performance fetch FormData Headers Request Response MessageEvent WebSocket
  WebAssembly Navigator navigator crypto Crypto CryptoKey SubtleCrypto CustomEvent`.split(/\s+/),
);

describe("#7350 B2a — the global object's population", () => {
  it.each(NATIVE_REALM_GLOBALS.filter((row) => !NODE_ABSENT.has(row.name)).map((row) => [row.name, row] as const))(
    "%s answers as node's globalThis",
    (name, row) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)!;
      expect(descriptor).toBeDefined();
      expect({ writable: row.writable, enumerable: false, configurable: row.configurable }).toEqual({
        writable: descriptor.writable,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
      });
      expect(nativeRealmGlobalTypeof(name)).toBe(typeof descriptor.value);
      if (row.value.kind === "global-object") expect(descriptor.value).toBe(globalThis);
      if (row.value.kind === "number") expect(Object.is(row.value.value, descriptor.value)).toBe(true);
      if (row.value.kind === "intrinsic" && row.value.typeof === "function") {
        const fn = descriptor.value as (...args: unknown[]) => unknown;
        expect([row.value.length, name, row.value.constructible]).toEqual([fn.length, fn.name, isConstructor(fn)]);
      }
    },
  );

  it("lists every ECMAScript global node 22 has", () => {
    const listed = new Set(NATIVE_REALM_GLOBALS.map((row) => row.name));
    const unlisted = Object.getOwnPropertyNames(globalThis).filter((name) => !listed.has(name));
    // `gc` (`--expose-gc`) and `__vitest_*__` are the test runner's own.
    const foreign = (name: string) => NODE_HOST_GLOBALS.has(name) || name === "gc" || /^__vitest_\w+__$/.test(name);
    expect(unlisted.filter((name) => !foreign(name))).toEqual([]);
  });

  it("names each intrinsic once and marks the catalog's rows complete", () => {
    const ids = NATIVE_REALM_GLOBALS.flatMap((row) => (row.value.kind === "intrinsic" ? [row.value.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    const catalog = new Set(NATIVE_REALM_CATALOG.intrinsics.map((row) => row.id));
    expect(ids.filter((id) => nativeRealmGlobalSurface(id) === "complete")).toEqual(
      ids.filter((id) => catalog.has(id)),
    );
    expect(nativeRealmGlobalSurface("%Object%")).toBe("complete");
    expect(nativeRealmGlobalSurface("%TypeError%")).toBe("identity");
  });

  it("answers undefined for a name that is not a global of the realm", () => {
    expect(nativeRealmGlobalTypeof("console")).toBeUndefined();
    expect(nativeRealmGlobalTypeof("Intl")).toBeUndefined();
  });

  it("keeps the frozen value properties and the Annex B functions apart", () => {
    expect(nativeRealmGlobalTypeof("NaN")).toBe("number");
    expect(nativeRealmGlobalTypeof("undefined")).toBe("undefined");
    expect(NATIVE_REALM_GLOBALS.filter((row) => row.legacy).map((row) => row.name)).toEqual(["escape", "unescape"]);
  });
});
