// #3214 B0 — canonical callable ABI shared by legacy and IR.
//
// Function-typed source parameters are boundary carriers (`callable<S>`) and
// therefore lower to externref, matching the legacy `__fn_wrap_*` ABI. Local
// closure literals remain internal root-carrier refs and cross that boundary
// only through an exact-signature closure→callable pack. Invocation reverses
// the pack by casting externref to the wrapper root, extracting field 0, then
// call_ref'ing the typed funcref (never the wrapper struct itself).

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { collectIrDirectCallLoweringPlans } from "../src/ir/ast-lowering-plans.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { irTypeEquals, irVal, type IrClosureSignature, type IrType } from "../src/ir/nodes.js";
import { lowerIrFunctionBody, wasmValueTypeConverter, type IrLowerResolver } from "../src/ir/lower.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import { planIrCompilation } from "../src/ir/select.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

type CompileOptions = NonNullable<Parameters<typeof compile>[1]>;

const F64: IrType = irVal({ kind: "f64" });
const identities = createTestIrFunctionIdentityFactory("issue-3214-callable-abi");

const ISSUE_2859_PROGRAM = `
function apply(fn: () => number): number {
  const v = fn();
  return v + 1;
}
function applyWith(x: number, f: (a: number) => number): number {
  return f(x) * 2;
}
export function test(): number {
  const g = (): number => 41;
  const h = (a: number): number => a + 3;
  return apply(g) + applyWith(10, h);
}
`;

// `choose` deliberately creates a different wrapper signature before
// `apply`. That makes apply's () => number wrapper a non-root descendant and
// catches creation-order bugs that cast a callable to the module-local exact
// signature wrapper instead of the canonical root.
// `p` has no captures; `g` captures bias; `forward` passes an already-packed
// callable onward without a second pack.
const ORDERED_CAPTURE_PROGRAM = `
function choose(fn: (x: number) => boolean): number {
  return fn(2) ? 10 : 0;
}
function apply(fn: () => number): number {
  return fn();
}
function forward(fn: () => number): number {
  return apply(fn) + 1;
}
function applyText(fn: (s: string) => string): number {
  return fn("a").length;
}
export function test(): number {
  const p = (x: number): boolean => x > 0;
  const bias: number = 7;
  const g = (): number => bias + 5;
  const decorate = (s: string): string => s + "!";
  return choose(p) + forward(g) + applyText(decorate);
}
`;

// Neither callback consumer is reachable at runtime. They still contribute
// distinct invoke-only callable signatures to the prepared IR graph. Keeping
// allocation-only wrapper children alive for those signatures used to leave a
// stale type index after optimization removed the unused function bodies.
const INVOKE_ONLY_SIGNATURES_PROGRAM = `
function zero(fn: () => number): number {
  return fn();
}
function one(fn: (value: number) => number): number {
  return fn(2);
}
export function run(input: number): number {
  return input + 2;
}
`;

const INVOKE_ONLY_SIGNATURE_BODIES = ["zero", "one", "run"] as const;

// `fn` crosses a source FunctionTypeNode parameter boundary, so it is an
// externref callable rather than an internal closure ref. A local consumer
// must not reinterpret that value as the one-hop internal representation.
const EXTERNAL_CALLABLE_CONSUMER_PROGRAM = `
export function consumeExternal(fn: (value: number) => number, value: number): number {
  const consume = (fn: (value: number) => number, value: number): number => fn(value);
  return consume(fn, value);
}
export function run(input: number): number {
  return input + 2;
}
`;

async function compileAndRun(
  source: string,
  options: CompileOptions,
): Promise<{ result: CompileResult; value: unknown }> {
  const result = await compile(source, options);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const exports = await instantiate(result);
  const test = (exports as Record<string, unknown>).test;
  expect(typeof test).toBe("function");
  return { result, value: (test as () => unknown)() };
}

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  const imports = buildImports(result.imports, undefined, result.stringPool) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  return instance.exports;
}

function watTypeLines(wat: string): string[] {
  return wat
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("(type "));
}

function watTypeLine(wat: string, typeRef: string): string | undefined {
  if (/^\d+$/.test(typeRef)) return undefined;
  return watTypeLines(wat).find((definition) => definition.startsWith(`(type ${typeRef} `));
}

function expectFunctionFirstParamExternref(wat: string, name: string): void {
  const header = wat.split("\n").find((line) => line.startsWith(`  (func $${name}`));
  expect(header, `missing $${name} WAT function`).toBeDefined();
  if (header!.includes("(param externref")) return;

  const typeRef = header!.match(/\(type ([^)]+)\)/)?.[1];
  expect(typeRef, `$${name} has neither inline params nor a type use`).toBeDefined();
  if (/^\d+$/.test(typeRef!)) {
    // Binaryen prints numeric type uses after recursive-type canonicalization,
    // so their WAT indices cannot be reconstructed from textual order. The
    // function's exact source ABI is still explicit in its retained local 0
    // uses; pin that value carrier instead of accepting an unrelated type.
    const body = functionBody(wat, name);
    expect(body).toMatch(/local\.get 0\s+(?:local\.tee \d+\s+)?any\.convert_extern/);
    return;
  }
  const typeLine = watTypeLine(wat, typeRef!);
  expect(typeLine, `missing WAT type ${typeRef} used by $${name}`).toContain("(param externref");
}

function functionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name}`);
  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

function expectCanonicalCapturedSubtypeAndCallUnpack(wat: string): void {
  const types = watTypeLines(wat);
  const rootStruct = types.find((line) => /\$__fn_wrap_\d+_struct \(sub \(struct/.test(line));
  expect(rootStruct, "canonical wrapper root missing").toBeDefined();
  expect(rootStruct).not.toContain("(sub final");
  const rootSuffix = rootStruct!.match(/\$__fn_wrap_(\d+)_struct/)?.[1];
  expect(rootSuffix).toBeDefined();
  const rootLifted = types.find((line) => line.includes(`$__fn_wrap_${rootSuffix}_type`));
  expect(rootLifted, "canonical wrapper root has no lifted func type").toBeDefined();
  const rootIdxText = rootLifted!.match(/\(ref(?: null)? (\d+)\)/)?.[1];
  expect(rootIdxText, "canonical wrapper root has no lifted self type").toBeDefined();
  const rootIdx = Number(rootIdxText);
  expect(rootLifted).toMatch(new RegExp(`\\(param \\(ref(?: null)? ${rootIdx}\\)`));

  const irCaptured = types.filter((line) => line.includes("(type $__ir_closure_"));
  // Exactly one captured IR literal. The no-capture literal must use its exact
  // wrapper directly rather than manufacture an empty IR subtype.
  expect(irCaptured).toHaveLength(1);
  const exactIdxText = irCaptured[0]!.match(/\(sub(?: final)? \$type(\d+)/)?.[1];
  expect(exactIdxText, "captured IR closure has no declared exact-wrapper supertype").toBeDefined();
  const exactIdx = Number(exactIdxText);
  const exactLifted = types.find((line) =>
    new RegExp(`\\$__fn_wrap_(\\d+)_type \\(func \\(param \\(ref(?: null)? ${rootIdx}\\)\\) \\(result f64\\)\\)`).test(
      line,
    ),
  );
  const exactSuffix = exactLifted?.match(/\$__fn_wrap_(\d+)_type/)?.[1];
  expect(exactSuffix, "zero-arg number signature has no lifted func type").toBeDefined();
  const exactWrapper = types.find((line) => line.includes(`$__fn_wrap_${exactSuffix}_struct`));
  expect(exactWrapper, "zero-arg number signature has no allocation wrapper").toBeDefined();
  expect(exactWrapper).toContain(`$type${rootIdx}`);
  expect(exactLifted).toMatch(new RegExp(`\\(param \\(ref(?: null)? ${rootIdx}\\)`));
  expect(exactIdx, "test did not force a non-root callback wrapper").not.toBe(rootIdx);

  const apply = functionBody(wat, "apply");
  const unpack = new RegExp(`any\\.convert_extern\\s+ref\\.cast \\(ref ${rootIdx}\\)`, "g");
  // Once for lifted `self`, once for field-0 extraction.
  expect(apply.match(unpack)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(apply).not.toMatch(new RegExp(`ref\\.cast \\(ref ${exactIdx}\\)`));
  expect(apply).toMatch(
    new RegExp(`struct\\.get ${rootIdx} 0\\s+ref\\.cast \\(ref (\\d+)\\)\\s+(?:return_)?call_ref \\1`),
  );
  // Forwarding receives an already-packed callable and must not perform a
  // second closure→externref pack.
  expect(functionBody(wat, "forward")).not.toContain("extern.convert_any");
}

function expectZeroArgNumberWrapperPosition(wat: string, expected: "root" | "child"): void {
  const types = watTypeLines(wat);
  const rootStruct = types.find((line) => /\$__fn_wrap_\d+_struct \(sub \(struct/.test(line));
  expect(rootStruct, "canonical wrapper root missing").toBeDefined();
  expect(rootStruct).not.toContain("(sub final");
  const rootSuffix = rootStruct!.match(/\$__fn_wrap_(\d+)_struct/)?.[1];
  expect(rootSuffix).toBeDefined();
  const rootLifted = types.find((line) => line.includes(`$__fn_wrap_${rootSuffix}_type`));
  const rootIdxText = rootLifted?.match(/\(ref(?: null)? (\d+)\)/)?.[1];
  expect(rootIdxText, "canonical wrapper root has no lifted self type").toBeDefined();
  const rootIdx = Number(rootIdxText);
  const targetLifted = types.find((line) =>
    new RegExp(`\\$__fn_wrap_(\\d+)_type \\(func \\(param \\(ref(?: null)? ${rootIdx}\\)\\) \\(result f64\\)\\)`).test(
      line,
    ),
  );
  const targetSuffix = targetLifted?.match(/\$__fn_wrap_(\d+)_type/)?.[1];
  expect(targetSuffix, "zero-arg number wrapper missing").toBeDefined();
  if (expected === "root") {
    expect(targetSuffix).toBe(rootSuffix);
  } else {
    expect(targetSuffix).not.toBe(rootSuffix);
  }
}

function expectNamedPrivateCandidateArm(wat: string, callerName: string): void {
  const privateLifted = watTypeLines(wat).find((line) =>
    /\$__closure_\d+_type \(func \(param \(ref null \d+\)\) \(result f64\)\)/.test(line),
  );
  expect(privateLifted, "same-arity named/private closure func type missing").toBeDefined();
  const privateSelfIdx = privateLifted!.match(/\(param \(ref null (\d+)\)\)/)?.[1];
  expect(privateSelfIdx).toBeDefined();
  expect(functionBody(wat, callerName)).toMatch(
    new RegExp(`ref\\.cast(?: null)? \\(ref(?: null)? ${privateSelfIdx}\\)`),
  );
}

function selectorPlan(source: string): ReturnType<typeof planIrCompilation> {
  const sourceFile = ts.createSourceFile("issue-3214-selector.ts", source, ts.ScriptTarget.ES2022, true);
  return planIrCompilation(
    sourceFile,
    { experimentalIR: true, trackFallbacks: true, jsHostExterns: true },
    buildTypeMap(sourceFile),
  );
}

function selectorClaims(source: string): ReadonlySet<string> {
  return selectorPlan(source).funcs;
}

function minimalResolver(): IrLowerResolver {
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => 0,
  };
}

describe("#3214 B0 — canonical callable ABI", () => {
  it("keeps the #2859 callback ABI externref in legacy and IR, and IR still returns 68", async () => {
    const legacy = await compileAndRun(ISSUE_2859_PROGRAM, {
      fileName: "issue-3214-legacy.ts",
      experimentalIR: false,
    });
    const ir = await compileAndRun(ISSUE_2859_PROGRAM, {
      fileName: "issue-3214-ir.ts",
      experimentalIR: true,
      trackFallbacks: true,
    });

    expect(legacy.value).toBe(68);
    expect(ir.value).toBe(68);
    expectFunctionFirstParamExternref(legacy.result.wat, "apply");
    expectFunctionFirstParamExternref(ir.result.wat, "apply");
    expect(ir.result.irPostClaimErrors ?? []).toEqual([]);
    expect(ir.result.irCompiledFuncs).toEqual(
      expect.arrayContaining(["apply", "applyWith", "test", "test__closure_0", "test__closure_1"]),
    );
    expect(ir.result.wat).toContain("__fn_wrap_");
    expect(ir.result.wat).not.toContain("__ir_closure_base_");
  });

  it.each([
    ["host", false],
    ["nativeStrings", true],
  ] as const)("runs no-capture, captured, and forwarded callables in %s mode", async (_label, nativeStrings) => {
    const { result, value } = await compileAndRun(ORDERED_CAPTURE_PROGRAM, {
      fileName: `issue-3214-${nativeStrings ? "native" : "host"}.ts`,
      experimentalIR: true,
      trackFallbacks: true,
      nativeStrings,
    });

    expect(value).toBe(25);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs).toEqual(
      expect.arrayContaining([
        "choose",
        "apply",
        "forward",
        "applyText",
        "test",
        "test__closure_0",
        "test__closure_1",
        "test__closure_2",
      ]),
    );
    expect(result.wat).toContain("__fn_wrap_");
    expect(result.wat).not.toContain("__ir_closure_base_");
    expectCanonicalCapturedSubtypeAndCallUnpack(result.wat);
  });

  it("optimized callable output validates and matches the unoptimized result", async () => {
    const unoptimized = await compileAndRun(ORDERED_CAPTURE_PROGRAM, {
      fileName: "issue-3214-unoptimized.ts",
      experimentalIR: true,
      trackFallbacks: true,
      optimize: false,
    });
    const optimized = await compileAndRun(ORDERED_CAPTURE_PROGRAM, {
      fileName: "issue-3214-optimized.ts",
      experimentalIR: true,
      trackFallbacks: true,
      optimize: true,
    });

    expect(optimized.value).toBe(unoptimized.value);
    expect(optimized.value).toBe(25);
    expect(unoptimized.result.irPostClaimErrors ?? []).toEqual([]);
    expect(optimized.result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(["gc", "standalone"] as const)(
    "keeps dead invoke-only callable signatures free of allocation dependencies in %s",
    async (target) => {
      const direct = await compile(INVOKE_ONLY_SIGNATURES_PROGRAM, {
        fileName: `issue-3214-invoke-only-direct-${target}.ts`,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      const prepared: CompileResult[] = [];
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = INVOKE_ONLY_SIGNATURE_BODIES.join(",");
        for (const optimize of [false, true] as const) {
          prepared.push(
            await compile(INVOKE_ONLY_SIGNATURES_PROGRAM, {
              fileName: `issue-3214-invoke-only-ir-${target}-${optimize}.ts`,
              experimentalIR: true,
              optimize,
              target,
              trackIrOutcomes: true,
            }),
          );
        }
      } finally {
        if (previousPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
        }
      }

      for (const compiled of [direct, ...prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        const run = (await instantiate(compiled)).run;
        expect(run).toBeTypeOf("function");
        expect((run as (input: number) => number)(40)).toBe(42);
      }
      for (const compiled of prepared) {
        expect(compiled.irPostClaimErrors ?? []).toEqual([]);
        expect(compiled.irCompiledFuncs ?? []).toEqual(INVOKE_ONLY_SIGNATURE_BODIES);
        expect((compiled.irOutcomes ?? []).filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toEqual([]);
      }

      const optimized = prepared[1]!;
      const directImports = WebAssembly.Module.imports(new WebAssembly.Module(direct.binary))
        .map((entry) => `${entry.module}::${entry.name}`)
        .sort();
      const optimizedImports = WebAssembly.Module.imports(new WebAssembly.Module(optimized.binary))
        .map((entry) => `${entry.module}::${entry.name}`)
        .sort();
      expect(optimizedImports.filter((label) => !directImports.includes(label))).toEqual([]);
      expect(optimizedImports.length).toBeLessThanOrEqual(directImports.length);
      if (target === "standalone") expect(optimizedImports).toEqual([]);
      expect(optimized.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it("keeps an external callable passed to a local consumer on the source-boundary ABI", async () => {
    const result = await compile(EXTERNAL_CALLABLE_CONSUMER_PROGRAM, {
      fileName: "issue-3214-external-callable-consumer.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const run = (await instantiate(result)).run;
    expect(run).toBeTypeOf("function");
    expect((run as (input: number) => number)(40)).toBe(42);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((result.irOutcomes ?? []).filter(({ displayName }) => displayName === "consumeExternal")).toEqual([
      expect.objectContaining({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      }),
    ]);
  });

  it.each([
    [
      "a returned callable",
      `
function make(): (value: number) => number {
  try { return (value: number): number => value + 2; } finally {}
}
export function run(input: number): number {
  const external = make();
  const consume = (fn: (value: number) => number, value: number): number => fn(value);
  return consume(external, input);
}
`,
    ],
    [
      "an object-method consumer",
      `
function make(): (value: number) => number {
  try { return (value: number): number => value + 2; } finally {}
}
export function run(input: number): number {
  const external = make();
  const operations = {
    consume(fn: (value: number) => number, value: number): number { return fn(value); }
  };
  return operations.consume(external, input);
}
`,
    ],
    [
      "mixed internal and external consumer calls",
      `
function make(): (value: number) => number {
  try { return (value: number): number => value + 2; } finally {}
}
export function run(input: number): number {
  const external = make();
  const local = (value: number): number => value + 2;
  const consume = (fn: (value: number) => number, value: number): number => fn(value);
  return consume(local, input) + consume(external, input) - 42;
}
`,
    ],
    [
      "a top-level function value",
      `
function add(value: number): number { return value + 2; }
export function run(input: number): number {
  const consume = (fn: (value: number) => number, value: number): number => fn(value);
  return consume(add, input);
}
`,
    ],
  ] as const)("keeps %s out of the internal one-hop closure ABI", async (_label, source) => {
    const result = await compile(source, {
      fileName: `issue-3214-one-hop-boundary-${_label.replaceAll(" ", "-")}.ts`,
      experimentalIR: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const run = (await instantiate(result)).run;
    expect(run).toBeTypeOf("function");
    expect((run as (input: number) => number)(40)).toBe(42);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((result.irOutcomes ?? []).filter(({ displayName }) => displayName === "run")).toEqual([
      expect.objectContaining({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      }),
    ]);
    if (_label === "mixed internal and external consumer calls") {
      // The consumer itself must not be prepared with the internal closure ABI
      // after its second call supplies an externref/source-boundary callable.
      expect(result.irCompiledFuncs ?? []).toEqual([]);
    }
  });

  it("keeps callable call/coercion outside the linear backend before lowering", () => {
    const signature: IrClosureSignature = { params: [], returnType: F64 };
    const callable: IrType = { kind: "callable", signature };
    const closure: IrType = { kind: "closure", signature };
    expect(irTypeEquals(callable, { kind: "callable", signature: { params: [], returnType: F64 } })).toBe(true);
    expect(irTypeEquals(callable, closure)).toBe(false);

    const callBuilder = new IrFunctionBuilder(identities.next("linearCallableCall"), [F64]);
    const callee = callBuilder.addParam("fn", callable);
    callBuilder.openBlock();
    const called = callBuilder.emitClosureCall(callee, [], F64);
    callBuilder.terminate({ kind: "return", values: [called] });
    const callFunc = callBuilder.finish();
    expect(verifyIrBackendLegality(callFunc, "wasmgc")).toEqual([]);
    const callErrors = verifyIrBackendLegality(callFunc, "linear");
    expect(callErrors.some((e) => e.instr === "closure.call")).toBe(true);
    expect(callErrors.some((e) => e.message.includes("IR type 'callable'"))).toBe(true);
    const callResolver = minimalResolver();
    expect(() =>
      lowerIrFunctionBody(
        callFunc,
        callResolver,
        new LinearEmitter(),
        wasmValueTypeConverter("linear", callResolver, callFunc.name),
      ),
    ).toThrow(/linear backend legality failed/);

    const packBuilder = new IrFunctionBuilder(identities.next("linearCallablePack"), [F64]);
    const internal = packBuilder.addParam("internal", closure);
    packBuilder.openBlock();
    packBuilder.emitCallablePack(internal, signature);
    const zero = packBuilder.emitConst({ kind: "f64", value: 0 }, F64);
    packBuilder.terminate({ kind: "return", values: [zero] });
    const packFunc = packBuilder.finish();
    expect(verifyIrBackendLegality(packFunc, "wasmgc")).toEqual([]);
    expect(verifyIrBackendLegality(packFunc, "linear").some((e) => e.instr === "coerce.to_externref")).toBe(true);
    const packResolver = minimalResolver();
    expect(() =>
      lowerIrFunctionBody(
        packFunc,
        packResolver,
        new LinearEmitter(),
        wasmValueTypeConverter("linear", packResolver, packFunc.name),
      ),
    ).toThrow(/linear backend legality failed/);

    const mismatched: IrClosureSignature = { params: [F64], returnType: F64 };
    const mismatchBuilder = new IrFunctionBuilder(identities.next("exactPackOnly"), []);
    const value = mismatchBuilder.addParam("internal", closure);
    mismatchBuilder.openBlock();
    expect(() => mismatchBuilder.emitCallablePack(value, mismatched)).toThrow(/exact closure signature/);
  });

  it("runs a legacy captured closure through a genuine-IR callee in both wrapper orders", async () => {
    const legacyProducer = await compile(
      `
        export function make(): () => number {
          const bias: number = 40;
          return (): number => bias + 1;
        }
        function seed(fn: (x: number) => boolean): number {
          return fn(1) ? 1 : 0;
        }
      `,
      { fileName: "issue-3214-legacy-producer.ts", experimentalIR: false },
    );
    const irConsumer = await compile(
      `
        function seed(fn: (x: number) => boolean): number {
          return fn(1) ? 1 : 0;
        }
        export function apply(fn: () => number): number {
          return fn() + 1;
        }
      `,
      {
        fileName: "issue-3214-ir-consumer.ts",
        experimentalIR: true,
        trackFallbacks: true,
      },
    );
    expect(legacyProducer.success, legacyProducer.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(irConsumer.success, irConsumer.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(irConsumer.irPostClaimErrors ?? []).toEqual([]);
    expect(irConsumer.irCompiledFuncs).toEqual(expect.arrayContaining(["seed", "apply"]));
    expectFunctionFirstParamExternref(irConsumer.wat, "apply");
    expect(legacyProducer.wat).toContain("__fn_wrap_");
    expect(irConsumer.wat).toContain("__fn_wrap_");
    expect(irConsumer.wat).not.toContain("__ir_closure_base_");
    expectZeroArgNumberWrapperPosition(legacyProducer.wat, "root");
    expectZeroArgNumberWrapperPosition(irConsumer.wat, "child");

    const producerExports = (await instantiate(legacyProducer)) as Record<string, unknown>;
    const consumerExports = (await instantiate(irConsumer)) as Record<string, unknown>;
    expect(typeof producerExports.make).toBe("function");
    expect(typeof consumerExports.apply).toBe("function");
    const rawLegacyClosure = (producerExports.make as () => unknown)();
    expect((consumerExports.apply as (fn: unknown) => unknown)(rawLegacyClosure)).toBe(42);

    const legacyConsumer = await compile(
      `
        function seed(fn: (x: number) => boolean): number {
          return fn(1) ? 1 : 0;
        }
        export function privateProbe(): number {
          let remaining: number = 1;
          const privateFn = function recur(): number {
            if (remaining === 0) return 7;
            remaining = remaining - 1;
            return recur();
          };
          return privateFn();
        }
        export function apply(fn: () => number): number {
          return fn() + 1;
        }
      `,
      { fileName: "issue-3214-legacy-child-consumer.ts", experimentalIR: false },
    );
    expect(legacyConsumer.success, legacyConsumer.errors.map((e) => e.message).join("\n")).toBe(true);
    expectZeroArgNumberWrapperPosition(legacyConsumer.wat, "child");
    expectNamedPrivateCandidateArm(legacyConsumer.wat, "apply");
    const legacyConsumerExports = (await instantiate(legacyConsumer)) as Record<string, unknown>;
    expect((legacyConsumerExports.privateProbe as () => unknown)()).toBe(7);
    expect((legacyConsumerExports.apply as (fn: unknown) => unknown)(rawLegacyClosure)).toBe(42);

    const childProducer = await compile(
      `
        function seed(fn: (x: number) => boolean): number {
          return fn(1) ? 1 : 0;
        }
        export function make(): () => number {
          const bias: number = 40;
          return (): number => bias + 1;
        }
      `,
      { fileName: "issue-3214-legacy-child-producer.ts", experimentalIR: false },
    );
    const rootConsumer = await compile(
      `
        export function apply(fn: () => number): number {
          return fn() + 1;
        }
        function seed(fn: (x: number) => boolean): number {
          return fn(1) ? 1 : 0;
        }
      `,
      {
        fileName: "issue-3214-ir-root-consumer.ts",
        experimentalIR: true,
        trackFallbacks: true,
      },
    );
    expect(childProducer.success, childProducer.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(rootConsumer.success, rootConsumer.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(rootConsumer.irPostClaimErrors ?? []).toEqual([]);
    expect(rootConsumer.irCompiledFuncs).toEqual(expect.arrayContaining(["apply", "seed"]));
    expectZeroArgNumberWrapperPosition(childProducer.wat, "child");
    expectZeroArgNumberWrapperPosition(rootConsumer.wat, "root");
    const childProducerExports = (await instantiate(childProducer)) as Record<string, unknown>;
    const rootConsumerExports = (await instantiate(rootConsumer)) as Record<string, unknown>;
    const rawChildLegacyClosure = (childProducerExports.make as () => unknown)();
    expect((rootConsumerExports.apply as (fn: unknown) => unknown)(rawChildLegacyClosure)).toBe(42);
  });

  it.each([false, true])(
    "keeps a minimal no-capture wrapper root open across separately compiled modules (optimize=%s)",
    async (optimize) => {
      const producer = await compile(`export function make(): () => number { return (): number => 41; }`, {
        fileName: `issue-3214-minimal-producer-${optimize}.ts`,
        experimentalIR: false,
        optimize,
      });
      const consumer = await compile(
        `
        function seed(fn: (x: number) => boolean): number {
          return fn(1) ? 1 : 0;
        }
        export function apply(fn: () => number): number {
          return fn() + 1;
        }
      `,
        {
          fileName: `issue-3214-minimal-consumer-${optimize}.ts`,
          experimentalIR: true,
          trackFallbacks: true,
          optimize,
        },
      );
      expect(producer.success, producer.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(consumer.success, consumer.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(consumer.irPostClaimErrors ?? []).toEqual([]);
      expect(consumer.irCompiledFuncs).toEqual(expect.arrayContaining(["seed", "apply"]));
      expectZeroArgNumberWrapperPosition(producer.wat, "root");
      expectZeroArgNumberWrapperPosition(consumer.wat, "child");
      const producerExports = (await instantiate(producer)) as Record<string, unknown>;
      const consumerExports = (await instantiate(consumer)) as Record<string, unknown>;
      const rawClosure = (producerExports.make as () => unknown)();
      expect((consumerExports.apply as (fn: unknown) => unknown)(rawClosure)).toBe(42);
    },
  );

  it("keeps callable undefined guards dynamic at the externref boundary", async () => {
    const result = await compile(
      `
        export function apply(fn: () => number): number {
          if (fn === undefined) return 99;
          return fn();
        }
      `,
      {
        fileName: "issue-3214-callable-undefined.ts",
        experimentalIR: true,
        trackFallbacks: true,
      },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs).toContain("apply");
    expect(result.imports.some((i) => i.module === "env" && i.name === "__extern_is_undefined")).toBe(true);
    const exports = (await instantiate(result)) as Record<string, unknown>;
    expect((exports.apply as (fn: unknown) => unknown)(undefined)).toBe(99);
  });

  it("builds an exact IR closure pack for a legacy-compatible direct-call slot", async () => {
    const signature: IrClosureSignature = { params: [F64], returnType: F64 };
    const callable: IrType = { kind: "callable", signature };
    const sourceFile = ts.createSourceFile(
      "issue-3214-ir-caller.ts",
      `
        export function test(): number {
          const bias: number = 3;
          const addBias = (x: number): number => x + bias;
          return apply(addBias, 5);
        }
      `,
      ts.ScriptTarget.ES2022,
      true,
    );
    const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
    expect(declaration).toBeDefined();
    const ownerIdentity = identities.next("test");
    const applyIdentity = identities.next("apply");
    const directCalls = collectIrDirectCallLoweringPlans(
      declaration!,
      ownerIdentity.unitId,
      new Map([
        [
          "apply",
          {
            target: irUnitFuncRef(applyIdentity),
            signature: { params: [callable, F64], returnType: F64 },
          },
        ],
      ]),
    );
    const lowered = lowerFunctionAstToIr(declaration!, {
      exported: true,
      ownerUnitId: ownerIdentity.unitId,
      paramTypeOverrides: [],
      returnTypeOverride: F64,
      directCalls,
    });
    const instrs = lowered.main.blocks.flatMap((block) => block.instrs);
    const closureNew = instrs.find((instr) => instr.kind === "closure.new");
    const pack = instrs.find((instr) => instr.kind === "coerce.to_externref" && instr.resultType?.kind === "callable");
    const call = instrs.find((instr) => instr.kind === "call" && instr.target.name === "apply");
    expect(closureNew?.kind).toBe("closure.new");
    expect(pack?.kind).toBe("coerce.to_externref");
    expect(call?.kind).toBe("call");
    if (closureNew?.kind !== "closure.new" || pack?.kind !== "coerce.to_externref" || call?.kind !== "call") {
      throw new Error("expected closure.new → callable pack → direct call");
    }
    expect(pack.value).toBe(closureNew.result);
    expect(pack.resultType).toEqual(callable);
    expect(call.args[0]).toBe(pack.result);

    // The opposite frontend's consumer independently pins the exact same
    // direct-call ABI: externref param, canonical wrapper family, no private
    // IR base hierarchy. Together with the all-IR runtime tests above, this is
    // a compositional IR-caller→legacy-callee proof without forcing ownership.
    const legacyConsumer = await compile(
      `export function apply(fn: (x: number) => number, x: number): number { return fn(x) + 1; }`,
      { fileName: "issue-3214-legacy-consumer.ts", experimentalIR: false },
    );
    expect(legacyConsumer.success, legacyConsumer.errors.map((e) => e.message).join("\n")).toBe(true);
    expectFunctionFirstParamExternref(legacyConsumer.wat, "apply");
    expect(legacyConsumer.wat).toContain("__fn_wrap_");
    expect(legacyConsumer.wat).not.toContain("__ir_closure_base_");
  });

  it("selects supported function-valued arguments and results without widening named values", () => {
    const inlineClaims = selectorClaims(`
      function apply(fn: () => number): number { return fn(); }
      export function inlineCaller(): number { return apply((): number => 1); }
    `);
    expect(inlineClaims.has("inlineCaller")).toBe(true);

    const namedClaims = selectorClaims(`
      function apply(fn: () => number): number { return fn(); }
      function named(): number { return 1; }
      export function namedCaller(): number { return apply(named); }
    `);
    expect(namedClaims.has("namedCaller")).toBe(false);

    const resultPlan = selectorPlan(`
      function make(): () => number { return (): number => 1; }
      export function consume(): number {
        const fn = make();
        return fn();
      }
    `);
    expect(resultPlan.funcs.has("make")).toBe(true);
    expect(resultPlan.funcs.has("consume")).toBe(true);
  });
});
