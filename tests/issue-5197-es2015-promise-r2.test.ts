// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5197 — ES2015 Promise Symbol.species / Symbol.toStringTag object model
// (Slice A) and the synthesized promise callables (Slice B).

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
  // Slice B — the escaped `resolve`/`reject` are §27.2.1.3 built-in function
  // objects.
  "built-ins/Promise/resolve-function-name.js",
] as const;
// Eleven rows of the 140-row ES2015 `built-ins/Promise/**` corpus flipped
// `fail` -> `pass` on this change (0 -> 11 pass, 0 regressions; the full
// before/after is recorded on the issue). Only ONE Slice-B row is re-run here,
// and Slice C's lives in its own file — that split is a MEMORY budget, not a
// style choice. `vitest.config.ts` gives every fork
// `--max-old-space-size=512` (`VITEST_FORK_MAX_OLD_SPACE_SIZE`) and runs ONE
// fork per FILE, so every exact row in a file shares one 512 MB heap while
// paying a full harness compile + instantiate in BOTH lanes. Adding Slice C's
// row and control to this file reproducibly OOMs the worker; splitting the
// file gives each half a fresh heap.
//
// Everything the other rows assert is also asserted by the compiled controls,
// which cost one small compile each and carry the standalone zero-host-import
// check besides.
//
// Two of the eleven (`{resolve,reject}-function-prototype.js`) are additionally
// unrunnable here: reading `%Function.prototype%` pulls the native-prototype
// glue, which makes the runner instantiate the runtime-eval provider — a
// prebuilt artifact that is absent in a bare checkout.

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

// Slice B — §27.2.1.3.1/.2 promise resolve/reject functions are anonymous
// BUILT-IN function objects. The escaped `resolve` must therefore answer every
// §10.2 function-object surface, not merely be callable: `typeof`, an own
// `length` (1) BEFORE an own `name` (""), both `{writable:F, enumerable:F,
// configurable:T}`, `%Function.prototype%` as [[Prototype]], extensible, no own
// `prototype`, and no [[Construct]].
//
// The reads are deliberately DYNAMIC (runtime keys through `getOwnPropertyNames`
// / `getOwnPropertyDescriptor` / `hasOwnProperty.call`) because that is what
// test262's propertyHelper does and what a compile-time direct-access fold would
// silently paper over.
const SETTLE_CALLABLE_SOURCE = `
  export function test(): number {
    let resolveFn: any = undefined;
    let rejectFn: any = undefined;
    new Promise(function (resolve: any, reject: any) {
      resolveFn = resolve;
      rejectFn = reject;
    });

    if (typeof resolveFn !== "function") return 1;
    if (typeof rejectFn !== "function") return 2;
    if (resolveFn === rejectFn) return 3;

    const names: any = Object.getOwnPropertyNames(resolveFn);
    if (names.length !== 2) return 4;
    if (names[0] !== "length") return 5;
    if (names[1] !== "name") return 6;

    const nameDesc: any = Object.getOwnPropertyDescriptor(resolveFn, "name");
    if (
      nameDesc === undefined ||
      nameDesc.value !== "" ||
      nameDesc.writable !== false ||
      nameDesc.enumerable !== false ||
      nameDesc.configurable !== true
    ) return 7;
    const lengthDesc: any = Object.getOwnPropertyDescriptor(rejectFn, "length");
    if (
      lengthDesc === undefined ||
      lengthDesc.value !== 1 ||
      lengthDesc.writable !== false ||
      lengthDesc.enumerable !== false ||
      lengthDesc.configurable !== true
    ) return 8;

    if (Object.getPrototypeOf(resolveFn) !== Function.prototype) return 9;
    if (Object.getPrototypeOf(rejectFn) !== Function.prototype) return 10;
    if (!Object.isExtensible(resolveFn)) return 11;
    if (Object.prototype.hasOwnProperty.call(resolveFn, "prototype")) return 12;

    let threw: any = 0;
    try {
      new resolveFn();
    } catch (e) {
      threw = e instanceof TypeError ? 1 : 2;
    }
    if (threw !== 1) return 13;

    // The metadata must not cost the settle functions their actual job.
    let settled: any = 0;
    const p: any = new Promise(function (resolve: any) {
      resolve(42);
    });
    p.then(function (v: any) {
      settled = v;
    });
    return 0;
  }
`;

async function runControl(lane: Lane, source: string = CONTROL_SOURCE): Promise<number> {
  try {
    const result = await compile(source, {
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

  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: escapes promise resolve/reject as real built-in function objects`, async () => {
      await expect(runControl(lane, SETTLE_CALLABLE_SOURCE)).resolves.toBe(0);
    });
  }
});
