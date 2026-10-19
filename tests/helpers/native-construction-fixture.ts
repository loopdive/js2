// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { prepareWholeIrProgram } from "../../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../../src/ir/program-codec.js";
import { sourceInput } from "./typed-program-fixtures.js";
import { descriptorFixture, completeDescriptorFixture } from "./native-descriptor-fixture.js";
import { deriveNativeObjectConstructionRequirements } from "../../src/ir/program/native-object-construction-requirements.js";
import {
  declareNativeObjectConstructionResources,
  reserveNativeObjectConstructionResources,
  fillNativeObjectConstructionResources,
  requireCompletedNativeObjectConstruction,
} from "../../src/backend/wasmgc/resources/native-object-construction.js";
import { emitBinary } from "../../src/emit/binary.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";

export const RECORD_SOURCE = `
type Ref={x:number};
export function make(n:number,b:boolean,s:string,r:Ref):{z:number,a:boolean,text:string,ref:Ref}{return {z:n,a:b,text:s,ref:r};}
export function reverse(n:number,b:boolean,s:string,r:Ref):{z:number,a:boolean,text:string,ref:Ref}{return {a:b,z:n,text:s,ref:r};}
export function grow(n:number):{z:number,y:number,x:number,w:number,v:number,u:number,t:number,s:number,r:number,q:number,p:number,o:number}{return {z:n,y:n,x:n,w:n,v:n,u:n,t:n,s:n,r:n,q:n,p:n,o:n};}
`;
let cached: ReturnType<typeof constructionSource> | undefined;
export function constructionSource(text = RECORD_SOURCE, decoded = false) {
  const policy = {
    backend: "wasmgc",
    target: "standalone",
    numberBoundary: { box: "unsupported", unbox: "native" },
    stringConst: { storage: "native" },
  } as const;
  const result = prepareWholeIrProgram({
    ...sourceInput({ "./entry.ts": text }),
    policy,
    runtimePolicies: [policy],
    nativeStringValueProjection: "standalone-native",
    objectReferenceProjection: "live",
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(result.program)) : result.program;
  return { program, projection: program.runtime[0]! };
}
export function constructionFixture(offset = false, decoded = false, text = RECORD_SOURCE) {
  const source =
    decoded || text !== RECORD_SOURCE ? constructionSource(text, decoded) : (cached ??= constructionSource());
  const literals = [..."zyxwvutsrqpo", "a", "text", "ref", "hello", "inherited"];
  const f = descriptorFixture(offset, source, literals);
  const requirements = deriveNativeObjectConstructionRequirements(f.access);
  const dependencies = { descriptors: f.pack, descriptorDependencies: f.dependencies };
  const stringType = f.strings.types.find((type) => type.typeIndex === f.strings.layout.anyStrTypeIdx)!;
  const plans = requirements.constructors.map((demand, index) =>
    declareNativeObjectConstructionResources("construction:" + index, demand, f.layouts.object.key, stringType.key),
  );
  const constructors = plans.map((plan, index) =>
    reserveNativeObjectConstructionResources(f.tx, "construction:" + index, requirements, index, dependencies, plan),
  );
  return { ...f, requirements, constructionDependencies: dependencies, constructionPlans: plans, constructors };
}

/** Observer ABI is test-only; actual record demand and every production resource are genuine. */
export function constructionRuntime(offset = false, decoded = false, text = RECORD_SOURCE) {
  const f = constructionFixture(offset, decoded, text),
    { tx } = f;
  const ext: ValType = { kind: "externref" },
    i32: ValType = { kind: "i32" };
  const observer = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction("observer:" + name, name, { params, results });
  const key = observer("key", [], [ext]),
    entry = observer("entry", [ext, ext], [i32, ext, i32]);
  const prototype = observer("prototype", [ext], [ext]),
    count = observer("count", [ext], [i32]);
  const has = observer("has", [ext, ext], [i32]),
    isBoolean = f.booleans.isBoolean;
  const wrappers = f.constructors.map((_, index) => {
    const demand = f.requirements.constructors[index]!;
    const params: ValType[] = demand.carriers.map((carrier) =>
      carrier === "number" ? { kind: "f64" } : carrier === "boolean" ? i32 : ext,
    );
    return observer("initialize" + index, [ext, ...params], [ext]);
  });
  const keyObservers = [..."zyxwvutsrqpo", "a", "text", "ref", "hello", "inherited"].map((text) => ({
    text,
    token: observer("key:" + text, [], [ext]),
  }));
  completeDescriptorFixture(f);
  f.constructors.forEach((pack, index) => {
    fillNativeObjectConstructionResources(tx, pack);
    requireCompletedNativeObjectConstruction(tx, pack, f.requirements, index, f.constructionDependencies);
  });
  const literal = (text: string): Instr[] => {
    const ref = requireNativeStringLiteral(tx, f.strings, text);
    return [
      ref.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(ref.global) }
        : { op: "call", funcIdx: ref.function.handle },
      { op: "extern.convert_any" },
    ];
  };
  tx.fillFunction(key, { locals: [], body: literal("hello") });
  keyObservers.forEach(({ text, token }) => tx.fillFunction(token, { locals: [], body: literal(text) }));
  const object = (index = 0): Instr[] => [
    { op: "local.get", index },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.layouts.object.typeIndex },
  ];
  const found = (): Instr[] => [
    ...object(),
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: f.lookup.findOwn.handle },
    { op: "ref.as_non_null" },
  ];
  tx.fillFunction(entry, {
    locals: [],
    body: [
      ...found(),
      { op: "struct.get", typeIdx: f.layouts.propEntry.typeIndex, fieldIdx: 2 },
      ...found(),
      { op: "struct.get", typeIdx: f.layouts.propEntry.typeIndex, fieldIdx: 1 },
      { op: "extern.convert_any" },
      ...found(),
      { op: "struct.get", typeIdx: f.layouts.propEntry.typeIndex, fieldIdx: 3 },
    ],
  });
  tx.fillFunction(prototype, {
    locals: [],
    body: [
      ...object(),
      { op: "struct.get", typeIdx: f.layouts.object.typeIndex, fieldIdx: 0 },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(count, {
    locals: [],
    body: [...object(), { op: "struct.get", typeIdx: f.layouts.object.typeIndex, fieldIdx: 2 }],
  });
  tx.fillFunction(has, {
    locals: [],
    body: [...object(), { op: "local.get", index: 1 }, { op: "call", funcIdx: f.lookup.has.handle }],
  });
  wrappers.forEach((token, index) => {
    const demand = f.requirements.constructors[index]!;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast_null", typeIdx: f.layouts.object.typeIndex },
    ];
    demand.carriers.forEach((carrier, i) => {
      body.push({ op: "local.get", index: i + 1 });
      if (carrier === "native-string")
        body.push({ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: f.strings.layout.anyStrTypeIdx });
    });
    body.push({ op: "call", funcIdx: f.constructors[index]!.initialize.handle });
    tx.fillFunction(token, { locals: [], body });
  });
  for (const [name, token] of Object.entries({
    key,
    entry,
    prototype,
    count,
    has,
    isBoolean,
    createNull: f.storage.createNull,
    defineData: f.pack.defineData,
    unboxNumber: f.values.functions.unboxNumber,
    unboxBoolean: f.booleans.unboxBoolean,
  }))
    tx.defineExport("export:" + name, name, token);
  wrappers.forEach((token, index) => tx.defineExport("export:initialize" + index, "initialize" + index, token));
  keyObservers.forEach(({ text, token }) => tx.defineExport("export:key:" + text, "key:" + text, token));
  tx.seal();
  const bytes = emitBinary(f.module),
    module = new WebAssembly.Module(bytes as BufferSource);
  if (WebAssembly.Module.imports(module).length) throw Error("native construction unexpectedly imports providers");
  const exports = new WebAssembly.Instance(module).exports as Record<string, (...values: any[]) => any>;
  return { f, exports, bytes, imports: WebAssembly.Module.imports(module) };
}
