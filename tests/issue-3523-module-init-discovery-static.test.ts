// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3523 R4 gap-6a) A module initializer whose closure DISCOVERY is static
// compiles its direct body ONCE — after the top-level function bodies, not
// before them.
//
// `module-init-pass1` exists so those bodies can see what compiling the
// initializer discovers. Measured (gap-6 design record) the only
// decision-changing product is the closure binding family: without it,
// `doneprintHandle.js`'s `var __consolePrintHandle__ = function (msg) {
// print(msg); }` compiles from a typed `call_ref` to the dynamic
// `__call_function_*` boundary and the async runner never observes completion.
//
// `declarations/module-init-closure-prelift.ts` publishes that family from the
// AST alone. What a call site actually consumes is the SIGNATURE wrapper — the
// `ref.cast` target comes from `getClosureFuncSelfTypeIdx(info.funcTypeIdx)` —
// and a capture-carrying closure's real struct is a SUBTYPE of that wrapper
// sharing its lifted func type. So the pre-lift mints the wrapper with an empty
// capture list, registers, and never compiles a body.
//
// The census below is the acceptance criterion: an admitted population reads
// `pre-lift=1 pass1=0 pass2=1`, a refused one keeps `pass1=1`, and every
// refusal ships with the twin that flips it to admitted — the reason is proven
// by mutation, not asserted.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { getCompileProfile, refreshCompileProfileConfig, resetCompileProfile } from "../src/compile-profile.js";
import { compileMultiSource } from "../src/compiler.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// Register the statement/expression delegates used by generateModule.
import "../src/codegen/expressions.js";

const PROFILE_ENV = "JS2WASM_COMPILE_PROFILE";
const FORCE_PASS2_ENV = "JS2WASM_TEST_FORCE_MODULE_INIT_PASS2";
const DISABLE_PRELIFT_ENV = "JS2WASM_TEST_DISABLE_MODULE_INIT_PRELIFT";

const originalProfileMode = process.env[PROFILE_ENV];

function restoreEnv(): void {
  if (originalProfileMode === undefined) Reflect.deleteProperty(process.env, PROFILE_ENV);
  else process.env[PROFILE_ENV] = originalProfileMode;
  Reflect.deleteProperty(process.env, FORCE_PASS2_ENV);
  Reflect.deleteProperty(process.env, DISABLE_PRELIFT_ENV);
  refreshCompileProfileConfig();
  resetCompileProfile();
}

afterEach(restoreEnv);

interface Lane {
  readonly name: string;
  readonly options: Record<string, unknown>;
  /** Only lanes with a JS/standalone host are instantiated for runtime parity. */
  readonly runnable: boolean;
}

const LANES: readonly Lane[] = [
  { name: "host-start", options: { target: "gc" }, runnable: true },
  { name: "host-deferred", options: { target: "gc", deferTopLevelInit: true }, runnable: true },
  { name: "standalone", options: { target: "standalone" }, runnable: true },
  { name: "wasi", options: { target: "wasi" }, runnable: false },
];

const RUNTIME_LANES = LANES.filter((lane) => lane.runnable);

interface Census {
  readonly prelift: number;
  readonly pass1: number;
  readonly pass2: number;
}

function censusFromProfile(): Census {
  const rows = getCompileProfile();
  const calls = (suffix: string): number =>
    rows
      .filter((row) => row.path === suffix || row.path.endsWith(`/${suffix}`))
      .reduce((sum, row) => sum + row.calls, 0);
  return {
    prelift: calls("module-init-prelift"),
    pass1: calls("module-init-pass1"),
    pass2: calls("module-init-pass2"),
  };
}

/**
 * Run `body` with the profiler armed. `profileCount` writes straight to stderr
 * while it is on and this file profiles ~150 compiles — mute that stream so the
 * suite log stays readable.
 */
async function withProfiler<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  process.env[PROFILE_ENV] = "1";
  Reflect.deleteProperty(process.env, FORCE_PASS2_ENV);
  Reflect.deleteProperty(process.env, DISABLE_PRELIFT_ENV);
  Object.assign(process.env, env);
  refreshCompileProfileConfig();
  resetCompileProfile();
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean =>
    typeof chunk === "string" && chunk.startsWith("[js2:profile]")
      ? true
      : (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stderr.write;
  try {
    return await body();
  } finally {
    process.stderr.write = realWrite;
    restoreEnv();
  }
}

async function compileWithCensus(
  source: string,
  lane: Lane,
  fileName: string,
  env: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Promise<{ readonly result: CompileResult; readonly census: Census }> {
  return withProfiler(env, async () => {
    const result = await compile(source, {
      fileName,
      skipSemanticDiagnostics: true,
      emitWat: false,
      ...lane.options,
      ...extra,
    });
    return { result, census: censusFromProfile() };
  });
}

async function readValue(result: CompileResult, lane: Lane): Promise<unknown> {
  let exports: Record<string, unknown>;
  if (lane.options.target === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    exports = instance.exports as Record<string, unknown>;
  } else {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    exports = instance.exports as Record<string, unknown>;
  }
  // The deferred lane does not run the initializer from the start section.
  (exports as { __module_init?: () => void }).__module_init?.();
  return (exports as { read?: () => unknown }).read?.();
}

const functionCount = (wat: string): number => (wat.match(/^\s*\(func /gm) ?? []).length;

interface Shape {
  readonly name: string;
  readonly source: string;
  readonly read: number;
  /** Module-scope closures the pre-lift registers — one dead twin each. */
  readonly closures: number;
}

/**
 * Admitted: the harness family the slice exists for, plus the arrow/function
 * expression shapes gap-1b left at two passes.
 */
const ADMITTED_SHAPES: readonly Shape[] = [
  {
    name: "h1-harness-print",
    source:
      `var print = function (value: any) { console.log(value); };\n` +
      `var __consolePrintHandle__ = function (msg: any) { print(msg); };\n` +
      `function $DONE(err?: any) { if (err) __consolePrintHandle__("F"); else __consolePrintHandle__("C"); }\n` +
      `export function read(): number { $DONE(); return 1; }\n`,
    read: 1,
    closures: 2,
  },
  {
    name: "h2-harness-assert",
    source:
      `function Test262Error(this: any, message: string) { this.message = message; }\n` +
      `var assert: any = function (mustBeTrue: any, message?: string) { if (mustBeTrue !== true) throw new Test262Error(message ?? "x"); };\n` +
      `assert.sameValue = function (a: any, b: any, m?: string) { if (a !== b) throw new Test262Error(m ?? "y"); };\n` +
      `export function read(): number { assert.sameValue(1, 1); return 1; }\n`,
    read: 1,
    closures: 2,
  },
  {
    name: "v1-var-fnexpr",
    source: `var g = function (n: number): number { return n * 2; };\nexport function read(): number { return g(21); }\n`,
    read: 42,
    closures: 1,
  },
  {
    name: "x5-arrow-used-by-fn",
    source: `const add = (a: number, b: number): number => a + b;\nexport function read(): number { return add(1, 2); }\n`,
    read: 3,
    closures: 1,
  },
  {
    name: "x2-arrow-calls-fn",
    source: `function h(): number { return 4; }\nconst f = (): number => h();\nexport function read(): number { return f(); }\n`,
    read: 4,
    closures: 1,
  },
  {
    name: "c9-arrow",
    source: `const fn = () => 1;\nconst v = fn();\nexport function read(): number { return v; }\n`,
    read: 1,
    closures: 1,
  },
  {
    // The module-lexical shape the gap-6 plan expected to refuse. Measured
    // 2026-09-02, a module-scope `let` is a module GLOBAL, not a module-init
    // local, so the closure carries no capture at all and the pre-lift's
    // wrapper registration is exact. Admitted, with runtime parity pinned.
    name: "x6-closure-mutates-let",
    source: `let count = 0;\nconst inc = (): void => { count = count + 1; };\nexport function read(): number { inc(); inc(); return count; }\n`,
    read: 2,
    closures: 1,
  },
  {
    name: "v2-assign-to-module-global",
    source: `var g: any;\ng = function (n: number): number { return n * 3; };\nexport function read(): number { return g(7); }\n`,
    read: 21,
    closures: 1,
  },
];

/**
 * Refused, each with the ADMITTED twin that isolates the refusing feature —
 * the pair is what proves the reason, since a refusal record has no observation
 * channel that would not add production surface.
 */
interface RefusalPair {
  readonly name: string;
  readonly reason: string;
  readonly refused: Shape;
  readonly admittedTwin: Shape;
}

const REFUSAL_PAIRS: readonly RefusalPair[] = [
  {
    name: "nested-function-like-in-body",
    reason: "a nested closure is minted while the LIFTED body compiles — a fact no AST pre-lift can publish",
    refused: {
      name: "returns-nested-arrow",
      source: `const mk = (): (() => number) => { const inner = () => 5; return inner; };\nexport function read(): number { return mk()(); }\n`,
      read: 5,
      closures: 1,
    },
    admittedTwin: {
      name: "returns-number",
      source: `const mk = (): number => { const inner = 5; return inner; };\nexport function read(): number { return mk(); }\n`,
      read: 5,
      closures: 1,
    },
  },
  {
    name: "named-function-expression",
    reason: "takes the private-liftedFuncTypeIdx arm, so the body's call_ref type would not match",
    refused: {
      name: "named-fnexpr",
      source: `var g = function named(n: number): number { return n * 2; };\nexport function read(): number { return g(21); }\n`,
      read: 42,
      closures: 1,
    },
    admittedTwin: {
      name: "anonymous-fnexpr",
      source: `var g = function (n: number): number { return n * 2; };\nexport function read(): number { return g(21); }\n`,
      read: 42,
      closures: 1,
    },
  },
  {
    name: "generator",
    reason: "its own lowering machinery owns the lifted signature",
    refused: {
      name: "generator-fnexpr",
      source: `const gen = function* (): Generator<number> { yield 4; };\nexport function read(): number { return gen().next().value as number; }\n`,
      read: 4,
      closures: 1,
    },
    admittedTwin: {
      name: "plain-fnexpr",
      source: `const gen = function (): number { return 4; };\nexport function read(): number { return gen(); }\n`,
      read: 4,
      closures: 1,
    },
  },
  {
    name: "population-has-no-pre-liftable-closure (fnctor prototype methods only)",
    reason:
      "a write-once fnctor prototype method is never KEYED in closureMap, so there is nothing to publish — and its compile mints the #3683 typed-`this` twin and the #3765 direct-call carrier that the between-pass bodies consume",
    refused: {
      name: "prototype-methods-only",
      source:
        `function Tok(input: any) { (this as any).input = input; (this as any).pos = 0; }\n` +
        `(Tok as any).prototype.nextCode = function (this: any): number { const c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c; };\n` +
        `function drive(s: string): number { const t: any = new (Tok as any)(s); return t.nextCode(); }\n` +
        `export function read(): number { return drive("A"); }\n`,
      read: 65,
      closures: 1,
    },
    admittedTwin: {
      name: "one-keyed-binding-instead",
      source:
        `const nextCode = function (s: string): number { return s.charCodeAt(0); };\n` +
        `function drive(s: string): number { return nextCode(s); }\n` +
        `export function read(): number { return drive("A"); }\n`,
      read: 65,
      closures: 1,
    },
  },
  {
    name: "population-integrity-call",
    reason: "bodies deliberately consume pass 1's END integrity state (the #2965 snapshot)",
    refused: {
      name: "object-freeze",
      source: `const o = { p: 1 };\nObject.freeze(o);\nconst f = (): number => o.p;\nexport function read(): number { return f(); }\n`,
      read: 1,
      closures: 1,
    },
    admittedTwin: {
      name: "no-freeze",
      source: `const o = { p: 1 };\nconst f = (): number => o.p;\nexport function read(): number { return f(); }\n`,
      read: 1,
      closures: 1,
    },
  },
  {
    name: "population-class-static-block",
    reason: "static evaluation is order- and pass-sensitive",
    refused: {
      name: "static-block",
      source: `const f = (): number => 1;\nclass C { static n: number = 0; static { C.n = 3; } }\nexport function read(): number { return f() + C.n; }\n`,
      read: 4,
      closures: 1,
    },
    admittedTwin: {
      name: "no-static-block",
      source: `const f = (): number => 1;\nconst n = 3;\nexport function read(): number { return f() + n; }\n`,
      read: 4,
      closures: 1,
    },
  },
  {
    name: "population-class-expression",
    reason: "its methods are lifted with it — gap-1b's refusal, unchanged",
    refused: {
      name: "class-expression",
      source: `const f = (): number => 1;\nconst K = class { static s: number = 2; };\nexport function read(): number { return f() + K.s; }\n`,
      read: 3,
      closures: 1,
    },
    admittedTwin: {
      name: "no-class-expression",
      source: `const f = (): number => 1;\nconst s = 2;\nexport function read(): number { return f() + s; }\n`,
      read: 3,
      closures: 1,
    },
  },
  {
    name: "population-has-no-pre-liftable-closure",
    reason: "no discovery to replace — skipping pass 1 would bet on the other families instead of substituting for one",
    refused: {
      name: "no-closure",
      source: `function h(): number { return 4; }\nlet z = h();\nexport function read(): number { return z; }\n`,
      read: 4,
      closures: 0,
    },
    admittedTwin: {
      name: "one-closure",
      source: `function h(): number { return 4; }\nconst f = (): number => h();\nlet z = f();\nexport function read(): number { return z; }\n`,
      read: 4,
      closures: 1,
    },
  },
];

describe("#3523 gap-6a — a discovery-static module init compiles its direct body once, AFTER the bodies", () => {
  it("(a) reads pre-lift=1, pass1=0, pass2=1 for every admitted shape on all four lanes", async () => {
    for (const shape of ADMITTED_SHAPES) {
      for (const lane of LANES) {
        const { result, census } = await compileWithCensus(
          shape.source,
          lane,
          `g6a-admit-${shape.name}-${lane.name}.ts`,
        );
        expect(result.success, `${shape.name}/${lane.name}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(
          true,
        );
        expect({ shape: shape.name, lane: lane.name, ...census }).toEqual({
          shape: shape.name,
          lane: lane.name,
          prelift: 1,
          pass1: 0,
          pass2: 1,
        });
      }
    }
  }, 300_000);

  it("(a) keeps pass 1 for every refused population, and the twin that removes the refusal is admitted", async () => {
    for (const pair of REFUSAL_PAIRS) {
      for (const lane of LANES) {
        const refused = await compileWithCensus(
          pair.refused.source,
          lane,
          `g6a-refuse-${pair.refused.name}-${lane.name}.ts`,
        );
        expect(
          refused.result.success,
          `${pair.name}/${lane.name}: ${refused.result.errors.map((e) => e.message).join("\n")}`,
        ).toBe(true);
        expect(
          { pair: pair.name, lane: lane.name, prelift: refused.census.prelift, pass1: refused.census.pass1 },
          `${pair.name} (${pair.reason})`,
        ).toEqual({ pair: pair.name, lane: lane.name, prelift: 0, pass1: 1 });

        const twin = await compileWithCensus(
          pair.admittedTwin.source,
          lane,
          `g6a-twin-${pair.admittedTwin.name}-${lane.name}.ts`,
        );
        expect(
          { pair: pair.name, lane: lane.name, ...twin.census },
          `${pair.name} twin must isolate the refusing feature`,
        ).toEqual({ pair: pair.name, lane: lane.name, prelift: 1, pass1: 0, pass2: 1 });
      }
    }
  }, 300_000);

  it("(a) refuses a multi-source population — `discover` mode owns the whole-graph pass 1", async () => {
    const files = {
      "dep.ts": `const make = (): number => 7;\nexport const depValue = make();\n`,
      "entry.ts": `import { depValue } from "./dep";\nconst local = depValue;\nexport function read(): number { return local; }\n`,
    };
    const census = await withProfiler({}, async () => {
      const result = await compileMultiSource(files, "entry.ts", { skipSemanticDiagnostics: true });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      return censusFromProfile();
    });
    // Both sources still run pass 1: `dep.ts` because it is not `"full"` mode,
    // `entry.ts` because the ACCUMULATED population reaches beyond its source.
    expect(census.prelift).toBe(0);
    expect(census.pass1).toBe(2);
  }, 120_000);

  it("(b) keeps the typed closure dispatch the between-pass bodies depend on", async () => {
    const h1 = ADMITTED_SHAPES[0]!;
    const x5 = ADMITTED_SHAPES[3]!;
    const lane = LANES[0]!;
    for (const shape of [h1, x5]) {
      const single = await compileWithCensus(
        shape.source,
        lane,
        `g6a-dispatch-${shape.name}.ts`,
        {},
        { emitWat: true },
      );
      const twoPass = await compileWithCensus(
        shape.source,
        lane,
        `g6a-dispatch-${shape.name}.ts`,
        { [FORCE_PASS2_ENV]: "1" },
        { emitWat: true },
      );
      expect(single.census).toEqual({ prelift: 1, pass1: 0, pass2: 1 });
      expect(twoPass.census).toEqual({ prelift: 0, pass1: 1, pass2: 1 });

      // The exported reader is compiled BETWEEN the (absent) pass 1 and the
      // single compile, so it is exactly the body pass 1 used to serve.
      const readBody = (wat: string): string =>
        /\n {2}\(func \$read[\s(][\s\S]*?\n {2}\)/.exec(wat)?.[0] ?? "(no $read)";
      const single$read = readBody(single.result.wat);
      const twoPass$read = readBody(twoPass.result.wat);
      expect(single$read, `${shape.name}: $read must contain call_ref`).toContain("call_ref");
      expect(single$read.split("\n").length, `${shape.name}: $read must not grow`).toBe(
        twoPass$read.split("\n").length,
      );
      // The dynamic-dispatch boundary the gap-1b `p2only` run fell back to.
      const dynamicImports = (wat: string) => (wat.match(/\(import "env" "__call_function_\d+"/g) ?? []).length;
      expect(dynamicImports(single.result.wat), `${shape.name}: no extra dynamic-call import`).toBe(
        dynamicImports(twoPass.result.wat),
      );
    }
  }, 120_000);

  it("(b) the between-pass body is the SAME code the two-pass build produced", async () => {
    // The strongest available statement of "the inventory reproduces pass 1's
    // discovery": normalize the FUNCTION-index operands — the only thing the
    // dropped dead twin shifts — and the body a between-pass consumer gets is
    // character-for-character what the two-pass build gave it. TYPE indices are
    // deliberately NOT normalized: the `ref.cast` target and the `call_ref` type
    // are exactly the facts the pre-lift publishes, so they must match as-is.
    const lane = LANES[0]!;
    const normalize = (body: string) => body.replace(/\b(call|ref\.func) \d+\b/g, "$1 N");
    const bodyOf = (wat: string, name: string) =>
      new RegExp(`\\n {2}\\(func \\$${name}[\\s(][\\s\\S]*?\\n {2}\\)`).exec(wat)?.[0] ?? `(no $${name})`;

    for (const [shape, fn] of [
      [ADMITTED_SHAPES[3]!, "read"], // x5: capture-free, cast target IS the allocated type
      [ADMITTED_SHAPES[0]!, "\\$DONE"], // h1: capture-carrying, allocation is a SUBTYPE of it
    ] as const) {
      const single = await compileWithCensus(shape.source, lane, `g6a-cast-${shape.name}.ts`, {}, { emitWat: true });
      const twoPass = await compileWithCensus(
        shape.source,
        lane,
        `g6a-cast-${shape.name}.ts`,
        { [FORCE_PASS2_ENV]: "1" },
        { emitWat: true },
      );
      const a = bodyOf(single.result.wat, fn);
      const b = bodyOf(twoPass.result.wat, fn);
      expect(a, `${shape.name}: $${fn} must exist and dispatch typed`).toContain("call_ref");
      expect(normalize(a), `${shape.name}: $${fn} up to the dead-twin index shift`).toBe(normalize(b));
      expect(WebAssembly.validate(single.result.binary)).toBe(true);
    }

    // And for the capture-free shape the cast target is literally the type
    // `__module_init` allocates — the identity the gap-6 plan asked to pin.
    const x5 = ADMITTED_SHAPES[3]!;
    const { result } = await compileWithCensus(x5.source, lane, "g6a-cast-x5-identity.ts", {}, { emitWat: true });
    const allocated = [
      ...(bodyOf(result.wat, "__module_init").matchAll(/struct\.new (\d+)/g) as Iterable<RegExpMatchArray>),
    ].map((m) => Number(m[1]));
    const casts = [
      ...(bodyOf(result.wat, "read").matchAll(
        /ref\.cast(?: null)? \(ref(?: null)? (\d+)\)/g,
      ) as Iterable<RegExpMatchArray>),
    ].map((m) => Number(m[1]));
    expect(allocated.length, "x5: __module_init must allocate the closure").toBeGreaterThan(0);
    expect(
      casts.some((c) => allocated.includes(c)),
      `x5: casts ${casts} vs allocated ${allocated}`,
    ).toBe(true);
  }, 120_000);

  it("(c) matches the forced two-pass build on runtime value, exports, imports and validity", async () => {
    for (const shape of ADMITTED_SHAPES) {
      for (const lane of RUNTIME_LANES) {
        for (const ir of ["1", "0"]) {
          const single = await compileWithCensus(
            shape.source,
            lane,
            `g6a-rt-${shape.name}-${lane.name}-ir${ir}.ts`,
            { JS2WASM_IR: ir },
            {},
          );
          const twoPass = await compileWithCensus(
            shape.source,
            lane,
            `g6a-rt-${shape.name}-${lane.name}-ir${ir}.ts`,
            { [FORCE_PASS2_ENV]: "1", JS2WASM_IR: ir },
            {},
          );
          const label = `${shape.name}/${lane.name}/ir=${ir}`;
          expect(await readValue(single.result, lane), label).toBe(shape.read);
          expect(await readValue(twoPass.result, lane), label).toBe(shape.read);
          expect(single.result.imports.map((d) => `${d.module}.${d.name}`).sort(), `${label}: import surface`).toEqual(
            twoPass.result.imports.map((d) => `${d.module}.${d.name}`).sort(),
          );
          expect(WebAssembly.validate(single.result.binary), label).toBe(true);
        }
      }
    }
  }, 600_000);

  it("(d) the inventory is load-bearing — with the gate ON and the registrations OFF the dispatch degrades", async () => {
    // The mutation the gap-6 plan asks for: same route, no pre-lift. `$DONE` is
    // compiled between the (absent) pass 1 and the single compile, so it is
    // exactly the body that loses `closureMap`.
    const h1 = ADMITTED_SHAPES[0]!;
    for (const lane of RUNTIME_LANES) {
      const shipped = await compileWithCensus(h1.source, lane, `g6a-mut-${lane.name}.ts`, {}, { emitWat: true });
      const mutant = await compileWithCensus(
        h1.source,
        lane,
        `g6a-mut-${lane.name}.ts`,
        { [DISABLE_PRELIFT_ENV]: "1" },
        { emitWat: true },
      );
      // Same route — only the inventory differs.
      expect(shipped.census).toEqual({ prelift: 1, pass1: 0, pass2: 1 });
      expect(mutant.census).toEqual({ prelift: 0, pass1: 0, pass2: 1 });

      const doneBody = (wat: string) => /\n {2}\(func \$\$DONE[\s(][\s\S]*?\n {2}\)/.exec(wat)?.[0] ?? "";
      expect(
        doneBody(mutant.result.wat).split("\n").length,
        `${lane.name}: $DONE must grow without the inventory`,
      ).toBeGreaterThan(doneBody(shipped.result.wat).split("\n").length);
      expect(mutant.result.binary.length, `${lane.name}: the mutant must be larger`).toBeGreaterThan(
        shipped.result.binary.length,
      );
      // Still a valid module producing the right answer — the inventory is about
      // dispatch quality (and, on the async harness, observed completion), not
      // about correctness collapsing on this shape.
      expect(await readValue(mutant.result, lane)).toBe(h1.read);
    }
  }, 300_000);

  it("(e) drops the dead re-lifted closure twin — one function per module-scope closure", async () => {
    for (const shape of ADMITTED_SHAPES) {
      for (const lane of LANES) {
        const single = await compileWithCensus(
          shape.source,
          lane,
          `g6a-twins-${shape.name}-${lane.name}.ts`,
          {},
          { emitWat: true },
        );
        const twoPass = await compileWithCensus(
          shape.source,
          lane,
          `g6a-twins-${shape.name}-${lane.name}.ts`,
          { [FORCE_PASS2_ENV]: "1" },
          { emitWat: true },
        );
        expect(
          functionCount(twoPass.result.wat) - functionCount(single.result.wat),
          `${shape.name}/${lane.name}: one dead twin per module-scope closure`,
        ).toBe(shape.closures);
        expect(single.result.binary.length, `${shape.name}/${lane.name}`).toBeLessThan(twoPass.result.binary.length);
        expect(WebAssembly.validate(single.result.binary), `${shape.name}/${lane.name}`).toBe(true);
      }
    }
  }, 300_000);

  it("(f) reports an init-statement diagnostic exactly once with no pass 1", async () => {
    // (#4195) Two passes report every top-level diagnostic twice and
    // `dedupeDiagnosticsFrom` reconciles the pair after pass 2. The mark is a
    // program POSITION, so it is taken whether or not pass 1 runs — a
    // discovery-static population still reconciles the pair its function bodies
    // and its single init compile can report.
    const source = `const f = (): number => 1;
const nn = f();
const bad = ({} as any).x.y;
export function read(): number { return nn + (bad === undefined ? 1 : 0); }
`;
    const hits = (result: CompileResult, message: string) =>
      result.errors.filter((error) => error.message.includes(message)).length;
    for (const lane of RUNTIME_LANES) {
      const single = await compileWithCensus(source, lane, `g6a-diag-${lane.name}.ts`);
      const twoPass = await compileWithCensus(source, lane, `g6a-diag-${lane.name}.ts`, { [FORCE_PASS2_ENV]: "1" });
      expect(single.census).toEqual({ prelift: 1, pass1: 0, pass2: 1 });
      expect(twoPass.census).toEqual({ prelift: 0, pass1: 1, pass2: 1 });
      // Whatever either route reports, it reports at most once per location.
      for (const result of [single.result, twoPass.result]) {
        const keys = result.errors.map((e) => `${e.severity}@${e.file ?? ""}:${e.line}:${e.column}:${e.message}`);
        expect(new Set(keys).size, `${lane.name}: no duplicate diagnostic`).toBe(keys.length);
      }
      for (const error of twoPass.result.errors) {
        expect(hits(single.result, error.message), `${lane.name}: ${error.message}`).toBeLessThanOrEqual(1);
      }
    }
  }, 120_000);

  it("(f) KNOWN DIFFERENCE: a pass-1-only compile refusal becomes the JS runtime TypeError", async () => {
    // Measured 2026-09-02 and named rather than hidden. `const [p, q] = <a
    // number>` is refused by pass 1 (`Cannot destructure: not an array type`)
    // but NOT by the compile that runs after the function bodies — the two-pass
    // build's own pass 2 reports nothing new either, so the refusal is pass 1's
    // alone. With pass 1 skipped the module compiles and the destructure throws
    // the §7.4.3 TypeError at run time instead.
    //
    // Direction matters: this moves a compiler refusal onto the JS error
    // channel, which is what the language specifies (`const [p] = 1` throws).
    // Measured impact: 0 error-count and 0 success divergences across 325
    // runner-faithful test262 compiles, and +1 pass on the 90-file runtime
    // sample. The same population with a plain function instead of a closure is
    // refused by the gate and keeps the compile error — which is what makes
    // this a property of the route, not of the destructure.
    const withClosure = `const f = (): number => 1;
const nn: number = f();
const [p, q] = nn as unknown as number[];
export function read(): number { return p + q; }
`;
    const withoutClosure = `function f(): number { return 1; }
const nn: number = f();
const [p, q] = nn as unknown as number[];
export function read(): number { return p + q; }
`;
    const message = "Cannot destructure: not an array type";
    const lane = LANES[0]!;

    const single = await compileWithCensus(withClosure, lane, "g6a-known-diff.ts");
    expect(single.census).toEqual({ prelift: 1, pass1: 0, pass2: 1 });
    expect(single.result.success).toBe(true);
    expect(single.result.errors.some((e) => e.message.includes(message))).toBe(false);
    await expect(readValue(single.result, lane)).rejects.toThrow(TypeError);

    const twoPass = await compileWithCensus(withClosure, lane, "g6a-known-diff.ts", { [FORCE_PASS2_ENV]: "1" });
    expect(twoPass.result.success).toBe(false);
    expect(twoPass.result.errors.some((e) => e.message.includes(message))).toBe(true);

    // Gate-refused: the compile error stays exactly where it is today.
    const refused = await compileWithCensus(withoutClosure, lane, "g6a-known-diff-refused.ts");
    expect(refused.census.pass1).toBe(1);
    expect(refused.result.success).toBe(false);
    expect(refused.result.errors.some((e) => e.message.includes(message))).toBe(true);
  }, 120_000);

  it("(f) keeps test262 harness diagnostic counts identical through the runner assembly", async () => {
    const file = "test262/test/language/statements/for-in/cptn-decl-itr.js";
    if (!existsSync(file)) return; // submodule not present in this job
    const raw = readFileSync(file, "utf-8");
    const meta = parseMeta(raw);
    const source = assembleOriginalHarness(raw, meta as never).primary.source;
    const options = { allowJs: true, sourceMap: true, deferTopLevelInit: true };
    const lane = LANES[0]!;
    const single = await compileWithCensus(source, lane, "cptn-decl-itr.js", {}, options);
    const twoPass = await compileWithCensus(source, lane, "cptn-decl-itr.js", { [FORCE_PASS2_ENV]: "1" }, options);
    const errorCount = (result: CompileResult) => result.errors.filter((e) => e.severity === "error").length;
    expect(errorCount(single.result)).toBe(errorCount(twoPass.result));
    expect(single.result.success).toBe(twoPass.result.success);
  }, 120_000);
});
