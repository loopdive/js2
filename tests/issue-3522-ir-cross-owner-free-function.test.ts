// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) TWO tuned flags interfere here, and they interfere differently:
//
//  - `JS2WASM_IR_INLINE` removes call EDGES, so the "prepared exactly these
//    owners" lists come back short (`[] ` vs `['Base_init']`). The preparation
//    happened; the caller no longer calls it.
//  - `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR` removes the very `ref.is_null …
//    throw` guard three assertions use as their marker for "the forwarding
//    chain went through the prepared owner". A provably non-null receiver has
//    no guard to find — the elision is correct and the marker is gone.
//
// Both are shape proxies for an IR-preparation property, so both are pinned.
pinPerfFlags({ JS2WASM_IR_INLINE: "0", JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR: "0" });
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

function canonicalWatFunctionBody(wat: string, name: string): string {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return watFunctionBody(wat, name)
    .replace(/\(type \d+\)/g, "(type <canonical>)")
    .replace(/\b(return_)?call (\d+)/g, (_match, tail: string | undefined, index: string) => {
      const target = names[Number(index)] ?? "<missing>";
      return `${tail ?? ""}call $${target}`;
    });
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

  it.each(["gc", "standalone"] as const)(
    "prepares a plain implicit constructor before sealing its caller in %s",
    async (target) => {
      const source = `
        function increment(value: number): number { return value + 1; }
        class Box { value(): number { return increment(41); } }
        export function run(): number { return new Box().value(); }
      `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let result: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "increment,run";
        result = await compile(source, {
          fileName: `plain-implicit-constructor-${target}.ts`,
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
        outcome(result, "class-member", "Box_value"),
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
      expect(
        (result.irOutcomes ?? [])
          .filter((candidate) => candidate.legacyBodyEmitted)
          .map((candidate) => `${candidate.unitKind}:${candidate.displayName}`),
      ).toEqual([]);

      const boxNew = watFunctionBody(result.wat, "Box_new");
      const boxInit = watFunctionBody(result.wat, "Box_init");
      const boxValue = watFunctionBody(result.wat, "Box_value");
      const run = watFunctionBody(result.wat, "run");
      expect(boxNew).toMatch(/struct\.new/);
      expect(watCallTargets(result.wat, boxNew)).toEqual(["Box_init"]);
      expect(boxInit).toMatch(/local\.get 0/);
      expect(watCallTargets(result.wat, boxInit)).toEqual([]);
      expect(boxValue).toMatch(/f64\.const 42/);
      expect(watCallTargets(result.wat, run)).toEqual(["Box_new", "Box_value"]);
      for (const body of [boxNew, boxInit, boxValue, run]) {
        expect(body).not.toMatch(
          /__current_this|(?:return_)?call_ref|call_indirect|any\.convert_extern|extern\.convert_any|(?:^|_)(?:box|unbox)(?:_|$)/,
        );
      }
      expect((await instantiate(result)).run!()).toBe(42);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares an implicit local-user derived forwarding chain in %s",
    async (target) => {
      const source = `
        class Base {
          value: number;
          constructor(value: number) { this.value = value; }
        }
        class Mid extends Base {}
        class Leaf extends Mid {}
        export function run(): number { return new Leaf(7).value; }
      `;
      const fileName = `implicit-derived-chain-${target}.ts`;
      const direct = await compile(source, {
        fileName,
        experimentalIR: false,
        emitWat: true,
        target,
      });
      expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(direct.binary)).toBe(true);
      expect((await instantiate(direct)).run!()).toBe(7);

      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Base_new,Mid_new,Leaf_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        prepared = await compile(source, {
          fileName,
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

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expect((await instantiate(prepared)).run!()).toBe(7);
      for (const terminal of [outcome(prepared, "class-member", "Base_new"), outcome(prepared, "function", "run")]) {
        expect(terminal).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect((prepared.irOutcomes ?? []).filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toEqual([]);
      expect(prepared.binary.length).toBeLessThanOrEqual(direct.binary.length);

      expect(watCallTargets(prepared.wat, watFunctionBody(prepared.wat, "Mid_new"))).toEqual(["Mid_init"]);
      expect(watCallTargets(prepared.wat, watFunctionBody(prepared.wat, "Mid_init"))).toEqual(["Base_init"]);
      expect(watCallTargets(prepared.wat, watFunctionBody(prepared.wat, "Leaf_new"))).toEqual(["Leaf_init"]);
      expect(watCallTargets(prepared.wat, watFunctionBody(prepared.wat, "Leaf_init"))).toEqual(["Mid_init"]);
      for (const name of ["Mid_new", "Mid_init", "Leaf_new", "Leaf_init"] as const) {
        expect(canonicalWatFunctionBody(prepared.wat, name)).toBe(canonicalWatFunctionBody(direct.wat, name));
      }
      const preparedRun = watFunctionBody(prepared.wat, "run");
      const directRun = watFunctionBody(direct.wat, "run");
      expect(watCallTargets(prepared.wat, preparedRun)).toEqual(["Leaf_new"]);
      expect(preparedRun).toMatch(/call \d+[\s\S]*struct\.get/);
      expect(preparedRun).not.toMatch(/ref\.is_null|throw|local\.(?:get|set|tee)/);
      expect(directRun).toMatch(/ref\.is_null[\s\S]*throw/);
      expect(preparedRun.split("\n").length).toBeLessThan(directRun.split("\n").length);
      for (const body of [
        watFunctionBody(prepared.wat, "Mid_new"),
        watFunctionBody(prepared.wat, "Mid_init"),
        watFunctionBody(prepared.wat, "Leaf_new"),
        watFunctionBody(prepared.wat, "Leaf_init"),
      ]) {
        expect(body).not.toMatch(
          /__current_this|(?:return_)?call_ref|call_indirect|any\.convert_extern|extern\.convert_any|(?:^|_)(?:box|unbox)(?:_|$)/,
        );
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares a plain implicit constructor with zero-initialized declared fields in %s",
    async (target) => {
      const source = `
        class Box { value: number; }
        export function run(): number { return new Box().value; }
      `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let result: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        result = await compile(source, {
          fileName: `implicit-declared-field-${target}.ts`,
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
      expect((await instantiate(result)).run!()).toBe(0);
      expect(outcome(result, "function", "run")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect((result.irOutcomes ?? []).filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toEqual([]);
      expect(watFunctionBody(result.wat, "Box_new")).toMatch(/f64\.const 0[\s\S]*struct\.new/);
      expect(watFunctionBody(result.wat, "Box_init")).toMatch(/local\.get 0/);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares source-ordered initialized fields through an implicit inheritance chain in %s",
    async (target) => {
      const source = `
        class Base { base: number = 1; }
        class Mid extends Base { mid: number = this.base * 10 + 2; }
        class Leaf extends Mid { leaf: number = this.mid * 10 + 3; }
        export function run(): number {
          const value = new Leaf();
          return value.base * 10000 + value.mid * 100 + value.leaf;
        }
      `;
      const fileName = `implicit-initialized-field-${target}.ts`;
      const direct = await compile(source, {
        fileName,
        experimentalIR: false,
        emitWat: true,
        target,
      });
      expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(direct.binary)).toBe(true);
      expect((await instantiate(direct)).run!()).toBe(11323);
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Base_new,Mid_new,Leaf_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        prepared = await compile(source, {
          fileName,
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

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expect((await instantiate(prepared)).run!()).toBe(11323);
      expect(prepared.binary.length).toBeLessThanOrEqual(direct.binary.length);
      for (const name of ["Base_new", "Mid_new", "Leaf_new"] as const) {
        const terminal = outcome(prepared, "class-member", name);
        expect(terminal, JSON.stringify(terminal, null, 2)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect(outcome(prepared, "function", "run")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect((prepared.irOutcomes ?? []).filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toEqual([]);
      expect(watCallTargets(prepared.wat, watFunctionBody(prepared.wat, "Base_init"))).toEqual([]);
      expect(watCallTargets(prepared.wat, watFunctionBody(prepared.wat, "Mid_init"))).toEqual(["Base_init"]);
      expect(watCallTargets(prepared.wat, watFunctionBody(prepared.wat, "Leaf_init"))).toEqual(["Mid_init"]);
      for (const name of ["Base_init", "Mid_init", "Leaf_init"] as const) {
        const body = watFunctionBody(prepared.wat, name);
        const directBody = watFunctionBody(direct.wat, name);
        expect(body.match(/struct\.set/g) ?? []).toHaveLength(1);
        if (name === "Base_init") {
          // IR spells the terminal stack result with an explicit `return`
          // while the direct base body uses Wasm fallthrough; all
          // value-producing work is otherwise byte-for-byte the same shape.
          expect(body.replace(/\n\s+return(?=\n\s*\)$)/, "")).toBe(directBody);
        } else {
          // The typed IR receiver removes the direct backend's nullable /
          // nominal receiver guard before inherited field reads.
          expect(body.split("\n").length).toBeLessThan(directBody.split("\n").length);
          expect(directBody).toMatch(/ref\.is_null|ref\.test/);
          expect(body).not.toMatch(/ref\.is_null|ref\.test/);
        }
        expect(body).not.toMatch(
          /__current_this|(?:return_)?call_ref|call_indirect|any\.convert_extern|extern\.convert_any|(?:^|_)(?:box|unbox)(?:_|$)/,
        );
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "runs explicit base fields before the body and derived fields after super in %s",
    async (target) => {
      const source = `
        class Base {
          base: number = 1;
          order: number = this.base * 10 + 2;
          constructor() { this.order = this.order * 10 + 3; }
        }
        class Child extends Base {
          child: number = this.order * 10 + 4;
          constructor() { super(); this.child = this.child * 10 + 5; }
        }
        export function run(): number {
          const value = new Child();
          return value.base * 100000 + value.order * 100 + value.child;
        }
      `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Base_new,Child_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        prepared = await compile(source, {
          fileName: `explicit-initialized-field-order-${target}.ts`,
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

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expect((await instantiate(prepared)).run!()).toBe(124645);
      for (const name of ["Base_new", "Child_new"] as const) {
        expect(outcome(prepared, "class-member", name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect(outcome(prepared, "function", "run")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect((prepared.irOutcomes ?? []).filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toEqual([]);
      const baseInit = watFunctionBody(prepared.wat, "Base_init");
      const childInit = watFunctionBody(prepared.wat, "Child_init");
      expect(baseInit.match(/struct\.set/g) ?? []).toHaveLength(3);
      expect(watCallTargets(prepared.wat, childInit)).toEqual(["Base_init"]);
      expect(childInit.match(/struct\.set/g) ?? []).toHaveLength(2);
      expect(childInit.indexOf("call ")).toBeLessThan(childInit.indexOf("struct.set"));
      for (const body of [baseInit, childInit]) {
        expect(body).not.toMatch(
          /__current_this|(?:return_)?call_ref|call_indirect|any\.convert_extern|extern\.convert_any|(?:^|_)(?:box|unbox)(?:_|$)/,
        );
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "preserves direct-call inlining inside initialized fields in %s",
    async (target) => {
      const source = `
        function bump(value: number): number { return value + 1; }
        class Box {
          first: number = bump(1);
          second: number = bump(this.first);
        }
        export function run(): number {
          const value = new Box();
          return value.first * 10 + value.second;
        }
      `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "bump,run";
        prepared = await compile(source, {
          fileName: `initialized-field-inline-${target}.ts`,
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

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expect((await instantiate(prepared)).run!()).toBe(23);
      for (const [kind, name] of [
        ["function", "bump"],
        ["class-member", "Box_new"],
        ["function", "run"],
      ] as const) {
        expect(outcome(prepared, kind, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect((prepared.irOutcomes ?? []).filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toEqual([]);
      const boxInit = watFunctionBody(prepared.wat, "Box_init");
      expect(watCallTargets(prepared.wat, boxInit)).toEqual([]);
      expect(boxInit.match(/struct\.set/g) ?? []).toHaveLength(2);
      expect(boxInit).toMatch(/f64\.const 2[\s\S]*f64\.const 1[\s\S]*f64\.add/);
      expect(boxInit).not.toMatch(/(?:return_)?call_ref|call_indirect|__current_this/);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "withdraws an initialized-field constructor atomically when its local callee is not IR-preparable in %s",
    async (target) => {
      const source = `
        class Boom extends Error {}
        function fail() { throw new Boom(); }
        class C { value = fail(); }
        export function run(): number {
          try { new C(); return 0; }
          catch { return 1; }
        }
      `;
      const options = {
        fileName: `initialized-field-unprepared-callee-${target}.ts`,
        emitWat: true,
        target,
      } as const;
      const direct = await compile(source, options);
      const prepared = await compile(source, {
        ...options,
        experimentalIR: true,
        trackIrOutcomes: true,
      });

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expect((await instantiate(prepared)).run!()).toBe(1);
      expect(prepared.binary).toEqual(direct.binary);
      expect(prepared.wat).toBe(direct.wat);
      expect(outcome(prepared, "function", "fail")).toMatchObject({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(outcome(prepared, "class-member", "C_new")).toMatchObject({
        kind: "unsupported",
        code: "late-preparation-unsupported",
        stage: "resolve",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(watCallTargets(prepared.wat, watFunctionBody(prepared.wat, "C_init"))).toEqual(["fail"]);

      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "C_new";
        const poisoned = await compile(source, {
          ...options,
          experimentalIR: true,
          trackIrOutcomes: true,
        });
        expect(poisoned.success).toBe(false);
        expect(
          poisoned.errors.some((error) => error.message.includes("injected direct class-body poison: C_new")),
        ).toBe(true);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares private and literal-computed fields without mixing static initialization in %s",
    async (target) => {
      const source = `
        class Box {
          static count: number = 9;
          #secret: number = 4;
          ["value"]: number = this.#secret + 1;
          read(): number { return this.value; }
        }
        export function runInstance(): number { return new Box().read(); }
        export function readStatic(): number { return Box.count; }
      `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_new,Box_read";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "runInstance";
        prepared = await compile(source, {
          fileName: `initialized-private-literal-static-${target}.ts`,
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

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      const exports = await instantiate(prepared);
      expect(exports.runInstance!()).toBe(5);
      expect(exports.readStatic!()).toBe(9);
      for (const [kind, name] of [
        ["class-member", "Box_new"],
        ["class-member", "Box_read"],
        ["function", "runInstance"],
      ] as const) {
        expect(outcome(prepared, kind, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      const boxInit = watFunctionBody(prepared.wat, "Box_init");
      expect(boxInit.match(/struct\.set/g) ?? []).toHaveLength(2);
      expect(boxInit).not.toMatch(/f64\.const 9|__current_this|(?:return_)?call_ref|call_indirect/);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "refuses a dynamic computed field name before prepared constructor emission in %s",
    async (target) => {
      const source = `
        const key: string = "value";
        class DynamicField { [key]: number = 7; }
        export function run(): number { new DynamicField(); return 1; }
      `;
      const options = {
        fileName: `initialized-dynamic-computed-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      } as const;
      const result = await compile(source, options);
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(outcome(result, "class-member", "DynamicField_new")).toMatchObject({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });

      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "DynamicField_new";
        const poisoned = await compile(source, options);
        expect(poisoned.success).toBe(false);
        expect(
          poisoned.errors.some((error) =>
            error.message.includes("injected direct class-body poison: DynamicField_new"),
          ),
        ).toBe(true);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }
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
