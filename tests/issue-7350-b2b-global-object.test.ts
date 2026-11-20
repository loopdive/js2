// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 B2b — the realm's global object as a dynamic value on the Prepared standalone path. G1's admission claims a
// built-in global read here too; from-ast lowers it as `dyn.member_get(dyn.global_object, "<Name>")`, the
// legalization binds `dyn.global_object` to the realm contract `js.object.global`, and the realm builds one global
// object whose own properties are exactly the globals the program reads. A callable is a kernel function object with
// its identity surface (name, length, [[Prototype]], `prototype` and its `constructor` link); calling it, or reading
// any other own member, aborts uncatchably. Every accepted program runs twice: as written (node's answers, returns)
// and with one answer replaced (throws).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { coerceIrValueToExternref } from "../src/ir/value-coercion.js";
import { nativeRealmReservationInventory } from "../src/backend/wasmgc/program/native-realm.js";
import { nativeBuiltinFunctionSingletonBinding } from "../src/backend/wasmgc/resources/native-builtin-functions.js";
import { nativeStringLiteralInstrs } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { emitBinary } from "../src/emit/binary.js";
import type { FunctionReservation } from "../src/wasm/physical/module-reservations.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { NATIVE_REALM_GLOBALS, nativeRealmGlobalReadRefusal } from "../src/shared/contracts/native-realm-globals.js";
import { builtinGlobalLanes } from "../src/shared/ambient-intrinsics.js";
import { fillRealmFixture, realmFixture } from "./helpers/native-realm-source-integration.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile through the strict Prepared entry, run its top-level code and report whether it threw. */
async function run(source: string): Promise<"returned" | "threw"> {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, options());
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

async function refusal(source: string) {
  const result = await compile(source, options());
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

/** node's verdict on the same script. */
function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

describe("#7350 B2b — a built-in global read as a value on the Prepared path", () => {
  it.each([
    ["an alias compared with the global", "var E = TypeError; if (E !== TypeError) throw 1;", ["!==", "==="]],
    ["typeof of a complete callable", 'if (typeof Object !== "function") throw 1;', ['"function"', '"object"']],
    ["typeof of a namespace", 'if (typeof JSON !== "object") throw 1;', ['"object"', '"function"']],
    ["two callables apart", "var E = TypeError; if (E === RangeError) throw 1;", ["===", "!=="]],
    [
      "a NativeError and its %Error% read together",
      "var E = TypeError, F = Error; if (E === F || F !== Error) throw 1;",
      ["F !== Error", "F === Error"],
    ],
    ["a namespace's identity", "var J = JSON; if (J !== JSON) throw 1;", ["!==", "==="]],
    ["a truthiness test", "if (!Math) throw 1;", ["!Math", "Math"]],
    [
      "typeof of a callable in a function",
      'function t() { return typeof parseInt; }\nif (t() !== "function") throw 1;',
      ['!== "function"', '=== "function"'],
    ],
  ] as const)(
    "answers %s like node",
    async (_label, source, [right, wrong]) => {
      const replaced = source.replace(right, wrong);
      expect([node(source), node(replaced)]).toEqual(["returned", "threw"]);
      expect(await run(source)).toBe("returned");
      expect(await run(replaced)).toBe("threw");
    },
    120_000,
  );

  // A callable in the carrier is held as the object kind, which `typeof` would misanswer ("object"): it refuses by
  // name where the value is not a read of the global object itself. (ToPrimitive of an alias refuses the same way;
  // G1's admission does not let an alias reach one today.)
  it("refuses typeof of an alias of a callable by name", async () => {
    expect(await refusal('var E = TypeError; if (typeof E !== "function") throw 1;')).toContain(
      `typeof of an object compared with "function" (the program reads the built-in function 'TypeError')`,
    );
  });

  // The realm's verdict on a global G1 may read: none of G1's names is refused today; these are the rows it refuses.
  it.each([
    ["Int8Array", "%Int8Array% links to %TypedArray%, which the realm does not build"],
    ["globalThis", "the global 'globalThis' is a global-object value"],
    ["NaN", "the global 'NaN' is a number value"],
    ["console", "'console' is not a language global"],
  ])("refuses a read of %s by name", (name, reason) => {
    expect(nativeRealmGlobalReadRefusal(name)).toBe(reason);
  });
  it("answers a read of every name G1 admits", () => {
    const names = NATIVE_REALM_GLOBALS.map((row) => row.name).filter((name) => builtinGlobalLanes(name) !== undefined);
    expect(names).toHaveLength(28); // every name of `builtinGlobalLanes` is a row
    expect(names.filter((name) => nativeRealmGlobalReadRefusal(name) !== undefined)).toEqual([]);
  });

  // The unsupported-surface rule: a call or member read of a built-in is never a catchable error. Statically visible,
  // each refuses at compile time; the dynamic ones are the kernel aborts pinned below.
  it.each([
    ["a member read", 'var E = TypeError; if (E.name !== "TypeError") throw 1;'],
    ["a call in try/catch", "var E = TypeError; try { E(); } catch (e) {}"],
    [
      "assert.throws-style code",
      "function throws(C, f) { try { f(); } catch (e) { return e instanceof C; } return false; }\n" +
        "if (!throws(TypeError, function () { TypeError(); })) throw 1;",
    ],
    ["a construction", "var e = new TypeError('x');"],
  ])("refuses %s of a built-in at compile time", async (_label, source) => {
    expect((await compile(source, options())).success).toBe(false);
  });
});

/** A typed backend program that reads `keys` off the realm's global object. */
function globalReadProgram(keys: readonly string[]) {
  const { packet } = sourcePacket({ "./entry.ts": "export function run(): number { return 7; }" });
  const original = packet.ir.functions.find((row) => row.name === "run")!;
  const allocations = AllocSiteRegistry.fromSnapshot(packet.allocations);
  const builder = new IrFunctionBuilder(
    { unitId: original.unitId, name: original.name },
    original.resultTypes,
    original.exported,
    allocations,
  );
  builder.openBlock();
  const external = { kind: "val", val: { kind: "externref" } } as const;
  const global = builder.emitCall(irIntrinsicFuncRef("js.object.global"), [], external)!;
  for (const key of keys)
    builder.emitCall(
      irIntrinsicFuncRef("js.object.get"),
      [global, coerceIrValueToExternref(builder, builder.emitStringConst(key)), global],
      external,
    );
  const result = builder.emitConst({ kind: "f64", value: 7 }, { kind: "val", val: { kind: "f64" } });
  builder.terminate({ kind: "return", values: [result] });
  const fn = builder.finish();
  const input = {
    ...packet,
    allocations: allocations.snapshot(),
    ir: { ...packet.ir, functions: packet.ir.functions.map((row) => (row === original ? fn : row)) },
  };
  const policy = {
    backend: "wasmgc",
    target: "standalone",
    numberBoundary: { box: "native", unbox: "native" },
    booleanBoundary: { box: "unsupported", unbox: "native" },
    stringConst: { storage: "native" },
  } as const;
  return requireProgram(prepareTypedIrProgram(input, { ...typedOptions, policy, runtimePolicies: [policy] }));
}

const ext = { kind: "externref" } as const;
const KEYS = ["Function", "JSON", "TypeError"];
const TEXTS = [
  "TypeError",
  "Error",
  "Function",
  "JSON",
  "Object",
  "name",
  "length",
  "prototype",
  "constructor",
  "call",
];

/** The realm of {@link globalReadProgram}, with its global object, kernel [[Get]] and calls exported. */
function globalRealm() {
  const f = realmFixture(globalReadProgram(KEYS));
  const { tx, kernel } = f;
  const keys = TEXTS.map((text) =>
    tx.reserveFunction("b2b-control:key:" + text, "key:" + text, { params: [], results: [ext] }),
  );
  const unbox = tx.reserveFunction("b2b-control:unbox", "unbox", { params: [ext], results: [{ kind: "f64" }] });
  const adapter = (feature: string): FunctionReservation =>
    nativeRealmReservationInventory(tx, f.realm).functions.find((row) =>
      row.key.endsWith(":source-objects:" + feature),
    )!;
  const [globalObject, adapterGet] = [adapter("js.object.global"), adapter("js.object.get")];
  fillRealmFixture(f);
  TEXTS.forEach((text, index) =>
    tx.fillFunction(keys[index]!, { locals: [], body: nativeStringLiteralInstrs(tx, f.strings.strings, text) }),
  );
  tx.fillFunction(unbox, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: f.strings.number!.values.functions.unboxNumber.handle },
    ],
  });
  const singleton = (id: string) => nativeBuiltinFunctionSingletonBinding(tx, kernel, id).getter;
  for (const [name, token] of Object.entries({
    globalObject,
    adapterGet,
    unbox,
    get: kernel.functions.get,
    getPrototypeOf: kernel.functions.getPrototypeOf,
    method0: kernel.functions.method0,
    construct: kernel.functions.construct,
    newVector: f.realm.substrate.arguments.newVector,
    functionPrototype: kernel.entries.find((row) => row.id === "function-prototype")!.getter,
    objectPrototype: kernel.functions.objectPrototype,
    error: singleton("%Error%"),
    typeError: singleton("%TypeError%"),
    function: singleton("%Function%"),
    ...Object.fromEntries(TEXTS.map((text, index) => ["key:" + text, keys[index]!])),
  }))
    tx.defineExport("b2b-control:export:" + name, name, token);
  tx.seal();
  const exports = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(f.module) as BufferSource))
    .exports as Record<string, (...args: unknown[]) => unknown>;
  const key = (text: string) => exports["key:" + text]!();
  /** The kernel [[Get]]: [status, value] (0 absent, 1 present, 2 a miss at Object.prototype, 4 an identity miss). */
  const get = (object: unknown, text: string) => exports.get!(object, key(text), object) as [number, unknown];
  return { f, exports, key, get };
}

describe("#7350 B2b — the realm's global object and its identity intrinsics", () => {
  let realm: ReturnType<typeof globalRealm>;
  beforeAll(() => {
    realm = globalRealm();
  }, 120_000);
  const get = (object: unknown, text: string) => realm.get(object, text);
  const key = (text: string) => realm.key(text);

  /** `object` holds `value` as its own (or inherited) property `text`. GC references compare by identity only. */
  const holds = (object: unknown, text: string, value: unknown) => {
    const [status, actual] = get(object, text);
    expect([status, actual === value]).toEqual([1, true]);
  };

  it("builds one global object whose own properties are exactly the globals read", () => {
    expect(realm.f.requirements.description.globalKeys).toEqual(KEYS);
    const global = realm.exports.globalObject!();
    expect(realm.exports.globalObject!() === global).toBe(true);
    holds(global, "TypeError", realm.exports.typeError!());
    holds(global, "Function", realm.exports.function!());
    expect(get(global, "JSON")[0]).toBe(1);
    // `Error` is built (TypeError's [[Prototype]]) but not read, so it is no property; `Object` is not built at all.
    for (const absent of ["Error", "Object"]) expect(get(global, absent)[0]).toBe(2);
  });

  it("gives an identity callable its name, length, [[Prototype]] and prototype object", () => {
    const [typeError, error] = [realm.exports.typeError!(), realm.exports.error!()];
    holds(typeError, "name", key("TypeError"));
    expect(realm.exports.unbox!(get(typeError, "length")[1])).toBe(1);
    expect(realm.exports.getPrototypeOf!(typeError) === error).toBe(true);
    expect(realm.exports.getPrototypeOf!(error) === realm.exports.functionPrototype!()).toBe(true);
    const [status, prototype] = get(typeError, "prototype");
    expect(status).toBe(1);
    holds(prototype, "constructor", typeError);
    const errorPrototype = get(error, "prototype")[1];
    expect(errorPrototype === prototype).toBe(false);
    holds(errorPrototype, "constructor", error);
    // %Function%'s `prototype` is the realm's own Function.prototype, as %Object%'s is its Object.prototype.
    holds(realm.exports.function!(), "prototype", realm.exports.functionPrototype!());
  });

  it("answers a miss among an identity object's own properties as unknown, never as absent", () => {
    const global = realm.exports.globalObject!();
    const json = get(global, "JSON")[1];
    for (const object of [
      realm.exports.typeError!(),
      get(realm.exports.typeError!(), "prototype")[1],
      json,
      realm.exports.functionPrototype!(),
    ])
      expect(get(object, "call")[0]).toBe(4);
    expect(() => realm.exports.adapterGet!(json, key("call"), json)).toThrow(WebAssembly.RuntimeError);
  });

  it("aborts a call or construct of an identity callable with an uncatchable trap", () => {
    const typeError = realm.exports.typeError!();
    expect(() => realm.exports.method0!(typeError, undefined)).toThrow(WebAssembly.RuntimeError);
    expect(() => realm.exports.construct!(typeError, typeError, realm.exports.newVector!())).toThrow(
      WebAssembly.RuntimeError,
    );
    expect(() => realm.exports.method0!(typeError, undefined)).toThrow("unreachable");
  });
});
