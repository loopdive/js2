// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5152 — `String.raw` must observe the ordinary property semantics of a
 * closed `raw` struct.  The three original ES2015 failures cover an accessor
 * `length`, accessor numeric keys, and a symbol-valued numeric field.  The two
 * physical-field controls make descriptor precedence explicit: the bag entry
 * must win even when a compiled struct already has a `length` or `"0"` slot.
 */
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

const FULL_READER_MASK = 131071;
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

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-5152-raw-readers.js", target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
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
  const script = source.replace("export function test()", "function test()");
  return new Function(`${script}\nreturn test();`)() as number;
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
});
