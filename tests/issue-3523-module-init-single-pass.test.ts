// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3523 R4 gap-1a) One direct compile for a call-free module-init population.
//
// A typed-Unsupported module initializer used to compile its DIRECT body
// TWICE: `module-init-pass1` seeds closure/setup discovery for the top-level
// function bodies compiled after it, and `module-init-pass2` recompiles once
// those bodies exist "so call sites inside module-level code can see the final
// inlinable-function registry". That registry (`ctx.inlinableFunctions`) is
// consulted only when compiling a call, so a population containing no call
// anywhere recompiles to the body pass 1 already produced — and pass 1's body
// is kept structurally valid to the end by the `ctx.pendingInitBody` fixups.
//
// The census below is the acceptance criterion: gated shapes read `1/0`,
// controls stay `1/1`, IR-owned and function-only modules stay `0/0`.

import { afterEach, describe, expect, it } from "vitest";

import { getCompileProfile, refreshCompileProfileConfig, resetCompileProfile } from "../src/compile-profile.js";
import { compileMultiSource } from "../src/compiler.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// Register the statement/expression delegates used by generateModule.
import "../src/codegen/expressions.js";

const PROFILE_ENV = "JS2WASM_COMPILE_PROFILE";
const FORCE_PASS2_ENV = "JS2WASM_TEST_FORCE_MODULE_INIT_PASS2";
const POISON_ENV = "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY";

const originalProfileMode = process.env[PROFILE_ENV];

function restoreEnv(): void {
  if (originalProfileMode === undefined) Reflect.deleteProperty(process.env, PROFILE_ENV);
  else process.env[PROFILE_ENV] = originalProfileMode;
  Reflect.deleteProperty(process.env, FORCE_PASS2_ENV);
  Reflect.deleteProperty(process.env, POISON_ENV);
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

function compileLane(source: string, lane: Lane, fileName: string): Promise<CompileResult> {
  return compile(source, {
    fileName,
    target: lane.target,
    skipSemanticDiagnostics: true,
    emitWat: false,
  });
}

/**
 * Run `body` with the profiler armed. `profileCount`/`profileModuleScale` write
 * straight to stderr while it is on, and this file profiles ~60 compiles — mute
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
): Promise<{ readonly result: CompileResult; readonly census: DirectPassCensus }> {
  return withProfiler(forceSecondPass, async () => {
    const result = await compileLane(source, lane, fileName);
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

/** Call-free populations: nothing in the init subtrees is a call. */
const GATED_SHAPES: ReadonlyArray<{ readonly name: string; readonly source: string; readonly read: number }> = [
  {
    name: "string-const",
    source: `const greeting = "hi";\nexport function read(): number { return greeting.length; }\n`,
    read: 2,
  },
  { name: "top-level-var", source: `var w = 5;\nexport function read(): number { return w; }\n`, read: 5 },
  {
    name: "arrow-initializer",
    source: `const f = (x: number): number => x * 2;\nexport function read(): number { return f(3); }\n`,
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

/** Call-bearing populations: every one keeps today's two passes. */
const CONTROL_SHAPES: ReadonlyArray<{ readonly name: string; readonly source: string; readonly read: number }> = [
  {
    name: "call-in-initializer",
    source: `function h(): number { return 4; }\nlet z = h();\nexport function read(): number { return z; }\n`,
    read: 4,
  },
  {
    name: "new-in-initializer",
    source: `class C { x: number = 1; }\nconst c = new C();\nexport function read(): number { return c.x; }\n`,
    read: 1,
  },
  {
    name: "call-in-static-block",
    source: `function h(): number { return 4; }\nclass C { static n: number = 0; static { C.n = h(); } }\nexport function read(): number { return C.n; }\n`,
    read: 4,
  },
  {
    name: "call-in-initializer-arrow-body",
    source: `function h(): number { return 4; }\nconst f = (): number => h();\nexport function read(): number { return f(); }\n`,
    read: 4,
  },
  {
    name: "tagged-template",
    source: `function tag(parts: TemplateStringsArray): number { return parts.length; }\nconst t = tag\`abc\`;\nexport function read(): number { return t; }\n`,
    read: 1,
  },
];

describe("#3523 gap-1a — a call-free module-init population compiles the direct body once", () => {
  it("reads pass1=1, pass2=0 for every gated shape in both lanes", async () => {
    for (const shape of GATED_SHAPES) {
      for (const lane of LANES) {
        const { result, census } = await compileWithCensus(
          shape.source,
          lane,
          `gap1a-gated-${shape.name}-${lane.name}.ts`,
        );
        expect(result.success, `${shape.name}/${lane.name}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(
          true,
        );
        expect({ shape: shape.name, lane: lane.name, ...census }).toEqual({
          shape: shape.name,
          lane: lane.name,
          pass1: 1,
          pass2: 0,
        });
      }
    }
  });

  it("matches the forced-two-pass control on runtime value, exports, imports and validity", async () => {
    for (const shape of GATED_SHAPES) {
      for (const lane of LANES) {
        const single = await compileWithCensus(shape.source, lane, `gap1a-ab-${shape.name}-${lane.name}.ts`);
        const twoPass = await compileWithCensus(shape.source, lane, `gap1a-ab-${shape.name}-${lane.name}.ts`, true);
        expect(single.census).toEqual({ pass1: 1, pass2: 0 });
        expect(twoPass.census).toEqual({ pass1: 1, pass2: 1 });

        const singleSurface = await observableSurface(single.result, lane);
        const twoPassSurface = await observableSurface(twoPass.result, lane);
        expect(singleSurface.read, `${shape.name}/${lane.name}`).toBe(shape.read);
        // Byte equality is NOT required (a second pass may emit deduped closure
        // twins); the observable surface is.
        expect(singleSurface).toEqual(twoPassSurface);
      }
    }
  });

  it("keeps pass1=1, pass2=1 and unchanged behavior for every call-bearing control", async () => {
    for (const shape of CONTROL_SHAPES) {
      for (const lane of LANES) {
        const gated = await compileWithCensus(shape.source, lane, `gap1a-control-${shape.name}-${lane.name}.ts`);
        expect(gated.result.success, `${shape.name}/${lane.name}`).toBe(true);
        expect({ shape: shape.name, lane: lane.name, ...gated.census }).toEqual({
          shape: shape.name,
          lane: lane.name,
          pass1: 1,
          pass2: 1,
        });
        expect((await observableSurface(gated.result, lane)).read, `${shape.name}/${lane.name}`).toBe(shape.read);
      }
    }
  });

  it("scans the compile inputs, not the source file", async () => {
    // A call that lives only inside a top-level FUNCTION body is not an init
    // input, so it must not disqualify — even though the module is
    // typed-Unsupported and does compile a direct body.
    const functionBodyOnly = `const greeting = "hi";
function h(): number { return 4; }
function g(): number { return h(); }
export function read(): number { return greeting.length + g(); }
`;
    // A call inside a STATIC BLOCK, or inside a class-expression method whose
    // owning statement reaches the init population (it carries statics), IS an
    // init input and must disqualify.
    const staticBlockCall = `const greeting = "hi";
function h(): number { return 4; }
class C { static n: number = 0; static { C.n = h(); } }
export function read(): number { return greeting.length + C.n; }
`;
    const classExpressionMethodCall = `const greeting = "hi";
function h(): number { return 4; }
const K = class { static s: number = 1; m(): number { return h(); } };
export function read(): number { return greeting.length + K.s; }
`;
    for (const lane of LANES) {
      expect(
        (await compileWithCensus(functionBodyOnly, lane, `gap1a-fnbody-${lane.name}.ts`)).census,
        `function-body-only/${lane.name}`,
      ).toEqual({ pass1: 1, pass2: 0 });
      expect(
        (await compileWithCensus(staticBlockCall, lane, `gap1a-staticblock-${lane.name}.ts`)).census,
        `static-block/${lane.name}`,
      ).toEqual({ pass1: 1, pass2: 1 });
      expect(
        (await compileWithCensus(classExpressionMethodCall, lane, `gap1a-clsexpr-${lane.name}.ts`)).census,
        `class-expression-method/${lane.name}`,
      ).toEqual({ pass1: 1, pass2: 1 });
    }
  });

  it("lets the ACCUMULATED multi-source population decide", async () => {
    async function multiCensus(files: Record<string, string>): Promise<DirectPassCensus> {
      return withProfiler(false, async () => {
        const result = await compileMultiSource(files, "entry.ts", { skipSemanticDiagnostics: true });
        expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
        return censusFromProfile();
      });
    }

    const entry = `import { depValue } from "./dep";\nconst local = depValue;\nexport function read(): number { return local; }\n`;
    // Both sources call-free: the emitting source skips its recompile.
    expect(
      await multiCensus({ "dep.ts": `export const depValue = 7;\n`, "entry.ts": entry }),
      "both sources call-free",
    ).toEqual({ pass1: 2, pass2: 0 });
    // A call contributed by an EARLIER source keeps two passes even though the
    // emitting source's own statements are call-free.
    expect(
      await multiCensus({
        "dep.ts": `function mk(): number { return 7; }\nexport const depValue = mk();\n`,
        "entry.ts": entry,
      }),
      "earlier source contributes a call",
    ).toEqual({ pass1: 2, pass2: 1 });
  });

  it("reports an init-statement diagnostic exactly once on both routes", async () => {
    // A call-free init statement whose codegen genuinely fails: before this
    // slice it compiled twice and `dedupeDiagnosticsFrom` reconciled the pair.
    const gated = `const greeting = "hi";
const nn: number = 1;
const [p, q] = nn as unknown as number[];
export function read(): number { return p + q; }
`;
    // The same failure with a call in the population — pass 2 still runs, so
    // the dedupe path is the one under test there.
    const control = `const greeting = "hi";
function h(): number { return 1; }
const z = h();
const nn: number = z;
const [p, q] = nn as unknown as number[];
export function read(): number { return p + q; }
`;
    const message = "Cannot destructure: not an array type";

    for (const lane of LANES) {
      const gatedRun = await compileWithCensus(gated, lane, `gap1a-diag-gated-${lane.name}.ts`);
      expect(gatedRun.census).toEqual({ pass1: 1, pass2: 0 });
      expect(gatedRun.result.errors.filter((error) => error.message.includes(message))).toHaveLength(1);

      // The dedupe path still runs whenever pass 2 ran.
      const controlRun = await compileWithCensus(control, lane, `gap1a-diag-control-${lane.name}.ts`);
      expect(controlRun.census).toEqual({ pass1: 1, pass2: 1 });
      expect(controlRun.result.errors.filter((error) => error.message.includes(message))).toHaveLength(1);

      // And the gated shape reports once under the forced-two-pass control too.
      const forced = await compileWithCensus(gated, lane, `gap1a-diag-forced-${lane.name}.ts`, true);
      expect(forced.census).toEqual({ pass1: 1, pass2: 1 });
      expect(forced.result.errors.filter((error) => error.message.includes(message))).toHaveLength(1);
    }
  });

  it("still compiles pass 1 for a gated shape (the skip must not skip BOTH passes)", async () => {
    process.env[POISON_ENV] = "1";
    try {
      const poisoned = await compileLane(GATED_SHAPES[0]!.source, LANES[0]!, "gap1a-poison-gated.ts");
      expect(poisoned.success).toBe(false);
      expect(poisoned.errors.map((error) => error.message).join("\n")).toContain(
        "injected direct module-init body poison",
      );
      // An IR-owned population never reaches the direct body, so the poison is
      // inert there — the gate must not have created a direct compile.
      const irOwned = await compileLane(
        `let v = 7;\nexport function read(): number { return v; }\n`,
        LANES[0]!,
        "gap1a-poison-ir-owned.ts",
      );
      expect(irOwned.success, irOwned.errors.map((error) => error.message).join("\n")).toBe(true);
    } finally {
      restoreEnv();
    }
  });

  it("leaves the inlining route byte-identical where pass 2 still supplies the final registry", async () => {
    const source = `function twice(x: number): number { return x * 2; }\nconst v = twice(21);\nexport function read(): number { return v; }\n`;
    for (const lane of LANES) {
      const single = await compileWithCensus(source, lane, `gap1a-inline-${lane.name}.ts`);
      const forced = await compileWithCensus(source, lane, `gap1a-inline-${lane.name}.ts`, true);
      expect(single.census).toEqual({ pass1: 1, pass2: 1 });
      expect(forced.census).toEqual({ pass1: 1, pass2: 1 });
      expect(Buffer.from(single.result.binary).equals(Buffer.from(forced.result.binary)), lane.name).toBe(true);
      expect((await observableSurface(single.result, lane)).read).toBe(42);
    }
  });

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
          `gap1a-untouched-${shape.name}-${lane.name}.ts`,
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
  });
});
