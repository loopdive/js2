// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import {
  DATA_STRUCT_HOST_BRIDGE_TOKEN,
  DATA_STRUCT_HOST_BRIDGE_ORDINAL,
  DATA_STRUCT_HOST_BRIDGE_ROLE,
} from "../src/codegen/data-struct-host-bridge.js";
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
import { buildImports, instantiateWasm, wrapExports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const DATA_BRIDGES = Object.freeze([
  { name: "__is_data_struct", physicalBase: "$d0", ordinal: DATA_STRUCT_HOST_BRIDGE_ORDINAL.isDataStruct },
  {
    name: "__struct_field_names",
    physicalBase: "$d1",
    ordinal: DATA_STRUCT_HOST_BRIDGE_ORDINAL.structFieldNames,
  },
] as const);

const DATA_SOURCE = `
  class Box {
    alpha: number = 3;
    beta: number = 4;
  }
  export function makeBox(): Box { return new Box(); }
  export function countKeys(value: any): number {
    let count: number = 0;
    for (const _key in value) count = count + 1;
    return count;
  }
`;

const COLLISION_SOURCE = `
  export function __is_data_struct(_value: any): number { return 701; }
  export function __struct_field_names(_value: any): number { return 702; }
  export function $d0(): number { return 703; }
  export function $d1(): number { return 704; }
  export function $dm(): number { return 705; }
  export function $dt(): number { return 706; }
  export function $du(): number { return 707; }
  export function $dv(): number { return 713; }
  export function __vec_len(_value: any): number { return 708; }
  export function $v0(): number { return 709; }
  export function __call_fn_1(_closure: any, _value: any): number { return 710; }
  export function $c1(): number { return 711; }
  export function __is_closure(_value: any): number { return 1; }
  export function $cf(): number { return 712; }
  export function forgedIsDataStruct(_value: any): boolean { return true; }
  export function forgedStructFieldNames(_value: any): any { return "second"; }

  class Box {
    first: number = 3;
    second: number = 4;
  }
  const addTwo = function (value: number): number { return value + 2; };
  export function makeBox(): Box { return new Box(); }
  export function getArray(): number[] { return [3, 4]; }
  export function getAddTwo(): any { return addTwo; }
  export function countKeys(value: any): number {
    let count: number = 0;
    for (const _key in value) count = count + 1;
    return count;
  }
`;

function trackedModule(source = DATA_SOURCE) {
  const ast = analyzeSource(source, "issue-3520-data-struct-host-bridge.ts");
  return generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
}

function entrySourceRecord(source = DATA_SOURCE) {
  const ast = analyzeSource(source, "issue-3520-data-struct-host-bridge.ts");
  return buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  }).sources.find((candidate) => candidate.kind === "entry")!;
}

function hardErrors(result: ReturnType<typeof generateModule>) {
  return result.errors.filter((error) => error.severity !== "warning");
}

async function instantiate(source: string): Promise<{
  readonly instance: WebAssembly.Instance;
  readonly exports: Record<string, unknown>;
  readonly imports: ReturnType<typeof buildImports>;
  readonly result: Awaited<ReturnType<typeof compile>>;
}> {
  const result = await compile(source, {
    fileName: "issue-3520-data-struct-host-runtime.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return { instance, exports: instance.exports as Record<string, unknown>, imports, result };
}

async function instantiateUnwiredCollision(): Promise<{
  readonly instance: WebAssembly.Instance;
  readonly exports: Record<string, unknown>;
  readonly imports: ReturnType<typeof buildImports>;
  readonly result: Awaited<ReturnType<typeof compile>>;
}> {
  const result = await compile(COLLISION_SOURCE, {
    fileName: "issue-3520-data-struct-host-unwired.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return { instance, exports: instance.exports as Record<string, unknown>, imports, result };
}

function terminalAliasKey(exports: Record<string, unknown>, physicalBase: string): string {
  let key = physicalBase;
  let terminal = physicalBase;
  while (Object.prototype.hasOwnProperty.call(exports, key)) {
    terminal = key;
    key += "$";
  }
  return terminal;
}

describe("#3520 C33 data-struct host bridge Program ABI ownership", () => {
  it("plans two fixed entry-source IDs and publishes their exact final helper slots", () => {
    const result = trackedModule();
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    const entrySource = entrySourceRecord();
    const importCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    const exportsByName = new Map(result.module.exports.map((entry) => [entry.name, entry]));
    const dataEntries = result
      .programAbi!.abi.entries()
      .filter((entry) => entry.id.includes(`:${DATA_STRUCT_HOST_BRIDGE_ROLE}:`));
    expect(dataEntries).toHaveLength(2);

    for (const bridge of DATA_BRIDGES) {
      const expectedId = createIrBindingId({
        ownerId: entrySource.id,
        domain: "support",
        role: DATA_STRUCT_HOST_BRIDGE_ROLE,
        ordinal: bridge.ordinal,
      });
      expect(result.programAbi!.abi.get(expectedId)).toMatchObject({
        id: expectedId,
        displayName: bridge.name,
        intent: {
          kind: "callable",
          origin: "support",
          sourceId: entrySource.id,
        },
      });
      const slot = result.programAbi!.abi.resolveFinalIndex(expectedId);
      expect(slot).toEqual({ space: "function", index: exportsByName.get(bridge.physicalBase)?.desc.index });
      if (!slot || slot.space !== "function") throw new Error(`missing ${bridge.name} final slot`);
      expect(result.module.functions[slot.index - importCount]?.name).toBe(bridge.name);
      expect(
        result
          .programAbi!.abi.entries()
          .filter((entry) => entry.displayName === bridge.name && entry.id.includes("retained-module-function")),
      ).toEqual([]);
    }
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
      name: "__is_data_struct",
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
      role: DATA_STRUCT_HOST_BRIDGE_ROLE,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.dataStructHostBridge,
      derivedOrdinal: DATA_STRUCT_HOST_BRIDGE_ORDINAL.isDataStruct,
      displayName: helper.name,
      func: helper,
    });
    const expectedId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: DATA_STRUCT_HOST_BRIDGE_ROLE,
      ordinal: DATA_STRUCT_HOST_BRIDGE_ORDINAL.isDataStruct,
    });
    expect(ref?.binding).toEqual({ kind: "support", bindingId: expectedId });
    expect(session.getDraft(expectedId)?.structuralOrder).toMatchObject({
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.dataStructHostBridge,
      derivedOrdinal: DATA_STRUCT_HOST_BRIDGE_ORDINAL.isDataStruct,
    });
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper)).toBe(0);

    const lateImport: Import = { module: "env", name: "late", desc: { kind: "func", typeIdx: 0 } };
    module.imports.push(lateImport);
    module.functions.splice(module.functions.indexOf(dead), 1);
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper)).toBe(1);
    const publication = session.publish(module);
    expect(publication.abi.resolveFinalIndex(expectedId)).toEqual({ space: "function", index: 1 });
    expect(module.functions[0]).toBe(helper);
  });

  it("emits zero rows without data and only the classifier for a private-only class", async () => {
    const empty = trackedModule(`export function add(a: number, b: number): number { return a + b; }`);
    expect(hardErrors(empty)).toEqual([]);
    expect(
      empty.programAbi!.abi.entries().filter((entry) => entry.id.includes(`:${DATA_STRUCT_HOST_BRIDGE_ROLE}:`)),
    ).toEqual([]);
    const emptyExports = empty.module.exports.map((entry) => entry.name);
    expect(emptyExports).not.toContain("__is_data_struct");
    expect(emptyExports).not.toContain("__\0js2_data_struct_host_bridge");

    const fieldlessSource = `
      class PrivateOnly {
        #secret: number = 7;
        read(): number { return this.#secret; }
      }
      export function makePrivateOnly(): PrivateOnly { return new PrivateOnly(); }
    `;
    const fieldless = trackedModule(fieldlessSource);
    expect(hardErrors(fieldless)).toEqual([]);
    const rows = fieldless
      .programAbi!.abi.entries()
      .filter((entry) => entry.id.includes(`:${DATA_STRUCT_HOST_BRIDGE_ROLE}:`));
    expect(rows.map((entry) => entry.displayName)).toEqual(["__is_data_struct"]);
    const { exports, imports } = await instantiate(fieldlessSource);
    expect(exports.__is_data_struct).toBeTypeOf("function");
    expect(exports.__struct_field_names).toBeUndefined();
    expect((exports["__\0js2_data_struct_host_bridge"] as WebAssembly.Global).value).toBe(0x5a300001);
    expect(exports["__\0js2_data_struct_host_bridge_token"]).toBe(
      imports.string_constants[DATA_STRUCT_HOST_BRIDGE_TOKEN],
    );
    const bindings = exports["__\0js2_data_struct_host_bridge_bindings"] as WebAssembly.Table;
    expect(bindings.length).toBe(2);
    expect(bindings.get(0)).toBeTypeOf("function");
    expect(bindings.get(1)).toBeNull();
  });

  it("keeps tracked and untracked data modules byte-identical", async () => {
    const options = {
      fileName: "issue-3520-data-struct-byte-parity.ts",
      experimentalIR: true,
    } as const;
    const untracked = await compile(DATA_SOURCE, options);
    const tracked = await compile(DATA_SOURCE, { ...options, trackIrOutcomes: true });
    expect(untracked.success, untracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.success, tracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.binary).toEqual(untracked.binary);
  });

  it("imports the association Global only in the host lane", async () => {
    const host = await compile(DATA_SOURCE, {
      fileName: "issue-3520-data-struct-host-token.ts",
      experimentalIR: true,
    });
    expect(host.success, host.errors.map((error) => error.message).join("\n")).toBe(true);
    const hostImports = WebAssembly.Module.imports(new WebAssembly.Module(host.binary));
    expect(
      hostImports.filter(
        (entry) => entry.module === "string_constants" && entry.name === DATA_STRUCT_HOST_BRIDGE_TOKEN,
      ),
    ).toHaveLength(1);

    const standalone = await compile(DATA_SOURCE, {
      fileName: "issue-3520-data-struct-standalone-token.ts",
      target: "standalone",
      experimentalIR: true,
    });
    expect(standalone.success, standalone.errors.map((error) => error.message).join("\n")).toBe(true);
    const standaloneImports = WebAssembly.Module.imports(new WebAssembly.Module(standalone.binary));
    expect(standaloneImports).toEqual([]);
  });

  it("preserves the association Global through the instantiateWasm helper", async () => {
    const result = await compile(DATA_SOURCE, {
      fileName: "issue-3520-data-struct-instantiate-helper.ts",
      experimentalIR: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance, nativeBuiltins } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );

    expect(nativeBuiltins).toBe(false);
    expect(instance.exports["__\0js2_data_struct_host_bridge_token"]).toBe(
      imports.string_constants[DATA_STRUCT_HOST_BRIDGE_TOKEN],
    );
    imports.setInstance?.(instance);
    const box = (instance.exports.makeBox as () => unknown)();
    expect((instance.exports.countKeys as (value: unknown) => number)(box)).toBe(2);
  });

  it("moves exactly five census rows without changing functions or terminal routing", () => {
    let definedFunctions = 0;
    let genericRows = 0;
    let dataRows = 0;
    let vecRows = 0;
    let closureRows = 0;
    let dateRows = 0;
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
      dataRows += entries.filter((candidate) => candidate.id.includes(`:${DATA_STRUCT_HOST_BRIDGE_ROLE}:`)).length;
      vecRows += entries.filter((candidate) => candidate.id.includes(":vec-host-bridge:")).length;
      closureRows += entries.filter((candidate) => candidate.id.includes(":closure-host-bridge:")).length;
      dateRows += entries.filter((candidate) => candidate.id.includes(":date-civil-support:")).length;
      for (const outcome of result.irOutcomes ?? []) {
        terminalUnits++;
        if (outcome.kind === "emitted") emitted++;
        if (outcome.kind === "unsupported") unsupported++;
        if (outcome.kind === "invariant") invariants++;
        if (outcome.legacyBodyEmitted) legacyBodies++;
        if (outcome.irBodyEmitted) irBodies++;
      }
    }

    expect({ definedFunctions, genericRows, dataRows, vecRows, closureRows, dateRows }).toEqual({
      definedFunctions: 166,
      genericRows: 45,
      dataRows: 5,
      vecRows: 24,
      closureRows: 26,
      dateRows: 1,
    });
    expect({ terminalUnits, emitted, unsupported, invariants, legacyBodies, irBodies }).toEqual({
      terminalUnits: 37,
      emitted: 30,
      unsupported: 7,
      invariants: 0,
      legacyBodies: 37,
      irBodies: 30,
    });
  });

  it("preserves data classification and field order through the authenticated helpers", async () => {
    const source = `
      class Box {
        zeta: number = 1;
        alpha: number = 2;
      }
      const closure = function (): number { return 7; };
      export function makeBox(): Box { return new Box(); }
      export function getClosure(): any { return closure; }
    `;
    const { exports } = await instantiate(source);
    const box = (exports.makeBox as () => unknown)();
    const closure = (exports.getClosure as () => unknown)();
    const bindings = exports["$du"] as WebAssembly.Table;
    expect(bindings.get(0)).toBe(exports["$d0"]);
    expect(bindings.get(1)).toBe(exports["$d1"]);
    expect((exports.__is_data_struct as (value: unknown) => number)(box)).toBe(1);
    expect((exports.__is_data_struct as (value: unknown) => number)(closure)).toBe(0);
    expect((exports.__struct_field_names as (value: unknown) => string)(box)).toBe("zeta,alpha");
    expect(wrapExports(exports as WebAssembly.Exports).makeBox()).toEqual({ zeta: 1, alpha: 2 });
  });

  it("preserves colliding public names while setExports and wrapExports compose vec, closure, and data helpers", async () => {
    const tracked = trackedModule(COLLISION_SOURCE);
    expect(
      hardErrors(tracked),
      hardErrors(tracked)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    const byName = new Map(tracked.module.exports.map((entry) => [entry.name, entry]));
    for (const [logicalName, physicalName] of [
      ["__is_data_struct", "$d0$"],
      ["__struct_field_names", "$d1$"],
    ] as const) {
      expect(byName.get(logicalName)?.desc.index).not.toBe(byName.get(physicalName)?.desc.index);
    }

    const { exports, imports } = await instantiate(COLLISION_SOURCE);
    expect((exports.__is_data_struct as () => number)()).toBe(701);
    expect((exports.__struct_field_names as () => number)()).toBe(702);
    expect((exports.$d0 as () => number)()).toBe(703);
    expect((exports.$d1 as () => number)()).toBe(704);
    expect((exports.$dm as () => number)()).toBe(705);
    expect((exports.$dt as () => number)()).toBe(706);
    expect((exports.$du as () => number)()).toBe(707);
    expect((exports.$dv as () => number)()).toBe(713);
    expect(exports["$d0$"]).toBeTypeOf("function");
    expect(exports["$d1$"]).toBeTypeOf("function");
    expect(exports["$dm$"]).toBeInstanceOf(WebAssembly.Global);
    expect(exports["$dt$"]).toBeInstanceOf(WebAssembly.Table);
    expect(exports["$du$"]).toBeInstanceOf(WebAssembly.Table);
    expect(exports["$dv$"]).toBe(imports.string_constants[DATA_STRUCT_HOST_BRIDGE_TOKEN]);

    const rawBox = (exports.makeBox as () => unknown)();
    expect((exports.countKeys as (value: unknown) => number)(rawBox)).toBe(2);
    const wrapped = wrapExports(exports as WebAssembly.Exports);
    expect(wrapped.__is_data_struct()).toBe(701);
    expect(wrapped.makeBox()).toEqual({ first: 3, second: 4 });
    expect(wrapped.getArray()).toEqual([3, 4]);
    expect(wrapped.getAddTwo()(40)).toBe(42);
  });

  it("fails closed for missing, malformed, mismatched, and externref-forged metadata", async () => {
    const { exports, imports } = await instantiate(COLLISION_SOURCE);
    const box = (exports.makeBox as () => unknown)();
    const countKeys = exports.countKeys as (value: unknown) => number;
    expect(countKeys(box)).toBe(2);

    const clone = (): Record<string, unknown> => Object.assign(Object.create(null), exports);
    const assertNoForgedFields = (tampered: Record<string, unknown>): void => {
      imports.setExports?.(tampered as Record<string, Function>);
      expect(countKeys(box)).toBe(0);
      expect(wrapExports(tampered as WebAssembly.Exports).makeBox()).toEqual({});
    };

    const missingTerminal = clone();
    Reflect.deleteProperty(missingTerminal, "$d1$");
    assertNoForgedFields(missingTerminal);

    const nonEmptyMarker = clone();
    nonEmptyMarker["$dt$"] = new WebAssembly.Table({ element: "anyfunc", initial: 1, maximum: 1 });
    assertNoForgedFields(nonEmptyMarker);

    const externrefMarker = clone();
    externrefMarker["$dt$"] = new WebAssembly.Table({ element: "externref", initial: 0, maximum: 0 });
    assertNoForgedFields(externrefMarker);

    const manifestValue = (exports["$dm$"] as WebAssembly.Global).value as number;
    const mutableManifest = clone();
    mutableManifest["$dm$"] = new WebAssembly.Global({ value: "i32", mutable: true }, manifestValue);
    assertNoForgedFields(mutableManifest);

    const f64Manifest = clone();
    f64Manifest["$dm$"] = new WebAssembly.Global({ value: "f64", mutable: false }, manifestValue);
    assertNoForgedFields(f64Manifest);

    const reservedManifest = clone();
    reservedManifest["$dm$"] = new WebAssembly.Global({ value: "i32", mutable: false }, manifestValue | (1 << 2));
    assertNoForgedFields(reservedManifest);

    const bindings = exports["$du$"] as WebAssembly.Table;
    const mismatchedBindings = new WebAssembly.Table({ element: "anyfunc", initial: 2, maximum: 2 });
    mismatchedBindings.set(0, bindings.get(1));
    mismatchedBindings.set(1, bindings.get(0));
    const mismatch = clone();
    mismatch["$du$"] = mismatchedBindings;
    assertNoForgedFields(mismatch);

    const forgedIsData = () => 1;
    const forgedFieldNames = () => "forged";
    const externrefBindings = new WebAssembly.Table({ element: "externref", initial: 2, maximum: 2 });
    externrefBindings.set(0, null);
    externrefBindings.set(1, null);
    externrefBindings.set(0, forgedIsData);
    externrefBindings.set(1, forgedFieldNames);
    const externrefForge = clone();
    externrefForge["$d0$"] = forgedIsData;
    externrefForge["$d1$"] = forgedFieldNames;
    externrefForge["$du$"] = externrefBindings;
    assertNoForgedFields(externrefForge);

    imports.setExports?.(exports as Record<string, Function>);
    expect(countKeys(box)).toBe(2);
  });

  it("rejects a genuine donor instance from another buildImports and recovers with the associated instance", async () => {
    const donor = await instantiateUnwiredCollision();
    const targetImports = buildImports(donor.result.imports, undefined, donor.result.stringPool);
    const { instance: target } = await WebAssembly.instantiate(donor.result.binary, targetImports);
    const targetExports = target.exports as Record<string, unknown>;
    const targetBox = (targetExports.makeBox as () => unknown)();
    const targetCountKeys = targetExports.countKeys as (value: unknown) => number;

    targetImports.setInstance?.(donor.instance);
    expect(targetCountKeys(targetBox)).toBe(0);

    targetImports.setInstance?.(target);
    expect(targetCountKeys(targetBox)).toBe(2);
    expect(wrapExports(target).makeBox()).toEqual({ first: 3, second: 4 });
  });

  it("keeps raw setExports compatibility for legacy families while data authority fails closed", async () => {
    const unwired = await instantiateUnwiredCollision();
    unwired.imports.setExports?.(unwired.exports as Record<string, Function>);
    const wrapped = wrapExports(unwired.exports as WebAssembly.Exports);
    const box = (unwired.exports.makeBox as () => unknown)();

    expect(wrapped.getAddTwo()(40)).toBe(42);
    expect(wrapped.getArray()).toEqual([3, 4]);
    expect((unwired.exports.countKeys as (value: unknown) => number)(box)).toBe(0);
    expect(wrapped.makeBox()).toEqual({});

    unwired.imports.setInstance?.(unwired.instance);
    expect((unwired.exports.countKeys as (value: unknown) => number)(box)).toBe(2);
    expect(wrapExports(unwired.instance).makeBox()).toEqual({ first: 3, second: 4 });
  });

  it("resists poisoned invocation intrinsics during authority decisions", async () => {
    const unwired = await instantiateUnwiredCollision();
    const box = (unwired.exports.makeBox as () => unknown)();
    const countKeys = unwired.exports.countKeys as (value: unknown) => number;
    const forged = Object.assign(Object.create(null), unwired.exports) as Record<string, unknown>;
    Reflect.deleteProperty(forged, terminalAliasKey(unwired.exports, "$dt"));

    const originalCall = Function.prototype.call;
    let rawWiringError: unknown;
    try {
      Function.prototype.call = function poisonedCall(): never {
        throw new Error("live Function.prototype.call consulted");
      };
      unwired.imports.setExports?.(forged as Record<string, Function>);
    } catch (error) {
      rawWiringError = error;
    } finally {
      Function.prototype.call = originalCall;
    }

    expect(rawWiringError).toBeUndefined();
    expect(countKeys(box)).toBe(0);

    const inherited = Object.create(WebAssembly.Instance.prototype);
    const originalReflectApply = Reflect.apply;
    let fakeInstanceError: unknown;
    let recoveryError: unknown;
    try {
      Reflect.apply = function poisonedReflectApply(): WebAssembly.Exports {
        return unwired.instance.exports;
      };
      try {
        unwired.imports.setInstance?.(inherited);
      } catch (error) {
        fakeInstanceError = error;
      }
      try {
        unwired.imports.setInstance?.(unwired.instance);
      } catch (error) {
        recoveryError = error;
      }
    } finally {
      Reflect.apply = originalReflectApply;
    }

    expect(fakeInstanceError).toBeInstanceOf(TypeError);
    expect((fakeInstanceError as Error).message).toBe("setInstance: expected a genuine WebAssembly.Instance");
    expect(recoveryError).toBeUndefined();
    expect(countKeys(box)).toBe(2);
  });

  it("fails closed on a Proxy binding table and recovers without leaking its length trap", async () => {
    const { instance, exports, imports } = await instantiate(COLLISION_SOURCE);
    const box = (exports.makeBox as () => unknown)();
    const countKeys = exports.countKeys as (value: unknown) => number;
    const bindingKey = terminalAliasKey(exports, "$du");
    const tampered = Object.assign(Object.create(null), exports) as Record<string, unknown>;
    tampered[bindingKey] = new Proxy(exports[bindingKey] as WebAssembly.Table, {});

    expect(() => imports.setExports?.(tampered as Record<string, Function>)).not.toThrow();
    expect(countKeys(box)).toBe(0);

    imports.setInstance?.(instance);
    expect(countKeys(box)).toBe(2);
  });

  it("pins original callable identities against same-funcref binding-table mutation", async () => {
    const { exports, imports } = await instantiate(COLLISION_SOURCE);
    const box = (exports.makeBox as () => unknown)();
    const countKeys = exports.countKeys as (value: unknown) => number;
    const bindings = exports["$du$"] as WebAssembly.Table;
    const originalIsDataStruct = bindings.get(0);
    const originalStructFieldNames = bindings.get(1);
    const forgedIsDataStruct = exports.forgedIsDataStruct as (value: unknown) => number;
    const forgedStructFieldNames = exports.forgedStructFieldNames as (value: unknown) => string;

    expect(countKeys(box)).toBe(2);
    expect(forgedIsDataStruct(box)).toBe(1);
    expect(forgedStructFieldNames(box)).toBe("second");

    // This is a real funcref-table substitution with ordinary exported Wasm
    // functions, not the easier externref/JS-function forgery above.
    bindings.set(0, forgedIsDataStruct);
    bindings.set(1, forgedStructFieldNames);
    expect(bindings.get(0)).toBe(forgedIsDataStruct);
    expect(bindings.get(1)).toBe(forgedStructFieldNames);

    const tampered = Object.assign(Object.create(null), exports) as Record<string, unknown>;
    tampered["$d0$"] = forgedIsDataStruct;
    tampered["$d1$"] = forgedStructFieldNames;
    imports.setExports?.(tampered as Record<string, Function>);

    // If the mutable table were still its own authority, both paths would
    // accept the forged "second"-only field list and return one field.
    expect(countKeys(box)).toBe(0);
    expect(wrapExports(tampered as WebAssembly.Exports).makeBox()).toEqual({});

    bindings.set(0, originalIsDataStruct);
    bindings.set(1, originalStructFieldNames);
    imports.setExports?.(exports as Record<string, Function>);
    expect(countKeys(box)).toBe(2);
    expect(wrapExports(exports as WebAssembly.Exports).makeBox()).toEqual({ first: 3, second: 4 });
  });
});
