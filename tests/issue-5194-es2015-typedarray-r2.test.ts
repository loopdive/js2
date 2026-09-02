// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5194 r2 residual — the TypedArray PROTOTYPE GRAPH and the `%TypedArray%`
 * intrinsic surface (2026-09-01 plan, steps 1 and 2).
 *
 * The cluster-A rows (63) and cluster-B rows (31) are all reflection over two
 * objects the compiler owns: the per-kind `<View>.prototype` `$NativeProto`
 * glue and the `%TypedArray%` intrinsic constructor carrier. Their assertions
 * are identity (`ref.eq`) and descriptor attributes, so a control that reads
 * exactly those is a faithful, fast twin of the corpus rows.
 *
 * The standalone lane additionally asserts ZERO host imports: CI's standalone
 * gate fails a module that emits any `env::*`, and the in-process path probe
 * used during development does NOT apply that check (#5272).
 */
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

type Lane = "host" | "standalone";

const CONTROL_TIMEOUT = 180_000;

async function runControl(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5194-es2015-typedarray-r2.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `${lane} control compile failed:\n${result.errors?.map((error) => `L${error.line}: ${error.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return -1;

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  if (lane === "standalone") {
    expect(imports, "standalone TypedArray prototype-graph controls must emit zero imports").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

/**
 * Step 1 — the per-kind prototype GRAPH. §23.2.7: each concrete view prototype
 * inherits every method from `%TypedArray%.prototype` and owns only
 * `constructor` and `BYTES_PER_ELEMENT`.
 */
const PROTO_GRAPH_SOURCE = `
  export function test(): number {
    const TypedArray: any = Object.getPrototypeOf(Int8Array);

    // 23.2.5.6 -- an instance's [[Prototype]] is its own kind's prototype.
    if (Object.getPrototypeOf(new Uint8Array(0)) !== Uint8Array.prototype) return 1;
    if (Object.getPrototypeOf(new Float64Array([42, 43])) !== Float64Array.prototype) return 2;

    // 23.2.7 -- the view prototype's own [[Prototype]] is %TypedArray%.prototype.
    if (Object.getPrototypeOf(Uint8Array.prototype) !== TypedArray.prototype) return 3;
    if (Object.getPrototypeOf(Int32Array.prototype) !== TypedArray.prototype) return 4;

    // Methods are INHERITED, not own -- and are the same function object.
    if (Uint8Array.prototype.hasOwnProperty("forEach") !== false) return 5;
    if (Int32Array.prototype.hasOwnProperty("map") !== false) return 6;
    if (TypedArray.prototype.hasOwnProperty("forEach") !== true) return 7;
    if (Uint8Array.prototype.forEach !== TypedArray.prototype.forEach) return 8;
    if (typeof Uint8Array.prototype.map !== "function") return 9;

    // 23.2.7.x -- 'constructor' and 'BYTES_PER_ELEMENT' ARE own.
    if (Uint8Array.prototype.constructor !== Uint8Array) return 10;
    if (Float64Array.prototype.constructor !== Float64Array) return 11;
    if (Uint8Array.prototype.BYTES_PER_ELEMENT !== 1) return 12;
    if (Float64Array.prototype.BYTES_PER_ELEMENT !== 8) return 13;
    if (Uint8Array.prototype.hasOwnProperty("constructor") !== true) return 14;
    if (Uint8Array.prototype.hasOwnProperty("BYTES_PER_ELEMENT") !== true) return 15;
    return 0;
  }
`;

/** Step 1 — the §17 / §23.2.7.1 descriptor attributes of those own properties. */
const PROTO_DESCRIPTOR_SOURCE = `
  export function test(): number {
    const ctorDesc: any = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "constructor");
    if (ctorDesc === undefined) return 1;
    if (ctorDesc.value !== Uint8Array) return 2;
    if (ctorDesc.writable !== true) return 3;
    if (ctorDesc.enumerable !== false) return 4;
    if (ctorDesc.configurable !== true) return 5;

    const bpeDesc: any = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "BYTES_PER_ELEMENT");
    if (bpeDesc === undefined) return 6;
    if (bpeDesc.value !== 1) return 7;
    if (bpeDesc.writable !== false) return 8;
    if (bpeDesc.enumerable !== false) return 9;
    if (bpeDesc.configurable !== false) return 10;

    // 23.2.6.2 -- <View>.prototype itself is an all-false own property of
    // the constructor, and must answer hasOwnProperty (verifyProperty's very
    // first assertion).
    if (Object.prototype.hasOwnProperty.call(Uint8Array, "prototype") !== true) return 11;
    const protoDesc: any = Object.getOwnPropertyDescriptor(Uint8Array, "prototype");
    if (protoDesc === undefined) return 12;
    if (protoDesc.value !== Uint8Array.prototype) return 13;
    if (protoDesc.writable !== false) return 14;
    if (protoDesc.enumerable !== false) return 15;
    if (protoDesc.configurable !== false) return 16;
    return 0;
  }
`;

/** Step 2 — the `%TypedArray%` intrinsic's own §23.2.2 surface. */
const INTRINSIC_SURFACE_SOURCE = `
  export function test(): number {
    const TypedArray: any = Object.getPrototypeOf(Int8Array);
    if (typeof TypedArray !== "function") return 1;

    if (Object.prototype.hasOwnProperty.call(TypedArray, "name") !== true) return 2;
    if (TypedArray.name !== "TypedArray") return 3;
    const nameDesc: any = Object.getOwnPropertyDescriptor(TypedArray, "name");
    if (nameDesc === undefined) return 4;
    if (nameDesc.writable !== false || nameDesc.enumerable !== false || nameDesc.configurable !== true) return 5;

    if (TypedArray.length !== 0) return 6;
    const lenDesc: any = Object.getOwnPropertyDescriptor(TypedArray, "length");
    if (lenDesc === undefined) return 7;
    if (lenDesc.writable !== false || lenDesc.enumerable !== false || lenDesc.configurable !== true) return 8;

    const protoDesc: any = Object.getOwnPropertyDescriptor(TypedArray, "prototype");
    if (protoDesc === undefined) return 9;
    if (protoDesc.value !== TypedArray.prototype) return 10;
    if (protoDesc.writable !== false || protoDesc.enumerable !== false || protoDesc.configurable !== false) return 11;

    // 23.2.2.4 -- @@species is an own accessor returning the receiver.
    const speciesDesc: any = Object.getOwnPropertyDescriptor(TypedArray, Symbol.species);
    if (speciesDesc === undefined) return 12;
    if (typeof speciesDesc.get !== "function") return 13;
    if (speciesDesc.set !== undefined) return 14;
    if (speciesDesc.enumerable !== false || speciesDesc.configurable !== true) return 15;

    // 23.2.3.5 -- the intrinsic prototype's own constructor IS the intrinsic.
    if (TypedArray.prototype.constructor !== TypedArray) return 16;

    // 23.2.3.36 -- @@iterator IS the values function object.
    if (TypedArray.prototype[Symbol.iterator] !== TypedArray.prototype.values) return 17;

    // 23.2.3.27 -- slice's declared arity is 2.
    if (TypedArray.prototype.slice.length !== 2) return 18;
    return 0;
  }
`;

const CONTROL_CASES = [
  { name: "per-kind prototype graph identity and inherited members", source: PROTO_GRAPH_SOURCE },
  { name: "prototype own-property descriptors", source: PROTO_DESCRIPTOR_SOURCE },
  { name: "%TypedArray% intrinsic own surface", source: INTRINSIC_SURFACE_SOURCE },
] as const;

describe("#5194 ES2015 standalone TypedArray r2 — prototype graph + intrinsic surface", () => {
  for (const { name, source } of CONTROL_CASES) {
    it(`standalone control: ${name}`, { timeout: CONTROL_TIMEOUT }, async () => {
      expect(await runControl(source, "standalone")).toBe(0);
    });
  }

  // The host lane keeps its genuine `__get_builtin` / host-import reads, so it
  // is asserted separately and only where the host runtime answers the same
  // spec question. It is the regression guard for "the standalone arms did not
  // leak into gc mode".
  it("host control: per-kind prototype graph identity", { timeout: CONTROL_TIMEOUT }, async () => {
    expect(await runControl(PROTO_GRAPH_SOURCE, "host")).toBe(0);
  });
});
