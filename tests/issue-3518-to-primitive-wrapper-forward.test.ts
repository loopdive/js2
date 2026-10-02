// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./helpers/resume-main-composition.js";
import { applyPrototypeCompanionExtraction } from "./helpers/prototype-companion-extraction.js";
import { applyClosureApplyExtraction } from "./helpers/object-runtime-apply-extraction.js";
import { applyFnctorGuardForward } from "./helpers/object-runtime-fnctor-guard-forward.js";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import * as wrappers from "../src/runtime/wasmgc/values/to-primitive-wrapper-bodies.js";
import {
  buildToPrimitiveOrdinaryMethod,
  type ToPrimitiveCoreBindings,
} from "../src/runtime/wasmgc/values/to-primitive-method-bodies.js";
import {
  captureProtoIndexPresenceBinding,
  fillProtoIndexStore,
  reserveProtoIndexStore,
} from "../src/codegen/proto-index-store.js";
import { createToPrimitivePresenceOwner } from "../src/codegen/to-primitive-presence.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { ensureObjectRuntime } from "../src/codegen/object-runtime.js";
import { definedFuncAt, replaceDefinedFuncAt } from "../src/codegen/func-space.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { invertObjectRuntimeMainComposition } from "./helpers/object-runtime-main-composition.js";
import { invertObjectWriteSource } from "./helpers/native-object-write-donor.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = readBeforeResumeMain;
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});

type Completion = { kind: "return"; value: number } | { kind: "throw"; name: string };
function nativeExports(source: string): Record<string, (seed?: number) => number> {
  const exports = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(js, { exports });
  return exports;
}
const observer = `
let __wrapper_value=0;
export function __wrapper_observe(seed:number):number {
  try { __wrapper_value=run(seed); return 1; }
  catch(error) { if(error instanceof TypeError) return 2; throw error; }
}
export function __wrapper_result():number { return __wrapper_value; }
`;
function completion(exports: Record<string, (seed?: number) => number>): Completion {
  const kind = exports.__wrapper_observe!(7);
  if (kind === 1) return { kind: "return", value: exports.__wrapper_result!() };
  if (kind === 2) return { kind: "throw", name: "TypeError" };
  throw new Error(`unrecognized wrapper completion ${kind}`);
}
async function execute(body: string) {
  const source = `export function run(seed:number):number { ${body} }`;
  let native: Completion;
  try {
    native = { kind: "return", value: nativeExports(source).run!(7) };
  } catch (error) {
    native = { kind: "throw", name: String((error as Error).name) };
  }
  expect(completion(nativeExports(source + observer))).toEqual(native);
  const result = await compile(source + observer, {
    target: "standalone",
    fileName: "to-primitive-wrapper-forward.ts",
    emitWat: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  const actual = completion(instance.exports as Record<string, (seed?: number) => number>);
  console.info("ToPrimitive wrapper completion", JSON.stringify({ sourceSha256: sha(source), native, actual }));
  expect(actual).toEqual(native);
  return result;
}

const cases: [string, string][] = [
  [
    "late dynamic TypedArray demand remains a real positive requirement",
    `
    function primitive(x:any):number{return Number(x);}
    function erased(x:any):any{return x;}
    const w:any=new Number(seed);const n=primitive(w);
    const a=new Float64Array(erased([2,3]));return n+a[0]+a.length;`,
  ],
  [
    "String default order: intrinsic valueOf precedes an own toString",
    `
    const w:any=new String("7");let calls=0;
    w.toString=function():any{calls++;return "99";};
    return Number(w)*100+calls;`,
  ],
  [
    "String string order: intrinsic toString precedes an own valueOf",
    `
    const w:any=new String("xy");let calls=0;
    w.valueOf=function():any{calls++;return "own";};
    return (String(w)==="xy"?100:0)+calls;`,
  ],
  [
    "Number default order calls own valueOf once",
    `
    const w:any=new Number(seed);let calls=0;
    w.valueOf=function():any{calls++;return seed+2;};
    return Number(w)*100+calls;`,
  ],
  [
    "Number intrinsic toString converts the slot after object-returning valueOf",
    `
    const w:any=new Number(seed);let calls=0;
    w.valueOf=function():any{calls++;return {};};
    return Number(w)*100+calls;`,
  ],
  [
    "Number string order falls through object-returning toString to intrinsic valueOf",
    `
    const w:any=new Number(seed);let calls=0;
    w.toString=function():any{calls++;return {};};
    return (String(w)==="7"?100:0)+calls;`,
  ],
  [
    "Boolean intrinsic string result remains a string",
    `
    const w:any=new Boolean(true);let calls=0;
    w.valueOf=function():any{calls++;return {};};
    const n=Number(w);return (n!==n?100:0)+calls;`,
  ],
  [
    "String first method object result reaches its intrinsic second method",
    `
    const w:any=new String("7");let calls=0;
    w.valueOf=function():any{calls++;return {};};return Number(w)*100+calls;`,
  ],
  [
    "two object-returning Number overrides throw TypeError",
    `
    const w:any=new Number(seed);w.valueOf=function():any{return {};};
    w.toString=function():any{return {};};return Number(w);`,
  ],
  [
    "two object-returning String overrides throw TypeError",
    `
    const w:any=new String("xy");w.valueOf=function():any{return {};};
    w.toString=function():any{return {};};return String(w).length;`,
  ],
  [
    "null valueOf shadows the intrinsic",
    `
    const w:any=new Number(seed);let calls=0;w.valueOf=null;
    w.toString=function():any{calls++;return "13";};return Number(w)*100+calls;`,
  ],
  [
    "undefined valueOf shadows the intrinsic",
    `
    const w:any=new Number(seed);let calls=0;w.valueOf=undefined;
    w.toString=function():any{calls++;return "13";};return Number(w)*100+calls;`,
  ],
  [
    "noncallable valueOf shadows the intrinsic",
    `
    const w:any=new Number(seed);let calls=0;w.valueOf=42;
    w.toString=function():any{calls++;return "13";};return Number(w)*100+calls;`,
  ],
  [
    "null toString advances to own valueOf",
    `
    const w:any=new Number(seed);let calls=0;w.toString=null;
    w.valueOf=function():any{calls++;return 13;};return (String(w)==="13"?100:0)+calls;`,
  ],
  [
    "undefined toString advances to own valueOf",
    `
    const w:any=new Number(seed);let calls=0;w.toString=undefined;
    w.valueOf=function():any{calls++;return 13;};return (String(w)==="13"?100:0)+calls;`,
  ],
  [
    "inherited valueOf receives the original wrapper",
    `
    const w:any=new Number(seed);let calls=0;let receiver=0;const p:any={};
    p.valueOf=function():any{calls++;if(this===w)receiver++;return 13;};
    Object.setPrototypeOf(w,p);return Number(w)*100+calls*10+receiver;`,
  ],
  [
    "replaced prototype does not retain the old Number intrinsic",
    `
    const w:any=new Number(seed);let calls=0;const p:any={};
    p.toString=function():any{calls++;return "13";};
    Object.setPrototypeOf(w,p);return Number(w)*100+calls;`,
  ],
  [
    "inherited toString getter and method each see original receiver once",
    `
    const w:any=new Number(seed);let gets=0;let calls=0;let receivers=0;const p:any={};
    Object.defineProperty(p,"toString",{get:function():any{
      gets++;if(this===w)receivers++;return function():any{calls++;if(this===w)receivers++;return "13";};
    }});Object.setPrototypeOf(w,p);
    return (String(w)==="13"?1000:0)+gets*100+calls*10+receivers;`,
  ],
  [
    "own getter deletes itself and returns undefined without reviving intrinsic",
    `
    const w:any=new Number(seed);let gets=0;let calls=0;
    Object.defineProperty(w,"toString",{configurable:true,get:function():any{gets++;delete w.toString;return undefined;}});
    w.valueOf=function():any{calls++;return 13;};
    return (String(w)==="13"?1000:0)+gets*10+calls;`,
  ],
  [
    "inherited getter deletes itself and returns undefined without object fallback",
    `
    const w:any=new Number(seed);const p:any={};let gets=0;let calls=0;
    Object.defineProperty(p,"toString",{configurable:true,get:function():any{gets++;delete p.toString;return undefined;}});
    w.valueOf=function():any{calls++;return 13;};Object.setPrototypeOf(w,p);
    return (String(w)==="13"?1000:0)+gets*10+calls;`,
  ],
  [
    "companion getter deletion retains pre-Get presence",
    `
    const w:any=new Number(seed);let gets=0;let calls=0;
    Object.defineProperty(Number.prototype,"toString",{configurable:true,get:function():any{
      gets++;delete (Number.prototype as any).toString;return undefined;
    }});w.valueOf=function():any{calls++;return 13;};
    return (String(w)==="13"?1000:0)+gets*10+calls;`,
  ],
  [
    "throwing getter preserves thrown identity and prevents later method",
    `
    const w:any=new Number(seed);let gets=0;let calls=0;const abrupt:any={seed};
    Object.defineProperty(w,"valueOf",{get:function():any{gets++;throw abrupt;}});
    w.toString=function():any{calls++;return "13";};
    try {Number(w);return 0;}catch(e:any){return (e===abrupt?100:0)+gets*10+calls;}`,
  ],
  [
    "an explicit null prototype does not synthesize wrapper intrinsics",
    `
    const w:any=new Number(seed);Object.setPrototypeOf(w,null);return Number(w);`,
  ],
  [
    "Proxy prototype negative: no added observable has trap",
    `
    let has=0;const target:any={};target.valueOf=function():any{return seed;};
    const p:any=new Proxy(target,{has:function(_t:any,_k:any):boolean{has++;throw new TypeError("unexpected has");}});
    const w:any=new Number(seed);Object.setPrototypeOf(w,p);return Number(w)*100+has;`,
  ],
];
describe("ToPrimitive forward wrapper completion through the real compiler", () => {
  it.each(cases)("%s", async (_name, source) => {
    await execute(source);
  });
  it("positive first: the missing intrinsic path actually executes", async () => {
    const body = cases.find(
      ([name]) => name === "Number intrinsic toString converts the slot after object-returning valueOf",
    )![1];
    await execute(body);
    const original = wrappers.buildWrapperIntrinsicResult;
    vi.spyOn(wrappers, "buildWrapperIntrinsicResult").mockImplementation((...args) => [
      { op: "unreachable" },
      ...original(...args),
    ]);
    await expect(execute(body)).rejects.toThrow(/unreachable/);
  });
});

function core(): ToPrimitiveCoreBindings {
  return {
    frame: { any: 2, method: 3, result: 4, slot: 5, args: 6 },
    wrapperPresence: { presentLocal: 7, cursorLocal: 8, companion: { kind: "call", hasIdx: 108 } },
    primitiveTypePredicates: [101],
    typeofStringIdx: 102,
    typeofFunctionIdx: 103,
    symbolKeysEnabled: false,
    symbolTypeIdx: -1,
    anyStrTypeIdx: 4,
    objectTypeIdx: 0,
    propEntryTypeIdx: 1,
    strFlattenIdx: 104,
    strEqualsIdx: 105,
    externGetIdx: 106,
    externHasIdx: 107,
    callMethod0Idx: 109,
    objectTerminalAllowsImplicitProtoIdx: 110,
    objFindIdx: 111,
    flagInternal: 16,
    typeErrorCtorIdx: 112,
    exnTagIdx: 0,
    nullishToNullIdx: 113,
    objVecNewIdx: 114,
    objVecPushIdx: 115,
  };
}
function calls(body: Instr[]): number[] {
  const result: number[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("op" in value && value.op === "call") result.push((value as { funcIdx: number }).funcIdx);
    for (const child of Object.values(value)) visit(child);
  };
  visit(body);
  return result;
}
describe("ToPrimitive forward presence and provider boundaries", () => {
  it("pre-Get observation uses only exact ordinary/companion metadata", () => {
    const d = core();
    const body = buildToPrimitiveOrdinaryMethod(d, {
      lookup: [{ op: "ref.null.extern" }],
      missingLookup: [{ op: "ref.null.extern" }],
      wrapperIntrinsic: { kind: "valueOf", primitiveKey: [{ op: "ref.null.extern" }] },
    });
    const targets = calls(body);
    const firstGet = targets.indexOf(d.externGetIdx);
    expect(firstGet).toBeGreaterThan(0);
    expect(targets.slice(0, firstGet)).toEqual([d.objFindIdx, d.objectTerminalAllowsImplicitProtoIdx, 108]);
    expect(targets.filter((x) => x === d.externGetIdx)).toHaveLength(1);
    expect(targets.indexOf(d.externHasIdx)).toBeGreaterThan(firstGet);
  });
  it("unknown presence data cannot authorize a missing intrinsic", () => {
    const d = core();
    expect(Reflect.deleteProperty(d, "wrapperPresence")).toBe(true);
    expect(() =>
      buildToPrimitiveOrdinaryMethod(d, {
        lookup: [],
        missingLookup: [],
        wrapperIntrinsic: { kind: "valueOf", primitiveKey: [] },
      }),
    ).toThrow("missing complete wrapper presence data");
  });
  const demandFlags = ["protoIndexDirty", "protoNamedDirty", "protoMemberDirty", "moduleUsesDynTaView"] as const;
  const ownedDependencies = [
    "__protoidx_companion",
    "__protoidx_norm_key",
    "__protoidx_has_k",
    "__protoidx_brand_off",
    "__protoidx_has_r",
  ];
  function context(flag?: (typeof demandFlags)[number]) {
    const ctx = createCodegenContext(createEmptyModule(), ts.createProgram([], { noLib: true }).getTypeChecker(), {
      target: "standalone",
      nativeStrings: true,
    });
    if (flag) ctx[flag] = true;
    ensureObjectRuntime(ctx);
    return ctx;
  }
  function target(ctx: CodegenContext, name = "__to_primitive_companion_presence") {
    const index = ctx.funcMap.get(name);
    expect(index).not.toBeUndefined();
    const fn = definedFuncAt(ctx, index!);
    expect(fn).toBeDefined();
    return fn!;
  }
  function completed() {
    const ctx = context("protoNamedDirty");
    const binding = captureProtoIndexPresenceBinding(ctx);
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
    fillProtoIndexStore(ctx);
    expect(target(ctx).body).toEqual([
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: ctx.funcMap.get("__protoidx_has_r") },
    ]);
    expect(captureProtoIndexPresenceBinding(ctx)).toEqual(binding);
    expect(() => fillProtoIndexStore(ctx)).not.toThrow();
    return ctx;
  }
  it("disabled store has a stable unreachable reservation until final absence is known", () => {
    const ctx = context();
    const binding = captureProtoIndexPresenceBinding(ctx);
    const fn = target(ctx);
    expect(fn.body).toEqual([{ op: "unreachable" }]);
    expect(ctx.protoIndexStoreReserved).not.toBe(true);
    fillProtoIndexStore(ctx);
    expect(fn.body).toEqual([{ op: "i32.const", value: 0 }]);
    expect(captureProtoIndexPresenceBinding(ctx)).toEqual(binding);
    expect(() => fillProtoIndexStore(ctx)).not.toThrow();
    expect(ctx.protoIndexStoreReserved).not.toBe(true);
  });
  it.each(demandFlags)("late %s demand fills the real dependency without changing the captured handle", (flag) => {
    const ctx = context();
    const binding = captureProtoIndexPresenceBinding(ctx);
    const fn = target(ctx);
    expect(ctx.protoIndexStoreReserved).not.toBe(true);
    ctx[flag] = true;
    fillProtoIndexStore(ctx);
    expect(ctx.protoIndexStoreReserved).toBe(true);
    expect(ctx.protoIndexStoreFilled).toBe(true);
    expect(Object.is(target(ctx), fn)).toBe(true);
    expect(fn.body).toEqual([
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: ctx.funcMap.get("__protoidx_has_r") },
    ]);
    expect(captureProtoIndexPresenceBinding(ctx)).toEqual(binding);
    expect(() => fillProtoIndexStore(ctx)).not.toThrow();
  });
  it.each(["protoIndexStoreReserved", ...demandFlags] as const)(
    "completed absence refuses later %s rather than silently retaining zero",
    (flag) => {
      const ctx = context();
      fillProtoIndexStore(ctx);
      expect(target(ctx).body).toEqual([{ op: "i32.const", value: 0 }]);
      ctx[flag] = true;
      expect(() => fillProtoIndexStore(ctx)).toThrow("absence became stale");
    },
  );
  it("a foreign same-name bridge cannot acquire the private reservation", () => {
    const ctx = context();
    const foreign = { ...ctx, mod: ctx.mod, funcMap: ctx.funcMap };
    expect(() => captureProtoIndexPresenceBinding(foreign)).toThrow("without its owner");
  });
  it("an independent factory cannot adopt or complete the canonical instance", () => {
    completed();
    const ctx = context();
    const binding = captureProtoIndexPresenceBinding(ctx);
    const foreign = createToPrimitivePresenceOwner();
    foreign.complete(ctx);
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
    expect(() => foreign.capture(ctx)).toThrow("without its owner");
    expect(captureProtoIndexPresenceBinding(ctx)).toEqual(binding);
    fillProtoIndexStore(ctx);
    expect(target(ctx).body).toEqual([{ op: "i32.const", value: 0 }]);
  });
  it("reservation batches belong to one factory and one context", () => {
    completed();
    const ctx = context();
    const other = context();
    const owner = createToPrimitivePresenceOwner();
    const foreign = createToPrimitivePresenceOwner();
    const batch = owner.createReservations(ctx);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(() => owner.installReservations(ctx, batch)).not.toThrow();
    expect(() => owner.installReservations(other, batch)).toThrow("batch is not owned");
    expect(() => foreign.installReservations(ctx, batch)).toThrow("batch is not owned");
    expect(() => owner.installReservations(ctx, new Map())).toThrow("batch is not owned");
    expect(() => owner.installReservations(ctx, { ...batch })).toThrow("batch is not owned");
    expect(() => owner.recordReservation(other, batch, "foreign", target(ctx))).toThrow("batch is not owned");
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
  });
  it.each([
    { label: "empty array", token: [] },
    { label: "plain object", token: {} },
    { label: "mutable map", token: new Map() },
  ])("unissued $label cannot complete a canonical reservation", ({ token }) => {
    completed();
    const ctx = context();
    const owner = createToPrimitivePresenceOwner();
    expect(() => owner.complete(ctx, token)).toThrow("fill input is not owned");
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
  });
  it("actual reserved inputs issue only context-bound, instance-bound fill tokens", () => {
    completed();
    const ctx = createCodegenContext(createEmptyModule(), ts.createProgram([], { noLib: true }).getTypeChecker(), {
      target: "standalone",
      nativeStrings: true,
    });
    ctx.protoNamedDirty = true;
    const owner = createToPrimitivePresenceOwner();
    owner.capture(ctx);
    reserveProtoIndexStore(ctx);
    const batch = owner.createReservations(ctx);
    for (const name of ownedDependencies) owner.recordReservation(ctx, batch, name, target(ctx, name));
    owner.installReservations(ctx, batch);
    const token = owner.captureFillInputs(ctx)!;
    expect(Object.isFrozen(token)).toBe(true);
    expect(() => owner.complete(ctx, token)).toThrow("dependency was not filled");
    expect(() => owner.complete(ctx, batch)).toThrow("fill input is not owned");
    expect(() => owner.complete(ctx, { ...token })).toThrow("fill input is not owned");
    expect(() => createToPrimitivePresenceOwner().complete(ctx, token)).toThrow("fill input is not owned");
    expect(() => owner.complete(context(), token)).toThrow("fill input is not owned");
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
  });
  it("copied descriptor cannot replace the captured bridge", () => {
    const ctx = context();
    const binding = captureProtoIndexPresenceBinding(ctx);
    expect(captureProtoIndexPresenceBinding(ctx)).toEqual(binding);
    replaceDefinedFuncAt(ctx, binding.hasIdx, { ...target(ctx) });
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it("external zero prefill is not completed final absence", () => {
    const ctx = context();
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
    target(ctx).body = [{ op: "i32.const", value: 0 }];
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it("a legacy filled flag cannot authenticate unfilled dependencies", () => {
    completed();
    const ctx = context("protoNamedDirty");
    ctx.protoIndexStoreFilled = true;
    expect(() => fillProtoIndexStore(ctx)).toThrow("dependency was not filled");
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
  });
  it("missing real fill inputs cannot issue a receipt despite all presence helper names", () => {
    completed();
    const ctx = context("protoNamedDirty");
    for (const name of ownedDependencies) expect(ctx.funcMap.has(name)).toBe(true);
    ctx.funcMap.delete("__obj_find");
    expect(() => fillProtoIndexStore(ctx)).toThrow("dependency was not filled");
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
  });
  it("an early-returning canonical fill cannot certify its unchanged stub", () => {
    completed();
    const ctx = context("protoNamedDirty");
    ctx.anyStrTypeIdx = -1;
    expect(() => fillProtoIndexStore(ctx)).toThrow("dependency was not filled");
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
  });
  it("a matching receiver body cannot substitute for the actual fill chain", () => {
    completed();
    const ctx = context("protoNamedDirty");
    target(ctx, "__protoidx_has_r").body = [
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: ctx.funcMap.get("__protoidx_brand_off")! },
      { op: "call", funcIdx: ctx.funcMap.get("__protoidx_has_k")! },
    ];
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
    expect(target(ctx).body).toEqual([{ op: "unreachable" }]);
  });
  it.each(ownedDependencies)("idempotent completion rejects changed filled content of %s", (name) => {
    const ctx = completed();
    target(ctx, name).body.push({ op: "unreachable" });
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it.each(ownedDependencies)("idempotent completion rejects a copied filled descriptor for %s", (name) => {
    const ctx = completed();
    replaceDefinedFuncAt(ctx, ctx.funcMap.get(name)!, { ...target(ctx, name) });
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it("idempotent completion rejects a copied signature despite structural equality", () => {
    const ctx = completed();
    const fn = target(ctx);
    ctx.mod.types[fn.typeIdx] = structuredClone(ctx.mod.types[fn.typeIdx]!);
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it.each([
    ["negative zero", -0],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["present undefined", undefined],
    ["BigInt", 0n],
  ] as const)("completed scalar content rejects %s corruption", (_name, value) => {
    const ctx = context();
    fillProtoIndexStore(ctx);
    const instruction = target(ctx).body[0]!;
    expect(instruction).toEqual({ op: "i32.const", value: 0 });
    Object.defineProperty(instruction, "value", { value });
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it("an added present-undefined instruction field is detected", () => {
    const ctx = completed();
    Object.defineProperty(target(ctx).body[0]!, "extra", {
      value: undefined,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it("equal nested instruction replacement cannot change the owned graph", () => {
    const ctx = completed();
    const body = target(ctx).body;
    body[0] = { ...body[0]! };
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it("equal instruction aliasing cannot evade completed content checks", () => {
    const ctx = completed();
    const slots: { body: Instr[]; index: number }[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item: unknown, index) => {
          if (
            item &&
            typeof item === "object" &&
            "op" in item &&
            item.op === "local.get" &&
            "index" in item &&
            item.index === 0
          )
            slots.push({ body: value as Instr[], index });
        });
      }
      for (const child of Object.values(value)) visit(child);
    };
    const body = target(ctx, "__protoidx_companion").body;
    visit(body);
    expect(slots.length).toBeGreaterThan(1);
    const first = slots[0]!;
    const second = slots[1]!;
    expect(Object.is(first.body[first.index], second.body[second.index])).toBe(false);
    expect(first.body[first.index]).toEqual(second.body[second.index]);
    second.body[second.index] = first.body[first.index]!;
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
  });
  it("descriptor attribute mutation is rejected without invoking an accessor", () => {
    const ctx = completed();
    let invoked = false;
    Object.defineProperty(target(ctx).body[0]!, "index", {
      get() {
        invoked = true;
        return 0;
      },
    });
    expect(() => fillProtoIndexStore(ctx)).toThrow("target or content changed");
    expect(invoked).toBe(false);
  });
});

// This authored correction is explicit and separate from the signed donor.
// Inverting every admitted span restores the entire measured extraction file;
// the original 46-row suite then reconstructs its unchanged signed donors.
interface ForwardSpan {
  beforeStart: number;
  afterStart: number;
  before: string;
  after: string;
}
interface ForwardRow {
  path: string;
  beforeSha256: string;
  spans: ForwardSpan[];
}
const forwardText = read("tests/fixtures/issue-3518-to-primitive-wrapper-forward.json");
function forwardReceipt(text: string): ForwardRow[] {
  if (sha(text) !== "c12630d715fd7419e89785b9a8f942bc15cc99c114b846bd44c29964fc6ff3d2")
    throw new Error("changed explicit forward correction");
  const value = JSON.parse(text) as {
    kind: string;
    extractionFixtureSha256: string;
    originalDonorFixtureSha256: string;
    records: ForwardRow[];
  };
  if (value.kind !== "explicit-authored-forward-correction-not-historical-donor")
    throw new Error("foreign forward correction kind");
  const baselineText = read("tests/fixtures/issue-3518-to-primitive-extraction-baseline.json");
  if (
    sha(baselineText) !== value.extractionFixtureSha256 ||
    sha(read("tests/fixtures/issue-3518-native-to-primitive-donor.json")) !== value.originalDonorFixtureSha256
  )
    throw new Error("changed original baseline authority");
  return value.records;
}
const forwardRows = forwardReceipt(forwardText);
const beforeSources = new Map(
  (
    JSON.parse(read("tests/fixtures/issue-3518-to-primitive-extraction-baseline.json")) as {
      records: { path: string; sha256: string; text: string }[];
    }
  ).records.map((row) => {
    if (sha(row.text) !== row.sha256) throw new Error("changed extraction source");
    return [row.path, row.text] as const;
  }),
);
function invertForward(row: ForwardRow, source: string): string {
  const before = beforeSources.get(row.path);
  if (before === undefined || sha(before) !== row.beforeSha256) throw new Error("foreign forward source");
  let priorBefore = 0;
  let priorAfter = 0;
  for (const span of row.spans) {
    if (
      span.beforeStart < priorBefore ||
      span.afterStart < priorAfter ||
      !span.after ||
      before.slice(span.beforeStart, span.beforeStart + span.before.length) !== span.before ||
      source.slice(span.afterStart, span.afterStart + span.after.length) !== span.after
    )
      throw new Error("changed forward span or order");
    priorBefore = span.beforeStart + span.before.length;
    priorAfter = span.afterStart + span.after.length;
  }
  for (const span of [...row.spans].reverse())
    source = source.slice(0, span.afterStart) + span.before + source.slice(span.afterStart + span.after.length);
  if (source !== before) throw new Error("retained source outside forward spans changed");
  return source;
}
describe("explicit current-source forward correction over unchanged historical extraction", () => {
  it("authenticates all seven entire sources and all 29 ordered correction spans", () => {
    expect(forwardRows.map((row) => row.path)).toEqual([...beforeSources.keys()]);
    expect(forwardRows.reduce((sum, row) => sum + row.spans.length, 0)).toBe(29);
    for (const row of forwardRows)
      expect(invertForward(row, currentForwardSource(row.path))).toBe(beforeSources.get(row.path));
  });
  it.each(forwardRows)("positive first: $path rejects altered, removed, duplicate and outside-span bytes", (row) => {
    const source = currentForwardSource(row.path);
    invertForward(row, source);
    for (const span of row.spans) {
      const prefix = source.slice(0, span.afterStart);
      const suffix = source.slice(span.afterStart + span.after.length);
      expect(() => invertForward(row, prefix + "/* altered */" + span.after + suffix)).toThrow();
      expect(() => invertForward(row, prefix + suffix)).toThrow();
      expect(() => invertForward(row, prefix + span.after + span.after + suffix)).toThrow();
    }
    expect(() => invertForward(row, source + "\n/* retained-source corruption */\n")).toThrow();
  });
  it("positive first: reordered span records cannot change inversion order", () => {
    const row = forwardRows.find((value) => value.spans.length > 1)!;
    const source = currentForwardSource(row.path);
    invertForward(row, source);
    expect(() => invertForward({ ...row, spans: [...row.spans].reverse() }, source)).toThrow();
  });
  it("positive first: modified fixture bytes cannot reseed the authored correction", () => {
    forwardReceipt(forwardText);
    expect(() => forwardReceipt(forwardText + "\n")).toThrow("changed explicit forward correction");
  });
});

// A separate authored structural record composes with, never replaces, the
// original forward correction and its unchanged historical donor authority.
interface PresenceExtraction {
  kind: string;
  priorForwardFixtureSha256: string;
  store: ForwardRow & { afterSha256: string };
  modules: { path: string; sha256: string }[];
}
const presenceExtractionText = read("tests/fixtures/issue-3518-to-primitive-presence-extraction.json");
function presenceExtractionReceipt(text: string): PresenceExtraction {
  if (sha(text) !== "b1d1854ac98274ea89319628e446009f6bcd23a5532e69bb8b64329547737857")
    throw new Error("changed presence extraction receipt");
  const value = JSON.parse(text) as PresenceExtraction;
  if (
    value.kind !== "explicit-structural-extraction-with-private-factory-token-defence" ||
    value.priorForwardFixtureSha256 !== sha(forwardText) ||
    value.store.path !== "src/codegen/proto-index-store.ts"
  )
    throw new Error("foreign presence extraction provenance");
  return value;
}
const presenceExtraction = presenceExtractionReceipt(presenceExtractionText);
function restorePresenceStore(
  reader: (path: string) => string = read,
  record: PresenceExtraction = presenceExtraction,
): string {
  for (const module of record.modules)
    if (sha(reader(module.path)) !== module.sha256) throw new Error("changed extracted presence module");
  let source = applyPrototypeCompanionExtraction(reader(record.store.path), true, reader);
  if (sha(source) !== record.store.afterSha256) throw new Error("changed composed presence store");
  let priorBefore = 0;
  let priorAfter = 0;
  for (const span of record.store.spans) {
    if (
      span.beforeStart < priorBefore ||
      span.afterStart < priorAfter ||
      (!span.before && !span.after) ||
      source.slice(span.afterStart, span.afterStart + span.after.length) !== span.after
    )
      throw new Error("changed presence extraction span or order");
    priorBefore = span.beforeStart + span.before.length;
    priorAfter = span.afterStart + span.after.length;
  }
  for (const span of [...record.store.spans].reverse())
    source = source.slice(0, span.afterStart) + span.before + source.slice(span.afterStart + span.after.length);
  if (sha(source) !== record.store.beforeSha256) throw new Error("presence extraction did not restore prior source");
  for (const span of record.store.spans)
    if (source.slice(span.beforeStart, span.beforeStart + span.before.length) !== span.before)
      throw new Error("changed prior presence span");
  return source;
}
function currentForwardSource(path: string): string {
  if (path === presenceExtraction.store.path) return restorePresenceStore();
  const source = read(path);
  return path === "src/codegen/object-runtime.ts"
    ? invertObjectRuntimeMainComposition(
        invertObjectWriteSource(path, applyFnctorGuardForward(applyClosureApplyExtraction(source, true), true)),
      )
    : source;
}
function presenceDeclaration(source: string, name: string, owner?: string) {
  const sf = ts.createSourceFile("presence.ts", source, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) throw new Error("invalid presence source");
  const declarations = owner
    ? sf.statements
        .filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === owner)
        .flatMap((node) => node.members)
        .filter(
          (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
        )
    : sf.statements.filter(
        (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
  if (declarations.length !== 1) throw new Error(`nonunique presence declaration ${name}`);
  return { text: declarations[0]!.getText(sf), body: declarations[0]!.body!.getText(sf) };
}
function priorPresenceMethod(source: string, name: string): string {
  let body = presenceDeclaration(source, name, "ToPrimitivePresenceOwner")
    .body.split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n")
    .replaceAll("this.#captures", "toPrimitivePresenceCaptures")
    .replaceAll("this.assertCurrent(ctx)", "assertToPrimitivePresenceCurrent(ctx)");
  if (name === "complete") {
    const guard = "  const filled = token === undefined ? undefined : this.#filledInputs(ctx, token);\n";
    if (body.split(guard).length !== 2) throw new Error("missing owned fill-token guard");
    body = body.replace(guard, "");
  }
  return body;
}
describe("presence extraction preserves prior source and private completion authority", () => {
  it("restores every original store byte before the unchanged semantic forward inverse", () => {
    const prior = restorePresenceStore();
    const row = forwardRows.find((value) => value.path === presenceExtraction.store.path)!;
    expect(invertForward(row, prior)).toBe(beforeSources.get(row.path));
    expect(presenceExtraction.store.spans).toHaveLength(14);
    expect(presenceExtraction.modules).toHaveLength(2);
  });
  it("retains ten complete functions and three underlying lifecycle method bodies", () => {
    const prior = restorePresenceStore();
    const owner = read("src/codegen/to-primitive-presence.ts");
    for (const name of [
      "protoIndexPresenceDemanded",
      "presenceNumberBits",
      "presenceGraph",
      "assertPresenceGraphCurrent",
      "presenceFunctionReceipt",
      "assertPresenceFunctionCurrent",
      "findFn",
    ])
      expect(presenceDeclaration(owner, name).text).toBe(presenceDeclaration(prior, name).text);
    const reads = read("src/codegen/proto-index-read-bindings.ts");
    for (const name of ["protoIndexRecvGetMissInstrs", "captureProtoIndexReadBinding", "protoIndexRecvHasMissInstrs"])
      expect(presenceDeclaration(reads, name).text).toBe(presenceDeclaration(prior, name).text);
    for (const [current, original] of [
      ["capture", "captureProtoIndexPresenceBinding"],
      ["assertCurrent", "assertToPrimitivePresenceCurrent"],
      ["complete", "completeToPrimitivePresence"],
    ])
      expect(priorPresenceMethod(owner, current!)).toBe(presenceDeclaration(prior, original!).body);
  });
  it.each(presenceExtraction.modules)("positive first: changed $path is not an admitted extraction", (module) => {
    restorePresenceStore();
    expect(() => restorePresenceStore((path) => read(path) + (path === module.path ? "\n/* mutation */" : ""))).toThrow(
      "changed extracted presence module",
    );
  });
  it("positive first: removed, altered, duplicate and reordered spans cannot replace the prior source", () => {
    restorePresenceStore();
    const spans = presenceExtraction.store.spans;
    const altered = (changed: ForwardSpan[]) => ({
      ...presenceExtraction,
      store: { ...presenceExtraction.store, spans: changed },
    });
    expect(() => restorePresenceStore(read, altered(spans.slice(1)))).toThrow();
    expect(() =>
      restorePresenceStore(read, altered([{ ...spans[0]!, before: "/* altered */" }, ...spans.slice(1)])),
    ).toThrow();
    expect(() => restorePresenceStore(read, altered([spans[0]!, ...spans]))).toThrow();
    expect(() => restorePresenceStore(read, altered([...spans].reverse()))).toThrow();
    expect(() =>
      restorePresenceStore((path) => read(path) + (path === presenceExtraction.store.path ? "\n" : "")),
    ).toThrow("changed composed presence store");
  });
  it("positive first: the structural receipt cannot reseed either old fixture", () => {
    presenceExtractionReceipt(presenceExtractionText);
    forwardReceipt(forwardText);
    expect(() => presenceExtractionReceipt(presenceExtractionText + "\n")).toThrow(
      "changed presence extraction receipt",
    );
  });
});
