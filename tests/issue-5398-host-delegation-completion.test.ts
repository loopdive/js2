// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import * as safety from "../src/compiler/generator-semantic-safety.js";

afterEach(() => vi.restoreAllMocks());

// DIAGNOSTIC ONLY: parent owns admission. Filter only the measured array
// completion diagnostic at direct initializer, return, or import consumers.
function probeAdmission() {
  const collect = safety.collectUnsafeGeneratorSemantics;
  let filtered = 0;
  vi.spyOn(safety, "collectUnsafeGeneratorSemantics").mockImplementation((...args) =>
    collect(...args).filter((diagnostic) => {
      const node = diagnostic.node;
      if (diagnostic.id !== "JS2WASM_UNSUPPORTED_GENERATOR_DELEGATION_RESULT" || !ts.isYieldExpression(node))
        return true;
      if (!node.expression || !ts.isArrayLiteralExpression(node.expression)) return true;
      let use: ts.Node = node;
      while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
      const parent = use.parent;
      const allowed =
        ts.isVariableDeclaration(parent) ||
        ts.isReturnStatement(parent) ||
        (ts.isCallExpression(parent) &&
          parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
          parent.arguments[0] === use);
      if (allowed) filtered++;
      return !allowed;
    }),
  );
  return () => filtered;
}

async function build(source: string, optimize: 0 | 2) {
  const result = await compile(source, {
    optimize,
    fileName: "completion.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.errors.filter((e) => e.severity === "error")).toEqual([]);
  expect(result.success).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  return {
    result,
    imports,
    instantiate: async () => {
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      imports.setExports?.(instance.exports as Record<string, Function>);
      return instance.exports as { test(): any };
    },
  };
}

function helper() {
  return buildImports([
    {
      module: "env",
      name: "__gen_yield_star_result",
      kind: "func",
      paramCount: 2,
      intent: { type: "builtin", name: "__gen_yield_star_result" },
    },
  ]).env.__gen_yield_star_result!;
}

describe("#5398 host delegation completion helper", () => {
  it.each([null, undefined])("KNOWN LIMIT: eager pending-throw carrier loses %s", (pendingThrow) => {
    const make = buildImports([
      {
        module: "env",
        name: "__create_generator",
        kind: "func",
        paramCount: 2,
        intent: { type: "builtin", name: "__create_generator" },
      },
    ]).env.__create_generator!;
    // This records the pre-existing wrong behavior, not conformance. The
    // nullish pending-throw representation is outside the completion repair.
    expect(make([], pendingThrow).next()).toEqual({ value: undefined, done: true });
  });
  it.each([undefined, 0, -0, NaN, "done", false, true, null, { terminal: true }])(
    "preserves terminal %s without buffering it",
    (terminal) => {
      const buffer: unknown[] = [];
      const iterable = {
        *[Symbol.iterator]() {
          yield 1;
          return terminal;
        },
      };
      expect(Object.is(helper()(buffer, iterable), terminal)).toBe(true);
      expect(buffer).toEqual([1]);
    },
  );
  it("honors array iterator overrides and done-before-value ordering", () => {
    const order: string[] = [];
    const array: string[] = [];
    array[Symbol.iterator] = () => ({
      next: () => ({
        get done() {
          order.push("done");
          return true;
        },
        get value() {
          order.push("value");
          return "override";
        },
      }),
    });
    expect(helper()([], array)).toBe("override");
    expect(order).toEqual(["done", "value"]);
  });
  it.each(["acquisition", "next", "done", "value"])("propagates %s throws", (site) => {
    const sentinel = { site };
    const iterable = {
      get [Symbol.iterator]() {
        if (site === "acquisition") throw sentinel;
        return () => ({
          next() {
            if (site === "next") throw sentinel;
            return {
              get done() {
                if (site === "done") throw sentinel;
                return true;
              },
              get value() {
                throw sentinel;
              },
            };
          },
        });
      },
    };
    let observed: unknown;
    try {
      helper()([], iterable);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(sentinel);
  });
});

describe.each([0, 2] as const)("diagnostic-only host completion O%s", (optimize) => {
  it("compiles and executes the unchanged original assembly, primary and strict (not normal admission)", async () => {
    const source = readFileSync(
      new URL(
        "../test262/test/language/expressions/dynamic-import/assignment-expression/yield-star.js",
        import.meta.url,
      ),
      "utf8",
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "4ceab6c267bea8f1adc3dd076eafe2a59628ce2ae667971dc5e43650c04407bb",
    );
    const filtered = probeAdmission();
    const assembly = assembleOriginalHarness(source, {});
    const strict = assembly.strictRerun ?? assembleOriginalHarness(source, { flags: ["onlyStrict"] }).primary;
    for (const variant of [assembly.primary, strict]) {
      expect(variant.source).toContain(source);
      const result = await compile(variant.source, {
        optimize,
        fileName: "original.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
        hostBridge: "always",
      });
      expect(result.errors.filter((e) => e.severity === "error")).toEqual([]);
      expect(result.success).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      imports.setExports?.(instance.exports as Record<string, Function>);
      expect(instance.exports.__module_init).toBeTypeOf("function");
      (instance.exports.__module_init as Function)();
    }
    expect(filtered()).toBeGreaterThan(0);
  });
  it("observes completion without numeric specialization", async () => {
    probeAdmission();
    const body = `function* g(){var x=yield* [1,2];
      yield x===undefined ? "equal" : "wrong"; yield typeof x;
      yield Object.is(x,undefined) ? "same" : "wrong";
      yield String(x); yield x===null ? "wrong" : "not-null"; }
      function test(){ return g(); }`;
    const candidate = await build(`${body}\nexport {test};`, optimize);
    const iterator = (await candidate.instantiate()).test();
    const reference = new Function(`${body};return test();`)();
    for (let i = 0; i < 8; i++) expect(iterator.next()).toEqual(reference.next());
  });
  it.each(["return yield* [1,2];", "yield* [1,2];return 7;", 'yield* [1,2];return "done";'])(
    "keeps terminal values out of the yielded stream: %s",
    async (tail) => {
      probeAdmission();
      const body = `function* g(){${tail}} function test(){return g();}`;
      const candidate = await build(`${body}\nexport {test};`, optimize);
      const iterator = (await candidate.instantiate()).test();
      const reference = new Function(`${body};return test();`)();
      for (let i = 0; i < 4; i++) expect(iterator.next()).toEqual(reference.next());
    },
  );
  it("executes consumed import uninstrumented with its real rejection handled", async () => {
    probeAdmission();
    const candidate = await build(
      `function* g(){import(yield* [1,2]).catch(()=>{});} export function test(){return g();}`,
      optimize,
    );
    const iterator = (await candidate.instantiate()).test();
    expect(iterator.next()).toEqual({ value: 1, done: false });
    expect(iterator.next()).toEqual({ value: 2, done: false });
    expect(iterator.next()).toEqual({ value: undefined, done: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  it("executes an ordinary import through the uninstrumented production loader", async () => {
    const candidate = await build(
      'export function test(){return import("data:text/javascript,export default 5398");}',
      optimize,
    );
    expect((await (await candidate.instantiate()).test()).default).toBe(5398);
  });
  it.each(["var", "let", "const"])("preserves %s direct and parenthesized initializer carriers", async (binding) => {
    const count = probeAdmission();
    for (const array of ["[1,2]", "[]", '["a","b"]', '[1,"b"]']) {
      for (const parens of [false, true]) {
        const init = parens ? `(yield* ${array})` : `yield* ${array}`;
        const body = `function* g(){ ${binding} x = ${init}; yield x; }
          function test(){return g();}`;
        const candidate = await build(`${body}\nexport {test};`, optimize);
        const iterator = (await candidate.instantiate()).test();
        const reference = new Function(`${body}; return test();`)();
        for (let i = 0; i < 4; i++) {
          const got = iterator.next();
          const expected = reference.next();
          expect(got.done).toBe(expected.done);
          expect(Object.is(got.value, expected.value)).toBe(true);
        }
      }
    }
    expect(count()).toBeGreaterThan(0);
  });

  it("connects executed helper to genuine import boundary and retains thrown sentinel", async () => {
    const count = probeAdmission();
    const source = `function* g(){ import(yield* [1,2]); } export function test(){ return g(); }`;
    for (const negative of [false, true]) {
      const candidate = await build(source, optimize);
      const genuineHelper = candidate.imports.env.__gen_yield_star_result;
      const genuineImport = candidate.imports.env.__dynamic_import;
      expect(genuineHelper).toBeTypeOf("function");
      expect(genuineImport).toBeTypeOf("function");
      if (!negative) {
        const wat = candidate.result.wat;
        const functionImports = [...wat.matchAll(/\(import "[^"]+" "([^"]+)" \(func [^\n]+\(type (\d+)\)/g)];
        const helperIndex = functionImports.findIndex((entry) => entry[1] === "__gen_yield_star_result");
        const importIndex = functionImports.findIndex((entry) => entry[1] === "__dynamic_import");
        expect(helperIndex).toBeGreaterThanOrEqual(0);
        expect(importIndex).toBeGreaterThanOrEqual(0);
        const binaryen = (await import("binaryen")).default;
        // Installed Binaryen exposes the feature mask as readBinary's second
        // argument; its bundled declarations describe a different API name.
        const readWithFeatures = binaryen.readBinary as (
          bytes: Uint8Array,
          features: number,
        ) => ReturnType<typeof binaryen.readBinary>;
        const decoded = readWithFeatures(candidate.result.binary, binaryen.Features.All);
        try {
          const emitted = decoded.emitText();
          expect(emitted).toMatch(
            /\(import "env" "__gen_yield_star_result" \(func \S+ \(type \S+\) \(param externref externref\) \(result externref\)\)\)/,
          );
          expect(emitted).toMatch(
            /\(import "env" "__dynamic_import" \(func \S+ \(type \S+\) \(param externref\) \(result externref\)\)\)/,
          );
        } finally {
          decoded.dispose();
        }
        expect(wat).toMatch(new RegExp(`call ${helperIndex}\\s+call ${importIndex}\\b`));
        console.log(
          `O${optimize} completion/import emitted evidence`,
          wat
            .split("\n")
            .filter(
              (line) =>
                line.includes("__gen_yield_star_result") ||
                line.includes("__dynamic_import") ||
                line.startsWith("  (type "),
            )
            .join("\n"),
        );
        console.log(
          `O${optimize} emitted g/test bodies`,
          wat
            .split(/\n(?= {2}\(func )/)
            .filter((body) => /^ {2}\(func \$(g|test)\b/.test(body))
            .join("\n"),
        );
      }
      const sentinel = { negative: true };
      let helperCalls = 0;
      const argumentsSeen: unknown[] = [];
      const pending: Promise<unknown>[] = [];
      candidate.imports.env.__gen_yield_star_result = (...args: unknown[]) => {
        helperCalls++;
        // Inject the fault INSIDE the real helper's exception bridge. Throwing
        // outside buildImports' wrapper bypasses its pending-exception capture.
        if (negative)
          return genuineHelper!(args[0], {
            [Symbol.iterator]() {
              return {
                next: () => ({
                  done: true,
                  get value() {
                    throw sentinel;
                  },
                }),
              };
            },
          });
        const completion = genuineHelper!(...args);
        expect(completion).toBeUndefined();
        return completion;
      };
      candidate.imports.env.__dynamic_import = (argument: unknown) => {
        argumentsSeen.push(argument);
        const promise = genuineImport!(argument);
        pending.push(
          Promise.resolve(promise).then(
            () => "resolved",
            () => "rejected",
          ),
        );
        return promise;
      };
      const exported = await candidate.instantiate();
      const iterator = exported.test();
      // Current eager timing: both calls happen during g(), before first next().
      expect(helperCalls).toBe(1);
      if (negative) {
        expect(argumentsSeen).toEqual([]);
        let caught: unknown;
        try {
          iterator.next();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(sentinel);
      } else {
        expect(argumentsSeen).toEqual([undefined]);
        expect(typeof argumentsSeen[0]).toBe("undefined");
        expect(argumentsSeen[0]).not.toBeNull();
        expect(argumentsSeen[0]).not.toBe(0);
        expect(Object.is(argumentsSeen[0], NaN)).toBe(false);
        expect(await Promise.all(pending)).toEqual(["rejected"]);
      }
    }
    expect(count()).toBeGreaterThan(0);
  });
});

it("retains normal guard refusal for consumed array and numeric generator completions", async () => {
  for (const source of [
    "function* g(){var x=yield* [1,2];yield x}",
    "function* a(){yield 1;return 7}function* b(){var x=yield* a();yield x}",
    "function* g(){var x=0;import(x=yield* [1,2]);}",
  ]) {
    const result = await compile(source, { skipSemanticDiagnostics: true });
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.message.includes("consumed yield*"))).toBe(true);
  }
});
