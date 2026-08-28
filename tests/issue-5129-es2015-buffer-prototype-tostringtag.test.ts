// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5129 — ArrayBuffer/DataView prototype Symbol.toStringTag metadata.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, instantiateWasm } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");
const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" && existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const EXACT_ROWS = [
  "built-ins/ArrayBuffer/prototype/Symbol.toStringTag.js",
  "built-ins/DataView/prototype/Symbol.toStringTag.js",
] as const;

// Keep the key in an alias so these controls exercise the same dynamic
// well-known-symbol lookup as the corpus rows, rather than only a literal-key
// fold. All checks run inside Wasm, so the returned number is comparable in
// both the host and standalone lanes.
const CONTROL_SOURCE = `
  export function test(): number {
    const tagKey: any = Symbol.toStringTag;
    const alias: any = tagKey;
    const arrayBufferProto: any = ArrayBuffer.prototype;
    const dataViewProto: any = DataView.prototype;
    const mapProto: any = Map.prototype;
    const setProto: any = Set.prototype;

    if (arrayBufferProto === dataViewProto) return 1;
    if (arrayBufferProto[alias] !== "ArrayBuffer") return 2;
    if (dataViewProto[alias] !== "DataView") return 3;
    if (!(alias in arrayBufferProto) || !(alias in dataViewProto)) return 4;
    if (!Object.prototype.hasOwnProperty.call(arrayBufferProto, alias)) return 5;
    if (!Object.prototype.hasOwnProperty.call(dataViewProto, alias)) return 6;

    const arrayBufferDescriptor: any = Object.getOwnPropertyDescriptor(arrayBufferProto, alias);
    const dataViewDescriptor: any = Object.getOwnPropertyDescriptor(dataViewProto, alias);
    if (
      arrayBufferDescriptor === undefined ||
      arrayBufferDescriptor.value !== "ArrayBuffer" ||
      arrayBufferDescriptor.writable !== false ||
      arrayBufferDescriptor.enumerable !== false ||
      arrayBufferDescriptor.configurable !== true
    ) return 7;
    if (
      dataViewDescriptor === undefined ||
      dataViewDescriptor.value !== "DataView" ||
      dataViewDescriptor.writable !== false ||
      dataViewDescriptor.enumerable !== false ||
      dataViewDescriptor.configurable !== true
    ) return 8;
    if (Object.prototype.propertyIsEnumerable.call(arrayBufferProto, alias)) return 9;
    if (Object.prototype.propertyIsEnumerable.call(dataViewProto, alias)) return 10;
    if (arrayBufferProto[Symbol("toStringTag")] !== undefined) return 11;

    // A configurable redefinition must be observable and then restorable.
    let mutationCode = 0;
    if (!delete arrayBufferProto[alias]) mutationCode = 12;
    if (mutationCode === 0 && Object.prototype.hasOwnProperty.call(arrayBufferProto, alias)) mutationCode = 13;
    if (mutationCode === 0 && arrayBufferProto[alias] !== undefined) mutationCode = 14;
    if (mutationCode === 0) {
      Object.defineProperty(arrayBufferProto, alias, {
        value: "replacement",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      if (arrayBufferProto[alias] !== "replacement") mutationCode = 15;
      const replacementDescriptor: any = Object.getOwnPropertyDescriptor(arrayBufferProto, alias);
      if (
        mutationCode === 0 &&
        (replacementDescriptor === undefined ||
          replacementDescriptor.writable !== true ||
          replacementDescriptor.enumerable !== true ||
          replacementDescriptor.configurable !== true)
      ) mutationCode = 16;
    }
    Object.defineProperty(arrayBufferProto, alias, arrayBufferDescriptor);
    if (mutationCode === 0 && arrayBufferProto[alias] !== "ArrayBuffer") mutationCode = 17;
    if (mutationCode === 0 && !Object.prototype.hasOwnProperty.call(arrayBufferProto, alias)) mutationCode = 18;

    let dataViewMutationCode = 0;
    if (!delete dataViewProto[alias]) dataViewMutationCode = 19;
    if (dataViewMutationCode === 0 && Object.prototype.hasOwnProperty.call(dataViewProto, alias)) dataViewMutationCode = 20;
    if (dataViewMutationCode === 0 && dataViewProto[alias] !== undefined) dataViewMutationCode = 21;
    if (dataViewMutationCode === 0) {
      Object.defineProperty(dataViewProto, alias, {
        value: "replacement",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      if (dataViewProto[alias] !== "replacement") dataViewMutationCode = 22;
    }
    Object.defineProperty(dataViewProto, alias, dataViewDescriptor);
    if (dataViewMutationCode === 0 && dataViewProto[alias] !== "DataView") dataViewMutationCode = 23;
    if (dataViewMutationCode === 0 && !Object.prototype.hasOwnProperty.call(dataViewProto, alias)) dataViewMutationCode = 24;
    if (mutationCode !== 0) return mutationCode;
    if (dataViewMutationCode !== 0) return dataViewMutationCode;

    // Existing member/accessor metadata and prototype identity survive the
    // tag mutation. These are ordinary members of the same native records.
    if (ArrayBuffer.prototype !== arrayBufferProto || DataView.prototype !== dataViewProto) return 25;
    if (typeof arrayBufferProto.slice !== "function") return 26;
    if (typeof dataViewProto.getUint8 !== "function") return 27;
    const dataViewBufferDescriptor: any = Object.getOwnPropertyDescriptor(dataViewProto, "buffer");
    if (dataViewBufferDescriptor === undefined || typeof dataViewBufferDescriptor.get !== "function") return 28;

    // Current-main controls for the shared symbol seeder.
    if (mapProto[tagKey] !== "Map" || setProto[tagKey] !== "Set") return 29;
    const mapDescriptor: any = Object.getOwnPropertyDescriptor(mapProto, tagKey);
    const setDescriptor: any = Object.getOwnPropertyDescriptor(setProto, tagKey);
    if (
      mapDescriptor === undefined ||
      mapDescriptor.value !== "Map" ||
      mapDescriptor.writable !== false ||
      mapDescriptor.enumerable !== false ||
      mapDescriptor.configurable !== true
    ) return 30;
    if (
      setDescriptor === undefined ||
      setDescriptor.value !== "Set" ||
      setDescriptor.writable !== false ||
      setDescriptor.enumerable !== false ||
      setDescriptor.configurable !== true
    ) return 31;
    if (mapProto === setProto) return 32;

    // SharedArrayBuffer is an ES2017 sibling. Keep its prototype and ordinary
    // member materialization as a no-regression control without claiming its
    // own tag in this ES2015 slice.
    const sharedProto: any = SharedArrayBuffer.prototype;
    if (sharedProto === arrayBufferProto || typeof sharedProto.slice !== "function") return 33;

    if (Object.prototype.toString.call(new ArrayBuffer(8)) !== "[object ArrayBuffer]") return 34;
    if (Object.prototype.toString.call(new DataView(new ArrayBuffer(8))) !== "[object DataView]") return 35;
    return 0;
  }
`;

async function runControl(lane: Lane): Promise<number> {
  const result = await compile(CONTROL_SOURCE, {
    fileName: "issue-5129-es2015-buffer-prototype-tostringtag.ts",
    ...(lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {}),
  });
  expect(
    result.success,
    result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
  ).toBe(true);
  if (!result.success) return -1;

  if (lane === "standalone") {
    expect(result.imports?.length ?? 0, "standalone control must remain host-free").toBe(0);
  }
  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    built.env,
    built.string_constants,
    built.string_constants16,
  );
  built.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

describe("#5129 ES2015 ArrayBuffer/DataView prototype Symbol.toStringTag", () => {
  it.skipIf(!TEST262_AVAILABLE).each(EXACT_ROWS)(
    "passes the exact host Test262 row %s",
    async (relativePath) => {
      const result = await runTest262File(join(TEST262_ROOT, "test", relativePath), "issue-5129", 120_000);
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  it.skipIf(!TEST262_AVAILABLE).each(EXACT_ROWS)(
    "passes the exact standalone Test262 row %s",
    async (relativePath) => {
      const result = await runTest262File(
        join(TEST262_ROOT, "test", relativePath),
        "issue-5129",
        120_000,
        "standalone",
      );
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: preserves exact descriptors, dynamic lookup, mutation, and branding`, async () => {
      await expect(runControl(lane)).resolves.toBe(0);
    });
  }
});
