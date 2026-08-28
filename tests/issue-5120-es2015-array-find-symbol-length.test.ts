// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5120 — Array.prototype.find/findIndex must perform LengthOfArrayLike before
// callback validation, and ToNumber(Symbol) must throw in the standalone lane.
// The exact corpus rows use `o.length = Symbol(1)` and were host-pass /
// standalone-fail on fresh upstream/main; these controls keep the fix narrow:
// argument evaluation remains complete, the length getter is read once, and
// ordinary arrays/array-likes retain their existing results.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

type Method = "find" | "findIndex";
type Lane = { name: "host" | "standalone"; target?: "standalone" };

const METHODS: readonly Method[] = ["find", "findIndex"];
const LANES: readonly Lane[] = [{ name: "host" }, { name: "standalone", target: "standalone" }];
const TEST262 = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262, "harness", "assert.js"));
const corpusPath = (relative: string) => join(TEST262, "test", relative);

function moduleSource(body: string): string {
  return `export function test(): number { ${body} }`;
}

function moduleSourceWithPrecompiledHelper(method: Method, body: string): string {
  const helperName = `${method}WithAny`;
  return `
    // Keep this dynamic receiver helper ahead of the exported caller in source
    // order: the Symbol carrier is created only by the caller below.
    function ${helperName}(receiver: any): any {
      return [].${method}.call(receiver, (): boolean => true);
    }
    export function test(): number { ${body.replaceAll("HELPER", helperName)} }
  `;
}

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-5120-es2015-array-find-symbol-length.ts",
    ...(lane.target ? { target: lane.target } : {}),
  });
  if (!result.success) {
    throw new Error(`compile failed in ${lane.name}: ${result.errors?.map((e) => e.message).join("; ")}`);
  }

  const module = await WebAssembly.compile(result.binary);
  if (lane.target === "standalone") {
    // A true standalone regression must not be rescued by an env import.
    expect(WebAssembly.Module.imports(module), "standalone module must be host-free").toEqual([]);
    const { exports } = await WebAssembly.instantiate(module, {});
    return (exports as unknown as { test(): number }).test();
  }

  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as unknown as { test(): number }).test();
}

describe("#5120 — Array find/findIndex Symbol length ordering", () => {
  for (const lane of LANES) {
    describe(lane.name, () => {
      it.each(METHODS)(
        "%s throws the exact TypeError before predicate invocation",
        async (method) => {
          const source = moduleSource(`
          const o: any = {};
          o.length = Symbol("length");
          let calls = 0;
          try {
            [].${method}.call(o, function (): boolean { calls++; return true; });
            return 0;
          } catch (error) {
            return error instanceof TypeError && calls === 0 ? 1 : 0;
          }
        `);
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );

      it.each(METHODS)(
        "%s reads a Symbol-returning length getter once before callability",
        async (method) => {
          const source = moduleSource(`
          let gets = 0;
          const o: any = {};
          Object.defineProperty(o, "length", {
            get(): symbol { gets++; return Symbol("length"); },
          });
          try {
            [].${method}.call(o, null as any);
            return 0;
          } catch (error) {
            return error instanceof TypeError && gets === 1 ? 1 : 0;
          }
        `);
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );

      it.each(METHODS)(
        "%s checks a non-callable callback after reading length",
        async (method) => {
          const source = moduleSource(`
          let gets = 0;
          const o: any = {};
          Object.defineProperty(o, "length", {
            get(): number { gets++; return 0; },
          });
          try {
            [].${method}.call(o, null as any);
            return 0;
          } catch (error) {
            return (error instanceof TypeError ? 1 : 0) + (gets === 1 ? 2 : 0);
          }
        `);
          expect(await run(source, lane)).toBe(3);
        },
        180_000,
      );

      it.each(METHODS)(
        "%s preserves a dynamic Symbol carrier",
        async (method) => {
          const source = moduleSource(`
          const dynamic: any = Symbol("length");
          const o: any = {};
          o.length = dynamic;
          try {
            [].${method}.call(o, (): boolean => true);
            return 0;
          } catch (error) {
            return error instanceof TypeError ? 1 : 0;
          }
        `);
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );

      it.each(METHODS)(
        "%s preserves a dynamic Symbol carrier across a precompiled callee",
        async (method) => {
          const source = moduleSourceWithPrecompiledHelper(
            method,
            `
            const o: any = {};
            const dynamic: any = Symbol("length");
            o.length = dynamic;
            try {
              HELPER(o);
              return 0;
            } catch (error) {
              return error instanceof TypeError ? 1 : 0;
            }
          `,
          );
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );

      it.each(METHODS)(
        "%s throws for a direct closed-shape Symbol length",
        async (method) => {
          const source = moduleSource(`
          const o = { length: Symbol("length") };
          let calls = 0;
          try {
            [].${method}.call(o, function (): boolean { calls++; return true; });
            return 0;
          } catch (error) {
            return error instanceof TypeError && calls === 0 ? 1 : 0;
          }
        `);
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );

      it.each(METHODS)(
        "%s evaluates a later abrupt argument before Symbol length",
        async (method) => {
          const source = moduleSource(`
          let gets = 0;
          let thisArgEvaluations = 0;
          let extraEvaluations = 0;
          let receiverEvaluations = 0;
          const o: any = {};
          Object.defineProperty(o, "length", {
            get(): symbol { gets++; return Symbol("length"); },
          });
          function makeThisArg(): any { thisArgEvaluations++; return {}; }
          function laterAbrupt(): any {
            extraEvaluations++;
            throw new RangeError("later argument");
          }
          function makeReceiver(): any { receiverEvaluations++; return o; }
          try {
            [].${method}.call(makeReceiver(), (): boolean => true, makeThisArg(), laterAbrupt());
            return 0;
          } catch (error) {
            return error instanceof RangeError && gets === 0 && receiverEvaluations === 1
              && thisArgEvaluations === 1 && extraEvaluations === 1
              ? 1
              : 0;
          }
        `);
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );

      it.each(METHODS)(
        "%s evaluates an arrow callback's ignored thisArg once",
        async (method) => {
          const source = moduleSource(`
          let thisArgEvaluations = 0;
          const o: any = {};
          o.length = Symbol("length");
          function makeThisArg(): any { thisArgEvaluations++; return {}; }
          try {
            [].${method}.call(o, (): boolean => true, makeThisArg());
            return 0;
          } catch (error) {
            return error instanceof TypeError && thisArgEvaluations === 1 ? 1 : 0;
          }
        `);
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );

      it.each(METHODS)(
        "%s keeps real-array and numeric array-like results",
        async (method) => {
          const source = moduleSource(`
          const real = [3, 7, 9];
          const arrayLike: any = { 0: 3, 1: 7, 2: 9, length: 3 };
          const fromArray = real.${method}((value: number): boolean => value === 7);
          const fromArrayLike = [].${method}.call(arrayLike, (value: any): boolean => value === 7);
          return ${method === "find" ? "fromArray === 7 && fromArrayLike === 7" : "fromArray === 1 && fromArrayLike === 1"}
            ? 1
            : 0;
        `);
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );

      it.each(["reduce", "reduceRight"] as const)(
        "%s initialValue remains single-evaluated",
        async (method) => {
          const source = moduleSource(`
          const arrayLike: any = { 0: 1, 1: 2, length: 2 };
          let evaluations = 0;
          function initialValue(): number { evaluations++; return 0; }
          const result = [].${method}.call(arrayLike, (a: any, b: any): any => a + b, initialValue());
          return result === 3 && evaluations === 1 ? 1 : 0;
        `);
          expect(await run(source, lane)).toBe(1);
        },
        180_000,
      );
    });
  }
});

const EXACT_ROWS = [
  "built-ins/Array/prototype/find/return-abrupt-from-this-length-as-symbol.js",
  "built-ins/Array/prototype/findIndex/return-abrupt-from-this-length-as-symbol.js",
] as const;

describe.skipIf(!HAVE_TEST262)("#5120 exact Test262 rows", () => {
  for (const lane of LANES) {
    for (const relative of EXACT_ROWS) {
      it(`${lane.name}: ${relative}`, { timeout: 180_000 }, async () => {
        const result = await runTest262File(
          corpusPath(relative),
          "issue-5120-es2015-array-find-symbol-length",
          120_000,
          lane.target,
        );
        expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
      });
    }
  }
});
