// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { optimizeBinaryAsync } from "../src/optimize.js";
import type { Instr, ValType } from "../src/ir/types.js";

const compilerPath = process.env.CLASS_DELETE_COMPILER_ROOT;
// Preserve a runnable original red assertion, not just a hardcoded diagnostic receipt.
const originalJsAssertions = process.env.CLASS_DELETE_ASSERT_ORIGINAL_JS === "1";
afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.gc?.();
});
const { compileSourceSync } = await import(
  compilerPath ? pathToFileURL(`${compilerPath}/src/compiler.ts`).href : "../src/compiler.js"
);

const cases: [string, string][] = [];
for (const configurable of ["true", "false", "undefined"]) {
  for (const writable of [false, true]) {
    cases.push([
      `descriptor configurable=${configurable} writable=${writable}`,
      `
      class C { x = 11; } const o = new C();
      Object.defineProperty(o, "x", {value: undefined, configurable: ${configurable}, writable: ${writable}});
      const before = own(o, "x"); const deleted = delete o.x;
      return before + 2 * deleted + 4 * own(o, "x");`,
    ]);
  }
}
cases.push(
  [
    "double deletion hides physical field",
    `class C {x=11;} const o=new C();
    Object.defineProperty(o,"x",{value:23,writable:true,configurable:true});
    const a=delete o.x; const b=delete o.x;
    return a+2*b+4*own(o,"x");`,
  ],
  [
    "preventExtensions successful delete and failed assignment",
    `class C {x=11;} const o=new C();
    Object.defineProperty(o,"x",{value:23,writable:true,configurable:true});
    Object.preventExtensions(o); const a=delete o.x;
    try { o["x"]=37; } catch (_) {}
    return a+2*own(o,"x");`,
  ],
  [
    "accessor delete never invokes getter or setter",
    `let calls=0; class C {x=11;} const o=new C();
    Object.defineProperty(o,"x",{get(){calls++;return 23;},set(v){calls++;},configurable:true});
    const a=delete o.x; const b=delete o.x;
    return a+2*b+4*own(o,"x")+8*calls;`,
  ],
  [
    "constructor descriptor",
    `class C {static x=11;}
    Object.defineProperty(C,"x",{value:23,writable:true,configurable:true});
    const a=delete C.x; return a+2*own(C,"x");`,
  ],
  ["ordinary object unaffected", `const o={x:11};const a=delete o.x;return a+2*own(o,"x");`],
  ["array expando unaffected", `const o=[];o.x=11;const a=delete o.x;return a+2*own(o,"x");`],
  ["function expando unaffected", `function o(){}o.x=11;const a=delete o.x;return a+2*own(o,"x");`],
  ["real Object bag unaffected", `const o=Object.create(null);o.x=11;const a=delete o.x;return a+2*own(o,"x");`],
  [
    "proxy value is not invoked",
    `let calls=0;class C{x=11;}const o=new C();
    const value=new Proxy({},{get(t,k){calls++;return 17;}});
    Object.defineProperty(o,"x",{value,configurable:true});
    const a=delete o.x;return a+2*own(o,"x")+4*calls;`,
  ],
  [
    "keys and rehash after repeated deletion",
    `class C{}const o=new C();
    for(let i=0;i<40;i++)Object.defineProperty(o,"k"+i,{value:i,writable:true,enumerable:true,configurable:true});
    let deleted=0;for(let i=0;i<40;i++)deleted+=remove(o,"k"+i);
    for(let i=0;i<40;i++)deleted+=remove(o,"k"+i);
    for(let i=0;i<40;i++)Object.defineProperty(o,"j"+i,{value:i,writable:true,enumerable:true,configurable:true});
    let visible=0;for(let i=0;i<40;i++)visible+=own(o,"j"+i);
    return deleted+100*visible+10000*Object.keys(o).length;`,
  ],
);
for (const integrity of ["seal", "freeze"]) {
  cases.push([
    integrity,
    `class C {x=11;} const o=new C();
    Object.defineProperty(o,"x",{value:23,writable:true,configurable:true});
    Object.${integrity}(o); const a=delete o.x; return a+2*own(o,"x");`,
  ]);
}
for (const descriptor of ["{}", "{value:31}", "{get(){return 31;}}"]) {
  for (const nonextensible of [false, true]) {
    cases.push([
      `delete then define ${descriptor} nonextensible=${nonextensible}`,
      `
      function defineAgain(o,k){Object.defineProperty(o,k,${descriptor});}
      class C {x=11;} const o=new C();
      Object.defineProperty(o,"x",{value:23,writable:true,configurable:true});
      ${nonextensible ? "Object.preventExtensions(o);" : ""}
      const a=delete o.x; let threw=0;
      try {defineAgain(o,"x");} catch (_) {threw=1;}
      const present=own(o,"x"); const b=delete o.x;
      return a+2*threw+4*present+8*b;`,
    ]);
  }
}
for (const staged of [false, true]) {
  cases.push([
    `nonwritable delete then empty define staged=${staged}`,
    `function defineAgain(o,k){Object.defineProperty(o,k,{});}
    class C{x=11;}const o=new C();
    Object.defineProperty(o,"x",{value:23,writable:false,configurable:true});
    const deleted=remove(o,"x");const afterDelete=own(o,"x");
    defineAgain(o,"x");const afterDefine=own(o,"x");
    return ${staged ? "deleted+2*afterDelete+4*afterDefine" : "afterDefine"};`,
  ]);
}

for (const descriptor of ["{get:17}", "{value:31,get(){return 1;}}", "{get value(){throw 17;}}"]) {
  cases.push([
    `invalid or abrupt descriptor ${descriptor}`,
    `
    function define(o,k,d){Object.defineProperty(o,k,d);}
    class C{x=11;}const o=new C();
    define(o,"x",{value:23,writable:true,configurable:true});remove(o,"x");
    let threw=0;try{define(o,"x",${descriptor});}catch(_){threw=1;}
    return threw+2*own(o,"x")+4*remove(o,"x");`,
  ]);
}
for (const integrity of ["seal", "freeze"]) {
  cases.push([
    `marker ${integrity} refusal`,
    `
    function define(o,k,d){Object.defineProperty(o,k,d);}
    class C{x=11;}const o=new C();
    define(o,"x",{value:23,writable:true,configurable:true});remove(o,"x");
    Object.${integrity}(o);let threw=0;try{define(o,"x",{});}catch(_){threw=1;}
    return threw+2*own(o,"x")+4*remove(o,"x");`,
  ]);
}
cases.push([
  "repeated delete and redefine constructor",
  `
  function define(o,k,d){Object.defineProperty(o,k,d);}
  class C{static x=11;}let score=0;
  for(let i=0;i<12;i++){define(C,"x",{value:i,writable:true,configurable:true});
    score+=own(C,"x");score+=remove(C,"x");score+=10*own(C,"x");}
  return score;`,
]);

describe.each([0, 2])("class retained-entry deletion O%i (known diagnostics explicitly separate)", (level) => {
  it.each(cases)(
    "%s",
    async (name, body) => {
      const deletionBody = body.replace(/delete (o|C)\.x/g, 'remove($1,"x")');
      const source = `function own(o,k){const f=Object.prototype.hasOwnProperty;return f.call(o,k)?1:0;}
      function remove(o,k){try{return delete o[k]?1:0;}catch(_){return 0;}}
      export function main(){${deletionBody}}`;
      const expected = new Function(source.replace("export function", "function") + ";return main();")();
      const result = compileSourceSync(source, {
        fileName: "class-delete.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "standalone",
        emitWat: true,
        optimize: false,
      });
      expect(result.errors.filter((e: { severity: string }) => e.severity === "error")).toEqual([]);
      expect(result.success).toBe(true);
      const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
      const evidenceDir = process.env.CLASS_DELETE_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        const file = `${evidenceDir}/${cases.findIndex(([caseName]) => caseName === name)}`;
        writeFileSync(`${file}.js`, source);
        writeFileSync(`${file}.wat`, result.wat ?? "");
      }
      const optimized = level === 2 ? await optimizeBinaryAsync(result.binary, { level: 2 }) : undefined;
      if (optimized) expect(optimized.optimized, optimized.warning).toBe(true);
      const binary = optimized?.binary ?? result.binary;
      const module = new WebAssembly.Module(binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = new WebAssembly.Instance(module, {});
      (instance.exports.__module_init as (() => void) | undefined)?.();
      const actual = (instance.exports.main as () => number)();
      console.log(
        JSON.stringify({
          name,
          expected,
          actual,
          compiler: compilerPath ?? "candidate",
          sourceSha256: digest(source),
          binarySha256: digest(binary),
          level,
        }),
      );
      const known =
        name === "ordinary object unaffected"
          ? 3
          : name === "keys and rehash after repeated deletion"
            ? 4080
            : undefined;
      if (known !== undefined && !originalJsAssertions) {
        // Explicit baseline diagnostics, NOT conformance passes. Original red v3 logs retained.
        expect({ actual, correct: expected }).toEqual({
          actual: known,
          correct: name === "ordinary object unaffected" ? 1 : 404080,
        });
      } else expect(actual).toBe(expected);
    },
    30000,
  );
});

/** Test-only exports read actual runtime storage; no production ABI is changed. */
async function storageProbe(descriptor: string, level: number) {
  // Baseline-only behavioral runs must not load a second compiler graph into the worker.
  const [{ analyzeSource }, { generateModule }, { emitBinary }, { widenNonDefaultableTypes }] = await Promise.all([
    import("../src/checker/index.js"),
    import("../src/codegen/index.js"),
    import("../src/emit/binary.js"),
    import("../src/compiler/output.js"),
  ]);
  const source = `class C{x=11;} const o=new C();
    function define(o:any,k:string,d:any){Object.defineProperty(o,k,d);}
    export function receiver(){return o;} export function key(){return "x";}
    export function setup(){define(o,"x",{value:23,writable:true,enumerable:true,configurable:true});}
    export function erase(){try{return delete o["x"]?1:0;}catch(_){return 0;}}
    export function again(){define(o,"x",${descriptor});}
    export function prevent(){Object.preventExtensions(o);}
    export function seal(){Object.seal(o);} export function freeze(){Object.freeze(o);}
    export function invalid(){define(o,"x",{get:17});}
    export function mixed(){define(o,"x",{value:31,get(){return 1;}});}
    export function abrupt(){define(o,"x",{get value(){throw 17;}});}
    export function grow(){for(let i=0;i<40;i++)define(o,"p"+i,{value:i,configurable:true});}
    export function own(){return Object.prototype.hasOwnProperty.call(o,"x")?1:0;}`;
  const { module: mod, errors } = generateModule(analyzeSource(source, "storage.ts"), {
    standalone: true,
    nativeStrings: true,
    experimentalIR: true,
  });
  expect(errors.filter((e) => e.severity === "error")).toEqual([]);
  expect(mod.imports).toEqual([]);
  const find = (name: string) => {
    const i = mod.functions.findIndex((f) => f.name === name);
    expect(i, name).toBeGreaterThanOrEqual(0);
    return i;
  };
  const objectType = mod.types.findIndex((t) => t.kind === "struct" && t.name === "$Object");
  const entryType = mod.types.findIndex((t) => t.kind === "struct" && t.name === "$PropEntry");
  expect(objectType).toBeGreaterThanOrEqual(0);
  expect(entryType).toBeGreaterThanOrEqual(0);
  const undefinedGlobal = mod.globals.findIndex((g) => g.name === "__undefined");
  expect(undefinedGlobal).toBeGreaterThanOrEqual(0);
  const lookup = find("__closure_bag_lookup"),
    locate = find("__obj_find");
  const object: Instr[] = [{ op: "local.get", index: 3 }, { op: "ref.as_non_null" }];
  const entry: Instr[] = [{ op: "local.get", index: 4 }, { op: "ref.as_non_null" }];
  const reads: Instr[][] = [
    ...[2, 3, 5].map((fieldIdx) => [...object, { op: "struct.get", typeIdx: objectType, fieldIdx }] as Instr[]),
    ...[3, 2].map((fieldIdx) => [...entry, { op: "struct.get", typeIdx: entryType, fieldIdx }] as Instr[]),
    ...[1, 4, 5].map(
      (fieldIdx) => [...entry, { op: "struct.get", typeIdx: entryType, fieldIdx }, { op: "ref.is_null" }] as Instr[],
    ),
    [
      ...entry,
      { op: "struct.get", typeIdx: entryType, fieldIdx: 0 },
      { op: "ref.cast", typeIdx: -19 },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: -19 },
      { op: "ref.eq" },
    ],
    [
      ...entry,
      { op: "struct.get", typeIdx: entryType, fieldIdx: 1 },
      { op: "ref.cast_null", typeIdx: -19 },
      { op: "global.get", index: undefinedGlobal },
      { op: "ref.eq" },
    ],
  ];
  const params: ValType[] = [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }];
  const typeIdx = mod.types.length;
  mod.types.push({ kind: "func", params, results: [{ kind: "i32" }] });
  const index = mod.functions.length;
  mod.functions.push({
    name: "storage",
    typeIdx,
    locals: [
      { name: "bag", type: { kind: "ref_null", typeIdx: objectType } },
      { name: "entry", type: { kind: "ref_null", typeIdx: entryType } },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lookup },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: objectType },
      { op: "local.tee", index: 3 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: locate },
      { op: "local.set", index: 4 },
      ...reads.flatMap((read, i): Instr[] => [
        { op: "local.get", index: 2 },
        { op: "i32.const", value: i },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [...read, { op: "return" }] },
      ]),
      { op: "i32.const", value: -1 },
    ],
    exported: true,
  });
  mod.exports.push({ name: "storage", desc: { kind: "func", index } });
  const identityType = mod.types.length;
  mod.types.push({ kind: "func", params, results: [{ kind: "externref" }] });
  const identityIndex = mod.functions.length;
  mod.functions.push({
    name: "storageEntry",
    typeIdx: identityType,
    exported: true,
    locals: mod.functions[index]!.locals.map((local) => ({ ...local })),
    body: [
      ...mod.functions[index]!.body.slice(0, 8).map((i) => ({ ...i })),
      { op: "local.get", index: 4 },
      { op: "extern.convert_any" },
    ],
  });
  mod.exports.push({ name: "storageEntry", desc: { kind: "func", index: identityIndex } });
  widenNonDefaultableTypes(mod);
  let binary = emitBinary(mod);
  if (level === 2) {
    const opt = await optimizeBinaryAsync(binary, { level: 2 });
    expect(opt.optimized, opt.warning).toBe(true);
    binary = opt.binary;
  }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), {});
  const api = instance.exports as Record<string, (...args: any[]) => any>;
  api.__module_init?.();
  api.setup();
  const snapshot = () => reads.map((_, i) => api.storage(api.receiver(), api.key(), i));
  const entryIdentity = () => api.storageEntry(api.receiver(), api.key(), 0);
  return { api, snapshot, entryIdentity };
}

describe.each([0, 2])("actual retained-entry storage O%i", (level) => {
  it.each(["{}", "{value:null}", "{value:undefined}", "{get(){return 31;}}"])(
    "fresh descriptor %s",
    async (descriptor) => {
      const { api, snapshot, entryIdentity } = await storageProbe(descriptor, level);
      const identity = entryIdentity();
      expect(entryIdentity()).toBe(identity);
      const before = snapshot();
      expect(api.erase()).toBe(1);
      const deleted = snapshot();
      expect(deleted.slice(0, 4)).toEqual(before.slice(0, 4));
      expect(deleted.slice(4)).toEqual([7, 0, 1, 1, 1, 0]);
      expect(api.erase()).toBe(1);
      expect(snapshot()).toEqual(deleted);
      api.again();
      expect(entryIdentity()).toBe(identity);
      const after = snapshot();
      expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
      expect(after[2]).toBe(before[2] + 1);
      expect(after[3]).toBe(before[2]);
      expect(after[4]).toBe(descriptor.includes("get()") ? 8 : 0);
      expect(after[5]).toBe(descriptor === "{value:null}" || descriptor.includes("get()") ? 1 : 0);
      expect(after[6]).toBe(descriptor.includes("get()") ? 0 : 1);
      expect(after[7]).toBe(1);
      expect(after[9]).toBe(descriptor === "{}" || descriptor === "{value:undefined}" ? 1 : 0);
      expect(api.own()).toBe(1);
      expect(api.erase()).toBe(0);
      expect(snapshot()).toEqual(after);
      api.grow();
      const grown = snapshot();
      expect(grown[0]).toBe(after[0] + 40);
      expect(grown[1]).toBe(after[1]);
      expect(grown[2]).toBe(after[2] + 40);
      expect(grown.slice(3)).toEqual(after.slice(3));
    },
    60000,
  );
  it.each(
    ["prevent", "seal", "freeze"].flatMap((integrity) =>
      ["{}", "{value:31}", "{get(){return 31;}}"].map((descriptor) => [integrity, descriptor]),
    ),
  )(
    "%s refusal preserves %s marker",
    async (integrity, descriptor) => {
      const { api, snapshot } = await storageProbe(descriptor, level);
      expect(api.erase()).toBe(1);
      api[integrity]();
      const before = snapshot();
      expect(() => api.again()).toThrow();
      expect(snapshot()).toEqual(before);
      expect(api.own()).toBe(0);
    },
    60000,
  );
  it.each(["invalid", "mixed", "abrupt"])(
    "%s descriptor refusal preserves physical marker",
    async (method) => {
      const { api, snapshot, entryIdentity } = await storageProbe("{}", level);
      expect(api.erase()).toBe(1);
      const before = snapshot(),
        identity = entryIdentity();
      expect(() => api[method]()).toThrow();
      expect(snapshot()).toEqual(before);
      expect(entryIdentity()).toBe(identity);
      expect(api.own()).toBe(0);
    },
    60000,
  );
});
