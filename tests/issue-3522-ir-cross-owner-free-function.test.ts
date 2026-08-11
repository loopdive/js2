// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
const ALGORITHMS_SOURCE = readFileSync(
  new URL("../website/playground/examples/js/algorithms.ts", import.meta.url),
  "utf8",
);

const CLASS_TERMINALS = [
  "Animal_new",
  "Animal_get_name",
  "Animal_set_name",
  "Animal_get_age",
  "Animal_speak",
  "Dog_new",
  "Dog_speak",
  "Dog_get_breed",
  "Animal_kingdom",
  "Dog_kingdom",
] as const;

const MAIN_CLASS_TARGETS = [
  "Dog_new",
  "Animal_get_name",
  "Animal_get_age",
  "Dog_get_breed",
  "Dog_speak",
  "Animal_set_name",
  "Animal_get_name",
  "Animal_kingdom",
  "Dog_kingdom",
] as const;

const TRACE = [
  "name  = Rex",
  "age   = 4",
  "breed = Labrador",
  "Rex makes a sound — woof!",
  "renamed: Rex Jr.",
  "rex instanceof Dog    = true",
  "rex instanceof Animal = true",
  "Animal.kingdom() = Animalia",
  "Dog.kingdom()    = Animalia (canine)",
] as const;

function standaloneTraceSource(): string {
  const checks = TRACE.map(
    (line, index) =>
      `if (traceStep === ${index} && value !== ${JSON.stringify(line)}) traceMismatch = traceMismatch + 1;`,
  ).join("\n");
  return `
    let traceStep = 0;
    let traceMismatch = 0;
    function recordTrace(value: string): void {
      ${checks}
      traceStep = traceStep + 1;
    }
    ${SOURCE.replaceAll("console.log(", "recordTrace(")}
    export function traceStatus(): number { return traceStep * 100 + traceMismatch; }
  `;
}

function outcome(result: CompileResult, unitKind: IrObservedOutcome["unitKind"], name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === unitKind && candidate.displayName === name,
  );
  expect(observed, `terminal outcome count for ${unitKind} ${name}`).toHaveLength(1);
  return observed[0]!;
}

function watFunctionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name}`);
  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

function watCallTargets(wat: string, body: string): string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => names[Number(match[1])] ?? "<missing>");
}

function staticInstanceofShapes(
  body: string,
): { readonly tags: readonly number[]; readonly equals: number; readonly unions: number }[] {
  const lines = body.split("\n").map((line) => line.trim());
  const shapes: { tags: number[]; equals: number; unions: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^struct\.get \d+ 0$/.test(lines[index]!)) continue;
    const tags: number[] = [];
    let equals = 0;
    let unions = 0;
    for (let cursor = index + 1; cursor < lines.length && !lines[cursor]!.startsWith("(if"); cursor++) {
      const tag = lines[cursor]!.match(/^i32\.const (\d+)$/);
      if (tag && lines[cursor + 1] === "i32.eq") tags.push(Number(tag[1]));
      if (lines[cursor] === "i32.eq") equals++;
      if (lines[cursor] === "i32.or") unions++;
    }
    shapes.push({ tags, equals, unions });
  }
  return shapes;
}

async function instantiate(
  result: CompileResult,
  consoleLog?: (value: unknown) => void,
): Promise<Record<string, Function>> {
  const imports = buildImports(
    result.imports,
    consoleLog ? { console: { log: consoleLog } } : undefined,
    result.stringPool,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function expectPreparedClassTerminals(result: CompileResult): readonly IrObservedOutcome[] {
  const observed: IrObservedOutcome[] = [];
  for (const name of CLASS_TERMINALS) {
    const terminal = outcome(result, "class-member", name);
    expect(terminal).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    observed.push(terminal);
  }
  return observed;
}

function expectDirectClassShape(result: CompileResult, hostHelperParity = false): void {
  const main = watFunctionBody(result.wat, "main");
  const mainTargets = watCallTargets(result.wat, main);
  expect(mainTargets.filter((name) => /^(?:Animal|Dog)_/.test(name))).toEqual(MAIN_CLASS_TARGETS);
  if (hostHelperParity) {
    expect(mainTargets.filter((name) => name === "number_toString_import")).toHaveLength(1);
    expect(mainTargets.filter((name) => name === "console_log_string_import")).toHaveLength(9);
    expect(mainTargets.filter((name) => name === "concat_import")).toHaveLength(8);
    expect(main).not.toMatch(/extern\.convert_any|any\.convert_extern/);
  }
  expect(
    watCallTargets(result.wat, watFunctionBody(result.wat, "Dog_init")).filter((name) => name.startsWith("Animal_")),
  ).toEqual(["Animal_init"]);
  expect(
    watCallTargets(result.wat, watFunctionBody(result.wat, "Dog_speak")).filter((name) => name.startsWith("Animal_")),
  ).toEqual(["Animal_speak"]);
  expect(staticInstanceofShapes(main)).toEqual([
    { tags: [1], equals: 1, unions: 0 },
    { tags: [0, 1], equals: 2, unions: 1 },
  ]);
  expect(main).not.toMatch(/(?:return_)?call_ref|call_indirect|ref\.test/);
  expect(mainTargets).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/instanceof|__extern_(?:get|set|call|new)/)]),
  );
  expect(mainTargets).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/(?:^|_)(?:box|unbox|argc|arguments)(?:_|$)/)]),
  );
  expect(main).not.toMatch(/__current_this|__argc|__arguments/);
}

describe("#3522 prepared cross-owner retirement", () => {
  it("retires the GC main body onto exact prepared Animal/Dog dependencies", async () => {
    const result = await compile(SOURCE, {
      fileName: "website/playground/examples/js/classes.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
      target: "gc",
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const classTerminals = expectPreparedClassTerminals(result);
    expectDirectClassShape(result, true);
    const logs: string[] = [];
    (await instantiate(result, (value) => logs.push(String(value)))).main!();
    expect(logs).toEqual(TRACE);
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    // This assertion was the red checkpoint before the combined transaction:
    // main used to emit a legacy body and had no prepared component ID.
    const main = outcome(result, "function", "main");
    expect(main).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    for (const terminal of classTerminals) {
      expect(terminal.preparedComponentId, `${terminal.displayName} must be sealed with main`).toBe(
        main.preparedComponentId,
      );
    }
  });

  it("keeps standalone as an explicit unsupported-console parity control", async () => {
    const result = await compile(SOURCE, {
      fileName: "website/playground/examples/js/classes.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
      target: "standalone",
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expectPreparedClassTerminals(result);
    expectDirectClassShape(result);
    // Standalone deliberately has no host console import to capture. Run the
    // unchanged main for its boundary outcome, then use a direct-legacy behavior
    // control whose in-Wasm sink checks the same expressions and exact strings.
    const exports = await instantiate(result);
    expect(() => exports.main!()).not.toThrow();
    expect(outcome(result, "function", "main")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "body-shape-rejected",
      detail: "main rejected by IR selection (body-shape-rejected)",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "function", "main")).not.toHaveProperty("preparedComponentId");

    const traced = await compile(standaloneTraceSource(), {
      fileName: "website/playground/examples/js/classes-standalone-trace.ts",
      experimentalIR: true,
      target: "standalone",
    });
    expect(traced.success, traced.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(traced.binary)).toBe(true);
    const tracedExports = await instantiate(traced);
    tracedExports.main!();
    expect(tracedExports.traceStatus!()).toBe(900);
  });

  it.each(["gc", "standalone"] as const)(
    "prepares a class method across a free-function boundary without a legacy body in %s",
    async (target) => {
      const source = `
      function increment(value: number): number { return value + 1; }
      class Counter {
        value: number;
        constructor(value: number) { this.value = value; }
        next(): number { return increment(this.value); }
      }
      export function run(): number { return new Counter(4).next(); }
    `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let result: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Counter_next";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "increment,run";
        result = await compile(source, {
          fileName: `cross-owner-class-to-free-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
      } finally {
        if (previousClassPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClassPoison;
        }
        if (previousFunctionPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunctionPoison;
        }
      }

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const terminals = [
        outcome(result, "function", "increment"),
        outcome(result, "class-member", "Counter_new"),
        outcome(result, "class-member", "Counter_next"),
        outcome(result, "function", "run"),
      ];
      for (const terminal of terminals) {
        expect(terminal).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      for (const terminal of terminals.slice(1)) {
        expect(terminal.preparedComponentId).toBe(terminals[1]!.preparedComponentId);
      }
      const nextBody = watFunctionBody(result.wat, "Counter_next");
      // Preserve the existing inline-small optimization: after inlining, the
      // callee has no final dependency edge and may seal independently.
      expect(watCallTargets(result.wat, nextBody)).toEqual([]);
      expect(nextBody).toMatch(/f64\.const 1\s+f64\.add/);
      expect(nextBody).not.toMatch(/(?:return_)?call_ref|call_indirect/);
      expect((await instantiate(result)).run!()).toBe(5);
    },
  );

  it("keeps a selector-rejected class dependency and its free owner on the direct route", async () => {
    const source = `
      class UnsupportedConstructor {
        value: number;
        constructor(value: number = 7) { this.value = value; }
      }
      export function independent(): number { return 42; }
      export function readUnsupported(): number { return new UnsupportedConstructor().value; }
    `;
    const result = await compile(source, {
      fileName: "cross-owner-unsupported-control.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
      target: "gc",
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(outcome(result, "function", "independent")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(outcome(result, "class-member", "UnsupportedConstructor_new")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "class-projection-unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "function", "readUnsupported")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "class-projection-unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    const exports = await instantiate(result);
    expect(exports.independent!()).toBe(42);
    expect(exports.readUnsupported!()).toBe(7);

    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "UnsupportedConstructor_new";
      const poisoned = await compile(source, {
        fileName: "cross-owner-unsupported-control.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target: "gc",
      });
      expect(poisoned.success).toBe(false);
      expect(
        poisoned.errors.some((error) =>
          error.message.includes("injected direct class-body poison: UnsupportedConstructor_new"),
        ),
      ).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });

  it("does not publish a mutable class layout for a component already blocked on dynamic super access", async () => {
    const source = `
      class Parent {
        greet(): string { return "hello"; }
      }
      class Child extends Parent {
        greet(): string { return super["greet"]() + " world"; }
      }
      export function test(): string {
        const child = new Child();
        return child.greet();
      }
    `;
    const options = {
      fileName: "peeled-class-layout-control.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
      target: "gc" as const,
    };
    const result = await compile(source, options);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(outcome(result, "class-member", "Parent_greet")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(outcome(result, "class-member", "Child_greet")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "body-shape-rejected",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "function", "test")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect((await instantiate(result)).test!()).toBe("hello world");

    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Child_greet";
      const poisoned = await compile(source, options);
      expect(poisoned.success).toBe(false);
      expect(
        poisoned.errors.some((error) => error.message.includes("injected direct class-body poison: Child_greet")),
      ).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });

  it("keeps the retired Algorithms component free of legacy bodies", async () => {
    const result = await compile(ALGORITHMS_SOURCE, {
      fileName: "website/playground/examples/js/algorithms.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
      target: "gc",
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(outcome(result, "function", "fibIter")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(
      (result.irOutcomes ?? [])
        .filter((candidate) => candidate.legacyBodyEmitted)
        .map((candidate) => `${candidate.unitKind}:${candidate.displayName}`),
    ).toEqual([]);

    const fibIter = watFunctionBody(result.wat, "fibIter");
    expect(fibIter.match(/\(loop/g) ?? []).toHaveLength(1);
    expect(fibIter).toMatch(/\(local \$\$slot_a f64\)/);
    expect(fibIter).toMatch(/\(local \$\$slot_b f64\)/);
    expect(fibIter).toMatch(/\(local \$\$slot_i i32\)/);
    expect(fibIter).not.toMatch(
      /\b(?:return_)?call\b|extern\.convert_any|any\.convert_extern|(?:^|_)(?:box|unbox)(?:_|$)/,
    );

    const logs: string[] = [];
    (await instantiate(result, (value) => logs.push(String(value)))).main!();
    expect(logs).toEqual([
      "── Fibonacci ──",
      "fib(0) iter=0 memo=0",
      "fib(1) iter=1 memo=1",
      "fib(2) iter=1 memo=1",
      "fib(3) iter=2 memo=2",
      "fib(4) iter=3 memo=3",
      "fib(5) iter=5 memo=5",
      "fib(6) iter=8 memo=8",
      "fib(7) iter=13 memo=13",
      "fib(8) iter=21 memo=21",
      "fib(9) iter=34 memo=34",
      "fib(30) iter = 832040",
      "── Binary search ──",
      "sorted = [1,3,5,8,13,21,34,55,89,144]",
      "indexOf(13) = 4",
      "indexOf(34) = 6",
      "indexOf(7)  = -1",
      "── Quicksort ──",
      "before = [5,2,8,1,9,3,7,4,6,0]",
      "after  = [0,1,2,3,4,5,6,7,8,9]",
    ]);
  });
});
