// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3523 R4 gap-1a/1b) One direct compile for a pass-2-stable module-init
// population.
//
// A typed-Unsupported module initializer used to compile its DIRECT body
// TWICE: `module-init-pass1` seeds closure/setup discovery for the top-level
// function bodies compiled after it, and `module-init-pass2` recompiles once
// those bodies exist. Pass 1's body is kept structurally valid to the end by
// the `ctx.pendingInitBody` fixups, so the recompile is only worth paying for
// when it can actually differ.
//
// Measured, a second compile differs through exactly two mechanisms:
//
//   1. the inlinable-function registry, which is consulted only when compiling
//      a CALL (gap-1a: no call anywhere ⇒ nothing to observe);
//   2. closure re-lifting, which needs a CLOSURE to lift (gap-1b: pass 2 mints
//      a re-lifted `$__closure_N` twin and applies registry inlining inside the
//      closure body it recompiles).
//
// A population missing EITHER ingredient is pass-2-stable. Populations that
// carry both keep two passes — and that refusal is load-bearing twice over:
// admitting closures alongside calls breaks byte identity (the mutation pin
// below) and re-opens the #4195 duplicate-diagnostic that only the post-pass-2
// dedupe collapses.
//
// The census below is the acceptance criterion: pass-2-stable shapes read
// `1/0`, closure+call controls stay `1/1`, IR-owned and function-only modules
// stay `0/0`.

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
const POISON_ENV = "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY";
const ADMIT_CLOSURES_ENV = "JS2WASM_TEST_ADMIT_CLOSURES_IN_MODULE_INIT_PASS2_GATE";

const originalProfileMode = process.env[PROFILE_ENV];

function restoreEnv(): void {
  if (originalProfileMode === undefined) Reflect.deleteProperty(process.env, PROFILE_ENV);
  else process.env[PROFILE_ENV] = originalProfileMode;
  Reflect.deleteProperty(process.env, FORCE_PASS2_ENV);
  Reflect.deleteProperty(process.env, POISON_ENV);
  Reflect.deleteProperty(process.env, ADMIT_CLOSURES_ENV);
  refreshCompileProfileConfig();
  resetCompileProfile();
}

afterEach(restoreEnv);

const LANES = [
  { name: "host", target: "gc" as const },
  { name: "standalone", target: "standalone" as const },
];

type Lane = (typeof LANES)[number];

interface DirectPassCensus {
  readonly pass1: number;
  readonly pass2: number;
}

function censusFromProfile(): DirectPassCensus {
  const rows = getCompileProfile();
  const calls = (suffix: string): number =>
    rows
      .filter((row) => row.path === suffix || row.path.endsWith(`/${suffix}`))
      .reduce((sum, row) => sum + row.calls, 0);
  return { pass1: calls("module-init-pass1"), pass2: calls("module-init-pass2") };
}

function compileLane(
  source: string,
  lane: Lane,
  fileName: string,
  extra: Record<string, unknown> = {},
): Promise<CompileResult> {
  return compile(source, {
    fileName,
    target: lane.target,
    skipSemanticDiagnostics: true,
    emitWat: false,
    ...extra,
  });
}

/**
 * Run `body` with the profiler armed. `profileCount`/`profileModuleScale` write
 * straight to stderr while it is on, and this file profiles ~120 compiles — mute
 * that stream for the duration so the suite log stays readable.
 */
async function withProfiler<T>(forceSecondPass: boolean, body: () => Promise<T>): Promise<T> {
  process.env[PROFILE_ENV] = "1";
  if (forceSecondPass) process.env[FORCE_PASS2_ENV] = "1";
  else Reflect.deleteProperty(process.env, FORCE_PASS2_ENV);
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

/** Compile with the profiler armed and report both the result and the census. */
function compileWithCensus(
  source: string,
  lane: Lane,
  fileName: string,
  forceSecondPass = false,
  extra: Record<string, unknown> = {},
): Promise<{ readonly result: CompileResult; readonly census: DirectPassCensus }> {
  return withProfiler(forceSecondPass, async () => {
    const result = await compileLane(source, lane, fileName, extra);
    return { result, census: censusFromProfile() };
  });
}

async function instantiateLane(result: CompileResult, lane: Lane): Promise<Record<string, unknown>> {
  if (lane.target === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return instance.exports as Record<string, unknown>;
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return instance.exports as Record<string, unknown>;
}

/** Export names, import descriptors and Wasm validity — the parity surface. */
async function observableSurface(
  result: CompileResult,
  lane: Lane,
): Promise<{
  readonly exports: string[];
  readonly imports: string[];
  readonly valid: boolean;
  readonly read: unknown;
}> {
  const exports = await instantiateLane(result, lane);
  const read = (exports as { read?: () => unknown }).read?.();
  return {
    exports: Object.keys(exports).sort(),
    imports: result.imports.map((descriptor) => `${descriptor.module}.${descriptor.name}`).sort(),
    valid: WebAssembly.validate(result.binary),
    read,
  };
}

interface Shape {
  readonly name: string;
  readonly source: string;
  readonly read: number;
  /**
   * (#3523 gap-6a) This population's closure discovery is reproducible from the
   * AST, so pass 1 is replaced by the pre-lift and the single compile runs in
   * the pass-2 slot: `1/0` becomes `0/1`. Gap-1b's own predicate — "does a
   * SECOND compile differ?" — is not consulted for these, which is why each
   * group below keeps at least one shape gap-6a refuses.
   */
  readonly discoveryStatic?: true;
}

/** The census a shape must read, given whether gap-6a admits its population. */
const expectedCensus = (shape: Shape): DirectPassCensus =>
  shape.discoveryStatic ? { pass1: 0, pass2: 1 } : { pass1: 1, pass2: 0 };

/** gap-1a: call-free populations (some of them closure-BEARING). */
const CALL_FREE_SHAPES: readonly Shape[] = [
  {
    name: "string-const",
    source: `const greeting = "hi";\nexport function read(): number { return greeting.length; }\n`,
    read: 2,
  },
  { name: "top-level-var", source: `var w = 5;\nexport function read(): number { return w; }\n`, read: 5 },
  {
    // Closure-bearing but call-free: pass 2 has nothing to inline, so gap-1a
    // put it on the one-pass route. (#3523 gap-6a) Its discovery is also static,
    // so the single compile now runs AFTER the bodies instead of before them.
    name: "arrow-initializer",
    source: `const f = (x: number): number => x * 2;\nexport function read(): number { return f(3); }\n`,
    read: 6,
    discoveryStatic: true,
  },
  {
    // The same claim on a population gap-6a REFUSES (a named function
    // expression takes the private-lifted-func-type arm), so gap-1a's
    // closure-bearing-but-call-free half keeps a `1/0` witness.
    name: "named-fn-expression-initializer",
    source: `const f = function double(x: number): number { return x * 2; };\nexport function read(): number { return f(3); }\n`,
    read: 6,
  },
  {
    name: "object-literal",
    source: `const o = { a: 1, b: 2 };\nexport function read(): number { return o.a + o.b; }\n`,
    read: 3,
  },
  {
    name: "static-class-field",
    source: `class C { static n: number = 3; }\nexport function read(): number { return C.n; }\n`,
    read: 3,
  },
];

/**
 * gap-1b: call-bearing but closure-FREE populations. Every one of these was
 * `1/1` before this slice.
 */
const CALL_BEARING_SHAPES: readonly Shape[] = [
  {
    name: "call-in-initializer",
    source: `function h(): number { return 4; }\nlet z = h();\nexport function read(): number { return z; }\n`,
    read: 4,
  },
  {
    name: "call-as-statement",
    source: `let acc = 0;\nfunction bump(): void { acc = acc + 3; }\nbump();\nexport function read(): number { return acc; }\n`,
    read: 3,
  },
  {
    name: "new-in-initializer",
    source: `class C { x: number = 1; }\nconst c = new C();\nexport function read(): number { return c.x; }\n`,
    read: 1,
  },
  {
    name: "new-map-and-set",
    source: `const m = new Map<string, number>();\nm.set("a", 2);\nexport function read(): number { return m.size; }\n`,
    read: 1,
  },
  {
    name: "object-freeze",
    source: `const o = { p: 1 };\nObject.freeze(o);\nexport function read(): number { return o.p; }\n`,
    read: 1,
  },
  {
    name: "call-in-static-block",
    source: `function h(): number { return 4; }\nclass C { static n: number = 0; static { C.n = h(); } }\nexport function read(): number { return C.n; }\n`,
    read: 4,
  },
  {
    name: "string-method-call",
    source: `const s = "ab".toUpperCase();\nexport function read(): number { return s.length; }\n`,
    read: 2,
  },
  {
    name: "array-push",
    source: `const a: number[] = [];\na.push(7);\nexport function read(): number { return a[0]!; }\n`,
    read: 7,
  },
  {
    name: "parse-int",
    source: `const n = parseInt("21", 10);\nexport function read(): number { return n; }\n`,
    read: 21,
  },
  {
    // Legacy `any` parameter — the callee the IR path refuses.
    name: "legacy-any-callee",
    source: `function h(a: any): number { return a + 1; }\nconst z = h(41);\nexport function read(): number { return z; }\n`,
    read: 42,
  },
  {
    name: "console-log",
    source: `console.log("hi");\nexport function read(): number { return 1; }\n`,
    read: 1,
  },
];

/**
 * Call-bearing, closure-free, and byte-identical to the forced two-pass build
 * on both lanes — measured 2026-09-01. `tagged-template` is deliberately NOT
 * here: it has its own dead-artifact test below.
 */
const BYTE_IDENTICAL_SHAPES = CALL_BEARING_SHAPES;

/** A call in operator clothing — admitted, with a measured dead-global delta. */
const TAGGED_TEMPLATE: Shape = {
  name: "tagged-template",
  source: `function tag(parts: TemplateStringsArray): number { return parts.length; }\nconst t = tag\`abc\`;\nexport function read(): number { return t; }\n`,
  read: 1,
};

/**
 * Both ingredients present, so gap-1b's predicate refuses the pass-2 skip.
 *
 * (#3523 gap-6a) The first four are ALSO discovery-static, so their single
 * compile moved from the pass-1 slot to the pass-2 slot — `1/1` became `0/1`.
 * `named-fn-expression-calls-local` is the witness that keeps gap-1b's own
 * `1/1` verdict under test: gap-6a refuses a named function expression, so both
 * passes still run and the predicate is still the thing being measured.
 */
const CLOSURE_PLUS_CALL_SHAPES: readonly Shape[] = [
  {
    name: "arrow-body-calls-local",
    source: `function h(): number { return 4; }\nconst f = (): number => h();\nexport function read(): number { return f(); }\n`,
    read: 4,
    discoveryStatic: true,
  },
  {
    name: "fn-expression-calls-local",
    source: `function h(): number { return 4; }\nconst g = function (): number { return h(); };\nexport function read(): number { return g(); }\n`,
    read: 4,
    discoveryStatic: true,
  },
  {
    name: "var-fn-expression",
    source: `function h(): number { return 5; }\nvar g = function (): number { return h(); };\nexport function read(): number { return g(); }\n`,
    read: 5,
    discoveryStatic: true,
  },
  {
    name: "legacy-callee-inside-arrow",
    source: `function h(a: any): number { return a + 1; }\nconst f = (): number => h(41);\nexport function read(): number { return f(); }\n`,
    read: 42,
    discoveryStatic: true,
  },
  {
    name: "named-fn-expression-calls-local",
    source: `function h(a: any): number { return a + 1; }\nconst f = function inc(): number { return h(41); };\nexport function read(): number { return f(); }\n`,
    read: 42,
  },
];

/** The gap-6a-refused member of the group above — gap-1b's live `1/1` witness. */
const CLOSURE_PLUS_CALL_TWO_PASS = CLOSURE_PLUS_CALL_SHAPES[4]!;

describe("#3523 gap-1a/1b — a pass-2-stable module-init population compiles the direct body once", () => {
  it("compiles the direct body ONCE for every pass-2-stable shape in both lanes", async () => {
    for (const shape of [...CALL_FREE_SHAPES, ...CALL_BEARING_SHAPES, TAGGED_TEMPLATE]) {
      for (const lane of LANES) {
        const { result, census } = await compileWithCensus(
          shape.source,
          lane,
          `gap1b-stable-${shape.name}-${lane.name}.ts`,
        );
        expect(result.success, `${shape.name}/${lane.name}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(
          true,
        );
        expect({ shape: shape.name, lane: lane.name, ...census }).toEqual({
          shape: shape.name,
          lane: lane.name,
          ...expectedCensus(shape),
        });
      }
    }
  }, 300_000);

  it("matches the forced-two-pass control on runtime value, exports, imports and validity", async () => {
    for (const shape of [...CALL_FREE_SHAPES, ...CALL_BEARING_SHAPES, TAGGED_TEMPLATE]) {
      for (const lane of LANES) {
        const single = await compileWithCensus(shape.source, lane, `gap1b-ab-${shape.name}-${lane.name}.ts`);
        const twoPass = await compileWithCensus(shape.source, lane, `gap1b-ab-${shape.name}-${lane.name}.ts`, true);
        expect(single.census).toEqual(expectedCensus(shape));
        expect(twoPass.census).toEqual({ pass1: 1, pass2: 1 });

        const singleSurface = await observableSurface(single.result, lane);
        const twoPassSurface = await observableSurface(twoPass.result, lane);
        expect(singleSurface.read, `${shape.name}/${lane.name}`).toBe(shape.read);
        expect(singleSurface).toEqual(twoPassSurface);
      }
    }
  }, 300_000);

  it("emits BYTE-IDENTICAL output to the forced two-pass build for the closure-free call-bearing family", async () => {
    for (const shape of BYTE_IDENTICAL_SHAPES) {
      for (const lane of LANES) {
        const single = await compileLane(shape.source, lane, `gap1b-bytes-${shape.name}-${lane.name}.ts`);
        const forced = await withProfiler(true, () =>
          compileLane(shape.source, lane, `gap1b-bytes-${shape.name}-${lane.name}.ts`),
        );
        expect(
          Buffer.from(single.binary).equals(Buffer.from(forced.binary)),
          `${shape.name}/${lane.name}: ${single.binary.length} vs ${forced.binary.length} bytes`,
        ).toBe(true);
      }
    }
  }, 300_000);

  it("drops the dead duplicate template-object cache global that pass 2 re-registers", async () => {
    // The ONE measured byte delta in the closure-free call-bearing family on
    // these two lanes: pass 2 mints a second `$__tt_cache_N` global and leaves
    // pass 1's orphaned. Skipping pass 2 emits one cache, not two — the code is
    // otherwise identical and the runtime value is unchanged.
    for (const lane of LANES) {
      const single = await compileLane(TAGGED_TEMPLATE.source, lane, `gap1b-tt-${lane.name}.ts`, { emitWat: true });
      const forced = await withProfiler(true, () =>
        compileLane(TAGGED_TEMPLATE.source, lane, `gap1b-tt-${lane.name}.ts`, { emitWat: true }),
      );
      const caches = (wat: string | undefined) => (wat?.match(/\(global \$__tt_cache_\d+/g) ?? []).length;
      expect(caches(single.wat), `single/${lane.name}`).toBe(1);
      expect(caches(forced.wat), `forced/${lane.name}`).toBe(2);
      expect(single.binary.length).toBeLessThan(forced.binary.length);
      expect(WebAssembly.validate(single.binary)).toBe(true);
      expect((await observableSurface(single, lane)).read).toBe(TAGGED_TEMPLATE.read);
    }
  }, 120_000);

  it("drops the dead duplicate data segments a WASI console.log re-registers", async () => {
    // WASI is the one lane where `console.log` is not byte-identical: pass 2
    // re-registers the call's data segments, so the two-pass module carries a
    // dead copy of each. Acceptance here is validity + import surface + a
    // strictly smaller module, not byte identity.
    const wasi = { name: "wasi", target: "wasi" as const } as unknown as Lane;
    const single = await compileLane(CALL_BEARING_SHAPES[10]!.source, wasi, "gap1b-wasi-console.ts", {
      emitWat: true,
    });
    const forced = await withProfiler(true, () =>
      compileLane(CALL_BEARING_SHAPES[10]!.source, wasi, "gap1b-wasi-console.ts", { emitWat: true }),
    );
    const segments = (wat: string | undefined) => (wat?.match(/\(data \(i32\.const \d+\)/g) ?? []).length;
    expect(segments(forced.wat) - segments(single.wat)).toBe(2);
    expect(single.binary.length).toBeLessThan(forced.binary.length);
    expect(WebAssembly.validate(single.binary)).toBe(true);
    expect(single.imports.map((d) => `${d.module}.${d.name}`).sort()).toEqual(
      forced.imports.map((d) => `${d.module}.${d.name}`).sort(),
    );
  }, 120_000);

  it("never skips the emitting compile when a population carries BOTH ingredients", async () => {
    // gap-1b's verdict is "pass 2 runs", and it still does for all five. What
    // (#3523 gap-6a) changed is which SLOT the discovery-static four compile in:
    // `1/1` for the shape gap-6a refuses, `0/1` for the four it admits — never
    // `x/0`, which is the claim this control exists to make.
    for (const shape of CLOSURE_PLUS_CALL_SHAPES) {
      for (const lane of LANES) {
        const gated = await compileWithCensus(shape.source, lane, `gap1b-control-${shape.name}-${lane.name}.ts`);
        expect(gated.result.success, `${shape.name}/${lane.name}`).toBe(true);
        expect({ shape: shape.name, lane: lane.name, ...gated.census }).toEqual({
          shape: shape.name,
          lane: lane.name,
          pass1: shape.discoveryStatic ? 0 : 1,
          pass2: 1,
        });
        expect((await observableSurface(gated.result, lane)).read, `${shape.name}/${lane.name}`).toBe(shape.read);
      }
    }
  }, 300_000);

  it("keeps two passes for a chunk-forced population even though it is pass-2-stable", async () => {
    // Only the final emitting pass materializes the private chunk helpers, so
    // `moduleInitChunkingRequired` overrides the predicate.
    const statements = Array.from({ length: 17 }, (_, i) => `let v${i} = ${i}; v${i} = v${i} + 1;`).join("\n");
    const source = `function h(): number { return 1; }\n${statements}\nconst zz = h();\nexport function read(): number { return v16 + zz; }\n`;
    for (const lane of LANES) {
      const run = await compileWithCensus(source, lane, `gap1b-chunked-${lane.name}.ts`);
      expect(run.result.success, `${lane.name}`).toBe(true);
      expect(run.census, `chunk-forced/${lane.name}`).toEqual({ pass1: 1, pass2: 1 });
      expect((await observableSurface(run.result, lane)).read).toBe(18);
    }
  }, 120_000);

  it("the closure refusal is load-bearing — admitting closures breaks byte identity", async () => {
    // P4 mutation, on the one closure+call shape (#3523 gap-6a) refuses (a NAMED
    // function expression), so pass 1 still runs and the shipped verdict is
    // still `1/1`. Widen gap-1b's predicate through the test-only seam and the
    // same population goes `1/0` AND stops matching its two-pass build byte for
    // byte — which is exactly the divergence the refusal exists to avoid.
    const shape = CLOSURE_PLUS_CALL_TWO_PASS;
    for (const lane of LANES) {
      const shipped = await compileWithCensus(shape.source, lane, `gap1b-mut-${lane.name}.ts`);
      expect(shipped.census, `shipped/${lane.name}`).toEqual({ pass1: 1, pass2: 1 });

      process.env[ADMIT_CLOSURES_ENV] = "1";
      try {
        const mutated = await compileWithCensus(shape.source, lane, `gap1b-mut-${lane.name}.ts`);
        expect(mutated.census, `mutated/${lane.name}`).toEqual({ pass1: 1, pass2: 0 });
        expect(
          Buffer.from(mutated.result.binary).equals(Buffer.from(shipped.result.binary)),
          `mutated/${lane.name} must differ from the two-pass build`,
        ).toBe(false);
        // The mutant is still a valid module producing the right answer — the
        // refusal is about output stability, not about correctness collapsing.
        expect((await observableSurface(mutated.result, lane)).read).toBe(shape.read);
      } finally {
        Reflect.deleteProperty(process.env, ADMIT_CLOSURES_ENV);
      }
    }
  }, 120_000);

  it("scans the compile inputs, not the source file", async () => {
    // A call that lives only inside a top-level FUNCTION body is not an init
    // input, so it must not disqualify — even though the module is
    // typed-Unsupported and does compile a direct body.
    const functionBodyOnly = `const greeting = "hi";
function h(): number { return 4; }
function g(): number { return h(); }
export function read(): number { return greeting.length + g(); }
`;
    // A call inside a STATIC BLOCK is an init input — but a call alone is now
    // admitted, so this population is single-pass.
    const staticBlockCall = `const greeting = "hi";
function h(): number { return 4; }
class C { static n: number = 0; static { C.n = h(); } }
export function read(): number { return greeting.length + C.n; }
`;
    // A class-expression method whose owning statement reaches the population
    // (it carries statics) brings the CLOSURE ingredient with it, and the call
    // in its body brings the other — so this one keeps two passes.
    const classExpressionMethodCall = `const greeting = "hi";
function h(): number { return 4; }
const K = class { static s: number = 1; m(): number { return h(); } };
export function read(): number { return greeting.length + K.s; }
`;
    for (const lane of LANES) {
      expect(
        (await compileWithCensus(functionBodyOnly, lane, `gap1b-fnbody-${lane.name}.ts`)).census,
        `function-body-only/${lane.name}`,
      ).toEqual({ pass1: 1, pass2: 0 });
      expect(
        (await compileWithCensus(staticBlockCall, lane, `gap1b-staticblock-${lane.name}.ts`)).census,
        `static-block/${lane.name}`,
      ).toEqual({ pass1: 1, pass2: 0 });
      expect(
        (await compileWithCensus(classExpressionMethodCall, lane, `gap1b-clsexpr-${lane.name}.ts`)).census,
        `class-expression-method/${lane.name}`,
      ).toEqual({ pass1: 1, pass2: 1 });
    }
  }, 120_000);

  it("lets the ACCUMULATED multi-source population decide", async () => {
    async function multiCensus(files: Record<string, string>): Promise<DirectPassCensus> {
      return withProfiler(false, async () => {
        const result = await compileMultiSource(files, "entry.ts", { skipSemanticDiagnostics: true });
        expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
        return censusFromProfile();
      });
    }

    const entry = `import { depValue } from "./dep";\nconst local = depValue;\nexport function read(): number { return local; }\n`;
    // Both sources stable: the emitting source skips its recompile.
    expect(
      await multiCensus({ "dep.ts": `export const depValue = 7;\n`, "entry.ts": entry }),
      "both sources stable",
    ).toEqual({ pass1: 2, pass2: 0 });
    // A CALL contributed by an earlier source is not enough on its own.
    expect(
      await multiCensus({
        "dep.ts": `function mk(): number { return 7; }\nexport const depValue = mk();\n`,
        "entry.ts": entry,
      }),
      "earlier source contributes a call only",
    ).toEqual({ pass1: 2, pass2: 0 });
    // A call AND a closure contributed by an EARLIER source keep two passes
    // even though the emitting source's own statements are stable.
    expect(
      await multiCensus({
        "dep.ts": `function mk(): number { return 7; }\nconst make = (): number => mk();\nexport const depValue = make();\n`,
        "entry.ts": entry,
      }),
      "earlier source contributes call + closure",
    ).toEqual({ pass1: 2, pass2: 1 });
  }, 120_000);

  it("reports an init-statement diagnostic exactly once on both routes", async () => {
    // (#4195) Two passes report every top-level diagnostic twice and
    // `dedupeDiagnosticsFrom` reconciles the pair after pass 2. The one-pass
    // route never creates the pair — measured, it does not need the dedupe.
    const callFree = `const greeting = "hi";
const nn: number = 1;
const [p, q] = nn as unknown as number[];
export function read(): number { return p + q; }
`;
    // Call-bearing and closure-free: newly on the one-pass route (gap-1b).
    const callBearing = `const greeting = "hi";
function h(): number { return 1; }
const z = h();
const nn: number = z;
const [p, q] = nn as unknown as number[];
export function read(): number { return p + q; }
`;
    // Both ingredients AND (#3523 gap-6a)-refused (named function expression):
    // pass 1 still runs, so the post-pass-2 dedupe path is what is under test
    // here. The gap-6a-ADMITTED twin of this shape is pinned in
    // `issue-3523-module-init-discovery-static.test.ts` — where the refusal it
    // loses is a measured, named difference, not a silent one.
    const closurePlusCall = `function h(): number { return 1; }
const f = function inc(): number { return h(); };
const nn: number = f();
const [p, q] = nn as unknown as number[];
export function read(): number { return p + q; }
`;
    const message = "Cannot destructure: not an array type";
    const hits = (result: CompileResult) => result.errors.filter((error) => error.message.includes(message)).length;

    for (const lane of LANES) {
      const free = await compileWithCensus(callFree, lane, `gap1b-diag-free-${lane.name}.ts`);
      expect(free.census).toEqual({ pass1: 1, pass2: 0 });
      expect(hits(free.result), `call-free/${lane.name}`).toBe(1);

      const bearing = await compileWithCensus(callBearing, lane, `gap1b-diag-call-${lane.name}.ts`);
      expect(bearing.census).toEqual({ pass1: 1, pass2: 0 });
      expect(hits(bearing.result), `call-bearing/${lane.name}`).toBe(1);

      // The dedupe path still runs whenever pass 2 ran.
      const both = await compileWithCensus(closurePlusCall, lane, `gap1b-diag-both-${lane.name}.ts`);
      expect(both.census).toEqual({ pass1: 1, pass2: 1 });
      expect(hits(both.result), `closure+call/${lane.name}`).toBe(1);

      // And every route reports once under the forced-two-pass control too.
      const forced = await compileWithCensus(callBearing, lane, `gap1b-diag-forced-${lane.name}.ts`, true);
      expect(forced.census).toEqual({ pass1: 1, pass2: 1 });
      expect(hits(forced.result), `forced/${lane.name}`).toBe(1);
    }
  }, 120_000);

  it("keeps test262 diagnostic counts identical through the runner harness", async () => {
    // (#3523 gap-1b P2) `cptn-decl-itr.js` is the file where an unconditional
    // pass-2 skip doubled a diagnostic: pass 1 alone emits the pair that only
    // the post-pass-2 dedupe collapses.
    //
    // (#3523 gap-6a) Its harness population is discovery-static, so it now reads
    // `0/1` — and the dedupe still runs, because its mark is a program POSITION
    // taken whether or not pass 1 does. Measured: without that, this file
    // reported 2 errors where the two-pass build reports 1.
    const file = "test262/test/language/statements/for-in/cptn-decl-itr.js";
    if (!existsSync(file)) return; // submodule not present in this job
    const raw = readFileSync(file, "utf-8");
    const meta = parseMeta(raw);
    const source = assembleOriginalHarness(raw, meta as never).primary.source;
    const options = {
      allowJs: true,
      sourceMap: true,
      emitWat: false,
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
    };
    const single = await withProfiler(false, async () => {
      const result = await compile(source, { fileName: "cptn-decl-itr.js", ...options });
      return { result, census: censusFromProfile() };
    });
    const forced = await withProfiler(true, async () => {
      const result = await compile(source, { fileName: "cptn-decl-itr.js", ...options });
      return { result, census: censusFromProfile() };
    });
    const errorCount = (result: CompileResult) => result.errors.filter((e) => e.severity === "error").length;
    expect(single.census).toEqual({ pass1: 0, pass2: 1 });
    expect(errorCount(single.result)).toBe(errorCount(forced.result));
  }, 120_000);

  it("still compiles pass 1 for a stable shape (the skip must not skip BOTH passes)", async () => {
    process.env[POISON_ENV] = "1";
    try {
      const poisoned = await compileLane(CALL_BEARING_SHAPES[0]!.source, LANES[0]!, "gap1b-poison-stable.ts");
      expect(poisoned.success).toBe(false);
      expect(poisoned.errors.map((error) => error.message).join("\n")).toContain(
        "injected direct module-init body poison",
      );
      // An IR-owned population never reaches the direct body, so the poison is
      // inert there — the gate must not have created a direct compile.
      const irOwned = await compileLane(
        `let v = 7;\nexport function read(): number { return v; }\n`,
        LANES[0]!,
        "gap1b-poison-ir-owned.ts",
      );
      expect(irOwned.success, irOwned.errors.map((error) => error.message).join("\n")).toBe(true);
    } finally {
      restoreEnv();
    }
  }, 60_000);

  it("keeps the inlining route byte-identical now that it is single-pass", async () => {
    // The shape pass 2 was supposed to exist for: a module-level call to a
    // small local function. Measured, the final registry changes nothing here
    // (the finalize-time inliner owns it), so the one-pass build is identical.
    const source = `function twice(x: number): number { return x * 2; }\nconst v = twice(21);\nexport function read(): number { return v; }\n`;
    for (const lane of LANES) {
      const single = await compileWithCensus(source, lane, `gap1b-inline-${lane.name}.ts`);
      const forced = await compileWithCensus(source, lane, `gap1b-inline-${lane.name}.ts`, true);
      expect(single.census).toEqual({ pass1: 1, pass2: 0 });
      expect(forced.census).toEqual({ pass1: 1, pass2: 1 });
      expect(Buffer.from(single.result.binary).equals(Buffer.from(forced.result.binary)), lane.name).toBe(true);
      expect((await observableSurface(single.result, lane)).read).toBe(42);
    }
  }, 120_000);

  it("leaves IR-owned and function-only modules at 0/0", async () => {
    const shapes: ReadonlyArray<{ readonly name: string; readonly source: string }> = [
      {
        name: "ir-owned-map",
        source: `const memo = new Map<string, number>();\nexport function read(): number { return memo.size; }\n`,
      },
      { name: "ir-owned-let", source: `let v = 7;\nexport function read(): number { return v; }\n` },
      {
        name: "ir-owned-reassign",
        source: `let total = 0;\ntotal = total + 1;\nexport function read(): number { return total; }\n`,
      },
      { name: "function-only", source: `export function read(): number { return 1; }\n` },
    ];
    for (const shape of shapes) {
      for (const lane of LANES) {
        const { result, census } = await compileWithCensus(
          shape.source,
          lane,
          `gap1b-untouched-${shape.name}-${lane.name}.ts`,
        );
        expect(result.success, `${shape.name}/${lane.name}`).toBe(true);
        expect({ shape: shape.name, lane: lane.name, ...census }).toEqual({
          shape: shape.name,
          lane: lane.name,
          pass1: 0,
          pass2: 0,
        });
      }
    }
  }, 120_000);
});
