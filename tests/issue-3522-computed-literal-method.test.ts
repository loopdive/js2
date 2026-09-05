// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { literalComputedInstanceMethodKey } from "../src/ir/class-method-names.js";
import { ts } from "../src/ts-api.js";

const TARGETS = ["gc", "standalone"] as const;
type Target = (typeof TARGETS)[number];

const POSITIVE = `class Tagged {
  constructor() {}
  ["tagged"](n: number): number { return n + 2; }
  ["other"](n: number): number { return n + 7; }
}
export function run(): number {
  const value = new Tagged();
  return value.tagged(3) * 10 + value.other(4);
}
`;

// This is the exact literal computed-method case that used to be a #3529
// selector pre-claim refusal.
const SINGLE_LITERAL = `class Greeter { ["value"](): number { return 42; } }
export function test(): number { const greeter = new Greeter(); return greeter.value(); }
`;

const DYNAMIC_KEY = `const key = "tagged";
class Tagged { [key](n: number): number { return n + 2; } }
export function run(): number { return new Tagged().tagged(3); }
`;

const EFFECTFUL_KEY = `function key(): string { return "tagged"; }
class Tagged { [key()](n: number): number { return n + 2; } }
export function run(): number { return new Tagged().tagged(3); }
`;

const UNSUPPORTED_SIGNATURE = `class Tagged { ["tagged"](n: any): any { return n; } }
export function run(): number { return new Tagged().tagged(3); }
`;

const MIXED_WITH_DYNAMIC = `const key = "tagged";
class Tagged {
  plain(n: number): number { return n + 1; }
  [key](n: number): number { return n + 2; }
}
export function run(): number { return new Tagged().plain(3) + new Tagged().tagged(3); }
`;

function outcome(result: CompileResult, displayName: string): IrObservedOutcome {
  const matches = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName === displayName);
  expect(matches, `terminal outcome count for ${displayName}`).toHaveLength(1);
  return matches[0]!;
}

function expectIrOwned(result: CompileResult, names: readonly string[]): void {
  for (const name of names) {
    expect(outcome(result, name), `${name} must be prepared IR`).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? [], `${name} must carry genuine IR emission`).toContain(name);
  }
}

function expectRefused(result: CompileResult, name: string): void {
  expect(outcome(result, name)).toMatchObject({
    kind: "unsupported",
    irBodyEmitted: false,
  });
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  return instance.exports as Record<string, Function>;
}

async function compilePoisoned(
  source: string,
  fileName: string,
  target: Target,
  classBodies: readonly string[],
): Promise<CompileResult> {
  const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
  try {
    process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = classBodies.join(",");
    return await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
    else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
  }
}

function sourceClassMethods(source: string): readonly ts.MethodDeclaration[] {
  const file = ts.createSourceFile("computed-method-helper.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(ts.isClassDeclaration);
  expect(declaration).toBeDefined();
  return declaration!.members.filter(ts.isMethodDeclaration);
}

describe("#3522 W1-D literal computed instance-method names", () => {
  it.each(TARGETS)("owns both decoded methods and the caller through IR on %s", async (target) => {
    const result = await compilePoisoned(POSITIVE, `w1d-positive-${target}.ts`, target, [
      "Tagged_tagged",
      "Tagged_other",
    ]);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Tagged_tagged", "Tagged_other", "run"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const methods = (result.irOutcomes ?? []).filter((entry) => entry.unitKind === "class-member");
    expect(
      methods.filter((entry) => entry.displayName.startsWith("Tagged_")).map((entry) => entry.displayName),
    ).toEqual(["Tagged_new", "Tagged_tagged", "Tagged_other"]);
    const named = methods.filter(
      (entry) => entry.displayName === "Tagged_tagged" || entry.displayName === "Tagged_other",
    );
    expect(new Set(named.map((entry) => entry.unitId)).size).toBe(2);
    expect((result.irOutcomes ?? []).some((entry) => entry.displayName === "Tagged_<computed>")).toBe(false);
    expect((await instantiate(result)).run!()).toBe(61);
  });

  it.each(TARGETS)("moves the former #3529 literal case to positive ownership on %s", async (target) => {
    const result = await compilePoisoned(SINGLE_LITERAL, `w1d-single-${target}.ts`, target, ["Greeter_value"]);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Greeter_value", "test"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiate(result)).test!()).toBe(42);
  });

  it.each(TARGETS)("matches the unpoisoned direct baseline on %s", async (target) => {
    const result = await compile(POSITIVE, {
      fileName: `w1d-direct-baseline-${target}.ts`,
      experimentalIR: false,
      emitWat: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(61);
  });

  it("decodes only direct string-literal names and rejects unsupported sibling shapes", () => {
    expect(sourceClassMethods(POSITIVE).map(literalComputedInstanceMethodKey)).toEqual(["tagged", "other"]);
    expect(
      sourceClassMethods(`class Tagged { ["ta" + "gged"](): number { return 1; } }`).map(
        literalComputedInstanceMethodKey,
      ),
    ).toEqual([undefined]);
    expect(
      sourceClassMethods(`const key = "tagged"; class Tagged { [key](): number { return 1; } }`).map(
        literalComputedInstanceMethodKey,
      ),
    ).toEqual([undefined]);
    expect(
      sourceClassMethods(`class Tagged { ["tagged"](): number { return 1; } ["tagged"](): number { return 2; } }`).map(
        literalComputedInstanceMethodKey,
      ),
    ).toEqual([undefined, undefined]);
    expect(
      sourceClassMethods(`class Tagged { ["init"](): number { return 1; } }`).map(literalComputedInstanceMethodKey),
    ).toEqual([undefined]);
    expect(
      sourceClassMethods(`class Tagged { [1](): number { return 1; } }`).map(literalComputedInstanceMethodKey),
    ).toEqual([undefined]);
    expect(
      sourceClassMethods("class Tagged { [`tagged`](): number { return 1; } }").map(literalComputedInstanceMethodKey),
    ).toEqual([undefined]);
    expect(
      sourceClassMethods(`class Tagged { static ["tagged"](): number { return 1; } }`).map(
        literalComputedInstanceMethodKey,
      ),
    ).toEqual([undefined]);
    expect(
      sourceClassMethods(`class Tagged { #private(): number { return 1; } ["tagged"](): number { return 2; } }`).map(
        literalComputedInstanceMethodKey,
      ),
    ).toEqual([undefined, undefined]);
    expect(
      sourceClassMethods(`class Tagged { value: number = 1; ["tagged"](): number { return 2; } }`).map(
        literalComputedInstanceMethodKey,
      ),
    ).toEqual([undefined]);
    expect(
      sourceClassMethods(`class Tagged extends Base { ["tagged"](): number { return 1; } }`).map(
        literalComputedInstanceMethodKey,
      ),
    ).toEqual([undefined]);
    expect(
      sourceClassMethods(`class Tagged { ["tagged"](n: any): number { return 1; } }`).map(
        literalComputedInstanceMethodKey,
      ),
    ).toEqual([undefined]);
  });

  it.each(TARGETS)("keeps aliases and effectful keys on the legacy route on %s", async (target) => {
    for (const [source, label] of [
      [DYNAMIC_KEY, "alias"],
      [EFFECTFUL_KEY, "effectful"],
      [UNSUPPORTED_SIGNATURE, "signature"],
    ] as const) {
      const result = await compile(source, {
        fileName: `w1d-negative-${label}-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        ...(target === "standalone" ? { target: "standalone" as const } : {}),
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expectRefused(result, "Tagged_<computed>");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    }
  });

  it.each(TARGETS)("does not cascade a refused computed member into an ordinary method on %s", async (target) => {
    const result = await compile(MIXED_WITH_DYNAMIC, {
      fileName: `w1d-mixed-${target}.ts`,
      experimentalIR: true,
      trackIrOutcomes: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expectIrOwned(result, ["Tagged_plain"]);
    expectRefused(result, "Tagged_<computed>");
    expect((await instantiate(result)).run!()).toBe(9);
  });

  it.each(TARGETS)("keeps the direct body poison seam live on %s", async (target) => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Tagged_tagged";
      const result = await compile(POSITIVE, {
        fileName: `w1d-direct-${target}.ts`,
        experimentalIR: false,
        trackIrOutcomes: true,
        ...(target === "standalone" ? { target: "standalone" as const } : {}),
      });
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toContain(
        "injected direct class-body poison: Tagged_tagged",
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });
});
