// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5152 — `String.raw` must observe the ordinary property semantics of a
 * closed `raw` struct.  The three original ES2015 failures cover an accessor
 * `length`, accessor numeric keys, and a symbol-valued numeric field.  The two
 * physical-field controls make descriptor precedence explicit: the bag entry
 * must win even when a compiled struct already has a `length` or `"0"` slot.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const RAW_READER_SOURCE = `
  export function test() {
    let checks = 0;

    // ES2015 template-length-throws: a descriptor-only length on an empty
    // closed struct is an ordinary Get, and it runs before substitution coercion.
    let order = "";
    const substitution = {
      toString: function () {
        order += "S";
        return "unused";
      }
    };
    const lengthTemplate = { raw: {} };
    const lengthOnly = lengthTemplate.raw;
    const lengthOnlyError = new Error("length-only");
    Object.defineProperty(lengthOnly, "length", {
      get: function () {
        order += "L";
        throw lengthOnlyError;
      }
    });
    try {
      // @ts-ignore -- Test262 intentionally permits an accessor-only raw.
      String.raw(lengthTemplate, substitution);
    } catch (error) {
      if (error === lengthOnlyError && order === "L") checks += 1;
    }

    // ES2015 returns-abrupt-from-next-key, including delete/reassignment and
    // redefinition.  The first accessor exists only in the carrier bag.
    const indexOnly = { length: 2 };
    const indexTemplate = { raw: indexOnly };
    const indexZeroError = new Error("index-zero");
    Object.defineProperty(indexOnly, "0", {
      configurable: true,
      get: function () {
        throw indexZeroError;
      }
    });
    try {
      // @ts-ignore -- Test262's raw segment is defined dynamically.
      String.raw(indexTemplate);
    } catch (error) {
      if (error === indexZeroError) checks += 2;
    }
    // #5152-host-delete-reassign-start
    delete indexOnly["0"];
    let indexTrace = "";
    indexOnly["0"] = {
      toString: function () {
        indexTrace += "0";
        return "a";
      }
    };
    const indexOneError = new Error("index-one");
    Object.defineProperty(indexOnly, "1", {
      get: function () {
        indexTrace += "1";
        throw indexOneError;
      }
    });
    try {
      // @ts-ignore -- Test262's raw segment is defined dynamically.
      String.raw(indexTemplate);
    } catch (error) {
      if (error === indexOneError && indexTrace === "01") checks += 4;
    }
    // #5152-host-delete-reassign-end

    // A bag descriptor must override a physical field, not merely fill an
    // absent field.  These are deliberately separate: the length accessor
    // would otherwise prevent the "0" getter from being reached.
    const lengthOverrideTemplate = { raw: { length: 1, 0: "stale" } };
    const lengthOverride = lengthOverrideTemplate.raw;
    const physicalLengthError = new Error("physical-length");
    Object.defineProperty(lengthOverride, "length", {
      get: function () {
        throw physicalLengthError;
      }
    });
    try {
      // @ts-ignore -- Descriptor semantics, rather than TS array shape, matter.
      String.raw(lengthOverrideTemplate);
    } catch (error) {
      if (error === physicalLengthError) checks += 8;
    }

    const indexOverrideTemplate = { raw: { length: 1, 0: "stale" } };
    const indexOverride = indexOverrideTemplate.raw;
    const physicalIndexError = new Error("physical-index");
    Object.defineProperty(indexOverride, "0", {
      get: function () {
        throw physicalIndexError;
      }
    });
    try {
      // @ts-ignore -- Descriptor semantics, rather than TS array shape, matter.
      String.raw(indexOverrideTemplate);
    } catch (error) {
      if (error === physicalIndexError) checks += 16;
    }

    // A getter is invoked with the raw receiver, never the carrier bag.
    const receiverTemplate = { raw: { length: 1 } };
    const receiverRaw = receiverTemplate.raw;
    const receiverError = new Error("receiver");
    const wrongReceiverError = new Error("wrong-receiver");
    Object.defineProperty(receiverRaw, "0", {
      get: function () {
        if (this !== receiverRaw) throw wrongReceiverError;
        throw receiverError;
      }
    });
    try {
      // @ts-ignore -- The numeric segment is dynamically defined.
      String.raw(receiverTemplate);
    } catch (error) {
      if (error === receiverError) checks += 512;
    }

    // Undefined is a present descriptor value, not a signal to use the
    // stale physical slot. The getter observation rules out absence fallback.
    const undefinedTemplate = { raw: { length: 1, 0: "stale" } };
    const undefinedRaw = undefinedTemplate.raw;
    let undefinedReads = 0;
    Object.defineProperty(undefinedRaw, "0", {
      get: function () {
        undefinedReads += 1;
        return undefined;
      }
    });
    // @ts-ignore -- The numeric segment is dynamically defined.
    try {
      const undefinedSegment = String.raw(undefinedTemplate);
      if (undefinedReads === 1 && undefinedSegment === "undefined") checks += 1024;
    } catch (error) {
      // A broken undefined path is recorded as a missing bit, not a fixture abort.
    }

    // Static accessor registration is compilation metadata, not proof that a
    // descriptor has been installed on THIS object. Before the define executes,
    // the ordinary physical segment must remain observable; afterwards the
    // exact getter sentinel must win it.
    const temporalRaw = { length: 1, 0: "before" };
    const temporalTemplate = { raw: temporalRaw };
    const temporalError = new Error("temporal");
    try {
      if (String.raw(temporalTemplate) === "before") checks += 2048;
    } catch (error) {
      // A compile-time-only accessor dispatch is a failed pre-define control.
    }
    Object.defineProperty(temporalRaw, "0", {
      get: function () {
        throw temporalError;
      }
    });
    try {
      String.raw(temporalTemplate);
    } catch (error) {
      if (error === temporalError) checks += 4096;
    }

    // An untaken defineProperty branch must not change another ordinary read;
    // the matching taken branch independently proves the later installation.
    const falseBranchRaw = { length: 1, 0: "false-branch" };
    const falseBranchTemplate = { raw: falseBranchRaw };
    const falseBranchError = new Error("false-branch");
    let falseBranch = false;
    if (falseBranch) {
      Object.defineProperty(falseBranchRaw, "0", {
        get: function () {
          throw falseBranchError;
        }
      });
    }
    try {
      if (String.raw(falseBranchTemplate) === "false-branch") checks += 8192;
    } catch (error) {
      // A globally registered getter is not a live descriptor in this branch.
    }

    const trueBranchRaw = { length: 1, 0: "true-branch" };
    const trueBranchTemplate = { raw: trueBranchRaw };
    const trueBranchError = new Error("true-branch");
    let trueBranch = true;
    if (trueBranch) {
      Object.defineProperty(trueBranchRaw, "0", {
        get: function () {
          throw trueBranchError;
        }
      });
    }
    try {
      String.raw(trueBranchTemplate);
    } catch (error) {
      if (error === trueBranchError) checks += 16384;
    }

    // Two same-shaped values do not share a descriptor. Defining the first
    // must not make the untouched second value invoke its getter.
    const firstSameShapeRaw = { length: 1, 0: "first" };
    const firstSameShapeTemplate = { raw: firstSameShapeRaw };
    const secondSameShapeRaw = { length: 1, 0: "second" };
    const secondSameShapeTemplate = { raw: secondSameShapeRaw };
    const sameShapeError = new Error("same-shape");
    Object.defineProperty(firstSameShapeRaw, "0", {
      get: function () {
        throw sameShapeError;
      }
    });
    try {
      String.raw(firstSameShapeTemplate);
    } catch (error) {
      if (error === sameShapeError) checks += 32768;
    }
    try {
      if (String.raw(secondSameShapeTemplate) === "second") checks += 65536;
    } catch (error) {
      // A per-shape getter would incorrectly affect this untouched instance.
    }

    // ES2015 nextkey-is-symbol-throws. The 0 field is an i32 symbol handle
    // in the closed representation, so its dynamic read must box as $Symbol,
    // not as a number, before String.raw's existing ToString guard runs.
    const symbolTemplate = { raw: { length: 1, 0: Symbol("") } };
    try {
      // @ts-ignore -- This intentionally violates the string segment type.
      String.raw(symbolTemplate);
    } catch (error) {
      if (error instanceof TypeError) checks += 32;
    }

    // Existing #3147 controls: nullish template/raw, empty/missing length, and
    // ordinary segment/substitution interleaving remain intact.
    let nullish = 0;
    try {
      // @ts-ignore -- Explicit nullish boundary control.
      String.raw(undefined);
    } catch (error) { if (error instanceof TypeError) nullish++; }
    try {
      // @ts-ignore -- Explicit nullish boundary control.
      String.raw({ raw: null });
    } catch (error) { if (error instanceof TypeError) nullish++; }
    if (nullish === 2) checks += 64;
    const emptyRaw = {};
    const emptyTemplate = { raw: emptyRaw };
    // @ts-ignore -- Empty raw is a valid runtime input.
    if (String.raw(emptyTemplate) === "") checks += 128;
    const positive = { length: 2, 0: "a", 1: "b" };
    const positiveTemplate = { raw: positive };
    if (String.raw(positiveTemplate, "X") === "aXb") checks += 256;

    return checks;
  }
`;

const NATIVE_FIRST_POSITIVE_SOURCE = `
  export function test() {
    const raw = { length: 2, 0: "a", 1: "b" };
    const template = { raw };
    return String.raw(template, "X");
  }
`;

// No user closures, classes, arrays, or generators occur in this source. The
// dynamic receiver is the nested raw value, matching the original `indexOnly`
// allocation shape. Keeping the outer template literal untouched prevents the
// growable-literal prepass from deliberately promoting a direct receiver
// literal to an open $Object carrier before this anonymous-arm probe runs.
const ANONYMOUS_EXPANDO_DELETE_SOURCE = `
  export function test() {
    let checks = 0;
    const key = "expando";
    const firstTemplate = { raw: { length: 1 } };
    const secondTemplate = { raw: { length: 1 } };
    const first = firstTemplate.raw;
    const second = secondTemplate.raw;
    const lengthKey = "length";

    // Define both bags before either deletion. A shared-bag bug would then
    // make first's delete erase second's independently defined entry.
    Object.defineProperty(first, key, { value: 41, configurable: true });
    Object.defineProperty(second, key, { value: 9, configurable: true });
    if (first[key] === 41) checks += 1;
    if (delete first[key]) checks += 2;
    if (first[key] === undefined) checks += 4;
    if (delete first[key]) checks += 8;
    if (first[lengthKey] === 1) checks += 256;

    // A same-shape second receiver must retain its independently defined bag
    // entry after first's delete, before its own delete can change the result.
    if (second[key] === 9) checks += 16;
    if (delete second[key] && second[key] === undefined) checks += 32;

    // Symbols never collide with a physical string field and retain their
    // identity through the stored '$PropEntry.key' route.
    const symbol = Symbol("anon-delete");
    Object.defineProperty(first, symbol, { value: 7, configurable: true });
    if (delete first[symbol] && first[symbol] === undefined) checks += 64;

    // The delegated ordinary delete must still refuse a non-configurable bag
    // entry; it cannot collapse the answer into the non-object fallback.
    const lockedTemplate = { raw: { length: 1 } };
    const locked = lockedTemplate.raw;
    Object.defineProperty(locked, key, { value: 3 });
    // Module source is strict, where a failed 'delete' would throw instead of
    // yielding false. Reflect keeps this non-configurable refusal check
    // language-mode-neutral; strict-delete throwing is a separate control.
    if (Reflect.deleteProperty(locked, key) === false && locked[key] === 3) checks += 128;

    return checks;
  }
`;

// This is a diagnostic baseline-limitation fixture, not a conformance claim.
// It exercises physical `length`, empty, `$`, `__`, and constructor spellings
// so the candidate selector must decline them rather than exposing stale
// storage. Its compiled standalone result is recorded separately because the
// underlying physical-field delete path is not yet ordinary-delete complete.
const ANONYMOUS_EXPANDO_PHYSICAL_DELETE_SNAPSHOT_SOURCE = `
  export function test() {
    let checks = 0;
    const physicalTemplate = { raw: {
      length: 1,
      "": "empty",
      "$keep": "dollar",
      "__keep": "under",
      "$constructor": "dollar-constructor"
    } };
    const target = physicalTemplate.raw;
    const lengthKey = "length";
    const emptyKey = "";
    const dollarKey = "$keep";
    const underKey = "__keep";
    const dollarConstructorKey = "$constructor";
    // The current dynamic reader maps a '$constructor' field to both spelling
    // surfaces. Both must remain covered by this delete arm's physical union.
    const constructorKey = "constructor";
    Object.defineProperty(target, lengthKey, { value: 10, configurable: true });
    Object.defineProperty(target, emptyKey, { value: "empty-override", configurable: true });
    Object.defineProperty(target, dollarKey, { value: "dollar-override", configurable: true });
    Object.defineProperty(target, underKey, { value: "under-override", configurable: true });
    Object.defineProperty(target, dollarConstructorKey, { value: "dollar-constructor-override", configurable: true });
    Object.defineProperty(target, constructorKey, { value: "constructor-override", configurable: true });
    if (delete target[lengthKey] && target[lengthKey] === 10) checks += 1;
    if (delete target[emptyKey] && target[emptyKey] === "empty-override") checks += 2;
    if (delete target[dollarKey] && target[dollarKey] === "dollar-override") checks += 4;
    if (delete target[underKey] && target[underKey] === "under-override") checks += 8;
    if (delete target[dollarConstructorKey] && target[dollarConstructorKey] === "dollar-constructor-override") checks += 16;
    if (delete target[constructorKey] && target[constructorKey] === "constructor-override") checks += 32;

    return checks;
  }
`;

// This deliberately uses public operator and Reflect routes. A key object's
// toString must run exactly once per deletion: the anonymous carrier helper may
// reuse the `$PropEntry` key after lookup, but must not replay user coercion.
const ANONYMOUS_EXPANDO_DELETE_COERCION_SOURCE = `
  export function test() {
    let calls = 0;
    const firstTemplate = { raw: { length: 1 } };
    const secondTemplate = { raw: { length: 1 } };
    const first = firstTemplate.raw;
    const second = secondTemplate.raw;
    const lengthKey = "length";
    Object.defineProperty(first, "expando", { value: 1, configurable: true });
    Object.defineProperty(second, "expando", { value: 2, configurable: true });
    const firstKey = {
      toString: function () {
        calls += 1;
        return "expando";
      }
    };
    const secondKey = {
      toString: function () {
        calls += 1;
        return "expando";
      }
    };
    // Keep both receivers concretely inferred. Only the dynamic key needs the
    // TypeScript escape hatch; annotating either receiver as any would route
    // this probe through the open-object lowering instead of the closed arm.
    const operatorDeleted = delete first[firstKey as any];
    const reflectDeleted = Reflect.deleteProperty(second, secondKey as any);
    return operatorDeleted && reflectDeleted && calls === 2 && first[lengthKey] === 1 &&
      first["expando"] === undefined && second["expando"] === undefined ? 1 : 0;
  }
`;

// This stays separate from the language-mode-neutral Reflect control above:
// ES modules are strict, so a failed operator delete of a non-configurable
// bag entry must throw rather than merely return false.
const ANONYMOUS_EXPANDO_STRICT_DELETE_SOURCE = `
  export function test() {
    const template = { raw: { length: 1 } };
    const target = template.raw;
    Object.defineProperty(target, "locked", { value: 3 });
    try {
      delete target["locked"];
      return 0;
    } catch (error) {
      return error instanceof TypeError && target["locked"] === 3 ? 1 : 0;
    }
  }
`;

// A closed field named `@@iterator` can denote an actual well-known Symbol
// slot. Until the delete native has exact Symbol-field inventory, this fixture
// records the baseline behavior for that receiver and the distinct ordinary
// string spelling. It is deliberately not asserted as Symbol-delete
// conformance.
const ANONYMOUS_EXPANDO_SYMBOL_COLLISION_SOURCE = `
  export function test() {
    const symbolTemplate = { raw: { length: 1, [Symbol.iterator]: "physical-symbol" } };
    const stringTemplate = { raw: { length: 1, "@@iterator": "physical-string" } };
    const symbolTarget = symbolTemplate.raw;
    const stringTarget = stringTemplate.raw;
    const symbolKey = Symbol.iterator;
    const stringKey = "@@iterator";
    Object.defineProperty(symbolTarget, symbolKey, { value: "symbol-override", configurable: true });
    Object.defineProperty(stringTarget, stringKey, { value: "string-override", configurable: true });
    const symbolRetained = delete symbolTarget[symbolKey] &&
      symbolTarget[symbolKey] === "symbol-override";
    const stringRetained = delete stringTarget[stringKey] &&
      stringTarget[stringKey] === "string-override";
    return (symbolRetained ? 1 : 0) + (stringRetained ? 2 : 0);
  }
`;

const FULL_READER_MASK = 131071;
const ANONYMOUS_EXPANDO_DELETE_MASK = 511;
// Read-only 4a6 evidence: JS-host compilation has the same descriptor-reader
// deficit even when the delete/reassignment sequence is removed. This records
// the pre-existing mask rather than presenting host parity as a #5152 result.
// Present: symbol (32), ordinary controls (64/128/256), receiver (512), and
// same-shape isolation (65536). Missing: descriptor length/index/override,
// present-undefined, and temporal/branch accessor bits
// (1/2/8/16/1024/2048/4096/8192/16384/32768). See #5152's host residual.
const HOST_DESCRIPTOR_BASELINE_MASK = 66528;
const HOST_COMPATIBLE_RAW_READER_SOURCE = RAW_READER_SOURCE.replace(
  /\n {4}\/\/ #5152-host-delete-reassign-start[\s\S]*? {4}\/\/ #5152-host-delete-reassign-end\n/,
  "\n",
);

async function runStandalone(source: string, fileName = "issue-5152-raw-readers.js"): Promise<number> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

type ThrownObservation =
  | { readonly kind: "error"; readonly name: string; readonly message: string }
  | { readonly kind: "object" }
  | { readonly kind: "primitive"; readonly value: string };

function observeThrown(error: unknown): ThrownObservation {
  if (error instanceof Error) return { kind: "error", name: error.name, message: error.message };
  if (typeof error === "object" && error !== null) return { kind: "object" };
  return { kind: "primitive", value: String(error) };
}

/**
 * Keep known standalone limitations out of positive tests. It records exactly
 * whether compilation, validation, instantiation, or the exported call fails,
 * rather than conflating a guest exception with invalid Wasm.
 */
async function observeStandalone(source: string, fileName: string) {
  const result = await compile(source, { fileName, target: "standalone" });
  const reportedImports = result.imports;
  if (!result.success) {
    return {
      stage: "compile" as const,
      reportedImports,
      errors: result.errors.map(({ severity, message }) => ({ severity, message })),
    };
  }

  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(result.binary);
  } catch (error) {
    return { stage: "module" as const, reportedImports, error: observeThrown(error) };
  }
  const imports = WebAssembly.Module.imports(module);
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(module, {});
  } catch (error) {
    return { stage: "instance" as const, reportedImports, imports, error: observeThrown(error) };
  }
  try {
    return {
      stage: "invoke" as const,
      reportedImports,
      imports,
      value: (instance.exports as { test(): number }).test(),
    };
  } catch (error) {
    return { stage: "invoke-throw" as const, reportedImports, imports, error: observeThrown(error) };
  }
}

async function compileStandaloneWithWat(source: string, fileName: string) {
  const result = await compile(source, { fileName, target: "standalone", emitWat: true });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  // Artifact capture is opt-in so normal focused tests stay side-effect free.
  // The structural assertions below must be derived from the exact WAT that
  // ran, rather than a formatter label or a guessed source-local name.
  const artifactDir = process.env.JS2WASM_5152_WAT_DIR;
  if (artifactDir !== undefined) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, `${fileName}.wat`), result.wat);
  }
  return result;
}

function watFunctionBody(wat: string, name: string): string {
  const starts = [...wat.matchAll(/^[ \t]*\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  const matches = starts.flatMap((entry, index) =>
    entry.name === name ? [wat.slice(entry.index, starts[index + 1]?.index ?? wat.length)] : [],
  );
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!;
}

function watCallTargets(wat: string, body: string): string[] {
  const imports = [...wat.matchAll(/^[ \t]*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^[ \t]*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  if (new Set(names).size !== names.length) throw new Error("WAT callable names are not unique");
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])];
    if (!target) throw new Error(`WAT call ${match[1]} has no exact callable target`);
    return target;
  });
}

async function runHost<T>(source: string): Promise<T> {
  const result = await compile(source, { fileName: "issue-5152-raw-readers-host.js" });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as unknown as { test(): T }).test();
}

async function runNativeFirst<T>(source: string): Promise<T> {
  const result = await compile(source, {
    fileName: "issue-5152-raw-readers-native-first.js",
    semanticProviders: "native-first",
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as unknown as { test(): T }).test();
}

function runDirectNodeOracle(source: string): number {
  const script = source
    .replace("export function test(): number", "function test()")
    .replace("export function test()", "function test()")
    .replaceAll(": any", "")
    .replaceAll(" as any", "");
  return new Function(`${script}\nreturn test();`)() as number;
}

function runStrictDirectNodeOracle(source: string): number {
  const script = source
    .replace("export function test(): number", "function test()")
    .replace("export function test()", "function test()")
    .replaceAll(": any", "")
    .replaceAll(" as any", "");
  return new Function(`"use strict";\n${script}\nreturn test();`)() as number;
}

describe("#5152 closed-struct String.raw readers", () => {
  it("uses ordinary Get/ToLength/index semantics without host imports", async () => {
    expect(await runStandalone(RAW_READER_SOURCE)).toBe(FULL_READER_MASK);
  });

  it("keeps the complete direct-Node oracle matrix positive", () => {
    expect(runDirectNodeOracle(RAW_READER_SOURCE)).toBe(FULL_READER_MASK);
  });

  it("keeps the documented host delete/reassignment blocker observable", async () => {
    await expect(runHost<number>(RAW_READER_SOURCE)).rejects.toThrow(
      "Cannot set property 0 of #<Object> which has only a getter",
    );
  });

  it("preserves the verified 4a6 host descriptor-deficit snapshot", async () => {
    expect(await runHost<number>(HOST_COMPATIBLE_RAW_READER_SOURCE)).toBe(HOST_DESCRIPTOR_BASELINE_MASK);
  });

  it("keeps the native-first JavaScript boundary positive", async () => {
    expect(await runNativeFirst<string>(NATIVE_FIRST_POSITIVE_SOURCE)).toBe("aXb");
  });

  describe("anonymous true-expando deletion", () => {
    it("keeps the direct-Node oracle positive", () => {
      expect(runDirectNodeOracle(ANONYMOUS_EXPANDO_DELETE_SOURCE)).toBe(ANONYMOUS_EXPANDO_DELETE_MASK);
    });

    it("deletes independently owned string and Symbol bag entries without host imports", async () => {
      expect(await runStandalone(ANONYMOUS_EXPANDO_DELETE_SOURCE, "issue-5152-anonymous-expando-delete.js")).toBe(
        ANONYMOUS_EXPANDO_DELETE_MASK,
      );
    });

    it("captures a reviewable anonymous-delete helper artifact when requested", async () => {
      const result = await compileStandaloneWithWat(
        ANONYMOUS_EXPANDO_DELETE_SOURCE,
        "issue-5152-anonymous-expando-delete-artifact.js",
      );
      const carrierDelete = watFunctionBody(result.wat, "__carrier_bag_delete");
      // These identifiers are emitted only by this consumer-only arm. They
      // establish that an anonymous lookup/screen path was filled, but not
      // that a formatter's local/type labels identify a particular source
      // allocation. The persisted artifact is the input to that separate
      // producer-to-slot audit.
      expect(carrierDelete).toContain("$anonCandidate");
      expect(carrierDelete).toContain("$anonEntry");
      expect(watCallTargets(result.wat, carrierDelete)).toEqual(
        expect.arrayContaining(["__closure_bag_lookup", "__obj_find", "__delete_property"]),
      );
    });
  });

  describe("known standalone deletion limitations (not conformance)", () => {
    it("records the unchanged strict failed-delete validation error", async () => {
      expect(runStrictDirectNodeOracle(ANONYMOUS_EXPANDO_STRICT_DELETE_SOURCE)).toBe(1);
      const observation = await observeStandalone(
        ANONYMOUS_EXPANDO_STRICT_DELETE_SOURCE,
        "issue-5152-anon-delete-strict.js",
      );
      expect(observation.stage).toBe("module");
      if (observation.stage !== "module") throw new Error(`expected module error, got ${observation.stage}`);
      expect(observation.reportedImports).toEqual([]);
      expect(observation.error).toMatchObject({
        kind: "error",
        name: "CompileError",
        message: expect.stringContaining("type error in fallthru"),
      });
    });

    it("records the coercion-path validation limitation before asserting delete semantics", async () => {
      expect(runDirectNodeOracle(ANONYMOUS_EXPANDO_DELETE_COERCION_SOURCE)).toBe(1);
      const observation = await observeStandalone(
        ANONYMOUS_EXPANDO_DELETE_COERCION_SOURCE,
        "issue-5152-anon-delete-coercion.ts",
      );
      expect(observation.stage).toBe("module");
      if (observation.stage !== "module") throw new Error(`expected module error, got ${observation.stage}`);
      expect(observation.reportedImports).toEqual([]);
      expect(observation.error).toMatchObject({
        kind: "error",
        name: "CompileError",
        message: expect.stringContaining("type error in fallthru"),
      });
    });

    it("records the physical-field deletion limitation without treating it as conformance", async () => {
      const observation = await observeStandalone(
        ANONYMOUS_EXPANDO_PHYSICAL_DELETE_SNAPSHOT_SOURCE,
        "issue-5152-anon-delete-physical.js",
      );
      expect(observation.stage).toBe("invoke-throw");
      if (observation.stage !== "invoke-throw") {
        throw new Error(`expected guest invocation failure, got ${observation.stage}`);
      }
      expect(observation.reportedImports).toEqual([]);
      expect(observation.imports).toEqual([]);
      // The guest value is deliberately not normalized into a passing delete
      // result. Its exact payload is recorded in the issue evidence instead.
      expect(observation.error.kind).toBe("object");
    });

    it("records the well-known-Symbol physical-field limitation distinctly from the @@ string", async () => {
      const observation = await observeStandalone(
        ANONYMOUS_EXPANDO_SYMBOL_COLLISION_SOURCE,
        "issue-5152-anon-delete-symbol.js",
      );
      expect(observation.stage).toBe("invoke");
      if (observation.stage !== "invoke") throw new Error(`expected invocation result, got ${observation.stage}`);
      expect(observation.reportedImports).toEqual([]);
      expect(observation.imports).toEqual([]);
      // `1` is the current baseline's nonconforming snapshot: only the Symbol
      // spelling remains visible. It is not a positive Symbol-delete claim.
      expect(observation.value).toBe(1);
    });
  });
});
