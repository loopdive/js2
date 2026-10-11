// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import type { WasmFunction } from "../src/wasm/model/module-records.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
  requireCompletedNativeStringFlatten,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  buildStringCopyTreeDefinition,
  buildStringFlattenDefinition,
} from "../src/runtime/wasmgc/values/string-flatten-bodies.js";
import { buildStringUtf8ToFlatDefinition } from "../src/runtime/wasmgc/values/string-utf8-decode-bodies.js";
import {
  projectCopyTreeUtf8,
  projectFlattenAdapterStaging,
} from "../scripts/verify-native-scanner-source-preservation.mjs";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { makeNativeStrShared } from "../src/codegen/native-strings-shared.js";
import { addFuncType, getOrRegisterArrayType } from "../src/codegen/registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { nativeStringLiteralInstrs } from "../src/codegen/native-strings.js";
import { compile } from "../src/index.js";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const units = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const decoderPath = "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts";
type Leaf = { kind: "flat" | "utf8" | "hashed"; text: string; prefix?: string; suffix?: string };
type Tree = Leaf | { kind: "cons"; left: Tree; right: Tree };
const flat = (text: string): Leaf => ({ kind: "flat", text });
const utf8 = (text: string, prefix = "", suffix = ""): Leaf => ({ kind: "utf8", text, prefix, suffix });
const cons = (left: Tree, right: Tree): Tree => ({ kind: "cons", left, right });
const textOf = (tree: Tree): string => (tree.kind === "cons" ? textOf(tree.left) + textOf(tree.right) : tree.text);
const leafs = (tree: Tree): Leaf[] => (tree.kind === "cons" ? [...leafs(tree.left), ...leafs(tree.right)] : [tree]);
let deep: Tree = utf8("€");
for (let i = 0; i < 40; i++) deep = cons(deep, i % 2 ? flat("x") : utf8("é"));
const recipes: { name: string; tree: Tree }[] = [
  { name: "direct-utf8", tree: utf8("Aé€😀") },
  { name: "direct-window", tree: utf8("é€😀", "é😀|", "&Ω") },
  { name: "root-flat", tree: flat("A\uD800Z") },
  { name: "root-hashed", tree: { kind: "hashed", text: "hashed" } },
  { name: "left-utf8", tree: cons(utf8("é"), flat("right")) },
  { name: "right-utf8", tree: cons(flat("left"), utf8("€")) },
  { name: "both-utf8", tree: cons(utf8("é"), utf8("😀")) },
  { name: "mixed-window", tree: cons(utf8("é€😀", "é😀|", "&Ω"), flat("\uD800!")) },
  { name: "balanced", tree: cons(cons(utf8("é"), flat("A")), cons(utf8("😀"), utf8("€"))) },
  { name: "deep-worklist-40", tree: deep },
  { name: "empty-left", tree: cons(utf8(""), utf8("é")) },
  { name: "empty-right", tree: cons(utf8("é"), utf8("")) },
  { name: "empty-window", tree: cons(utf8("", "é😀|", "&Ω"), flat("Z")) },
  { name: "all-empty", tree: cons(utf8(""), flat("")) },
  { name: "direct-empty", tree: utf8("", "é😀|", "&Ω") },
];
function storage(leaf: Leaf) {
  return {
    value: (leaf.prefix ?? "") + leaf.text + (leaf.suffix ?? ""),
    encoding: leaf.kind === "utf8" ? ("utf8-guaranteed" as const) : ("wtf16" as const),
  };
}
function reserve(importCount = 0, utf8Storage = true) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  for (let i = 0; i < importCount; i++)
    tx.reserveFunctionImport("offset:" + i, "offset", "f" + i, { params: [], results: [] });
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "rope:strings",
    utf8Storage,
    literals: [
      { value: "", encoding: "wtf16" },
      ...recipes
        .flatMap((r) => leafs(r.tree))
        .filter((l) => utf8Storage || l.kind !== "utf8")
        .map(storage),
    ],
  });
  const pack = reserveNativeStringFlattenResources(tx, "rope:flatten", strings);
  return { module, tx, strings, pack };
}
type State = ReturnType<typeof reserve>;
function construct(tree: Tree, state: State): Instr[] {
  const l = state.strings.layout;
  if (tree.kind === "cons")
    return [
      { op: "i32.const", value: textOf(tree).length },
      ...construct(tree.left, state),
      ...construct(tree.right, state),
      { op: "struct.new", typeIdx: l.consStrTypeIdx },
    ];
  const { value, encoding } = storage(tree);
  const literal = requireNativeStringLiteral(state.tx, state.strings, value, encoding);
  if (literal.kind !== "global") throw Error("issued test literal must be global");
  const load: Instr = { op: "global.get", index: state.tx.physicalIndex(literal.global) };
  if (tree.kind === "utf8")
    return [
      { op: "i32.const", value: tree.text.length },
      { op: "i32.const", value: new TextEncoder().encode(tree.text).length },
      { op: "i32.const", value: new TextEncoder().encode(tree.prefix ?? "").length },
      load,
      { op: "struct.get", typeIdx: l.utf8StrTypeIdx, fieldIdx: 3 },
      { op: "struct.new", typeIdx: l.utf8StrTypeIdx },
    ];
  if (tree.kind === "hashed")
    return [
      { op: "i32.const", value: tree.text.length },
      { op: "i32.const", value: 0 },
      load,
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: 123 },
      { op: "i32.const", value: 0 },
      { op: "ref.null.eq" },
      { op: "ref.null.eq" },
      { op: "ref.null.eq" },
      { op: "struct.new", typeIdx: l.hashedStrTypeIdx },
    ];
  return [load];
}
function probeDefinition(tree: Tree, mode: "copy" | "flatten", state: State) {
  const l = state.strings.layout,
    n = textOf(tree).length;
  const locals = [
    { name: "root", type: { kind: "ref_null", typeIdx: l.anyStrTypeIdx } as ValType },
    { name: "flat", type: { kind: "ref_null", typeIdx: l.nativeStrTypeIdx } as ValType },
    { name: "buffer", type: { kind: "ref_null", typeIdx: l.nativeStrDataTypeIdx } as ValType },
    { name: "position", type: { kind: "i32" } as ValType },
  ];
  const getFlat: Instr[] = [{ op: "local.get", index: 1 }, { op: "ref.as_non_null" }];
  const body: Instr[] = [...construct(tree, state), { op: "local.set", index: 0 }];
  if (mode === "copy") {
    body.push(
      ...Array.from({ length: n + 4 }, (_, i): Instr => ({ op: "i32.const", value: i < 2 ? 0x1234 : 0x5678 })),
      { op: "array.new_fixed", typeIdx: l.nativeStrDataTypeIdx, length: n + 4 },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "i32.const", value: 2 },
      { op: "call", funcIdx: state.pack.copyTree.handle },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "array.len" },
    );
    for (let i = 0; i < n + 4; i++)
      body.push(
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: i },
        { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
      );
  } else {
    body.push(
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: state.pack.flatten.handle },
      { op: "local.set", index: 1 },
      ...getFlat,
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 0 },
      ...getFlat,
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: state.pack.flatten.handle },
      ...getFlat,
      { op: "ref.eq" },
    );
    for (let i = 0; i < n; i++)
      body.push(
        ...getFlat,
        { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "i32.const", value: i },
        { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
      );
  }
  return { locals, body };
}
function buildModule(importCount: number) {
  expect(sha(read(decoderPath))).toBe("119976d2b5c593dc05b22ed82df454537d3b0bed9395e9ae47ef7dbac64bb748");
  const state = reserve(importCount),
    { module, tx, strings, pack } = state;
  const entries = recipes.flatMap((recipe) =>
    (["copy", "flatten"] as const).map((mode) => ({
      ...recipe,
      mode,
      name: recipe.name + ":" + mode,
      token: tx.reserveFunction(recipe.name + ":" + mode, recipe.name + ":" + mode, {
        params: [],
        results: Array.from({ length: textOf(recipe.tree).length + (mode === "copy" ? 6 : 3) }, () => ({
          kind: "i32" as const,
        })),
      }),
    })),
  );
  expect(module.functions.slice(0, 3).map((f) => f.name)).toEqual([
    "__str_copy_tree",
    "__str_utf8_to_flat",
    "__str_flatten",
  ]);
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, pack);
  expect(requireCompletedNativeStringFlatten(tx, pack, strings)).toBe(pack);
  expect(pack.copyTree.object.locals).toHaveLength(7);
  expect(tx.physicalIndex(pack.copyTree)).toBe(importCount);
  expect(tx.physicalIndex(pack.utf8Decoder!)).toBe(importCount + 1);
  expect(tx.physicalIndex(pack.flatten)).toBe(importCount + 2);
  const canonical = buildStringCopyTreeDefinition(strings.layout, pack.worklist.typeIndex, {
    kind: "present",
    handle: pack.utf8Decoder!.handle,
  });
  expect(pack.copyTree.object.body).toEqual(canonical.body);
  expect(pack.copyTree.object.locals).toEqual(canonical.locals);
  for (const entry of entries) {
    tx.fillFunction(entry.token, probeDefinition(entry.tree, entry.mode, state));
    tx.defineExport("export:" + entry.name, entry.name, entry.token);
  }
  const census = tx.seal(),
    binary = Uint8Array.from(emitBinary(module)),
    wat = emitWat(module);
  const compiled = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(compiled)).toEqual(
    Array.from({ length: importCount }, (_, i) => ({ module: "offset", name: "f" + i, kind: "function" })),
  );
  return { entries, compiled, binary: Buffer.from(binary).toString("base64"), wat, census };
}
function evidenceDirectory() {
  const parent = resolve(".tmp");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(resolve(parent, "utf8-rope-repair-"));
}
const execution = new Map<number, ReturnType<typeof buildModule> | Error>();
function moduleOnce(importCount: number) {
  if (!execution.has(importCount)) {
    try {
      execution.set(importCount, buildModule(importCount));
    } catch (error) {
      execution.set(
        importCount,
        error instanceof Error ? error : new Error("fixture construction failed", { cause: error }),
      );
    }
  }
  const cached = execution.get(importCount)!;
  if (cached instanceof Error) throw cached;
  return cached;
}
describe("genuine issued UTF8 rope copy-tree and flatten execution", () => {
  for (const importCount of [0, 3])
    for (const recipe of recipes)
      for (const mode of ["copy", "flatten"] as const)
        it(importCount + " imports: " + recipe.name + ":" + mode, () => {
          const fixture = moduleOnce(importCount),
            name = recipe.name + ":" + mode,
            data = units(textOf(recipe.tree));
          const expected =
            mode === "copy"
              ? [data.length + 2, data.length + 4, 0x1234, 0x1234, ...data, 0x5678, 0x5678]
              : [data.length, 0, recipe.tree.kind === "utf8" ? 0 : 1, ...data];
          const observations = [];
          for (let instance = 0; instance < 2; instance++) {
            const wasm = new WebAssembly.Instance(fixture.compiled, { offset: { f0() {}, f1() {}, f2() {} } });
            const fn = wasm.exports[name] as () => number[];
            for (let repeat = 0; repeat < 2; repeat++) {
              try {
                observations.push({ instance, repeat, value: fn() });
              } catch (error) {
                observations.push({
                  instance,
                  repeat,
                  error:
                    error instanceof Error
                      ? { name: error.name, message: error.message, stack: error.stack }
                      : { thrown: String(error) },
                });
              }
            }
          }
          const directory = evidenceDirectory();
          writeFileSync(
            resolve(directory, "receipt.json"),
            JSON.stringify(
              {
                name,
                importCount,
                binary: fixture.binary,
                instantiatedBinary: fixture.binary,
                wat: fixture.wat,
                census: fixture.census,
                expected,
                observations,
              },
              null,
              2,
            ),
          );
          for (const observation of observations) expect(observation, directory).toMatchObject({ value: expected });
        });
});

// Execute exact selected function source with instrumented real dependency calls;
// the actual real pushDefinedFunc retains the very object observed by the probe.
function evaluate(source: string, names: string[], dependencies: Record<string, unknown>) {
  const sf = ts.createSourceFile("actual.ts", source, ts.ScriptTarget.Latest, true);
  const functions = sf.statements.filter(ts.isFunctionDeclaration).filter((n) => names.includes(n.name?.text ?? ""));
  expect(functions.map((n) => n.name!.text).sort()).toEqual([...names].sort());
  const js = ts.transpileModule(functions.map((n) => n.getText(sf)).join("\n"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, Function> = {};
  new Function("exports", ...Object.keys(dependencies), js)(exports, ...Object.values(dependencies));
  return exports;
}
function legacy(utf8Storage: boolean, options: { stale?: boolean; throwDecoder?: unknown } = {}) {
  const ctx = createCodegenContext(createEmptyModule(), ts.createProgram([], { noLib: true }).getTypeChecker(), {
    standalone: true,
    nativeStrings: true,
    utf8Storage,
  });
  const shared = makeNativeStrShared(
    ctx,
    ctx.nativeStrTypeIdx,
    ctx.nativeStrDataTypeIdx,
    ctx.anyStrTypeIdx,
    ctx.consStrTypeIdx,
  );
  const events: string[] = [],
    captured: WasmFunction[] = [];
  const pending: { name: string; body: number; locals: number }[] = [];
  if (options.stale) {
    const handle = mintDefinedFunc(ctx),
      typeIdx = addFuncType(ctx, [], []);
    pushDefinedFunc(ctx, handle, { name: "stale-decoder", typeIdx, locals: [], body: [], exported: false });
    ctx.nativeStrHelpers.set("__str_utf8_to_flat", handle);
  }
  const set = ctx.nativeStrHelpers.set.bind(ctx.nativeStrHelpers);
  ctx.nativeStrHelpers.set = (name, value) => {
    events.push("map:" + name);
    return set(name, value);
  };
  const funcSet = ctx.funcMap.set.bind(ctx.funcMap);
  ctx.funcMap.set = (name, value) => {
    events.push("funcMap:" + name);
    return funcSet(name, value);
  };
  const selections: unknown[] = [],
    worklists: number[] = [];
  const dependencies = {
    addFuncType: (...args: Parameters<typeof addFuncType>) => {
      events.push("type");
      return addFuncType(...args);
    },
    getOrRegisterArrayType: (...args: Parameters<typeof getOrRegisterArrayType>) => {
      events.push("worklist");
      return getOrRegisterArrayType(...args);
    },
    mintDefinedFunc: (...args: Parameters<typeof mintDefinedFunc>) => {
      events.push("mint");
      return mintDefinedFunc(...args);
    },
    pushDefinedFunc: (context: typeof ctx, handle: number, fn: WasmFunction) => {
      events.push("push:" + fn.name);
      captured.push(fn);
      pending.push({ name: fn.name!, body: fn.body.length, locals: fn.locals.length });
      pushDefinedFunc(context, handle, fn);
      expect(ctx.mod.functions.at(-1)).toBe(fn);
    },
    nativeStringLiteralInstrs: (...args: Parameters<typeof nativeStringLiteralInstrs>) => {
      events.push("empty");
      return nativeStringLiteralInstrs(...args);
    },
    buildStringCopyTreeDefinition: (...args: Parameters<typeof buildStringCopyTreeDefinition>) => {
      events.push("build:copy");
      selections.push(args[2]);
      worklists.push(args[1]);
      return buildStringCopyTreeDefinition(...args);
    },
    buildStringUtf8ToFlatDefinition: (...args: Parameters<typeof buildStringUtf8ToFlatDefinition>) => {
      events.push("build:decoder");
      if (Object.hasOwn(options, "throwDecoder")) throw options.throwDecoder;
      return buildStringUtf8ToFlatDefinition(...args);
    },
    buildStringFlattenDefinition: (...args: Parameters<typeof buildStringFlattenDefinition>) => {
      events.push("build:flatten");
      selections.push(args[1].utf8Decoder);
      return buildStringFlattenDefinition(...args);
    },
  };
  const source = read("src/codegen/native-strings-core.ts");
  const url = new URL("../src/codegen/native-strings-core.ts", import.meta.url).href;
  projectFlattenAdapterStaging(source, url, url, sha);
  const entry = evaluate(source, ["emitStrFlattenHelpers"], dependencies).emitStrFlattenHelpers!;
  let error: unknown;
  try {
    entry(shared);
  } catch (caught) {
    error = caught;
  }
  return { ctx, events, captured, pending, selections, worklists, error };
}
describe("legacy ordered pending-object registration, no provisional executable body", () => {
  for (const enabled of [false, true])
    it("preserves actual registration/fill ordering " + enabled, () => {
      const r = legacy(enabled);
      expect(r.error).toBeUndefined();
      expect(r.events).toEqual([
        "worklist",
        "type",
        "mint",
        "map:__str_copy_tree",
        "push:__str_copy_tree",
        ...(enabled ? ["type", "mint", "map:__str_utf8_to_flat", "build:decoder", "push:__str_utf8_to_flat"] : []),
        "build:copy",
        "type",
        "mint",
        "map:__str_flatten",
        "funcMap:__str_flatten",
        "empty",
        "build:flatten",
        "push:__str_flatten",
      ]);
      expect(r.pending[0]).toEqual({ name: "__str_copy_tree", body: 0, locals: 0 });
      expect(r.captured[0]).toBe(r.ctx.mod.functions[0]);
      expect(r.captured[0]!.body.length).toBeGreaterThan(0);
      expect(r.captured[0]!.locals).toHaveLength(7);
      expect(r.selections).toHaveLength(2);
      expect(r.selections[0]).toBe(r.selections[1]);
      expect(r.selections[0]).toEqual(
        enabled ? { kind: "present", handle: r.ctx.nativeStrHelpers.get("__str_utf8_to_flat") } : { kind: "absent" },
      );
    });
  it("does not reuse a stale decoder map entry in disabled mode", () => {
    const r = legacy(false, { stale: true });
    expect(r.error).toBeUndefined();
    expect(r.ctx.nativeStrHelpers.has("__str_utf8_to_flat")).toBe(true);
    expect(r.selections).toEqual([{ kind: "absent" }, { kind: "absent" }]);
    expect(r.events).not.toContain("build:decoder");
  });
  it("propagates the exact decoder construction error and leaves the pushed copy object pending", () => {
    expect(legacy(true).error).toBeUndefined();
    const sentinel = new Error("decoder construction sentinel");
    const r = legacy(true, { throwDecoder: sentinel });
    expect(r.error).toBe(sentinel);
    expect(r.events).toEqual([
      "worklist",
      "type",
      "mint",
      "map:__str_copy_tree",
      "push:__str_copy_tree",
      "type",
      "mint",
      "map:__str_utf8_to_flat",
      "build:decoder",
    ]);
    expect(r.ctx.mod.functions).toHaveLength(1);
    expect(r.ctx.mod.functions[0]).toBe(r.captured[0]);
    expect(r.captured[0]!.body).toEqual([]);
    expect(r.captured[0]!.locals).toEqual([]);
    expect(r.selections).toEqual([]);
  });
  it("disabled copy body and all seven locals equal the complete original checked source", () => {
    const r = legacy(false);
    expect(r.error).toBeUndefined();
    const path = "src/runtime/wasmgc/values/string-flatten-bodies.ts";
    const url = new URL("../" + path, import.meta.url).href;
    const original = projectCopyTreeUtf8(read(path), url, url, sha).text;
    const build = evaluate(original, ["buildStringCopyTreeDefinition"], {}).buildStringCopyTreeDefinition!;
    const expected = build(r.ctx, r.worklists[0]);
    expect(r.captured[0]!.body).toEqual(expected.body);
    expect(r.captured[0]!.locals).toEqual(expected.locals);
  });
  for (const field of ["utf8StrTypeIdx", "utf8StrDataTypeIdx"] as const)
    for (const invalid of [-1, NaN, 1.5])
      it("rejects present decoder with invalid " + field + "=" + invalid, () => {
        const state = reserve(),
          { pack, strings } = state;
        const binding = { kind: "present" as const, handle: pack.utf8Decoder!.handle };
        expect(buildStringCopyTreeDefinition(strings.layout, pack.worklist.typeIndex, binding).locals).toHaveLength(7);
        expect(() =>
          buildStringCopyTreeDefinition({ ...strings.layout, [field]: invalid }, pack.worklist.typeIndex, binding),
        ).toThrow("decoder requires UTF8 layout");
      });
});

describe("actual public long concat uses the repaired shared flatten path", () => {
  for (const experimentalIR of [false, true])
    for (const utf8Storage of [false, true])
      it(
        "IR=" + experimentalIR + " UTF8=" + utf8Storage,
        async () => {
          const source =
            "function join(a: string, b: string): string { return a + b; }\n" +
            'export function probe(flag: number): number { const a = flag ? "' +
            "x".repeat(64) +
            '" : "' +
            "y".repeat(64) +
            '"; const b = flag ? "é" : "Ω"; return join(a, b).charCodeAt(64); }';
          expect(sha(source)).toBe("81efa68899db0020c346843ecac041348e573af3079605e2a3c1ab7c3f953e03");
          const options = {
            fileName: "e1-long-concat.ts",
            target: "standalone" as const,
            nativeStrings: true,
            utf8Storage,
            experimentalIR,
            optimize: false,
            emitWat: true,
          };
          const result = await compile(source, options);
          expect(result.success, JSON.stringify(result.errors)).toBe(true);
          if (!result.binary || !result.wat) throw Error("missing public compiler artifacts");
          const binary = Uint8Array.from(result.binary),
            compiled = new WebAssembly.Module(binary);
          expect(WebAssembly.Module.imports(compiled)).toEqual([]);
          const observations = [];
          for (let instance = 0; instance < 2; instance++) {
            const wasm = new WebAssembly.Instance(compiled, {});
            const run = wasm.exports.probe as (flag: number) => number;
            for (let repeat = 0; repeat < 2; repeat++)
              for (const argument of [1, 0]) {
                const expected = argument ? 233 : 937;
                try {
                  observations.push({ instance, repeat, argument, value: run(argument), expected });
                } catch (error) {
                  observations.push({
                    instance,
                    repeat,
                    argument,
                    expected,
                    error:
                      error instanceof Error
                        ? { name: error.name, message: error.message, stack: error.stack }
                        : { thrown: String(error) },
                  });
                }
              }
          }
          writeFileSync(
            resolve(evidenceDirectory(), "public.json"),
            JSON.stringify(
              {
                source,
                options,
                binary: Buffer.from(binary).toString("base64"),
                instantiatedBinary: Buffer.from(binary).toString("base64"),
                wat: result.wat,
                imports: WebAssembly.Module.imports(compiled),
                exports: WebAssembly.Module.exports(compiled),
                observations,
                enabledByteParityClaimed: false,
              },
              null,
              2,
            ),
          );
          for (const observation of observations) expect(observation).toMatchObject({ value: observation.expected });
        },
        120000,
      );
});
