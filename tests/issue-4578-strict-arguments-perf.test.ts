// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4578 — strict ESM functions used to install the §10.6 step 14 poison
// accessor on every arguments object, even when the object was provably private
// and only read through `.length` / numeric indices. In clsx and Acorn this put
// the full descriptor/object runtime on a per-invocation hot path.

import { describe, expect, it } from "vitest";

import type { CodegenContext } from "../src/codegen/context/types.js";
import { bodyRequiresArgumentsHostRegistration } from "../src/codegen/helpers/arguments-registration.js";
import { type CompileResult, compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

const EAGER_CONTROL_ENV = "JS2WASM_ELIDE_PRIVATE_ARGUMENTS_REGISTRATION";
const DEFINE_ACCESSOR = "__defineProperty_accessor";

const CLSX_SHAPED_SOURCE = `
  export function clsxShape(): number {
    let index: number = 0;
    let checksum: number = arguments.length;
    while (index < arguments.length) {
      checksum += arguments[index++] as number;
    }
    return checksum;
  }

  export function test(): number {
    return clsxShape(4, 5);
  }
`;

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

function parseWatFunctions(wat: string): readonly WatFunction[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  const names = starts.map(({ name }) => name);
  expect(new Set(names).size, "WAT function names must be unique for call-graph attribution").toBe(names.length);
  return starts.map(({ name, index }, position) => ({
    name,
    body: wat.slice(index, starts[position + 1]?.index ?? wat.length),
  }));
}

function watFunction(wat: string, name: string): WatFunction {
  const matches = parseWatFunctions(wat).filter((fn) => fn.name === name);
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!;
}

function watCallTargets(wat: string, body: string): readonly string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])] ?? "<missing>";
    return target.endsWith("_import") ? target.slice(0, -"_import".length) : target;
  });
}

function reachableFunctions(wat: string, root: string): ReadonlySet<string> {
  const functions = new Map(parseWatFunctions(wat).map((fn) => [fn.name, fn]));
  expect(functions.has(root), `call-graph root $${root} must exist`).toBe(true);
  const reachable = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const fn = functions.get(name);
    if (!fn) continue;
    for (const target of watCallTargets(wat, fn.body)) {
      if (functions.has(target) && !reachable.has(target)) queue.push(target);
    }
  }
  return reachable;
}

async function compileStandalone(source: string, forceEager = false): Promise<CompileResult> {
  const previous = process.env[EAGER_CONTROL_ENV];
  if (forceEager) process.env[EAGER_CONTROL_ENV] = "0";
  else delete process.env[EAGER_CONTROL_ENV];
  try {
    const result = await compile(source, {
      fileName: "issue-4578.ts",
      target: "standalone",
      inferModuleStrictArguments: true,
      skipSemanticDiagnostics: true,
      emitWat: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.wat.length, "structural proof requires non-empty WAT").toBeGreaterThan(0);
    return result;
  } finally {
    if (previous === undefined) delete process.env[EAGER_CONTROL_ENV];
    else process.env[EAGER_CONTROL_ENV] = previous;
  }
}

function analyzedBodyRequiresRegistration(body: string): boolean {
  const sourceFile = ts.createSourceFile(
    "issue-4578-analysis.ts",
    `function inspect(): unknown { ${body} }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inspect = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!inspect?.body) throw new Error("analysis fixture must contain inspect() with a body");
  return bodyRequiresArgumentsHostRegistration({} as CodegenContext, inspect.body);
}

describe("#4578 private strict arguments poison-accessor elision", () => {
  it("removes the descriptor runtime from a clsx-shaped reachable call graph", async () => {
    const result = await compileStandalone(CLSX_SHAPED_SOURCE);
    const clsx = watFunction(result.wat, "clsxShape");
    expect(clsx.body, "the optimized function must still build/read its arguments vec").toMatch(/struct\.get/);
    expect(watCallTargets(result.wat, clsx.body)).not.toContain(DEFINE_ACCESSOR);
    expect(reachableFunctions(result.wat, "clsxShape")).not.toContain(DEFINE_ACCESSOR);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(11);
  });

  it("has a non-vacuous eager A/B control on the same clsx-shaped source", async () => {
    const result = await compileStandalone(CLSX_SHAPED_SOURCE, true);
    const clsx = watFunction(result.wat, "clsxShape");
    expect(watCallTargets(result.wat, clsx.body)).toContain(DEFINE_ACCESSOR);
    expect(reachableFunctions(result.wat, "clsxShape")).toContain(DEFINE_ACCESSOR);
  });

  const observableBodies = [
    { name: "escape", body: "return arguments as any;" },
    { name: "alias/store", body: "const holder: any = {}; holder.value = arguments; return holder.value;" },
    { name: "direct eval", body: 'return eval("arguments.length");' },
    { name: "dynamic key", body: "const key: any = 0; return (arguments as any)[key];" },
    { name: "string key", body: 'return (arguments as any)["0"];' },
    {
      name: "reflection",
      body: 'return Object.getOwnPropertyDescriptor(arguments as any, "callee");',
    },
    { name: "mutation", body: "(arguments as any)[0] = 9; return 9;" },
    { name: "receiver", body: "return (arguments as any)[0]();" },
  ] as const;

  for (const { name, body } of observableBodies) {
    it(`keeps eager poison materialization for ${name}`, async () => {
      const result = await compileStandalone(`
        function inspect(): any { ${body} }
        export function test(): number { inspect(); return 1; }
      `);
      const inspect = watFunction(result.wat, "inspect");
      expect(watCallTargets(result.wat, inspect.body)).toContain(DEFINE_ACCESSOR);
      expect(reachableFunctions(result.wat, "inspect")).toContain(DEFINE_ACCESSOR);
    });
  }

  it("keeps the outer poison accessor when a computed method name escapes arguments", async () => {
    const source = `
      let escaped: any;
      function capture(value: any): string { escaped = value; return "member"; }
      function inspect(): number {
        const object = { [capture(arguments)](): void {} };
        void object;
        return arguments.length;
      }
      export function test(): number {
        inspect();
        return Object.getOwnPropertyDescriptor(escaped, "callee") === undefined ? 0 : 1;
      }
    `;
    const candidate = await compileStandalone(source);
    const eagerControl = await compileStandalone(source, true);
    for (const [label, result] of [
      ["candidate", candidate],
      ["eager control", eagerControl],
    ] as const) {
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      expect((instance.exports.test as () => number)(), label).toBe(1);
    }
  });

  it("distinguishes outer-evaluated computed names from nested callable bodies", () => {
    expect(
      analyzedBodyRequiresRegistration(`
        const object = { [capture(arguments)](): void {} };
        return object;
      `),
      "a computed method name evaluates in inspect() and escapes its arguments",
    ).toBe(true);
    expect(
      analyzedBodyRequiresRegistration(`
        const object = { get [capture(arguments)](): number { return 1; } };
        return object;
      `),
      "a computed getter name evaluates in inspect() and escapes its arguments",
    ).toBe(true);
    expect(
      analyzedBodyRequiresRegistration(`
        const object = { set [capture(arguments)](value: number) { void value; } };
        return object;
      `),
      "a computed setter name evaluates in inspect() and escapes its arguments",
    ).toBe(true);
    expect(
      analyzedBodyRequiresRegistration(`
        const object = { method(): unknown { return arguments; } };
        return 1;
      `),
      "a nested method body binds its own arguments",
    ).toBe(false);
    expect(
      analyzedBodyRequiresRegistration(`
        const object = { get value(): unknown { return arguments; } };
        return 1;
      `),
      "a nested accessor body binds its own arguments",
    ).toBe(false);
    expect(
      analyzedBodyRequiresRegistration(`
        const object = { [(function (): unknown { return arguments; })()](): void {} };
        return 1;
      `),
      "an ordinary function inside a computed name binds its own arguments",
    ).toBe(false);
    expect(
      analyzedBodyRequiresRegistration(`
        const object = { [((): unknown => arguments)()](): void {} };
        return 1;
      `),
      "an arrow inside a computed name inherits inspect() arguments",
    ).toBe(true);
  });

  it("also elides the accessor for a private strict function expression", async () => {
    const result = await compileStandalone(`
      export function test(): number {
        const sum: any = function (): number {
          let index: number = 0;
          let total: number = arguments.length;
          while (index < arguments.length) total += arguments[index++] as number;
          return total;
        };
        return sum(3, 4);
      }
    `);
    expect(result.wat).not.toContain("$__args_callee_poison");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(9);
  });
});
