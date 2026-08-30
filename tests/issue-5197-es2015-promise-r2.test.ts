// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5197 — ES2015 Promise Symbol.species / Symbol.toStringTag object model.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, instantiateWasm } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");
const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" && existsSync(join(TEST262_ROOT, "harness", "assert.js"));

const EXACT_ROWS = [
  "built-ins/Promise/Symbol.species/prop-desc.js",
  "built-ins/Promise/Symbol.species/symbol-species.js",
  "built-ins/Promise/prototype/Symbol.toStringTag.js",
] as const;

// The species checks intentionally use both the syntactic constructor and an
// any-typed alias. The former exercises the canonical static gOPD/direct-key
// path; the latter reaches the materialized `$Object` carrier and verifies that
// its runtime accessor entry agrees with the synthesized descriptor. The
// prototype checks similarly flow through the native-prototype companion, so a
// tag that exists only in the immutable `$NativeProto` view cannot pass.
const CONTROL_SOURCE = `
  export function test(): number {
    const promiseCtor: any = Promise;
    const species: any = Promise[Symbol.species];
    if (species !== Promise) return 1;
    if (promiseCtor[Symbol.species] !== promiseCtor) return 2;

    const staticSpeciesDescriptor: any = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
    const dynamicSpeciesDescriptor: any = Object.getOwnPropertyDescriptor(promiseCtor, Symbol.species);
    if (
      staticSpeciesDescriptor === undefined ||
      typeof staticSpeciesDescriptor.get !== "function" ||
      staticSpeciesDescriptor.set !== undefined ||
      staticSpeciesDescriptor.enumerable !== false ||
      staticSpeciesDescriptor.configurable !== true
    ) return 3;
    if (
      dynamicSpeciesDescriptor === undefined ||
      dynamicSpeciesDescriptor.get !== staticSpeciesDescriptor.get ||
      dynamicSpeciesDescriptor.set !== undefined ||
      dynamicSpeciesDescriptor.enumerable !== false ||
      dynamicSpeciesDescriptor.configurable !== true
    ) return 4;

    const promiseProto: any = Promise.prototype;
    const tagKey: any = Symbol.toStringTag;
    if (promiseProto[tagKey] !== "Promise") return 5;
    if (!Object.prototype.hasOwnProperty.call(promiseProto, tagKey)) return 6;
    const tagDescriptor: any = Object.getOwnPropertyDescriptor(promiseProto, tagKey);
    if (
      tagDescriptor === undefined ||
      tagDescriptor.value !== "Promise" ||
      tagDescriptor.writable !== false ||
      tagDescriptor.enumerable !== false ||
      tagDescriptor.configurable !== true
    ) return 7;
    if (Object.prototype.propertyIsEnumerable.call(promiseProto, tagKey)) return 8;
    if (promiseProto[Symbol("toStringTag")] !== undefined) return 9;
    return 0;
  }
`;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number], lane: Lane) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-5197",
      120_000,
      lane === "standalone" ? lane : undefined,
    );
  } finally {
    // The host runner executes in-process. These descriptor rows deliberately
    // probe configurable properties with delete, so restore the shared host
    // realm before the next exact row (and before Vitest's strict rerun).
    restoreHostBuiltins();
  }
}

async function runControl(lane: Lane): Promise<number> {
  try {
    const result = await compile(CONTROL_SOURCE, {
      fileName: "issue-5197-es2015-promise-r2-control.ts",
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
  } finally {
    // Keep host compiler/runtime controls isolated as well; a future control
    // may add a destructive descriptor probe without weakening this harness.
    restoreHostBuiltins();
  }
}

describe("#5197 ES2015 Promise Symbol.species and Symbol.toStringTag", () => {
  it.skipIf(!TEST262_AVAILABLE).each(EXACT_ROWS)(
    "passes the exact host Test262 row %s",
    async (relativePath) => {
      const result = await runExactRow(relativePath, "host");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  it.skipIf(!TEST262_AVAILABLE).each(EXACT_ROWS)(
    "passes the exact standalone Test262 row %s",
    async (relativePath) => {
      const result = await runExactRow(relativePath, "standalone");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: keeps species and prototype tag descriptors aligned`, async () => {
      await expect(runControl(lane)).resolves.toBe(0);
    });
  }
});
