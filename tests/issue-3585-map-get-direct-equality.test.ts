// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3585 — an oracle-classified Map.get result is stored as anyref. In direct equality
// position it must be normalized through the native equality semantics rather
// than dropped by the typed-dispatch fallback.  Each case compiles and runs a
// standalone Wasm module; these are not compiler-shape-only assertions.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type StandaloneModule = {
  exports: Record<string, unknown>;
  functionImports: string[];
  wat: string;
};

async function compileStandalone(source: string, fileName: string): Promise<StandaloneModule> {
  const result: any = await compile(source, {
    emitWat: true,
    fileName,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error: { message: string }) => error.message).join("\n")).toBe(true);
  if (!WebAssembly.validate(result.binary)) {
    try {
      await WebAssembly.compile(result.binary);
    } catch (error) {
      throw new Error(`invalid standalone Wasm for ${fileName}: ${String(error)}`);
    }
    throw new Error(`WebAssembly.validate rejected ${fileName} but WebAssembly.compile accepted it`);
  }

  const module = await WebAssembly.compile(result.binary);
  const functionImports = WebAssembly.Module.imports(module)
    .filter((entry) => entry.kind === "function")
    .map((entry) => `${entry.module}.${entry.name}`);
  expect(functionImports).toEqual([]);

  const instance = await WebAssembly.instantiate(module, {});
  return { exports: instance.exports as Record<string, unknown>, functionImports, wat: result.wat };
}

function watFunctionBody(wat: string, name: string): string {
  const functions = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    index: match.index!,
    name: match[1]!,
  }));
  const index = functions.findIndex((entry) => entry.name === name);
  expect(index, `WAT function $${name}`).toBeGreaterThanOrEqual(0);
  return wat.slice(functions[index]!.index, functions[index + 1]?.index ?? wat.length);
}

type WatCallTarget = {
  index: number;
  name: string;
  signature: string;
};

function watCallTargets(wat: string, body: string, functionImports: readonly string[]): WatCallTarget[] {
  // The standalone assertion above has already rejected imports. Preserve that
  // invariant here so a numeric WAT call index is mapped to the definition at
  // exactly the same position rather than guessed from a display name.
  expect(functionImports).toEqual([]);
  const definitions = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)(.*)$/gm)].map((match, index) => ({
    index,
    name: match[1]!,
    signature: match[2]!.trim(),
  }));
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const index = Number(match[1]);
    const target = definitions[index];
    if (!target) throw new Error(`WAT call ${index} has no exact callable target`);
    return target;
  });
}

function expectNativeEqualityHelper(targets: readonly WatCallTarget[], name: string): void {
  // WAT permits repeated display names elsewhere in a module. The numerical
  // call index chooses the actual declaration; requiring one target index plus
  // its emitted type reference avoids the former first-name/duplicate ambiguity.
  const matching = targets.filter((target) => target.name === name);
  const indexes = [...new Set(matching.map((target) => target.index))];
  expect(indexes, `numeric WAT target for ${name}`).toHaveLength(1);
  const target = matching[0]!;
  expect(target.signature, `WAT signature for ${name}`).toMatch(/\(type \d+\)|\(param\b/);
}

const directNumericSource = `
  export function directNumeric(): number {
    const a: any = { v: 1 };
    const arr: any[] = [a];
    const m = new Map<any, number>();
    m.set(a, 7);
    let code = 0;
    if (m.get(a) == 7) code += 1;
    if (m.get(a) === 7) code += 2;
    const g = m.get(a);
    if (g == 7) code += 10;
    if (g === 7) code += 20;
    if (arr.length === 1) code += 100;
    return code;
  }
`;

const moduleCompositionSource = `
  export function moduleComposition(): number {
    const a: any = { v: 1 };
    const m = new Map<any, number>();
    m.set(a, 7);
    const m2 = new Map<object, number>();
    const plain = { v: 2 };
    m2.set(plain, 3);
    const g = m2.get(plain);
    let code = 0;
    if (g === 3) code += 1;
    if (m2.get(plain) === 3) code += 10;
    if (m2.get(plain) == 3) code += 100;
    return code;
  }
`;

const directStringSource = `
  export function directString(): number {
    const m = new Map<number, string>();
    m.set(1, "valid");
    const local = m.get(1);
    let code = 0;
    if (m.get(1) === "valid") code += 1;
    if (m.get(1) !== "valid") code += 2;
    if (local === "valid") code += 4;
    if (local !== "valid") code += 8;
    return code;
  }
`;

const identityAndNullishSource = `
  export function directObjectIdentity(): number {
    const key = { key: 1 };
    const value = { value: 1 };
    const other = { value: 2 };
    const m = new Map<object, object>();
    m.set(key, value);
    const local = m.get(key);
    let code = 0;
    if (m.get(key) === value) code += 1;
    if (m.get(key) !== other) code += 2;
    if (local === value) code += 4;
    if (local !== other) code += 8;
    return code;
  }

  export function nullishAndTypeMismatch(): number {
    const m = new Map<number, number>();
    let code = 0;
    if (m.get(1) == null) code += 1;
    if (m.get(1) !== 7) code += 2;
    return code;
  }
`;

const mixedSeedStringAndNullishSource = `
  export function mixedSeedStringAndNullish(): number {
    const m = new Map();
    m.set(0, 7);
    m.set(1, "valid");
    let code = 0;
    if (m.get(1) == "valid") code += 1;
    if ("valid" == m.get(1)) code += 2;
    if (m.get(1) === "valid") code += 4;
    if ("valid" === m.get(1)) code += 8;
    if (m.get(2) === undefined) code += 16;
    if (m.get(2) !== null) code += 32;
    m.set(3, undefined);
    if (m.get(3) === undefined) code += 64;
    if (m.get(3) !== null) code += 128;
    m.set(4, null);
    if (m.get(4) === null) code += 256;
    if (m.get(4) !== undefined) code += 512;
    return code;
  }
`;

const objectBothOrdersSource = `
  export function directObjectBothOrders(): number {
    const key = { key: 1 };
    const value = { value: 1 };
    const other = { value: 2 };
    const m = new Map<object, object>();
    m.set(key, value);
    let code = 0;
    if (m.get(key) === value) code += 1;
    if (value === m.get(key)) code += 2;
    if (m.get(key) !== other) code += 4;
    if (other !== m.get(key)) code += 8;
    return code;
  }
`;

const mixedSeedStringSource = `
  export function mixedSeedStringBothOrders(): number {
    const m = new Map();
    m.set(0, 7);
    m.set(1, "valid");
    let code = 0;
    if (m.get(1) == "valid") code += 1;
    if ("valid" == m.get(1)) code += 2;
    if (m.get(1) === "valid") code += 4;
    if ("valid" === m.get(1)) code += 8;
    return code;
  }
`;

const nullishMapResultsSource = `
  export function nullishMapResults(): number {
    const m = new Map<number, any>();
    m.set(3, undefined);
    m.set(4, null);
    let code = 0;
    if (m.get(2) === undefined) code += 1;
    if (m.get(2) !== null) code += 2;
    if (m.get(3) === undefined) code += 4;
    if (m.get(3) !== null) code += 8;
    if (m.get(4) === null) code += 16;
    if (m.get(4) !== undefined) code += 32;
    return code;
  }
`;

const aliasedMapGetSource = `
  export function aliasedMapGet(): number {
    const m = new Map();
    m.set(0, 7);
    m.set(1, "valid");
    const alias = m;
    let code = 0;
    if (alias.get(1) === "valid") code += 1;
    if ("valid" === alias.get(1)) code += 2;
    return code;
  }
`;

const userDeclaredMapSource = `
  class Map {
    value: string = "";

    set(_key: number, value: string): Map {
      this.value = value;
      return this;
    }

    get(_key: number): string {
      return this.value;
    }
  }

  export function userDeclaredMapGet(): number {
    const m = new Map();
    m.set(1, "valid");
    return m.get(1) === "valid" ? 1 : 0;
  }
`;

describe("#3585 standalone Map.get direct equality", () => {
  it("keeps the original any-keyed numeric direct-vs-local program coherent", async () => {
    const { exports } = await compileStandalone(directNumericSource, "issue-3585-direct-numeric.ts");
    expect((exports.directNumeric as () => number)()).toBe(133);
  });

  it("does not let an any-keyed Map poison direct equality for a typed Map", async () => {
    const { exports } = await compileStandalone(moduleCompositionSource, "issue-3585-module-composition.ts");
    expect((exports.moduleComposition as () => number)()).toBe(111);
  });

  it("compares a direct native-string result by value without the drop/constant fallback", async () => {
    const compiled = await compileStandalone(directStringSource, "issue-3585-direct-string.ts");
    expect((compiled.exports.directString as () => number)()).toBe(5);
    const body = watFunctionBody(compiled.wat, "directString");
    expect(body).not.toMatch(/\bdrop\b[\s\S]{0,160}\bdrop\b[\s\S]{0,160}\bi32\.const\s+[01]\b/);
  });

  it("preserves object identity and nullish/type-mismatch controls", async () => {
    const { exports } = await compileStandalone(identityAndNullishSource, "issue-3585-identity-nullish.ts");
    expect((exports.directObjectIdentity as () => number)()).toBe(15);
    expect((exports.nullishAndTypeMismatch as () => number)()).toBe(3);
  });

  it("normalizes mixed unannotated Map results for direct string and nullish equality in both orders", async () => {
    const compiled = await compileStandalone(mixedSeedStringAndNullishSource, "issue-3585-mixed-string-nullish.ts");
    expect((compiled.exports.mixedSeedStringAndNullish as () => number)()).toBe(1023);
    const targets = watCallTargets(
      compiled.wat,
      watFunctionBody(compiled.wat, "mixedSeedStringAndNullish"),
      compiled.functionImports,
    );
    expectNativeEqualityHelper(targets, "__extern_loose_eq"); // (#7194) the one loose-equality provider
    expectNativeEqualityHelper(targets, "__extern_strict_eq");
  });

  it("normalizes an unannotated mixed-seed Map for direct string equality in both orders", async () => {
    const compiled = await compileStandalone(mixedSeedStringSource, "issue-3585-mixed-string.ts");
    expect((compiled.exports.mixedSeedStringBothOrders as () => number)()).toBe(15);
    const targets = watCallTargets(
      compiled.wat,
      watFunctionBody(compiled.wat, "mixedSeedStringBothOrders"),
      compiled.functionImports,
    );
    expectNativeEqualityHelper(targets, "__extern_loose_eq"); // (#7194)
    expectNativeEqualityHelper(targets, "__extern_strict_eq");
  });

  it("distinguishes an absent result from explicitly stored undefined and null", async () => {
    const { exports } = await compileStandalone(nullishMapResultsSource, "issue-3585-nullish-map-results.ts");
    expect((exports.nullishMapResults as () => number)()).toBe(63);
  });

  it("preserves direct Map object equality and inequality when the operands are reversed", async () => {
    const { exports } = await compileStandalone(objectBothOrdersSource, "issue-3585-object-both-orders.ts");
    expect((exports.directObjectBothOrders as () => number)()).toBe(15);
  });

  it("retains the direct mixed-Map equality path through a const alias", async () => {
    const compiled = await compileStandalone(aliasedMapGetSource, "issue-3585-aliased-map.ts");
    expect((compiled.exports.aliasedMapGet as () => number)()).toBe(3);
    const targets = watCallTargets(
      compiled.wat,
      watFunctionBody(compiled.wat, "aliasedMapGet"),
      compiled.functionImports,
    );
    expectNativeEqualityHelper(targets, "__extern_strict_eq");
  });

  it("leaves a user-declared Map.get on its ordinary class path", async () => {
    const compiled = await compileStandalone(userDeclaredMapSource, "issue-3585-user-declared-map.ts");
    expect((compiled.exports.userDeclaredMapGet as () => number)()).toBe(1);
    expect(compiled.wat).not.toMatch(/\(func \$__map_get\b/);
  });
});

// Additional controls for the direct native Map.get literal-nullish boundary.
// Keep the original ten registrations above byte-exact. These use shipped
// standalone defaults; no singleton, IR-route, validation or provider override.
const directNullishBoundarySource = `
  export function nullishMatrix(key: number): number {
    const m = new Map<number, any>();
    m.set(0, undefined);
    m.set(1, null);
    m.set(2, 0);
    m.set(3, false);
    m.set(4, "value");
    m.set(5, { value: 1 });
    m.set(6, () => 7);
    let code = 0;
    if (m.get(key) === undefined) code += 1;
    if (undefined === m.get(key)) code += 2;
    if (m.get(key) !== undefined) code += 4;
    if (undefined !== m.get(key)) code += 8;
    if (m.get(key) == undefined) code += 16;
    if (undefined == m.get(key)) code += 32;
    if (m.get(key) != undefined) code += 64;
    if (undefined != m.get(key)) code += 128;
    if (m.get(key) === null) code += 256;
    if (null === m.get(key)) code += 512;
    if (m.get(key) !== null) code += 1024;
    if (null !== m.get(key)) code += 2048;
    if (m.get(key) == null) code += 4096;
    if (null == m.get(key)) code += 8192;
    if (m.get(key) != null) code += 16384;
    if (null != m.get(key)) code += 32768;
    return code;
  }
`;

const singleMapObservationSource = `
  let trace = 0;
  function observedReceiver(m: Map<number, any>): Map<number, any> {
    trace = trace * 10 + 1;
    return m;
  }
  function observedKey(): number {
    trace = trace * 10 + 2;
    return 0;
  }
  export function observationOrder(): number {
    trace = 0;
    const m = new Map<number, any>();
    m.set(0, undefined);
    let code = 0;
    if (observedReceiver(m).get(observedKey()) === undefined) code += 1;
    if (undefined == observedReceiver(m).get(observedKey())) code += 2;
    if (observedReceiver(m).get(observedKey()) !== null) code += 4;
    if (null != observedReceiver(m).get(observedKey())) code += 8;
    return trace * 16 + code;
  }
`;

const shadowedUndefinedMapSource = `
  export function shadowedUndefined(undefined: number): number {
    const m = new Map<number, any>();
    m.set(0, null);
    let code = 0;
    if (m.get(0) == undefined) code += 1;
    if (undefined == m.get(0)) code += 2;
    return code;
  }
`;

const effectfulVoidMapSource = `
  let effects = 0;
  function touch(): number {
    effects += 1;
    return 99;
  }
  export function effectfulVoid(): number {
    effects = 0;
    const m = new Map<number, any>();
    m.set(0, undefined);
    m.set(1, null);
    let code = 0;
    if (m.get(0) === void touch()) code += 1;
    if (void touch() !== m.get(1)) code += 2;
    return effects * 10 + code;
  }
`;

const userMapNullishSource = `
  class Map {
    get(_key: number): any { return null; }
  }
  export function userMapNullish(): number {
    const m = new Map();
    let code = 0;
    if (m.get(0) === null) code += 1;
    if (null === m.get(0)) code += 2;
    if (m.get(0) !== undefined) code += 4;
    if (undefined == m.get(0)) code += 8;
    return code;
  }
`;

describe("#3585 direct Map.get literal-nullish regression controls", () => {
  it("compares absent, stored nullish and nonnull values with all four operators in both orders", async () => {
    const { exports } = await compileStandalone(directNullishBoundarySource, "issue-3585-nullish-boundary.ts");
    const run = exports.nullishMatrix as (key: number) => number;
    // Each nibble records an actual JS equality/inequality result, not a
    // compiler implementation branch. Missing key 7 and stored undefined 0
    // agree; stored null 1 differs for strict comparison only.
    for (const [key, expected] of [
      [0, 15411],
      [1, 13116],
      [2, 52428],
      [3, 52428],
      [4, 52428],
      [5, 52428],
      [6, 52428],
      [7, 15411],
    ] as const) {
      expect(run(key), `Map value at key ${key}`).toBe(expected);
    }
  });

  it("evaluates each receiver and key once in source order for either literal side", async () => {
    const { exports } = await compileStandalone(singleMapObservationSource, "issue-3585-nullish-observation-order.ts");
    // Four receiver/key pairs produce trace 12121212. The true comparison
    // bits are 1+2+4; undefined != null contributes no bit.
    expect((exports.observationOrder as () => number)()).toBe(193939399);
  });

  it("does not treat a shadowed undefined parameter as the undefined literal", async () => {
    const { exports } = await compileStandalone(shadowedUndefinedMapSource, "issue-3585-shadowed-undefined.ts");
    expect((exports.shadowedUndefined as (value: number) => number)(7)).toBe(0);
  });

  it("evaluates effectful void operands on their ordinary expression route", async () => {
    const { exports } = await compileStandalone(effectfulVoidMapSource, "issue-3585-effectful-void.ts");
    expect((exports.effectfulVoid as () => number)()).toBe(23);
  });

  it("keeps user-declared Map nullish results on the ordinary class route", async () => {
    const compiled = await compileStandalone(userMapNullishSource, "issue-3585-user-map-nullish.ts");
    expect((compiled.exports.userMapNullish as () => number)()).toBe(15);
    expect(compiled.wat).not.toMatch(/\(func \$__map_get\b/);
  });
});
