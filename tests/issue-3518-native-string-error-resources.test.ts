// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { createEmptyModule, type Instr, type ValType } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
} from "../src/backend/wasmgc/resources/native-errors.js";
import { BUILTIN_TYPE_TAGS } from "../src/codegen/builtin-tags.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { registerNativeStringTypes } from "../src/codegen/registry/types.js";
import * as typeRegistry from "../src/codegen/registry/types.js";
import * as funcSpace from "../src/codegen/func-space.js";
import { addStringConstantGlobal } from "../src/codegen/registry/imports.js";
import { nativeStringLiteralMaterialization } from "../src/codegen/native-string-literals.js";
import { emitWasiErrorConstructor } from "../src/codegen/registry/error-types.js";
import {
  nativeStringLiteralHash,
  planNativeStringLiteral,
} from "../src/runtime/wasmgc/values/string-literal-bodies.js";

const required = ["then", "Chaining cycle detected for promise", "TypeError"];
const base = "5118637e0e9b34291465230428447e511958faa1";
const fixtureDigest = "b579a8d1d0c251ec9a5661f2602da72a90d96991e5915304a013dadc9fc5de61";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
interface DonorFixture {
  schemaVersion: number;
  base: string;
  originalTests: { count: number; fileSha256: string; populationSha256: string };
  sources: {
    path: string;
    sourceSha256: string;
    role: string;
    start: number;
    end: number;
    sha256: string;
    text: string;
  }[];
}
function authenticateDonors(text: string): DonorFixture {
  if (sha256(text) !== fixtureDigest) throw new Error("native string/Error donor fixture digest mismatch");
  const fixture = JSON.parse(text) as DonorFixture;
  if (
    fixture.schemaVersion !== 1 ||
    fixture.base !== base ||
    fixture.sources.length !== 4 ||
    fixture.originalTests.count !== 14 ||
    fixture.originalTests.fileSha256 !== "3f1a5ba67d64337e58f9b9b591d862f10e6a35c93c74c64c97e3a00b21293b6b"
  ) {
    throw new Error("native string/Error donor fixture provenance mismatch");
  }
  const paths = [
    "src/codegen/registry/types.ts",
    "src/codegen/native-string-literals.ts",
    "src/codegen/registry/error-types.ts",
    "src/codegen/native-strings.ts",
  ];
  const roles = ["layouts", "literals", "constructor", "nameRead"];
  fixture.sources.forEach((source, index) => {
    if (
      source.path !== paths[index] ||
      source.role !== roles[index] ||
      !/^[a-f0-9]{64}$/.test(source.sourceSha256) ||
      !Number.isInteger(source.start) ||
      source.start < 0 ||
      source.end - source.start !== source.text.length ||
      source.text.length === 0 ||
      sha256(source.text) !== source.sha256
    ) {
      throw new Error("native string/Error donor span authentication failed");
    }
  });
  return fixture;
}
// Self-contained checked fixture: collection never shells out, fetches, skips, or reads live donor source.
const fixtureText = readFileSync(
  new URL("./fixtures/issue-3518-native-string-error-donors.json", import.meta.url),
  "utf8",
);
const fixture = authenticateDonors(fixtureText);
const donorText = (role: string) => {
  const source = fixture.sources.find((row) => row.role === role);
  if (!source) throw new Error(`missing authenticated native string/Error donor ${role}`);
  return source.text;
};
function donorModule(source: string, dependencies: Record<string, unknown> = {}) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("exports", "require", js)(exports, (name: string) => {
    if (!(name in dependencies)) throw new Error(`unexpected donor dependency ${name}`);
    return dependencies[name];
  });
  return exports;
}
const donorTypes = donorModule(donorText("layouts"));
const donorLiterals = donorModule(donorText("literals"), {
  "./func-space.js": funcSpace,
  "./registry/types.js": typeRegistry,
});
type NameReader = (ctx: CodegenContext, value: string) => Instr[];
function nameReader(source: string): NameReader {
  return donorModule(`import { nativeStringLiteralInstrs } from "donor";\n${source}`, { donor: donorLiterals })
    .stringConstantExternrefInstrs;
}
const donorNameRead = nameReader(donorText("nameRead"));
const donorErrors = donorModule(
  `
  import { getOrRegisterErrorStructType, addFuncType, addStringConstantGlobal, stringConstantExternrefInstrs, mintDefinedFunc, pushDefinedFunc } from "donor";
  export ${donorText("constructor")}
`,
  {
    donor: {
      ...funcSpace,
      ...typeRegistry,
      getOrRegisterErrorStructType: donorTypes.getOrRegisterErrorStructType,
      addStringConstantGlobal,
      stringConstantExternrefInstrs: donorNameRead,
    },
  },
);
function reserve(values = required, utf8Storage = false) {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage,
    literals: values.map((value) => ({ value })),
  });
  return { module, tx, strings };
}
function legacy(utf8Storage = false, original = false) {
  // Only the fields read/written by these live donor adapters. No frontend run.
  const ctx = {
    mod: createEmptyModule(),
    utf8Storage,
    nativeStrings: true,
    errorStructTypeIdx: -1,
    nativeStrDataTypeIdx: -1,
    anyStrTypeIdx: -1,
    nativeStrTypeIdx: -1,
    consStrTypeIdx: -1,
    hashedStrTypeIdx: -1,
    utf8StrDataTypeIdx: -1,
    utf8StrTypeIdx: -1,
    numImportGlobals: 0,
    numImportFuncs: 0,
    nativeStrLiteralGlobals: new Map(),
    nativeStrHelpers: new Map(),
    funcTypeCache: new Map(),
    funcMap: new Map(),
    stringGlobalMap: new Map(),
    stringLiteralMap: new Map(),
    stringLiteralValues: new Map(),
    stringLiteralCounter: 0,
  } as unknown as CodegenContext;
  (original ? donorTypes.registerNativeStringTypes : registerNativeStringTypes)(ctx);
  return ctx;
}

describe("native literal and TypeError resources (literal-only family)", () => {
  it.each([false, true])("matches live legacy descriptors, initializer order, bytes and WAT (UTF8=%s)", (utf8) => {
    const values = [...required, "", "\ud800", "😀", "x".repeat(9999) + "😀" + "end", "z".repeat(20001), "then"];
    const { module, tx, strings } = reserve(values, utf8);
    const ctx = legacy(utf8);
    const original = legacy(utf8, true);
    for (const value of values) nativeStringLiteralMaterialization(ctx, value);
    for (const value of values) donorLiterals.nativeStringLiteralMaterialization(original, value);
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    tx.seal();
    expect(module.types).toEqual(ctx.mod.types);
    expect(module.globals).toEqual(ctx.mod.globals);
    expect(module.functions).toEqual(ctx.mod.functions);
    expect(emitBinary(module)).toEqual(emitBinary(ctx.mod));
    expect(emitWat(module)).toEqual(emitWat(ctx.mod));
    expect(emitBinary(ctx.mod)).toEqual(emitBinary(original.mod));
    expect(emitWat(ctx.mod)).toEqual(emitWat(original.mod));
    expect(strings.literals[0]).toBe(strings.literals.at(-1));
  });

  it("matches the live cached TypeError constructor after name registration", () => {
    const { module, tx, strings } = reserve();
    const errors = reserveNativeErrorResources(
      tx,
      { key: "errors" },
      { strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
    );
    const ctx = legacy();
    const original = legacy(false, true);
    required.forEach((value) => nativeStringLiteralMaterialization(ctx, value));
    required.forEach((value) => donorLiterals.nativeStringLiteralMaterialization(original, value));
    donorErrors.emitErrorStructConstructor(original, "__new_TypeError", "TypeError", BUILTIN_TYPE_TAGS.TypeError, 1);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const count = ctx.mod.functions.length;
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    expect(ctx.mod.functions).toHaveLength(count);
    expect(ctx.stringGlobalMap.get("TypeError")).toBe(-1);
    expect(ctx.mod.stringPool).toEqual(["TypeError"]);
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    fillNativeErrorResources(tx, errors);
    tx.seal();
    expect(errors.type.object).toEqual(ctx.mod.types[ctx.errorStructTypeIdx]);
    expect(errors.newTypeError.object.body).toEqual(ctx.mod.functions.at(-1)!.body);
    expect(errors.newTypeError.object.locals).toEqual([]);
    expect(emitBinary(module)).toEqual(emitBinary(ctx.mod));
    expect(emitWat(module)).toEqual(emitWat(ctx.mod));
    expect(emitBinary(ctx.mod)).toEqual(emitBinary(original.mod));
    expect(emitWat(ctx.mod)).toEqual(emitWat(original.mod));
  });

  it.each([0, 1, 3])("preserves the legacy host-name path with %s arguments", (argCount) => {
    const ctx = legacy(),
      original = legacy(false, true);
    for (const current of [ctx, original]) {
      current.nativeStrings = false;
      current.stringGlobalMap.set("TypeError", 0);
      current.numImportGlobals = 1;
      current.mod.imports.push({
        module: "string_constants",
        name: "TypeError",
        desc: { kind: "global", type: { kind: "externref" }, mutable: false },
      });
    }
    emitWasiErrorConstructor(ctx, "TypeError", argCount);
    donorErrors.emitErrorStructConstructor(
      original,
      "__new_TypeError",
      "TypeError",
      BUILTIN_TYPE_TAGS.TypeError,
      argCount,
    );
    expect(emitBinary(ctx.mod)).toEqual(emitBinary(original.mod));
    expect(emitWat(ctx.mod)).toEqual(emitWat(original.mod));
  });

  it("executes exact UTF16 strings and all six TypeError fields", () => {
    const { module, tx, strings } = reserve();
    const errors = reserveNativeErrorResources(
      tx,
      { key: "errors" },
      { strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
    );
    const ext: ValType = { kind: "externref" },
      i32: ValType = { kind: "i32" };
    const fields = [0, 1, 2, 3, 4, 5].map((field) =>
      tx.reserveFunction(`field:${field}`, `field${field}`, {
        params: [ext],
        results: [field === 0 || field === 4 ? i32 : ext],
      }),
    );
    const char = tx.reserveFunction("char", "char", { params: [ext, i32], results: [i32] });
    const length = tx.reserveFunction("length", "length", { params: [ext], results: [i32] });
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    fillNativeErrorResources(tx, errors);
    fields.forEach((fn, fieldIdx) =>
      tx.fillFunction(fn, {
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: errors.type.typeIndex },
          { op: "struct.get", typeIdx: errors.type.typeIndex, fieldIdx },
        ],
      }),
    );
    const flat: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: strings.layout.nativeStrTypeIdx },
    ];
    tx.fillFunction(char, {
      locals: [],
      body: [
        ...flat,
        { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: 1 },
        { op: "array.get_u", typeIdx: strings.layout.nativeStrDataTypeIdx },
      ],
    });
    tx.fillFunction(length, {
      locals: [],
      body: [...flat, { op: "struct.get", typeIdx: strings.layout.nativeStrTypeIdx, fieldIdx: 0 }],
    });
    for (const fn of [...fields, char, length, errors.newTypeError])
      tx.defineExport(`export:${fn.key}`, fn.object.name, fn);
    strings.literals.forEach((row, index) => {
      if (row.kind !== "global") throw new Error("expected fixed literal");
      tx.defineExport(`literal:${index}`, `literal${index}`, row.global);
    });
    tx.seal();
    const binary = emitBinary(module);
    expect(WebAssembly.validate(binary)).toBe(true);
    const api = new WebAssembly.Instance(new WebAssembly.Module(binary)).exports as Record<string, any>;
    const read = (value: unknown) =>
      Array.from({ length: api.length(value) }, (_, i) => String.fromCharCode(api.char(value, i))).join("");
    required.forEach((text, index) => expect(read(api[`literal${index}`].value)).toBe(text));
    const message = api.literal1.value;
    const error = api.__new_TypeError(message);
    expect(api.field0(error)).toBe(-11);
    expect(api.field1(error)).toBe(message);
    expect(read(api.field2(error))).toBe("TypeError");
    expect(api.field3(error)).toBeNull();
    expect(api.field4(error)).toBe(-1);
    expect(api.field5(error)).toBeNull();
  });

  it("preserves UTF8 evidence, UTF16 overflow fallback and hash semantics", () => {
    const { strings } = reserve([], true);
    const selected = planNativeStringLiteral(strings.layout, true, "😀", "utf8-guaranteed");
    expect(selected.kind).toBe("global");
    if (selected.kind !== "global") throw new Error("expected global");
    expect(selected.key).toBe("u8:😀");
    expect(selected.init.slice(0, 2)).toEqual([
      { op: "i32.const", value: 2 },
      { op: "i32.const", value: 4 },
    ]);
    expect(planNativeStringLiteral(strings.layout, true, "€".repeat(4000), "utf8-guaranteed")).toMatchObject({
      key: `u16:${"€".repeat(4000)}`,
    });
    expect(() => planNativeStringLiteral(strings.layout, true, "\ud800", "utf8-guaranteed")).toThrow(/surrogate/);
    // Independent BigInt arithmetic oracle avoids sharing the Math.imul implementation.
    let hash = 2166136261n;
    for (const unit of [116n, 104n, 101n, 110n]) hash = ((hash ^ unit) * 16777619n) & 0xffffffffn;
    expect(nativeStringLiteralHash("then")).toBe(Number(BigInt.asIntN(32, hash | 0x80000000n)));
  });

  it("executes a UTF8 literal and an oversized rope with a split surrogate pair", () => {
    const value = "x".repeat(9999) + "😀" + "end";
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const strings = reserveNativeStringLiteralResources(tx, {
      key: "strings",
      utf8Storage: true,
      literals: [{ value: "😀", encoding: "utf8-guaranteed" }, { value }],
    });
    const ctx = legacy(true),
      original = legacy(true, true);
    for (const current of [ctx, original]) {
      const materialize =
        current === ctx ? nativeStringLiteralMaterialization : donorLiterals.nativeStringLiteralMaterialization;
      materialize(current, "😀", "utf8-guaranteed");
      materialize(current, value);
    }
    const probe = tx.reserveFunction("probe", "probe", { params: [], results: [{ kind: "i32" }] });
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    const utf8 = strings.literals[0]!,
      rope = strings.literals[1]!;
    if (utf8.kind !== "global" || rope.kind !== "callable") throw new Error("wrong materializations");
    const l = strings.layout;
    // Return 1 only if actual stored bytes, UTF16 length, and both rope leaves match.
    const checks: Instr[][] = [
      [
        { op: "global.get", index: tx.physicalIndex(utf8.global) },
        { op: "struct.get", typeIdx: l.utf8StrTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
      ],
      ...[240, 159, 152, 128].map((byte, index): Instr[] => [
        { op: "global.get", index: tx.physicalIndex(utf8.global) },
        { op: "struct.get", typeIdx: l.utf8StrTypeIdx, fieldIdx: 3 },
        { op: "i32.const", value: index },
        { op: "array.get_u", typeIdx: l.utf8StrDataTypeIdx },
        { op: "i32.const", value: byte },
        { op: "i32.eq" },
      ]),
      [
        { op: "call", funcIdx: rope.function.handle },
        { op: "struct.get", typeIdx: l.anyStrTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: value.length },
        { op: "i32.eq" },
      ],
      ...[
        [1, 9999, 0xd83d],
        [2, 0, 0xde00],
      ].map(([fieldIdx, index, unit]): Instr[] => [
        { op: "call", funcIdx: rope.function.handle },
        { op: "ref.cast", typeIdx: l.consStrTypeIdx },
        { op: "struct.get", typeIdx: l.consStrTypeIdx, fieldIdx: fieldIdx! },
        { op: "ref.cast", typeIdx: l.nativeStrTypeIdx },
        { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "i32.const", value: index! },
        { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
        { op: "i32.const", value: unit! },
        { op: "i32.eq" },
      ]),
    ];
    tx.fillFunction(probe, {
      locals: [],
      body: checks.flatMap((check, index) => (index === 0 ? check : [...check, { op: "i32.and" }])),
    });
    tx.defineExport("export:probe", "probe", probe);
    tx.seal();
    expect(module.globals).toEqual(ctx.mod.globals);
    expect(ctx.mod.globals).toEqual(original.mod.globals);
    expect(ctx.mod.functions).toEqual(original.mod.functions);
    const binary = emitBinary(module);
    expect(WebAssembly.validate(binary)).toBe(true);
    const api = new WebAssembly.Instance(new WebAssembly.Module(binary)).exports;
    expect((api.probe as () => number)()).toBe(1);
  });

  it("rejects absent TypeError name and cross-module Error packs", () => {
    const absent = reserve(["then"]);
    expect(() =>
      reserveNativeErrorResources(
        absent.tx,
        { key: "errors" },
        { strings: absent.strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
      ),
    ).toThrow(/missing literal/);
    const a = reserve(),
      b = reserve();
    const errors = reserveNativeErrorResources(
      a.tx,
      { key: "errors" },
      { strings: a.strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
    );
    b.tx.freezeReservations();
    expect(() => fillNativeErrorResources(b.tx, errors)).toThrow(/foreign/);
  });

  it("rejects a text label on a foreign or fabricated literal pack", () => {
    const a = reserve(),
      b = reserve();
    expect(() => requireNativeStringLiteral(a.tx, b.strings, "then")).toThrow(/foreign/);
    expect(() => requireNativeStringLiteral(a.tx, { ...a.strings }, "then")).toThrow(/forged/);
    expect(() => requireNativeStringLiteral(a.tx, a.strings, "absent")).toThrow(/missing literal/);
  });

  it("rejects a stale layout", () => {
    const { tx, strings } = reserve();
    const type = strings.types[4]!.object;
    if (type.kind !== "struct") throw new Error("expected hash struct");
    type.fields[3]!.mutable = false;
    expect(() => tx.freezeReservations()).toThrow(/altered/);
  });

  it("rejects missing literal fill and altered completed initializer", () => {
    const a = reserve();
    a.tx.freezeReservations();
    expect(() => a.tx.seal()).toThrow(/missing global fill/);
    const b = reserve();
    b.tx.freezeReservations();
    fillNativeStringLiteralResources(b.tx, b.strings);
    const row = b.strings.literals[0]!;
    if (row.kind !== "global") throw new Error("expected global");
    row.global.object.init[0] = { op: "i32.const", value: 99 };
    expect(() => b.tx.seal()).toThrow(/altered/);
  });

  it("rejects missing error fill, wrong target, duplicate fill and wrong tag", () => {
    const a = reserve();
    const error = reserveNativeErrorResources(
      a.tx,
      { key: "errors" },
      { strings: a.strings, typeErrorTag: BUILTIN_TYPE_TAGS.TypeError },
    );
    a.tx.freezeReservations();
    fillNativeStringLiteralResources(a.tx, a.strings);
    expect(() => fillNativeErrorResources(a.tx, { ...error, newTypeError: {} as never })).toThrow(/forged/);
    expect(() => a.tx.seal()).toThrow(/missing function fill/);
    const b = reserve();
    b.tx.freezeReservations();
    fillNativeStringLiteralResources(b.tx, b.strings);
    expect(() => fillNativeStringLiteralResources(b.tx, b.strings)).toThrow(/duplicate/);
    const c = reserve();
    expect(() =>
      reserveNativeErrorResources(c.tx, { key: "errors" }, { strings: c.strings, typeErrorTag: -10 as -11 }),
    ).toThrow(/incorrect TypeError tag/);
  });
});

// Additional repair controls; the original 14-test describe above remains hash-pinned.
function assertNameReadBranches(read: NameReader): void {
  // Genuine native branch first, including an absent host entry and the native sentinel.
  for (const global of [undefined, -1]) {
    const ctx = legacy(false, true);
    if (global !== undefined) ctx.stringGlobalMap.set("TypeError", global);
    expect(read(ctx, "TypeError")).toEqual([{ op: "global.get", index: 0 }, { op: "extern.convert_any" }]);
    expect(ctx.nativeStrLiteralGlobals.get("u16:TypeError")).toBe(0);
    expect(ctx.mod.globals).toHaveLength(1);
    expect(ctx.mod.globals[0]!.init.length).toBeGreaterThan(8);
  }
  // Zero is admitted by the original >= 0 guard; this is a guard-level instruction probe.
  const zero = legacy(false, true);
  zero.nativeStrTypeIdx = 0;
  expect(read(zero, "TypeError")).toEqual([{ op: "global.get", index: 0 }, { op: "extern.convert_any" }]);
  // Valid global 0 is not missing. Native mode with an unavailable layout must also use it.
  for (const nativeStrings of [false, true]) {
    const ctx = legacy(false, true);
    ctx.nativeStrings = nativeStrings;
    if (nativeStrings) ctx.nativeStrTypeIdx = -1;
    ctx.stringGlobalMap.set("TypeError", 0);
    expect(read(ctx, "TypeError")).toEqual([{ op: "global.get", index: 0 }]);
    expect(ctx.mod.globals).toHaveLength(0);
  }
  // Check missing and negative entries on both routes through the fallback.
  for (const nativeStrings of [false, true]) {
    for (const global of [undefined, -1, -2]) {
      const ctx = legacy(false, true);
      ctx.nativeStrings = nativeStrings;
      if (nativeStrings) ctx.nativeStrTypeIdx = -1;
      if (global !== undefined) ctx.stringGlobalMap.set("TypeError", global);
      expect(read(ctx, "TypeError")).toEqual([{ op: "ref.null.extern" }]);
      expect(ctx.mod.globals).toHaveLength(0);
    }
  }
}

describe("authenticated donor fixture and exact name-read repair controls", () => {
  it("authenticates the exact-base fixture and preserves the original 14-test population hash", () => {
    expect(authenticateDonors(fixtureText)).toEqual(fixture);
    const testText = readFileSync(new URL(import.meta.url), "utf8");
    const start = testText.indexOf('describe("native literal and TypeError resources');
    const end = testText.indexOf("// Additional repair controls;");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(sha256(testText.slice(start, end).trimEnd() + "\n")).toBe(fixture.originalTests.populationSha256);
    expect(fixture.sources.map((source) => source.role)).toEqual(["layouts", "literals", "constructor", "nameRead"]);
  });

  it("accepts the checked fixture before rejecting missing, altered and wrong-base receipts", () => {
    expect(() => authenticateDonors(fixtureText)).not.toThrow();
    expect(() => authenticateDonors("")).toThrow(/digest mismatch/);
    const altered = JSON.parse(fixtureText);
    altered.sources[3].text = altered.sources[3].text.replace("strIdx < 0", "false");
    // Recomputing a self-reported span digest cannot bypass the pinned fixture digest.
    altered.sources[3].sha256 = sha256(altered.sources[3].text);
    expect(() => authenticateDonors(JSON.stringify(altered, null, 2) + "\n")).toThrow(/digest mismatch/);
    const wrongBase = JSON.parse(fixtureText);
    wrongBase.base = "0".repeat(40);
    expect(() => authenticateDonors(JSON.stringify(wrongBase, null, 2) + "\n")).toThrow(/digest mismatch/);
  });

  it("covers the genuine native branch before host/layout/missing-global fallbacks", () => {
    assertNameReadBranches(donorNameRead);
  });

  it.each([
    ["native branch", "ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0", "false"],
    ["native-mode guard", "ctx.nativeStrings && ", ""],
    ["native-layout guard", " && ctx.nativeStrTypeIdx >= 0", ""],
    ["zero-layout admission", "ctx.nativeStrTypeIdx >= 0", "ctx.nativeStrTypeIdx > 0"],
    ["missing-global fallback", "strIdx === undefined || ", ""],
    ["negative-global fallback", " || strIdx < 0", ""],
    ["entire fallback", "strIdx === undefined || strIdx < 0", "false"],
  ])("rejects removal of %s after the genuine positive control", (_label, from, to) => {
    expect(() => assertNameReadBranches(donorNameRead)).not.toThrow();
    const source = donorText("nameRead");
    expect(source.split(from)).toHaveLength(2);
    const mutant = nameReader(source.replace(from, to));
    expect(() => assertNameReadBranches(mutant)).toThrow();
  });
});

// Live-constructor repair controls; the preceding 24-test file remains hash-pinned.
const liveConstructorCases = ["native-unavailable-layout", "legacy-negative-name", "valid-global-zero"] as const;
type LiveConstructorCase = (typeof liveConstructorCases)[number];
type ConstructorProbe = (ctx: CodegenContext) => void;

function constructorProbeBody(emit: ConstructorProbe, scenario: LiveConstructorCase, original = false): Instr[] {
  const ctx = legacy(false, original);
  ctx.nativeStrings = scenario === "native-unavailable-layout";
  if (ctx.nativeStrings) ctx.nativeStrTypeIdx = -1;
  const nameGlobal = scenario === "legacy-negative-name" ? -1 : 0;
  ctx.stringGlobalMap.set("TypeError", nameGlobal);
  if (nameGlobal === 0) {
    ctx.numImportGlobals = 1;
    ctx.mod.imports.push({
      module: "string_constants",
      name: "TypeError",
      desc: { kind: "global", type: { kind: "externref" }, mutable: false },
    });
  }
  emit(ctx);
  const constructorFn = ctx.mod.functions.find((fn) => fn.name === "__new_TypeError");
  if (!constructorFn) throw new Error("constructor probe did not emit __new_TypeError");
  return constructorFn.body;
}

const actualLiveConstructor: ConstructorProbe = (ctx) => emitWasiErrorConstructor(ctx, "TypeError", 1);
const exactDonorConstructor: ConstructorProbe = (ctx) =>
  donorErrors.emitErrorStructConstructor(ctx, "__new_TypeError", "TypeError", BUILTIN_TYPE_TAGS.TypeError, 1);

async function evaluateLiveConstructor(source: string): Promise<ConstructorProbe> {
  const { buildErrorConstructorBody } = await import("../src/runtime/wasmgc/values/error-bodies.js");
  const evaluated = donorModule(
    `import { getOrRegisterErrorStructType, addStringConstantGlobal, nativeStringLiteralMaterialization,
      addFuncType, mintDefinedFunc, pushDefinedFunc, buildErrorConstructorBody } from "live-constructor";
    export ${source}`,
    {
      "live-constructor": {
        ...typeRegistry,
        ...funcSpace,
        addStringConstantGlobal,
        nativeStringLiteralMaterialization,
        buildErrorConstructorBody,
      },
    },
  );
  if (typeof evaluated.emitErrorStructConstructor !== "function") throw new Error("live constructor evaluation failed");
  return (ctx) =>
    evaluated.emitErrorStructConstructor(ctx, "__new_TypeError", "TypeError", BUILTIN_TYPE_TAGS.TypeError, 1);
}

describe("actual live constructor name-branch preservation", () => {
  it.each(liveConstructorCases)("matches the exact donor body for %s", (scenario) => {
    const testText = readFileSync(new URL(import.meta.url), "utf8");
    const boundary = testText.indexOf("// Live-constructor repair controls;");
    expect(boundary).toBeGreaterThan(0);
    expect(sha256(testText.slice(0, boundary).trimEnd() + "\n")).toBe(
      "17c43b01151c5f3e0b8dbb132ea9b0c17ae50ba9c6f50f4f87cd31d14b5992a6",
    );
    const actual = constructorProbeBody(actualLiveConstructor, scenario);
    const expected = constructorProbeBody(exactDonorConstructor, scenario, true);
    expect(actual).toEqual(expected);
    expect(actual[2]).toEqual(
      scenario === "legacy-negative-name" ? { op: "ref.null.extern" } : { op: "global.get", index: 0 },
    );
  });

  it.each([
    ["native layout guard", " && ctx.nativeStrTypeIdx >= 0"],
    ["negative name-index guard", " || index < 0"],
  ])("rejects removal of the live %s after genuine constructor controls", async (_label, removed) => {
    const expected = liveConstructorCases.map((scenario) =>
      constructorProbeBody(exactDonorConstructor, scenario, true),
    );
    const actual = liveConstructorCases.map((scenario) => constructorProbeBody(actualLiveConstructor, scenario));
    expect(actual).toEqual(expected);

    // Read live source only for live mutations; the independent donor remains the authenticated fixture.
    const file = readFileSync(new URL("../src/codegen/registry/error-types.ts", import.meta.url), "utf8");
    const start = file.indexOf("function emitErrorStructConstructor(");
    const end = file.indexOf("\n/**", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const source = file.slice(start, end);
    expect(source.split(removed)).toHaveLength(2);
    const genuine = await evaluateLiveConstructor(source);
    expect(liveConstructorCases.map((scenario) => constructorProbeBody(genuine, scenario))).toEqual(expected);

    // Both module evaluation AND constructor execution are outside the expected comparison failure.
    // A broken mutation harness must fail the test, never count as a rejected semantic mutant.
    const mutant = await evaluateLiveConstructor(source.replace(removed, ""));
    const mutantBodies = liveConstructorCases.map((scenario) => constructorProbeBody(mutant, scenario));
    expect(() => expect(mutantBodies).toEqual(expected)).toThrow();
  });
});
