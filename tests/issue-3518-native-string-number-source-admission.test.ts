// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import { lowerFunctionAstToIr, type AstToIrOptions } from "../src/ir/from-ast.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { makeIrAmbientBindingPredicate } from "../src/ir/module-bindings.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import {
  captureTypedIrProgramInput,
  prepareIrProgramSources,
  type IrProgramSourceInput,
} from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import type { RuntimeManifestPolicy } from "../src/runtime/contracts/provider-policy.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

const PARSE = "export function parse(s: string): number { return +s; }";
const NUMBER = { kind: "val", val: { kind: "f64" } };
const EXTERNREF = { kind: "val", val: { kind: "externref" } };

afterEach(() => vi.unstubAllEnvs());

function astInput(text: string) {
  const source = ts.createSourceFile("string-number-source.ts", text, ts.ScriptTarget.Latest, true);
  const identityContext = buildIrPlanningIdentityContext(buildIrUnitInventory([source], { entrySource: source }));
  const declaration = source.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("fixture requires a real function declaration");
  const ownerUnitId = identityContext.unitIdByDeclaration.get(declaration);
  if (!ownerUnitId) throw new Error("fixture requires the inventoried declaration identity");
  return { declaration, options: { ownerUnitId, identityContext } };
}

function lower(input: ReturnType<typeof astInput>, selection?: AstToIrOptions["stringNumericCoercion"]) {
  return lowerFunctionAstToIr(input.declaration, {
    ...input.options,
    ...(selection === undefined ? {} : { stringNumericCoercion: selection }),
  });
}

function instructions(fn: IrFunction): IrInstr[] {
  const rows: IrInstr[] = [];
  for (const block of fn.blocks)
    for (const instruction of block.instrs) forEachInstrDeep(instruction, (row) => rows.push(row));
  return rows;
}

function requireNumberBoundary(fn: IrFunction) {
  const rows = instructions(fn);
  const coercions = rows.filter((row) => row.kind === "coerce.to_externref");
  const unboxes = rows.filter((row) => row.kind === "intrinsic" && row.id === "js.number.unbox");
  expect(coercions).toHaveLength(1);
  expect(unboxes).toHaveLength(1);
  const coercion = coercions[0]!;
  const unbox = unboxes[0]!;
  expect(coercion.resultType).toEqual(EXTERNREF);
  expect(unbox).toMatchObject({ args: [coercion.result], version: 1, resultType: NUMBER });
  expect(Object.hasOwn(unbox, "provider")).toBe(false);
  expect(Object.hasOwn(unbox, "site")).toBe(false);
  expect(rows.indexOf(coercion)).toBeLessThan(rows.indexOf(unbox));
  expect(rows.filter((row) => row.kind === "box" || row.kind === "dyn.to_number")).toEqual([]);
  expect(rows.filter((row) => row.kind === "call")).toEqual([]);
  expect(fn.resultTypes).toEqual([NUMBER]);
  return { coercion, unbox, rows };
}

function requireHistoricalStringNumber(fn: IrFunction) {
  const rows = instructions(fn);
  const boxes = rows.filter((row) => row.kind === "box");
  const conversions = rows.filter((row) => row.kind === "dyn.to_number");
  expect(boxes).toHaveLength(1);
  expect(conversions).toHaveLength(1);
  expect(conversions[0]).toMatchObject({ value: boxes[0]!.result, resultType: NUMBER });
  expect(rows.filter((row) => row.kind === "intrinsic" || row.kind === "coerce.to_externref")).toEqual([]);
}

function requireSource(input: IrProgramSourceInput) {
  const source = prepareIrProgramSources(input);
  expect(source.kind, source.kind === "prepared" ? undefined : JSON.stringify(source)).toBe("prepared");
  if (source.kind !== "prepared") throw new Error(source.detail);
  const owner = source.inventory.terminalUnits.find((unit) => unit.displayName === "parse");
  expect(owner).toBeDefined();
  const fn = source.ir.functions.find((candidate) => candidate.unitId === owner!.id);
  if (!fn) throw new Error("source producer omitted the real parse owner");
  return { source, fn };
}

function requireInvalid(run: () => unknown, message: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
  expect(caught).toMatchObject({ code: "invalid-prepared-data", message: expect.stringContaining(message) });
}

describe("explicit AST-only string numeric conversion", () => {
  it.each(["+", "-"])("lowers nonconstant unary %s through a provider-free number boundary", (operator) => {
    const input = astInput(`export function parse(s: string): number { return ${operator}s; }`);
    const enabled = lower(input, "number-boundary");
    const { coercion, unbox, rows } = requireNumberBoundary(enabled.main);
    expect(enabled.main.params).toHaveLength(1);
    expect(enabled.main.params[0]!.type).toEqual({ kind: "string" });
    expect(coercion.value).toBe(enabled.main.params[0]!.value);
    expect(enabled.lifted).toEqual([]);
    const negations = rows.filter((row) => row.kind === "unary" && row.op === "f64.neg");
    expect(negations).toEqual(
      operator === "-" ? [expect.objectContaining({ rand: unbox.result, resultType: NUMBER })] : [],
    );
  });

  it.each(["+", "-"])("omission retains unary %s's real historical tagged conversion", (operator) => {
    const input = astInput(`export function parse(s: string): number { return ${operator}s; }`);
    const original = lowerFunctionAstToIr(input.declaration, input.options);
    requireHistoricalStringNumber(original.main);
    expect(lower(input)).toEqual(original);
    expect(lowerFunctionAstToIr(input.declaration, { ...input.options, stringNumericCoercion: undefined })).toEqual(
      original,
    );
  });

  it.each([
    ["number", "+"],
    ["number", "-"],
    ["boolean", "+"],
    ["boolean", "-"],
  ])("does not change %s unary %s", (type, operator) => {
    const input = astInput(`export function parse(s: ${type}): number { return ${operator}s; }`);
    const historical = lower(input);
    expect(lower(input, "number-boundary")).toEqual(historical);
    expect(instructions(historical.main).filter((row) => row.kind === "intrinsic")).toEqual([]);
  });

  it.each([
    ["nested declaration", "function inner(v: string): number { return +v; } return inner(s);"],
    ["arrow", "const inner = (v: string): number => +v; return inner(s);"],
    ["captured arrow", "const inner = (): number => +s; return inner();"],
  ])("propagates the explicit selection into the %s context", (_name, body) => {
    const input = astInput(`export function parse(s: string): number { ${body} }`);
    const historical = lower(input);
    const enabled = lower(input, "number-boundary");
    expect(historical.lifted).toHaveLength(1);
    expect(enabled.lifted).toHaveLength(1);
    requireHistoricalStringNumber(historical.lifted[0]!);
    requireNumberBoundary(enabled.lifted[0]!);
    expect(enabled.lifted[0]!.unitId).toBe(historical.lifted[0]!.unitId);
    expect(enabled.liftedUnitProvenance).toEqual(historical.liftedUnitProvenance);
  });

  it("does not change non-numeric string uses", () => {
    const input = astInput("export function parse(s: string): string { return s; }");
    expect(lower(input, "number-boundary")).toEqual(lower(input));
  });
});

describe("explicit standalone source-preparation forwarding", () => {
  // Real analyzeMultiSource input, shared read-only across source planning controls.
  const original = sourceInput({ "./entry.ts": PARSE });

  it("prepares the real nonconstant parse owner and captures its semantic boundary without a provider", () => {
    const { source, fn } = requireSource({ ...original, nativeStringValueProjection: "standalone-native" });
    const { coercion } = requireNumberBoundary(fn);
    expect(coercion.value).toBe(fn.params[0]!.value);
    expect(fn.params[0]!.type).toEqual({ kind: "string" });
    const captured = captureTypedIrProgramInput(source);
    const capturedFunction = captured.ir.functions.find((candidate) => candidate.unitId === fn.unitId)!;
    requireNumberBoundary(capturedFunction);
    expect(captured.ir).toEqual(source.ir);
    expect(captured.ir).not.toBe(source.ir);
    expect(captured.inventory).toEqual(source.inventory);
    expect(Object.hasOwn(captured, "nativeStringValueProjection")).toBe(false);
    expect(Object.hasOwn(captured, "stringNumericCoercion")).toBe(false);
    expect(original.policy).toEqual({ backend: "wasmgc", target: "standalone" });
  });

  it("does not infer the selection from a standalone target", () => {
    const { fn } = requireSource(original);
    requireHistoricalStringNumber(fn);
    expect(requireSource({ ...original, nativeStringValueProjection: undefined }).source).toEqual(
      requireSource(original).source,
    );
  });

  it.each(["disabled", "number-boundary", "host", "", null, true])(
    "rejects invalid explicit source selection %j before reading source files",
    (invalid) => {
      let reads = 0;
      const input: IrProgramSourceInput = {
        ...original,
        get sourceFiles() {
          reads++;
          throw new Error("source planning must not start for an invalid projection");
        },
      };
      Reflect.set(input, "nativeStringValueProjection", invalid);
      requireInvalid(() => prepareIrProgramSources(input), "native string-value source projection");
      expect(reads).toBe(0);
    },
  );

  const incompatiblePolicies: readonly RuntimeManifestPolicy[] = [
    { backend: "wasmgc", target: "host" },
    { backend: "wasmgc", target: "wasi" },
    { backend: "wasmgc", target: "strict-no-host" },
    { backend: "linear", target: "standalone" },
  ];
  it.each(incompatiblePolicies)("rejects source policy $backend:$target before source planning", (policy) => {
    let reads = 0;
    requireInvalid(
      () =>
        prepareIrProgramSources({
          ...original,
          policy,
          nativeStringValueProjection: "standalone-native",
          get sourceFiles() {
            reads++;
            throw new Error("source planning must not start for a conflicting source policy");
          },
        }),
      "native string-value source projection",
    );
    expect(reads).toBe(0);
  });

  it.each(incompatiblePolicies)("rejects every requested $backend:$target projection before lowering", (policy) => {
    for (const runtimePolicies of [
      [original.policy, policy],
      [policy, original.policy],
    ]) {
      let reads = 0;
      requireInvalid(
        () =>
          prepareWholeIrProgram({
            ...original,
            nativeStringValueProjection: "standalone-native",
            runtimePolicies,
            get sourceFiles() {
              reads++;
              throw new Error("lowering must not start for any conflicting runtime projection");
            },
          }),
        "cannot request a runtime projection outside wasmgc:standalone",
      );
      expect(reads).toBe(0);
    }
  });

  it.each([
    ["duplicate", [original.policy, original.policy]],
    ["missing source", [{ backend: "wasmgc", target: "host" }]],
  ] satisfies readonly (readonly [string, readonly RuntimeManifestPolicy[]])[])(
    "preserves the earlier %s runtime-policy invariant",
    (_label, runtimePolicies) => {
      requireInvalid(
        () => prepareWholeIrProgram({ ...original, nativeStringValueProjection: "standalone-native", runtimePolicies }),
        "runtime policies duplicate a backend/target pair or omit the source preparation policy",
      );
    },
  );
});

describe("source admission review controls", () => {
  it.each(["+", "-"])("evaluates a genuinely effectful string-returning call once under unary %s", (operator) => {
    const input = sourceInput({
      "./entry.ts": `var visits: number = 0;
function next(s: string): string { visits = visits + 1; return s; }
export function parse(s: string): number { return ${operator}next(s); }`,
    });
    const { source, fn } = requireSource({ ...input, nativeStringValueProjection: "standalone-native" });
    const next = source.ir.functions.find((candidate) => candidate.name === "next");
    if (!next) throw new Error("missing real side-effecting source owner");
    const writes = instructions(next).filter((row) => row.kind === "global.set");
    expect(writes).toHaveLength(1);
    expect(source.globals).toHaveLength(1);
    expect(writes[0]!.target).toEqual(source.globals[0]!.binding.globalRef);
    expect(instructions(next).filter((row) => row.kind === "binary" && row.op === "f64.add")).toHaveLength(1);
    expect(next.resultTypes).toEqual([{ kind: "string" }]);

    const rows = instructions(fn);
    const calls = rows.filter((row) => row.kind === "call");
    const coercions = rows.filter((row) => row.kind === "coerce.to_externref");
    const unboxes = rows.filter((row) => row.kind === "intrinsic" && row.id === "js.number.unbox");
    expect(calls).toHaveLength(1);
    expect(coercions).toHaveLength(1);
    expect(unboxes).toHaveLength(1);
    const call = calls[0]!,
      coercion = coercions[0]!,
      unbox = unboxes[0]!;
    expect(call).toMatchObject({
      target: { binding: { kind: "unit", unitId: next.unitId } },
      args: [fn.params[0]!.value],
      resultType: { kind: "string" },
    });
    expect(call.result).not.toBeNull();
    expect(coercion).toMatchObject({ value: call.result, resultType: EXTERNREF });
    expect(unbox).toMatchObject({ args: [coercion.result], version: 1, resultType: NUMBER });
    expect(Object.hasOwn(unbox, "provider")).toBe(false);
    expect(rows.indexOf(call)).toBeLessThan(rows.indexOf(coercion));
    expect(rows.indexOf(coercion)).toBeLessThan(rows.indexOf(unbox));
    const negations = rows.filter((row) => row.kind === "unary" && row.op === "f64.neg");
    expect(negations).toEqual(
      operator === "-" ? [expect.objectContaining({ rand: unbox.result, resultType: NUMBER })] : [],
    );
    if (operator === "-") expect(rows.indexOf(unbox)).toBeLessThan(rows.indexOf(negations[0]!));
    expect(rows.filter((row) => row.kind === "box" || row.kind === "dyn.to_number")).toEqual([]);
    // Omission still evaluates the same source call once, using its historical string conversion.
    const omitted = requireSource(input).fn;
    requireHistoricalStringNumber(omitted);
    expect(instructions(omitted).filter((row) => row.kind === "call")).toEqual(calls);
  });

  it("preserves complete checker-certified Number(c ? '42' : 7) IR under either selection", () => {
    vi.stubEnv("JS2WASM_IR_MIXED_PRIMITIVE_CONDITIONAL", "1");
    vi.stubEnv("JS2WASM_TEST_TAMPER_IR_MIXED_PRIMITIVE_CONDITIONAL", "");
    const input = sourceInput({
      "./entry.ts": "export function parse(c: boolean): number { return Number(c ? '42' : 7); }",
    });
    const declaration = input.entrySource.statements.find(ts.isFunctionDeclaration)!;
    const returned = declaration.body!.statements.find(ts.isReturnStatement)!.expression!;
    if (!ts.isCallExpression(returned) || !ts.isIdentifier(returned.expression))
      throw new Error("fixture lost its actual Number call");
    const conditional = returned.arguments[0]!;
    if (!ts.isConditionalExpression(conditional)) throw new Error("fixture lost its mixed conditional");
    const ambient = makeIrAmbientBindingPredicate(input.checker);
    const symbol = input.checker.getSymbolAtLocation(returned.expression);
    expect(symbol?.declarations?.some((node) => node.getSourceFile().isDeclarationFile)).toBe(true);
    expect(ambient(returned.expression)).toBe(true);
    expect(input.checker.getTypeAtLocation(conditional.whenTrue).flags & ts.TypeFlags.StringLike).not.toBe(0);
    expect(input.checker.getTypeAtLocation(conditional.whenFalse).flags & ts.TypeFlags.NumberLike).not.toBe(0);
    const identityContext = buildIrPlanningIdentityContext(
      buildIrUnitInventory(input.sourceFiles, { entrySource: input.entrySource, checker: input.checker }),
    );
    const ownerUnitId = identityContext.unitIdByDeclaration.get(declaration)!;
    const options: AstToIrOptions = {
      ownerUnitId,
      identityContext,
      checker: input.checker,
      resolver: { isAmbientBinding: ambient },
    };
    const omitted = lowerFunctionAstToIr(declaration, options);
    const enabled = lowerFunctionAstToIr(declaration, { ...options, stringNumericCoercion: "number-boundary" });
    expect(enabled).toEqual(omitted);
    requireHistoricalStringNumber(omitted.main);
    const rows = instructions(omitted.main);
    const branches = rows.filter((row) => row.kind === "if");
    expect(branches).toHaveLength(1);
    expect(branches[0]!.then.filter((row) => row.kind === "dyn.to_number")).toHaveLength(1);
    expect(branches[0]!.else.filter((row) => row.kind === "dyn.to_number")).toEqual([]);
    expect(rows.filter((row) => row.kind === "string.const")).toEqual([expect.objectContaining({ value: "42" })]);
    expect(rows.filter((row) => row.kind === "call" || row.kind === "intrinsic")).toEqual([]);
  });

  it("preserves a checker-resolved source function shadowing Number instead of certifying the builtin", () => {
    const input = sourceInput({
      "./entry.ts":
        "function Number(s: string): number { return 7; } export function parse(s: string): number { return Number(s); }",
    });
    const declaration = input.entrySource.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "parse",
    )!;
    const returned = declaration.body!.statements.find(ts.isReturnStatement)!.expression!;
    if (!ts.isCallExpression(returned) || !ts.isIdentifier(returned.expression))
      throw new Error("fixture lost its shadowed Number call");
    const shadow = input.checker.getSymbolAtLocation(returned.expression)?.valueDeclaration;
    expect(shadow?.getSourceFile()).toBe(input.entrySource);
    expect(makeIrAmbientBindingPredicate(input.checker)(returned.expression)).toBe(false);
    const omitted = requireSource(input);
    const enabled = requireSource({ ...input, nativeStringValueProjection: "standalone-native" });
    expect(enabled.source.ir).toEqual(omitted.source.ir);
    const owner = omitted.source.ir.functions.find((fn) => fn.name === "Number")!;
    const calls = instructions(enabled.fn).filter((row) => row.kind === "call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: { binding: { kind: "unit", unitId: owner.unitId } } });
    expect(instructions(enabled.fn).filter((row) => row.kind === "intrinsic" || row.kind === "dyn.to_number")).toEqual(
      [],
    );
  });

  it("successfully prepares a numeric whole program with the explicit option and a valid runtime policy", () => {
    const input = sourceInput({ "./entry.ts": "export function parse(n: number): number { return +n; }" });
    const omitted = prepareWholeIrProgram(input);
    const enabled = prepareWholeIrProgram({
      ...input,
      nativeStringValueProjection: "standalone-native",
      runtimePolicies: [input.policy],
    });
    expect(omitted.kind, JSON.stringify(omitted)).toBe("prepared");
    expect(enabled.kind, JSON.stringify(enabled)).toBe("prepared");
    if (omitted.kind !== "prepared" || enabled.kind !== "prepared")
      throw new Error("valid numeric preparation refused");
    expect(encodePreparedIrProgram(enabled.program)).toBe(encodePreparedIrProgram(omitted.program));
    expect(enabled.program).toMatchObject({
      schema: "prepared-ir-program-v1",
      sealed: true,
      reconciliation: "complete",
    });
    expect(enabled.program.ir.functions).toHaveLength(1);
    expect(enabled.program.runtime).toHaveLength(1);
    expect(enabled.program.runtime[0]).toMatchObject({ backend: "wasmgc", target: "standalone" });
    expect(enabled.program.ir.functions[0]!.resultTypes).toEqual([NUMBER]);
    expect(instructions(enabled.program.ir.functions[0]!).filter((row) => row.kind === "intrinsic")).toEqual([]);
  });

  it("measures whole string preparation with an explicit native-unbox policy, without physical emission", () => {
    const input = sourceInput({ "./entry.ts": PARSE });
    const policy: RuntimeManifestPolicy = {
      backend: "wasmgc",
      target: "standalone",
      numberBoundary: { box: "unsupported", unbox: "native" },
    };
    const phases: string[] = [];
    const unsubscribe = subscribePreparedIrProgram((event) => phases.push(event.phase));
    let result: ReturnType<typeof prepareWholeIrProgram>;
    try {
      result = prepareWholeIrProgram({
        ...input,
        policy,
        runtimePolicies: [policy],
        nativeStringValueProjection: "standalone-native",
      });
    } finally {
      unsubscribe();
    }
    // This assertion measures preparation, not acceptance, allocation, Wasm emission or execution.
    expect(result.kind, JSON.stringify(result)).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    expect(phases).toEqual(["prepared"]);
    expect(result.program.runtime).toHaveLength(1);
    requireNumberBoundary(result.program.ir.functions[0]!);
    const projection = result.program.runtime[0]!.prepared;
    expect(projection.manifest.policy.numberBoundary).toEqual({ box: "unsupported", unbox: "native" });
    expect(projection.manifest.providers.filter((provider) => provider.feature === "js.number.unbox")).toEqual([
      expect.objectContaining({
        id: "native.js.number.unbox",
        implementation: { kind: "runtime-callable", symbol: "__unbox_number" },
      }),
    ]);
    const unboxes = instructions(projection.functions[0]!).filter(
      (row) => row.kind === "intrinsic" && row.id === "js.number.unbox",
    );
    expect(unboxes).toHaveLength(1);
    expect(unboxes[0]).toMatchObject({
      provider: { kind: "callable", target: { binding: { kind: "runtime", symbol: "__unbox_number" } } },
    });
  });
});
