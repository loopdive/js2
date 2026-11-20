// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
  requireNativeStringFlattenReservations,
  requireCompletedNativeStringFlatten,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";

function reserve(utf8Storage = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage,
    literals: [
      { value: "", encoding: "wtf16" },
      { value: "x42y", encoding: "wtf16" },
      ...(utf8Storage ? [{ value: "Aé€😀", encoding: "utf8-guaranteed" as const }] : []),
    ],
  });
  const pack = reserveNativeStringFlattenResources(tx, "flatten", strings);
  return { module, tx, strings, pack };
}
function filled(utf8 = false) {
  const state = reserve(utf8);
  state.tx.freezeReservations();
  fillNativeStringLiteralResources(state.tx, state.strings);
  fillNativeStringFlattenResources(state.tx, state.pack);
  expect(requireCompletedNativeStringFlatten(state.tx, state.pack, state.strings)).toBe(state.pack);
  return state;
}

describe("native flatten resource authentication", () => {
  it("admits the issued pack before freeze without claiming completion", () => {
    const { tx, pack, strings } = reserve();
    expect(requireNativeStringFlattenReservations(tx, pack)).toBe(pack);
    expect(tx.state).toBe("reserving");
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow("missing canonical fill");
  });
  it("retains copy/decoder/flatten reservation order", () => {
    const { module, pack } = reserve(true);
    expect(module.functions.map((f) => f.name)).toEqual(["__str_copy_tree", "__str_utf8_to_flat", "__str_flatten"]);
    expect(pack.utf8Decoder).not.toBeNull();
  });
  it("rejects cloned packs after a genuine reservation positive", () => {
    const { tx, pack } = reserve();
    expect(requireNativeStringFlattenReservations(tx, pack)).toBe(pack);
    expect(() => requireNativeStringFlattenReservations(tx, { ...pack })).toThrow("foreign or forged");
  });
  it("rejects a foreign transaction after a genuine positive", () => {
    const a = reserve(),
      b = reserve();
    expect(requireNativeStringFlattenReservations(a.tx, a.pack)).toBe(a.pack);
    expect(() => requireNativeStringFlattenReservations(b.tx, a.pack)).toThrow("foreign or forged");
  });
  it("rejects a different completed string pack", () => {
    const a = filled(),
      b = filled();
    expect(() => requireCompletedNativeStringFlatten(a.tx, a.pack, b.strings)).toThrow("foreign string dependency");
  });
  it("refuses missing string fill before filling any flatten body", () => {
    filled();
    const { tx, pack, module } = reserve();
    tx.freezeReservations();
    expect(() => fillNativeStringFlattenResources(tx, pack)).toThrow();
    expect(module.functions.every((f) => f.body.length === 0)).toBe(true);
  });
  it("refuses missing own fill despite completed strings", () => {
    filled();
    const { tx, pack, strings } = reserve();
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow("missing canonical fill");
  });
  it("rejects a duplicate fill", () => {
    const { tx, pack } = filled();
    expect(() => fillNativeStringFlattenResources(tx, pack)).toThrow("duplicate fill");
  });
  it("requires an explicit UTF-16 empty demand even when a UTF-8 empty exists", () => {
    filled(true);
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const strings = reserveNativeStringLiteralResources(tx, {
      key: "utf8-only",
      utf8Storage: true,
      literals: [{ value: "", encoding: "ascii" }],
    });
    expect(() => reserveNativeStringFlattenResources(tx, "flatten", strings)).toThrow("missing literal");
  });
  it("rejects forged string ownership before reserving flatten resources", () => {
    const { tx, strings, module } = reserve();
    const count = module.functions.length;
    expect(() => reserveNativeStringFlattenResources(tx, "forged", { ...strings })).toThrow("foreign or forged");
    expect(module.functions.length).toBe(count);
  });
  it("rejects a changed completed UTF-8 decoder", () => {
    const { tx, pack, strings } = filled(true);
    expect(pack.utf8Decoder).not.toBeNull();
    pack.utf8Decoder!.object.body = [{ op: "unreachable" }];
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow();
  });
  for (const field of ["body", "locals"] as const)
    it(`rejects changed completed ${field}`, () => {
      const { tx, pack, strings } = filled();
      if (field === "body") pack.flatten.object.body = [{ op: "unreachable" }];
      else pack.flatten.object.locals = [];
      expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow();
    });
  it("rejects mutation of the completed empty literal", () => {
    const { tx, pack, strings } = filled();
    pack.emptyLiteral.object.init = [{ op: "unreachable" }];
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow();
  });
  it("rejects reordered completed functions", () => {
    const { tx, pack, strings, module } = filled();
    [module.functions[0], module.functions[1]] = [module.functions[1]!, module.functions[0]!];
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow("reordered");
  });
  it("rejects a correctly named constant-return substitute for completed copy-tree", () => {
    const { tx, pack, strings } = filled();
    expect(pack.copyTree.object.name).toBe("__str_copy_tree");
    pack.copyTree.object.body = [{ op: "i32.const", value: 0 }];
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow("altered completed function");
  });
});

/** Real string constructors feed the actual owned copy/flatten bodies; no scanner stand-in. */
function execute(utf8 = false) {
  const state = reserve(utf8),
    { tx, pack, strings, module } = state,
    l = strings.layout;
  const probe = tx.reserveFunction("probe", "probe", { params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
  const rope = tx.reserveFunction("rope", "rope", { params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, pack);
  const literal = requireNativeStringLiteral(tx, strings, utf8 ? "Aé€😀" : "x42y", utf8 ? "utf8-guaranteed" : "wtf16");
  if (literal.kind !== "global") throw Error("expected actual literal global");
  const load: Instr[] = [{ op: "global.get", index: tx.physicalIndex(literal.global) }];
  // The UTF-16 view uses a nonzero flat offset and length two.
  const view: Instr[] = utf8
    ? load
    : [
        { op: "i32.const", value: 2 },
        { op: "i32.const", value: 1 },
        ...load,
        { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "struct.new", typeIdx: l.nativeStrTypeIdx },
      ];
  tx.fillFunction(probe, {
    locals: [],
    body: [
      ...view,
      { op: "call", funcIdx: pack.flatten.handle },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 0 },
      ...(!utf8 ? ([{ op: "i32.const", value: 1 }, { op: "i32.add" }] as Instr[]) : []),
      { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
    ],
  });
  const leaf: Instr[] = [
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 65 },
    { op: "array.new_fixed", typeIdx: l.nativeStrDataTypeIdx, length: 1 },
    { op: "struct.new", typeIdx: l.nativeStrTypeIdx },
  ];
  tx.fillFunction(rope, {
    locals: [
      { name: "s", type: { kind: "ref_null", typeIdx: l.anyStrTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "first", type: { kind: "ref_null", typeIdx: l.nativeStrTypeIdx } },
    ],
    body: [
      ...leaf,
      { op: "local.set", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 0 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "i32.add" },
              { op: "local.get", index: 1 },
              { op: "ref.as_non_null" },
              ...leaf,
              { op: "struct.new", typeIdx: l.consStrTypeIdx },
              { op: "local.set", index: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: pack.flatten.handle },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: pack.flatten.handle },
      { op: "local.get", index: 3 },
      { op: "ref.eq" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 100 },
      { op: "i32.mul" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 0 },
      { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
      { op: "i32.add" },
      { op: "i32.mul" },
    ],
  });
  tx.defineExport("export:probe", "probe", probe);
  tx.defineExport("export:rope", "rope", rope);
  requireCompletedNativeStringFlatten(tx, pack, strings);
  tx.seal();
  const bytes = emitBinary(module),
    compiled = new WebAssembly.Module(bytes as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  return new WebAssembly.Instance(compiled).exports as unknown as {
    probe(index: number): number;
    rope(depth: number): number;
  };
}
describe("actual owned flatten execution", () => {
  it("executes a genuine UTF-8 flatten pack in a fresh process with legacy/frontend imports forbidden", () => {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      import { pathToFileURL } from "node:url";
      const seen = new Set();
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (/\/src\/(codegen|checker|frontend)\//.test(result.url) || /\/src\/ir\/program-source\./.test(result.url)) throw Error("forbidden frontend/legacy import " + result.url);
        if (result.url.includes("/src/")) seen.add(result.url);
        return result;
      }});
      const load = p => import(pathToFileURL(process.cwd() + "/" + p).href);
      const { PhysicalModuleReservations } = await load("src/wasm/physical/module-reservations.ts");
      const strings = await load("src/backend/wasmgc/resources/native-string-literals.ts");
      const flatten = await load("src/backend/wasmgc/resources/native-string-flatten.ts");
      const { emitBinary } = await load("src/emit/binary.ts");
      const module = { types:[], imports:[], functions:[], exports:[], tables:[], elements:[], globals:[], tags:[], stringPool:[], externClasses:[], nodeBuiltinModules:new Set(), platformCapabilityImportProvenance:new Map(), stringLiteralValues:new Map(), asyncFunctions:new Set(), declaredFuncRefs:[], funcOrdinalToPosition:[], memories:[], dataSegments:[] };
      const tx = new PhysicalModuleReservations(module);
      const s = strings.reserveNativeStringLiteralResources(tx, {key:"fresh",utf8Storage:true,literals:[{value:"",encoding:"wtf16"},{value:"é",encoding:"utf8-guaranteed"}]});
      const f = flatten.reserveNativeStringFlattenResources(tx,"flatten",s);
      const probe = tx.reserveFunction("probe","probe",{params:[],results:[{kind:"i32"}]});
      tx.freezeReservations(); strings.fillNativeStringLiteralResources(tx,s); flatten.fillNativeStringFlattenResources(tx,f);
      const literal = strings.requireNativeStringLiteral(tx,s,"é","utf8-guaranteed");
      assert.equal(literal.kind,"global");
      tx.fillFunction(probe,{locals:[],body:[{op:"global.get",index:tx.physicalIndex(literal.global)},{op:"call",funcIdx:f.flatten.handle},{op:"struct.get",typeIdx:s.layout.nativeStrTypeIdx,fieldIdx:2},{op:"i32.const",value:0},{op:"array.get_u",typeIdx:s.layout.nativeStrDataTypeIdx}]});
      tx.defineExport("export:probe","probe",probe);flatten.requireCompletedNativeStringFlatten(tx,f,s);tx.seal();
      const compiled = new WebAssembly.Module(emitBinary(module));assert.deepEqual(WebAssembly.Module.imports(compiled),[]);
      const run = new WebAssembly.Instance(compiled).exports.probe;
      assert.equal(run(),233);assert.equal(run(),233);
      assert([...seen].some(p=>p.endsWith("string-flatten-bodies.ts")));
      assert([...seen].some(p=>p.endsWith("string-utf8-decode-bodies.ts")));
      console.log(JSON.stringify({outcomes:[233,233],canonicalRoots:2}));
    `;
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ outcomes: [233, 233], canonicalRoots: 2 });
  });
  it("retains nonzero flat offsets", () => {
    const x = execute();
    expect(x.probe(0)).toBe(52);
    expect(x.probe(1)).toBe(50);
  });
  for (const depth of [1, 17, 40, 1000])
    it(`flattens and memoizes depth ${depth}`, () => {
      const x = execute();
      expect(x.rope(depth)).toBe((depth + 1) * 100 + 65);
      expect(x.rope(depth)).toBe((depth + 1) * 100 + 65);
    });
  it("decodes selected UTF-8 including astral code points", () => {
    const x = execute(true);
    expect([0, 1, 2, 3, 4].map((i) => x.probe(i))).toEqual([65, 233, 8364, 55357, 56832]);
  });
});
