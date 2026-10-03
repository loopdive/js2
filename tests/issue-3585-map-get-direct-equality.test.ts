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
    expectNativeEqualityHelper(targets, "__any_eq");
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
    expectNativeEqualityHelper(targets, "__any_eq");
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
