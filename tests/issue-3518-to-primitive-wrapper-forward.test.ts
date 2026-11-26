// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
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

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
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
