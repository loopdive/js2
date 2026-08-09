// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateModule } from "../src/codegen/index.js";
import {
  planProgramAbiEntrySourceSupportCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
  resolveProgramAbiSupportCallableHandle,
} from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { buildIrUnitInventory, createIrBindingId } from "../src/ir/identity.js";
import { createEmptyModule, type FuncTypeDef, type Import, type WasmFunction } from "../src/ir/types.js";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const CLOSURE_HOST_BRIDGE_ROLE = "closure-host-bridge";

const REQUIRED_BRIDGES = Object.freeze([
  { name: "__call_fn_0", ordinal: 0 },
  { name: "__call_fn_1", ordinal: 1 },
  { name: "__call_fn_2", ordinal: 2 },
  { name: "__call_fn_3", ordinal: 3 },
  { name: "__call_fn_4", ordinal: 4 },
  { name: "__call_fn_method_0", ordinal: 5 },
  { name: "__call_fn_method_1", ordinal: 6 },
  { name: "__call_fn_method_2", ordinal: 7 },
  { name: "__call_fn_method_3", ordinal: 8 },
  { name: "__call_fn_method_4", ordinal: 9 },
  { name: "__call_fn_method_5", ordinal: 10 },
  { name: "__closure_arity", ordinal: 11 },
  { name: "__is_closure", ordinal: 12 },
] as const);

const CLOSURE_PHYSICAL_BASES = [
  "$c0",
  "$c1",
  "$c2",
  "$c3",
  "$c4",
  "$c5",
  "$c6",
  "$c7",
  "$c8",
  "$c9",
  "$ca",
  "$cb",
  "$cc",
  "$cd",
  "$ce",
  "$cf",
  "$cg",
] as const;

const ZERO_ARITY_SOURCE = `
  declare function hostTick(value: number): number;
  const zero = function (): number { return 17; };
  export function getZero(): any { return zero; }
  export function invoke(): number { return hostTick(zero()); }
`;

const COLLIDING_CLOSURE_SOURCE = `
  export function __call_fn_1(_closure: any, _value: any): number { return 701; }
  export function $c1(): number { return 702; }
  export function $cf(): number { return 703; }
  const addTwo = function (value: number): number { return value + 2; };
  export function getAddTwo(): any { return addTwo; }
`;

function trackedModule(source = ZERO_ARITY_SOURCE) {
  const ast = analyzeSource(source, "issue-3520-closure-host-bridge.ts");
  return generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
}

function entrySourceRecord(source = ZERO_ARITY_SOURCE) {
  const ast = analyzeSource(source, "issue-3520-closure-host-bridge.ts");
  return buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  }).sources.find((candidate) => candidate.kind === "entry")!;
}

function hardErrors(result: ReturnType<typeof generateModule>) {
  return result.errors.filter((error) => error.severity !== "warning");
}

async function instantiate(source: string): Promise<{
  readonly exports: Record<string, unknown>;
  readonly result: Awaited<ReturnType<typeof compile>>;
}> {
  const result = await compile(source, {
    fileName: "issue-3520-closure-host-runtime.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown> & {
    env?: Record<string, unknown>;
    setInstance?: (value: WebAssembly.Instance) => void;
  };
  imports.env = imports.env ?? {};
  imports.env.hostTick = (value: number) => value;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return { exports: instance.exports as Record<string, unknown>, result };
}

describe("#3520 C31 closure host bridge Program ABI ownership", () => {
  it("plans fixed entry-source IDs and publishes each exact final helper slot", () => {
    const result = trackedModule();
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const entrySource = entrySourceRecord();
    const imports = result.module.imports.filter((entry) => entry.desc.kind === "func");
    expect(imports.length).toBeGreaterThan(0);
    const exportsByName = new Map(result.module.exports.map((entry) => [entry.name, entry]));
    const abiEntries = result.programAbi!.abi.entries();
    const closureEntries = abiEntries.filter(
      (entry) =>
        entry.intent.kind === "callable" &&
        entry.intent.origin === "support" &&
        entry.intent.sourceId === entrySource!.id &&
        REQUIRED_BRIDGES.some((bridge) => bridge.name === entry.displayName),
    );

    expect(closureEntries).toHaveLength(REQUIRED_BRIDGES.length);
    for (const bridge of REQUIRED_BRIDGES) {
      const expectedId = createIrBindingId({
        ownerId: entrySource!.id,
        domain: "support",
        role: CLOSURE_HOST_BRIDGE_ROLE,
        ordinal: bridge.ordinal,
      });
      const entry = closureEntries.find((candidate) => candidate.id === expectedId);
      expect(entry).toMatchObject({
        id: expectedId,
        displayName: bridge.name,
        intent: {
          kind: "callable",
          origin: "support",
          sourceId: entrySource!.id,
        },
      });
      const finalSlot = result.programAbi!.abi.resolveFinalIndex(expectedId);
      expect(finalSlot).toEqual({ space: "function", index: exportsByName.get(bridge.name)?.desc.index });
      if (!finalSlot || finalSlot.space !== "function") throw new Error(`missing ${bridge.name} final slot`);
      const exactFinalObject = result.module.functions[finalSlot.index - imports.length];
      expect(exactFinalObject).toBeDefined();
      expect(exactFinalObject?.name).toBe(bridge.name);
    }

    const allHelperEntries = abiEntries.filter(
      (entry) =>
        entry.intent.kind === "callable" && REQUIRED_BRIDGES.some((bridge) => bridge.name === entry.displayName),
    );
    expect(allHelperEntries.map((entry) => entry.id).sort()).toEqual(closureEntries.map((entry) => entry.id).sort());
  });

  it("re-resolves one exact allocator after a late import and dead-slot compaction", () => {
    const sourceFile = ts.createSourceFile(
      "/repo/entry.ts",
      "export function entry(): number { return 1; }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
    const entrySource = inventory.sources.find((source) => source.kind === "entry")!;
    const module = createEmptyModule();
    const signature: FuncTypeDef = { kind: "func", params: [{ kind: "externref" }], results: [{ kind: "i32" }] };
    module.types.push(signature);
    const helper: WasmFunction = {
      name: "__is_closure",
      typeIdx: 0,
      locals: [],
      body: [{ op: "i32.const", value: 0 }],
      exported: true,
    };
    const dead: WasmFunction = { name: "dead", typeIdx: 0, locals: [], body: [{ op: "i32.const", value: 0 }] };
    module.functions.push(helper, dead);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const ref = planProgramAbiEntrySourceSupportCallable(ctx, {
      role: CLOSURE_HOST_BRIDGE_ROLE,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.closureHostBridge,
      derivedOrdinal: 12,
      displayName: helper.name,
      func: helper,
    });
    expect(ref?.binding).toEqual({
      kind: "support",
      bindingId: createIrBindingId({
        ownerId: entrySource.id,
        domain: "support",
        role: CLOSURE_HOST_BRIDGE_ROLE,
        ordinal: 12,
      }),
    });
    expect(session.getDraft(ref!.binding.bindingId)?.structuralOrder).toMatchObject({
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.closureHostBridge,
      derivedOrdinal: 12,
    });
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper)).toBe(0);

    const lateImport: Import = { module: "env", name: "late", desc: { kind: "func", typeIdx: 0 } };
    module.imports.push(lateImport);
    module.functions.splice(module.functions.indexOf(dead), 1);
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper)).toBe(1);

    const publication = session.publish(module);
    expect(publication.abi.resolveFinalIndex(ref!.binding.bindingId)).toEqual({ space: "function", index: 1 });
    expect(module.functions[0]).toBe(helper);
  });

  it("emits no closure bridge rows or exports for a closure-free module", () => {
    const result = trackedModule(`export function add(a: number, b: number): number { return a + b; }`);
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    expect(
      result
        .programAbi!.abi.entries()
        .filter((entry) => REQUIRED_BRIDGES.some((bridge) => bridge.name === entry.displayName)),
    ).toEqual([]);
    const exportNames = result.module.exports.map((entry) => entry.name);
    for (const bridge of REQUIRED_BRIDGES) expect(exportNames).not.toContain(bridge.name);
  });

  it("keeps tracked and untracked closure modules byte-identical", async () => {
    const baseOptions = {
      fileName: "issue-3520-closure-host-byte-parity.ts",
      experimentalIR: true,
    } as const;
    const untracked = await compile(ZERO_ARITY_SOURCE, baseOptions);
    const tracked = await compile(ZERO_ARITY_SOURCE, { ...baseOptions, trackIrOutcomes: true });
    expect(untracked.success, untracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.success, tracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.binary).toEqual(untracked.binary);
  });

  it("moves exactly 26 five-entry census rows without changing functions or routing", () => {
    let definedFunctions = 0;
    let genericRows = 0;
    let closureRows = 0;
    let vecRows = 0;
    let dateRows = 0;
    let dataRows = 0;
    let terminalUnits = 0;
    let emitted = 0;
    let unsupported = 0;
    let invariants = 0;
    let legacyBodies = 0;
    let irBodies = 0;

    for (const entry of SINGLE_HOST_ENTRIES) {
      const source = readFileSync(resolve(entry), "utf8");
      const ast = analyzeSource(source, entry);
      const result = generateModule(ast, {
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      const errors = hardErrors(result);
      expect(errors, `${entry}\n${errors.map((error) => error.message).join("\n")}`).toEqual([]);
      definedFunctions += result.module.functions.length;
      const entries = result.programAbi!.abi.entries();
      genericRows += entries.filter((candidate) => candidate.id.includes("retained-module-function")).length;
      closureRows += entries.filter((candidate) => candidate.id.includes(":closure-host-bridge:")).length;
      vecRows += entries.filter((candidate) => candidate.id.includes(":vec-host-bridge:")).length;
      dateRows += entries.filter((candidate) => candidate.id.includes(":date-civil-support:")).length;
      dataRows += entries.filter((candidate) => candidate.id.includes(":data-struct-host-bridge:")).length;
      for (const outcome of result.irOutcomes ?? []) {
        terminalUnits++;
        if (outcome.kind === "emitted") emitted++;
        if (outcome.kind === "unsupported") unsupported++;
        if (outcome.kind === "invariant") invariants++;
        if (outcome.legacyBodyEmitted) legacyBodies++;
        if (outcome.irBodyEmitted) irBodies++;
      }
    }

    expect({ definedFunctions, closureRows }).toEqual({ definedFunctions: 166, closureRows: 26 });
    // C30, C32, and C33 are independent structural-ownership slices. Each
    // moves its rows one-for-one out of the generic retained-function bucket.
    expect([0, 24]).toContain(vecRows);
    expect([0, 1]).toContain(dateRows);
    expect(dataRows).toBe(5);
    expect(genericRows).toBe(75 - vecRows - dateRows - dataRows);
    expect({ terminalUnits, emitted, unsupported, invariants, legacyBodies, irBodies }).toEqual({
      terminalUnits: 37,
      emitted: 30,
      unsupported: 7,
      invariants: 0,
      legacyBodies: 37,
      irBodies: 30,
    });
  });

  it("preserves public labels, closure identity, direct calls, and method receivers", async () => {
    const { exports } = await instantiate(`
      declare function hostTick(value: number): number;
      const direct = function (value: number): number { return value + 2; };
      const receiver = function (): any { return this; };
      export function getDirect(): any { return direct; }
      export function getReceiver(): any { return receiver; }
      export function test(): number { return hostTick(direct(1)); }
    `);
    for (const bridge of REQUIRED_BRIDGES) expect(exports[bridge.name]).toBeTypeOf("function");

    const direct = (exports.getDirect as () => unknown)();
    expect((exports.__is_closure as (value: unknown) => number)(direct)).toBe(1);
    expect((exports.__closure_arity as (value: unknown) => number)(direct)).toBe(1);
    expect((exports.__call_fn_1 as (fn: unknown, value: unknown) => unknown)(direct, 40)).toBe(42);

    const receiver = (exports.getReceiver as () => unknown)();
    const hostReceiver = { marker: 7 };
    expect((exports.__call_fn_method_0 as (self: unknown, fn: unknown) => unknown)(hostReceiver, receiver)).toBe(
      hostReceiver,
    );
  });

  it("preserves user logical and physical names while runtime dispatch finds the exact closure helper", async () => {
    const tracked = trackedModule(COLLIDING_CLOSURE_SOURCE);
    expect(
      hardErrors(tracked),
      hardErrors(tracked)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    const exportsByName = new Map(tracked.module.exports.map((entry) => [entry.name, entry]));
    expect(exportsByName.get("__call_fn_1")?.desc.index).not.toBe(exportsByName.get("$c1$")?.desc.index);
    expect(exportsByName.get("$c1")?.desc.index).not.toBe(exportsByName.get("$c1$")?.desc.index);
    expect(exportsByName.get("$cf")?.desc.index).not.toBe(exportsByName.get("$cf$")?.desc.index);

    const entrySource = entrySourceRecord(COLLIDING_CLOSURE_SOURCE);
    const directOneId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: CLOSURE_HOST_BRIDGE_ROLE,
      ordinal: 1,
    });
    expect(tracked.programAbi!.abi.resolveFinalIndex(directOneId)).toEqual({
      space: "function",
      index: exportsByName.get("$c1$")?.desc.index,
    });

    const { exports } = await instantiate(COLLIDING_CLOSURE_SOURCE);
    expect((exports.__call_fn_1 as (_closure: unknown, _value: unknown) => number)(null, null)).toBe(701);
    expect((exports.$c1 as () => number)()).toBe(702);
    expect((exports.$cf as () => number)()).toBe(703);
    const closure = (exports.getAddTwo as () => unknown)();
    expect((exports["$c1$"] as (fn: unknown, value: unknown) => unknown)(closure, 40)).toBe(42);
    expect((exports["$cf$"] as (value: unknown) => number)(closure)).toBe(1);

    const wrapped = wrapExports(exports as WebAssembly.Exports);
    const addTwo = wrapped.getAddTwo();
    expect(addTwo).toBeTypeOf("function");
    expect(addTwo(40)).toBe(42);
  });

  it("composes vec and closure collision projections for setExports and wrapExports", async () => {
    const source = `
      export function __vec_len(_value: any): number { return 801; }
      export function $v0(_value: any): number { return 802; }
      export function __vec_get(_value: any, _index: number): number { return 803; }
      export function $v1(_value: any, _index: number): number { return 804; }
      export function __call_fn_1(_closure: any, _value: any): number { return 805; }
      export function $c1(): number { return 806; }
      export function __is_closure(_value: any): number { return 1; }
      export function $cf(): number { return 807; }
      export function $cm(): number { return 808; }
      export function $ct(): number { return 809; }
      const addTwo = function (value: number): number { return value + 2; };
      export function getAddTwo(): any { return addTwo; }
      export function getArray(): number[] { return [3, 4]; }
      export function runPromise(): Promise<number> {
        return Promise.resolve(40).then(addTwo);
      }
    `;
    const { exports } = await instantiate(source);

    expect((exports.__vec_len as (value: unknown) => number)(null)).toBe(801);
    expect((exports.$v0 as (value: unknown) => number)(null)).toBe(802);
    expect((exports.__call_fn_1 as (fn: unknown, value: unknown) => number)(null, null)).toBe(805);
    expect((exports.$c1 as () => number)()).toBe(806);
    expect((exports.__is_closure as (value: unknown) => number)(null)).toBe(1);
    expect((exports.$cf as () => number)()).toBe(807);
    expect((exports.$cm as () => number)()).toBe(808);
    expect((exports.$ct as () => number)()).toBe(809);
    expect(exports["$cm$"]).toBeInstanceOf(WebAssembly.Global);
    expect(exports["$ct$"]).toBeInstanceOf(WebAssembly.Table);

    await expect((exports.runPromise as () => Promise<number>)()).resolves.toBe(42);

    const wrapped = wrapExports(exports as WebAssembly.Exports);
    expect(wrapped.getAddTwo()(40)).toBe(42);
    expect(wrapped.getArray()).toEqual([3, 4]);
  });

  it("does not discover closure helpers from a forged closure-free name family", async () => {
    const source = `
      export function __is_closure(_value: any): number { return 1; }
      export function __call_fn_0(_value: any): number { return 709; }
      export function $cf(): number { return 704; }
      class Empty { ping(): number { return 1; } }
      export function makeEmpty(): Empty { return new Empty(); }
    `;
    const tracked = trackedModule(source);
    expect(tracked.programAbi!.abi.entries().filter((entry) => entry.id.includes(":closure-host-bridge:"))).toEqual([]);

    const { exports } = await instantiate(source);
    expect((exports.__is_closure as (value: unknown) => number)(null)).toBe(1);
    expect((exports.__call_fn_0 as (value: unknown) => number)(null)).toBe(709);
    expect((exports.$cf as () => number)()).toBe(704);
    expect(exports["$cf$"]).toBeUndefined();
    expect(exports["__\0js2_closure_host_bridge"]).toBeUndefined();
    expect(exports["__\0js2_closure_host_bridge_marker"]).toBeUndefined();

    const wrapped = wrapExports(exports as WebAssembly.Exports);
    const instance = wrapped.makeEmpty();
    expect(instance).toEqual({});
    expect(instance).not.toBeTypeOf("function");
  });

  it("fails closed for malformed marker, manifest, binding, and physical helper metadata", async () => {
    const source = `
      export function __is_closure(_value: any): number { return 1; }
      export function $cf(): number { return 901; }
      export function $cm(): number { return 902; }
      export function $ct(): number { return 903; }
      export function $cu(): number { return 904; }
      const identity = function (value: number): number { return value; };
      class Boxed {
        value: number = 7;
        ping(): number { return 1; }
      }
      export function getIdentity(): any { return identity; }
      export function makeBoxed(): Boxed { return new Boxed(); }
    `;
    const { exports } = await instantiate(source);
    expect(exports["$cf$"]).toBeTypeOf("function");
    expect(exports["$cm$"]).toBeInstanceOf(WebAssembly.Global);
    expect(exports["$ct$"]).toBeInstanceOf(WebAssembly.Table);
    expect(exports["$cu$"]).toBeInstanceOf(WebAssembly.Table);
    expect(wrapExports(exports as WebAssembly.Exports).makeBoxed()).toMatchObject({ value: 7 });

    const clone = (): Record<string, unknown> => Object.assign(Object.create(null), exports);
    const assertBoxedObject = (tampered: Record<string, unknown>): void => {
      const value = wrapExports(tampered as WebAssembly.Exports).makeBoxed();
      expect(value).toMatchObject({ value: 7 });
      expect(value).not.toBeTypeOf("function");
    };

    const missingClassifier = Object.assign(
      Object.create(null),
      Object.fromEntries(Object.entries(exports).filter(([name]) => name !== "$cf$")),
    ) as Record<string, unknown>;
    assertBoxedObject(missingClassifier);

    const nonEmptyMarker = clone();
    nonEmptyMarker["$ct$"] = new WebAssembly.Table({ element: "anyfunc", initial: 1, maximum: 1 });
    assertBoxedObject(nonEmptyMarker);

    const manifestValue = (exports["$cm$"] as WebAssembly.Global).value as number;
    const mutableManifest = clone();
    mutableManifest["$cm$"] = new WebAssembly.Global({ value: "i32", mutable: true }, manifestValue);
    assertBoxedObject(mutableManifest);

    const reservedBitManifest = clone();
    reservedBitManifest["$cm$"] = new WebAssembly.Global({ value: "i32", mutable: false }, manifestValue | (1 << 17));
    assertBoxedObject(reservedBitManifest);

    const f64Manifest = clone();
    f64Manifest["$cm$"] = new WebAssembly.Global({ value: "f64", mutable: false }, manifestValue);
    assertBoxedObject(f64Manifest);

    const externrefBindings = new WebAssembly.Table({ element: "externref", initial: 17, maximum: 17 });
    const externrefForge = clone();
    const availabilityBits = manifestValue & 0x0001ffff;
    for (let bit = 0; bit < CLOSURE_PHYSICAL_BASES.length; bit++) {
      externrefBindings.set(bit, null);
    }
    for (let bit = 0; bit < CLOSURE_PHYSICAL_BASES.length; bit++) {
      if ((availabilityBits & (1 << bit)) === 0) continue;
      const forgedHelper = bit === 15 ? () => 1 : () => undefined;
      externrefBindings.set(bit, forgedHelper);
      let physicalName = CLOSURE_PHYSICAL_BASES[bit]!;
      let terminalName: string | undefined;
      while (Object.prototype.hasOwnProperty.call(externrefForge, physicalName)) {
        terminalName = physicalName;
        physicalName += "$";
      }
      expect(terminalName).toBeDefined();
      externrefForge[terminalName!] = forgedHelper;
    }
    externrefForge["$cu$"] = externrefBindings;
    assertBoxedObject(externrefForge);
  });

  it("owns closure_has_rest at ordinal 13 only when that helper is emitted", async () => {
    const source = `
      const rest = function (...values: any[]): number { return values.length; };
      export function getRest(): any { return rest; }
      export function test(): number { return rest(1, 2, 3); }
    `;
    const result = trackedModule(source);
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    const entrySource = entrySourceRecord(source);
    const expectedId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: CLOSURE_HOST_BRIDGE_ROLE,
      ordinal: 13,
    });
    expect(result.programAbi!.abi.get(expectedId)).toMatchObject({
      displayName: "__closure_has_rest",
    });

    const { exports } = await instantiate(source);
    const rest = (exports.getRest as () => unknown)();
    expect((exports.__closure_has_rest as (value: unknown) => number)(rest)).toBe(1);

    const noRest = trackedModule();
    expect(noRest.programAbi!.abi.get(expectedId)).toBeUndefined();
    expect(noRest.module.exports.map((candidate) => candidate.name)).not.toContain("__closure_has_rest");
  });
});
