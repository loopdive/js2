// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import {
  deriveNativeValueResourcePlan,
  assertNativeValueResourcePlan,
} from "../src/ir/program/native-value-resources.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
  requireCompletedNativeValues,
  type NativeValueDependencies,
} from "../src/backend/wasmgc/resources/native-values.js";
import { buildUnboxNumberBody } from "../src/runtime/wasmgc/values/number-bodies.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
const policy = { backend: "wasmgc", target: "standalone" } as const;
const primitiveSource = "export function main(value: number): number { return value; }";
function prepare(replay = false, text = primitiveSource) {
  const source = prepareIrProgramSources({ ...sourceInput({ "./entry.ts": text }), policy });
  if (source.kind !== "prepared") throw Error(source.detail);
  const packet = captureTypedIrProgramInput(source);
  const program = requireProgram(
    prepareTypedIrProgram(replay ? decodeTypedPacket(encodeTypedPacket(packet)) : packet, {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
    }),
  );
  const projection = program.runtime[0]!;
  return { program, projection, plan: deriveNativeValueResourcePlan(program, projection, "primitive-only") };
}
let cached: ReturnType<typeof prepare> | undefined;
const actual = () => (cached ??= prepare());
const absent = (): NativeValueDependencies => ({ strings: { kind: "absent" } });

function reserve(plan = actual().plan) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const dependencies = absent();
  const pack = reserveNativeValueResources(tx, plan, dependencies);
  const f64 = { kind: "f64" } as const,
    i32 = { kind: "i32" } as const,
    extern = { kind: "externref" } as const;
  const roundtrip = tx.reserveFunction("control:roundtrip", "roundtrip", { params: [f64], results: [f64] });
  const small = tx.reserveFunction("control:small", "small", { params: [f64], results: [i32] });
  const boolean = tx.reserveFunction("control:boolean", "boolean", { params: [i32], results: [extern] });
  const undefinedValue = tx.reserveFunction("control:undefined", "undefinedValue", { params: [], results: [extern] });
  const tag = tx.reserveFunction("control:tag", "tag", { params: [], results: [i32] });
  return { module, tx, dependencies, plan, pack, roundtrip, small, boolean, undefinedValue, tag };
}

function filled(plan = actual().plan) {
  const state = reserve(plan);
  const { tx, dependencies, roundtrip, small, boolean, undefinedValue, tag } = state;
  tx.freezeReservations();
  fillNativeValueResources(tx, state.pack, dependencies);
  const pack = requireCompletedNativeValues(tx, state.pack, plan, dependencies);
  expect(pack).toBe(state.pack);
  tx.fillFunction(roundtrip, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: pack.functions.boxNumber.handle },
      { op: "call", funcIdx: pack.functions.unboxNumber.handle },
    ],
  });
  tx.fillFunction(small, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: pack.functions.boxNumber.handle },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: -20 },
    ],
  });
  tx.fillFunction(boolean, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: pack.types.boxedBoolean.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(undefinedValue, {
    locals: [],
    body: [{ op: "global.get", index: tx.physicalIndex(pack.globals.undefined) }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(tag, {
    locals: [],
    body: [
      { op: "global.get", index: tx.physicalIndex(pack.globals.undefined) },
      { op: "struct.get", typeIdx: pack.types.anyValue.typeIndex, fieldIdx: 0 },
    ],
  });
  for (const [name, fn] of Object.entries({
    box: pack.functions.boxNumber,
    unbox: pack.functions.unboxNumber,
    isNumber: pack.functions.isNumber,
    roundtrip,
    small,
    boolean,
    undefinedValue,
    tag,
  }))
    tx.defineExport("export:" + name, name, fn);
  return state;
}
interface Exports {
  box(value: number): unknown;
  unbox(value: unknown): number;
  isNumber(value: unknown): number;
  roundtrip(value: number): number;
  small(value: number): number;
  boolean(value: number): unknown;
  undefinedValue(): unknown;
  tag(): number;
}
function execute(plan = actual().plan) {
  const { module, tx, pack, dependencies } = filled(plan);
  const census = tx.seal();
  expect(requireCompletedNativeValues(tx, pack, plan, dependencies)).toBe(pack);
  const binary = emitBinary(module);
  const compiled = new WebAssembly.Module(binary as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  return { exports: new WebAssembly.Instance(compiled, {}).exports as unknown as Exports, census };
}
let execution: ReturnType<typeof execute> | undefined;
const executed = () => (execution ??= execute());

describe("native primitive resources: executed bodies, not signature-only admission", () => {
  it("uses actual source-produced requirements and the complete single-ledger fill census", () => {
    const { program, plan } = actual();
    expect(plan.owners).toEqual(program.ir.functions.map((fn) => fn.unitId));
    expect(plan.owners.length).toBeGreaterThan(0);
    expect(executed().census.completedFunctions).toBe(8);
    expect(executed().census.completedGlobals).toBe(1);
    expect(executed().census.types).toBeGreaterThanOrEqual(6);
  });
  it.each([-1073741824, -1073741823, -1, 0, 1, 1073741822, 1073741823])(
    "executes signed-i31 boxing and numeric recovery for %s",
    (value) => {
      const x = executed().exports;
      expect(x.small(value)).toBe(1);
      expect(x.isNumber(x.box(value))).toBe(1);
      expect(Object.is(x.roundtrip(value), value)).toBe(true);
    },
  );
  it.each([-1073741825, 1073741824, 3e9, -0, 1.5, -1.5, NaN, Infinity, -Infinity])(
    "executes boxed-f64 preservation for %s",
    (value) => {
      const x = executed().exports;
      expect(x.small(value)).toBe(0);
      expect(x.isNumber(x.box(value))).toBe(1);
      expect(Object.is(x.roundtrip(value), value)).toBe(true);
    },
  );
  it("executes boolean conversion before the opaque fallback", () => {
    const x = executed().exports;
    expect(x.unbox(x.boolean(0))).toBe(0);
    expect(x.unbox(x.boolean(1))).toBe(1);
    expect(x.isNumber(x.boolean(1))).toBe(0);
  });
  it("executes distinct canonical undefined and null behavior", () => {
    const x = executed().exports,
      undefinedValue = x.undefinedValue();
    expect(undefinedValue).not.toBeNull();
    expect(x.undefinedValue()).toBe(undefinedValue);
    expect(x.tag()).toBe(1);
    expect(x.unbox(null)).toBe(0);
    expect(x.unbox(undefinedValue)).toBeNaN();
    expect(x.isNumber(null)).toBe(0);
    expect(x.isNumber(undefinedValue)).toBe(0);
  });
  it("keeps primitive-only absence source-bound across codec replay", () => {
    const direct = actual(),
      replay = prepare(true);
    expect(replay.plan).toEqual(direct.plan);
    expect(() => assertNativeValueResourcePlan(replay.plan)).not.toThrow();
    expect(() => assertNativeValueResourcePlan({ ...replay.plan })).toThrow("unissued");
  });
  it("rejects an unsealed program only after its real positive", () => {
    const { program, projection, plan } = actual();
    expect(() => assertNativeValueResourcePlan(plan)).not.toThrow();
    expect(() =>
      deriveNativeValueResourcePlan(
        { ...program, sealed: false } as unknown as typeof program,
        projection,
        "primitive-only",
      ),
    ).toThrow("complete prepared program");
  });
  it("rejects an omitted selected owner after authentic scalar preparation", () => {
    const { program, projection, plan } = actual();
    assertNativeValueResourcePlan(plan);
    const missing = { ...projection, prepared: { ...projection.prepared, functions: [] } };
    const changed = { ...program, runtime: [missing] };
    expect(() => deriveNativeValueResourcePlan(changed, missing, "primitive-only")).toThrow("owner population");
  });
  it("does not infer scanner absence from a source owner with an unaccounted carrier", () => {
    const { program, projection, plan } = actual();
    assertNativeValueResourcePlan(plan);
    const first = program.ir.functions[0]!;
    const functions = [
      { ...first, resultTypes: [{ kind: "val", val: { kind: "externref" } } as const] },
      ...program.ir.functions.slice(1),
    ];
    const changed = { ...program, ir: { ...program.ir, functions } };
    expect(() => deriveNativeValueResourcePlan(changed, projection, "primitive-only")).toThrow(
      "reference/unknown signature",
    );
  });
  it("does not turn a missing scanner into absence in the native-string representation", () => {
    const { program, projection } = actual();
    expect(() => reserve()).not.toThrow();
    const plan = deriveNativeValueResourcePlan(program, projection, "native-string");
    const tx = new PhysicalModuleReservations(createEmptyModule());
    expect(() => reserveNativeValueResources(tx, plan, absent())).toThrow("actual StringToNumber");
  });
  it("requires explicit builder-side string selection", () => {
    expect(buildUnboxNumberBody(0, 1, { kind: "absent", evidence: "selected-primitive-only" })).not.toHaveLength(0);
    expect(() => buildUnboxNumberBody(0, 1, undefined!)).toThrow("explicit string conversion");
    expect(() =>
      buildUnboxNumberBody(0, 1, { kind: "native-string", anyStringTypeIdx: 2, toNumber: undefined! }),
    ).toThrow("unresolved string conversion");
  });
  it("rejects fills before freeze and duplicate fills", () => {
    const first = reserve();
    expect(() => fillNativeValueResources(first.tx, first.pack, first.dependencies)).toThrow(
      "physical index requested in reserving",
    );
    const second = filled();
    expect(() => fillNativeValueResources(second.tx, second.pack, second.dependencies)).toThrow("duplicate");
  });
  it("rejects a foreign transaction and copied resource wrapper", () => {
    const state = filled();
    expect(() =>
      fillNativeValueResources(new PhysicalModuleReservations(createEmptyModule()), state.pack, state.dependencies),
    ).toThrow("foreign");
    expect(() => fillNativeValueResources(state.tx, { ...state.pack }, state.dependencies)).toThrow("foreign");
  });
  it("retains missing-fill failure for real reserved resources", () => {
    expect(executed().census.completedGlobals).toBe(1);
    const state = reserve();
    state.tx.freezeReservations();
    expect(() => state.tx.seal()).toThrow(/missing .* fill/);
  });
  it("rejects stale/altered primitive layout after a real positive", () => {
    expect(executed().exports.roundtrip(3e9)).toBe(3e9);
    const state = reserve();
    const type = state.pack.types.boxedNumber.object;
    if (type.kind !== "struct") throw Error("missing actual number struct");
    type.fields[0]!.mutable = true;
    expect(() => state.tx.freezeReservations()).toThrow("altered");
  });
  it("rejects a wrong callable signature at the original ledger boundary", () => {
    expect(executed().exports.roundtrip(-0)).toBe(-0);
    const state = reserve();
    state.pack.functions.unboxNumber.object.typeIdx = state.pack.functions.boxNumber.object.typeIdx;
    expect(() => state.tx.freezeReservations()).toThrow();
  });
  it.each([0, 1, 2, 3, 4, 5])("rejects a changed undefined initializer instruction %s", (index) => {
    expect(executed().exports.tag()).toBe(1);
    const state = filled();
    state.pack.globals.undefined.object.init[index] = { op: "i32.const", value: 42 };
    expect(() => state.tx.seal()).toThrow("altered");
  });
});

describe("native value producer completion authority", () => {
  it("returns exact pack with a fresh containing dependency record without side effects", () => {
    const state = filled();
    const before = structuredClone(state.module);
    const spies = [
      vi.spyOn(state.tx, "reserveType"),
      vi.spyOn(state.tx, "reserveFunction"),
      vi.spyOn(state.tx, "reserveGlobal"),
      vi.spyOn(state.tx, "internFunctionType"),
      vi.spyOn(state.tx, "fillFunction"),
      vi.spyOn(state.tx, "fillGlobal"),
      vi.spyOn(state.tx, "defineExport"),
      vi.spyOn(state.tx, "seal"),
    ];
    expect(requireCompletedNativeValues(state.tx, state.pack, state.plan, absent())).toBe(state.pack);
    expect(state.tx.state).toBe("filling");
    expect(state.module).toStrictEqual(before);
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });
  it("executes decoded source-bound resources through completion before and after seal", () => {
    const x = execute(prepare(true).plan).exports;
    for (const value of [-1073741824, 1073741823, 70, 3e9, -0, 1.5, NaN, Infinity, -Infinity]) {
      expect(Object.is(x.roundtrip(value), value)).toBe(true);
      expect(x.isNumber(x.box(value))).toBe(1);
    }
    expect(x.tag()).toBe(1);
    expect(x.unbox(x.undefinedValue())).toBeNaN();
    expect(x.unbox(null)).toBe(0);
    expect(x.unbox(x.boolean(1))).toBe(1);
  });
  it("rejects a distinct genuinely issued equal-visible plan", () => {
    const state = filled();
    expect(requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toBe(state.pack);
    const { program, projection } = actual();
    const other = deriveNativeValueResourcePlan(program, projection, "primitive-only");
    assertNativeValueResourcePlan(other);
    expect(other).toEqual(state.plan);
    expect(other).not.toBe(state.plan);
    expect(() => requireCompletedNativeValues(state.tx, state.pack, other, state.dependencies)).toThrow(
      "substituted native value requirements",
    );
  });
  it("rejects foreign transactions and copied packs after a real completion", () => {
    const state = filled();
    expect(requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toBe(state.pack);
    expect(() =>
      requireCompletedNativeValues(
        new PhysicalModuleReservations(createEmptyModule()),
        state.pack,
        state.plan,
        state.dependencies,
      ),
    ).toThrow("foreign");
    expect(() => requireCompletedNativeValues(state.tx, { ...state.pack }, state.plan, state.dependencies)).toThrow(
      "foreign",
    );
  });
  it("rejects a genuine unfilled pack without marking it completed", () => {
    const positive = filled();
    expect(requireCompletedNativeValues(positive.tx, positive.pack, positive.plan, positive.dependencies)).toBe(
      positive.pack,
    );
    const state = reserve();
    state.tx.freezeReservations();
    expect(() => requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toThrow(
      "incomplete native value resources",
    );
    expect(state.tx.state).toBe("filling");
  });
  for (const stopped of [0, 1, 2, 3])
    it(`rejects real producer interrupted at fill ${stopped}`, () => {
      const positive = filled();
      expect(requireCompletedNativeValues(positive.tx, positive.pack, positive.plan, positive.dependencies)).toBe(
        positive.pack,
      );
      const state = reserve();
      state.tx.freezeReservations();
      const sentinel = new Error("stop actual fill " + stopped);
      const global = state.tx.fillGlobal.bind(state.tx),
        fn = state.tx.fillFunction.bind(state.tx);
      let calls = 0;
      vi.spyOn(state.tx, "fillGlobal").mockImplementation((...args) => {
        if (calls++ === stopped) throw sentinel;
        return global(...args);
      });
      vi.spyOn(state.tx, "fillFunction").mockImplementation((...args) => {
        if (calls++ === stopped) throw sentinel;
        return fn(...args);
      });
      let caught: unknown;
      try {
        fillNativeValueResources(state.tx, state.pack, state.dependencies);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      expect(calls).toBe(stopped + 1);
      expect(state.tx.state).toBe("filling");
      expect(() => requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toThrow(
        "incomplete native value resources",
      );
    });
  // Mandatory countermodels: returning from an intercepted ledger operation is
  // not proof that its token entered the ledger's successful-fill map.
  for (const omitted of [0, 1, 2, 3])
    it(`rejects nonthrowing omission of fill ${omitted}`, () => {
      const positive = filled();
      expect(requireCompletedNativeValues(positive.tx, positive.pack, positive.plan, positive.dependencies)).toBe(
        positive.pack,
      );
      const state = reserve();
      state.tx.freezeReservations();
      const global = state.tx.fillGlobal.bind(state.tx),
        fn = state.tx.fillFunction.bind(state.tx);
      let calls = 0;
      vi.spyOn(state.tx, "fillGlobal").mockImplementation((...args) => {
        if (calls++ === omitted) return;
        return global(...args);
      });
      vi.spyOn(state.tx, "fillFunction").mockImplementation((...args) => {
        if (calls++ === omitted) return;
        return fn(...args);
      });
      fillNativeValueResources(state.tx, state.pack, state.dependencies);
      expect(calls).toBe(4);
      expect(() => requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toThrow();
    });
  for (const mutation of ["body", "locals", "initializer", "type"] as const)
    it(`rejects post-fill ${mutation} drift via completion accessor`, () => {
      const state = filled();
      expect(requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toBe(state.pack);
      if (mutation === "body") state.pack.functions.boxNumber.object.body.push({ op: "unreachable" });
      if (mutation === "locals")
        state.pack.functions.unboxNumber.object.locals.push({ name: "foreign", type: { kind: "i32" } });
      if (mutation === "initializer") state.pack.globals.undefined.object.init[0] = { op: "i32.const", value: 42 };
      if (mutation === "type") state.pack.types.boxedBoolean.object.name = "foreign";
      expect(() => requireCompletedNativeValues(state.tx, state.pack, state.plan, state.dependencies)).toThrow();
    });
});

// Fixed 5118637 donor receipts. Tests read mandatory LIVE files only. Whitespace
// and optional separators are irrelevant; the complete parsed tree, lexical
// operators/declaration keywords and comments are not. This also covers every
// retained union helper, nested callback, cache write and registration position.
const sourcePaths = {
  any: "src/codegen/any-helpers.ts",
  union: "src/codegen/registry/imports.ts",
  layouts: "src/runtime/wasmgc/values/primitive-layouts.ts",
  numbers: "src/runtime/wasmgc/values/number-bodies.ts",
} as const;
type Sources = Record<keyof typeof sourcePaths, string>;
function liveSources(): Sources {
  return Object.fromEntries(
    Object.entries(sourcePaths).map(([key, path]) => [
      key,
      readFileSync(resolve(import.meta.dirname, "..", path), "utf8"),
    ]),
  ) as Sources;
}
function parsed(text: string): ts.SourceFile {
  const file = ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length)
    throw Error("native value receipt: invalid syntax");
  return file;
}
function sourceHash(text: string): string {
  const file = parsed(text);
  const comments = new Map<number, ts.CommentRange>();
  function tree(node: ts.Node): unknown {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ])
      comments.set(range.pos, range);
    const children = node
      .getChildren(file)
      .filter(
        (child) =>
          ![ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.EndOfFileToken].includes(
            child.kind,
          ) && !(child.kind >= ts.SyntaxKind.FirstJSDocNode && child.kind <= ts.SyntaxKind.LastJSDocNode),
      );
    return [node.kind, children.length ? children.map(tree) : node.getText(file)];
  }
  const syntax = tree(file);
  const docs = [...comments.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((range) => [
      range.kind,
      text
        .slice(range.pos, range.end)
        .split("\n")
        .map((line) => line.trim())
        .join("\n"),
    ]);
  return createHash("sha256")
    .update(JSON.stringify([syntax, docs]))
    .digest("hex");
}
/** Supplemental receipt: visit punctuation/EOF before any syntax filtering. */
function completeCommentReceipt(text: string): { count: number; sha256: string } {
  const file = parsed(text);
  const comments = new Map<number, ts.CommentRange>();
  function visit(node: ts.Node): void {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ])
      comments.set(range.pos, range);
    // The entire JSDoc range is captured as trivia. Its interior is prose, not
    // a second JavaScript token stream. All actual tokens, including commas,
    // semicolons and EOF, are otherwise visited without omission.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    for (const child of node.getChildren(file)) visit(child);
  }
  visit(file);
  const rows = [...comments.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((range) => [
      range.kind,
      text
        .slice(range.pos, range.end)
        .split("\n")
        .map((line) => line.trim())
        .join("\n"),
    ]);
  return { count: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}
function replaceOnce(text: string, before: string, after: string): string {
  const start = text.indexOf(before);
  if (start < 0 || text.indexOf(before, start + before.length) >= 0)
    throw Error("missing/duplicate mapped edit: " + before);
  return text.slice(0, start) + after + text.slice(start + before.length);
}
function returned(text: string, name: string): string {
  const matches = parsed(text).statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (matches.length !== 1 || !matches[0]!.body) throw Error("missing/duplicate canonical builder " + name);
  const returns = matches[0]!.body!.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0]!.expression) throw Error("missing canonical return " + name);
  return returns[0]!.expression!.getText();
}
function expandCall(text: string, name: string, expectedArgs: string[], body: string): string {
  const file = parsed(text),
    matches: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name)
      matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (matches.length !== 1) throw Error("missing/duplicate downward call " + name);
  const call = matches[0]!;
  if (
    call.arguments.length !== expectedArgs.length ||
    call.arguments.some((arg, i) => sourceHash(arg.getText()) !== sourceHash(expectedArgs[i]!))
  )
    throw Error("altered downward arguments " + name);
  return text.slice(0, call.getStart()) + body + text.slice(call.end);
}
function removeImport(text: string, target: string, bindings: string[]): string {
  const file = parsed(text);
  const matches = file.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === target,
  );
  if (matches.length !== 1) throw Error("missing/duplicate canonical import " + target);
  const node = matches[0]!,
    clause = node.importClause;
  if (
    !clause ||
    clause.isTypeOnly ||
    clause.name ||
    !clause.namedBindings ||
    !ts.isNamedImports(clause.namedBindings) ||
    node.attributes ||
    JSON.stringify(
      clause.namedBindings.elements.map((binding) => [
        binding.name.text,
        binding.propertyName?.text,
        binding.isTypeOnly,
      ]),
    ) !== JSON.stringify(bindings.map((name) => [name, undefined, false]))
  )
    throw Error("altered canonical import " + target);
  return text.slice(0, node.getStart()) + text.slice(node.end);
}
const sourceReceipts = {
  any: "04071954b55d418ae7049b184c1b005e8fede0559ab0ad69f017ff08e087c635",
  union: "7f8be351ea8004c7e86240336700fbd925c1632186011d7d94baf3854c59e0d8",
  layouts: "e84e851859b521b4ed31afa86559a1427f32bc877da2c59335e001d6b7fc1281",
  numbers: "ec5282195166408a0504c8cb75fe758723a3c0e85e1c848822bc12af1dc2e70d",
} as const;
// Additive only: the two original module hashes and two current delta hashes
// above remain unchanged. Historical comment rows come from the exact 5118637
// donors; new-owner comment rows come from the frozen rev1 canonical files.
const commentReceipts = {
  any: { count: 476, sha256: "e35e9db59375f54f74bc491a39aba1f0eede0224894a9f8824447fb923f63c68" },
  union: { count: 595, sha256: "21581e0cb2aa1c7df12188a698c2b86c43075934e21d5eea64511d6e2bcad0f6" },
  layouts: { count: 9, sha256: "34bb559fdbccc741ffb7d5523124f07522e084b8530ebbe35392c9ad44cdac7b" },
  numbers: { count: 32, sha256: "a42a5c888b538b807f71341fc2b90fc433c6964f7bfbe10dcef2b52f8f4b7b57" },
} as const;
function verifyCommentReceipt(text: string, owner: keyof Sources): void {
  const actual = completeCommentReceipt(text),
    expected = commentReceipts[owner];
  if (actual.count !== expected.count || actual.sha256 !== expected.sha256)
    throw Error("complete comment receipt: " + owner);
}
function historicalSources(live: Sources): Pick<Sources, "any" | "union"> {
  // Supplemental current delta pins include every new guard, signature, import
  // and attached document. They do not replace either original donor receipt.
  for (const owner of ["layouts", "numbers"] as const) {
    if (!live[owner] || sourceHash(live[owner]) !== sourceReceipts[owner])
      throw Error("canonical source receipt: " + owner);
    verifyCommentReceipt(live[owner], owner);
  }
  let any = removeImport(live.any, "../runtime/wasmgc/values/primitive-layouts.js", [
    "buildAnyValueType",
    "buildUndefinedInitializer",
  ]);
  any = expandCall(any, "buildAnyValueType", [], returned(live.layouts, "buildAnyValueType"));
  any = expandCall(
    any,
    "buildUndefinedInitializer",
    ["anyTypeIdx"],
    returned(live.layouts, "buildUndefinedInitializer"),
  );
  const singletonGuard = "if ((ctx.standalone || ctx.nativeStrings) && ctx.undefinedGlobalIdx === undefined) {";
  any = replaceOnce(
    any,
    singletonGuard,
    singletonGuard + "\nconst EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type",
  );
  let union = removeImport(live.union, "../../runtime/wasmgc/values/primitive-layouts.js", [
    "buildBoxNumberType",
    "buildBoxBooleanType",
  ]);
  union = removeImport(union, "../../runtime/wasmgc/values/number-bodies.js", [
    "buildBoxNumberBody",
    "buildBoxNumberLocals",
    "buildUnboxNumberBody",
    "buildUnboxNumberLocals",
    "buildTypeofNumberBody",
  ]);
  for (const name of ["buildBoxNumberType", "buildBoxBooleanType"])
    union = expandCall(union, name, [], returned(live.layouts, name));
  for (const name of ["buildBoxNumberBody", "buildTypeofNumberBody"])
    union = expandCall(union, name, ["boxNumStructIdx"], returned(live.numbers, name));
  for (const [name, kind] of [
    ["buildBoxNumberLocals", "i32"],
    ["buildUnboxNumberLocals", "anyref"],
  ]) {
    const locals = replaceOnce(
      returned(live.numbers, name!),
      '{ kind: "' + kind + '" }',
      '{ kind: "' + kind + '" } as ValType',
    );
    union = expandCall(union, name!, [], locals);
  }
  let unbox = returned(live.numbers, "buildUnboxNumberBody");
  unbox = replaceOnce(
    unbox,
    'strings.kind === "native-string"',
    "strToNumberIdx !== undefined && ctx.anyStrTypeIdx >= 0",
  );
  unbox = replaceOnce(unbox, "strings.anyStringTypeIdx", "ctx.anyStrTypeIdx");
  unbox = replaceOnce(unbox, "strings.toNumber", "strToNumberIdx");
  union = expandCall(
    union,
    "buildUnboxNumberBody",
    [
      "boxNumStructIdx",
      "boxBoolStructIdx",
      `strToNumberIdx !== undefined && ctx.anyStrTypeIdx >= 0
    ? { kind: "native-string", anyStringTypeIdx: ctx.anyStrTypeIdx, toNumber: strToNumberIdx }
    : { kind: "absent", evidence: "selected-primitive-only" }`,
    ],
    unbox,
  );
  return { any, union };
}
function verifySourceReceipts(live: Sources): void {
  const historical = historicalSources(live);
  for (const owner of ["any", "union"] as const) {
    if (sourceHash(historical[owner]) !== sourceReceipts[owner]) throw Error("historical donor receipt: " + owner);
    verifyCommentReceipt(historical[owner], owner);
  }
}

describe("mandatory live native-value donor reconstruction", () => {
  it("retains both complete donor modules, including nested bodies, docs and unrelated BigInt", () => {
    verifySourceReceipts(liveSources());
  });
  it.each(["layouts", "numbers"] as const)("rejects missing canonical %s", (owner) => {
    const live = liveSources();
    verifySourceReceipts(live);
    const changed = { ...live, [owner]: "" };
    expect(() => verifySourceReceipts(changed)).toThrow();
  });
  it.each([
    ["numbers", 'op: "i32.shl"', 'op: "i32.shr_s"'],
    ["numbers", 'name: "$i31_temp"', 'name: "$lost"'],
    ["numbers", "!Number.isInteger(strings.toNumber)", "~Number.isInteger(strings.toNumber)"],
    ["numbers", "return [", "const ignored = 1; return ["],
    ["layouts", "const EQ_HEAP_TYPE", "let EQ_HEAP_TYPE"],
    ["layouts", 'name: "tag"', 'name: "lost"'],
    ["layouts", "value: NaN", "value: 0"],
    ["layouts", "tag = 1 (Undefined)", "tag = 1 (Null)"],
    ["union", "ctx.nativeBoxNumberTypeIdx = boxNumStructIdx;", "ctx.nativeBoxNumberTypeIdx = boxBoolStructIdx;"],
    ["union", 'kind: "i64", bigint: true', 'kind: "i64", bigint: false'],
    ["union", "buildBoxNumberBody(boxNumStructIdx)", "buildBoxNumberBody(boxBoolStructIdx)"],
    ["any", "ctx.undefinedGlobalIdx = globalIdx;", "ctx.undefinedGlobalIdx = globalIdx + 1;"],
  ] as const)("rejects live %s mutation %s", (owner, before, after) => {
    const live = liveSources();
    verifySourceReceipts(live);
    // Some literals recur in a complete donor. Change one actual occurrence;
    // the original full-module receipt still covers every remaining occurrence.
    if (!live[owner].includes(before)) throw Error("mutation did not find live input");
    const changed = { ...live, [owner]: live[owner].replace(before, after) };
    expect(() => verifySourceReceipts(changed)).toThrow();
  });
  it.each([
    'import type { CodegenContext } from "../../../codegen/context/types.js";',
    'import { addFuncType } from "../../../codegen/registry/types.js";',
    'export * from "../../../codegen/index.js";',
    'type Hidden = import("../../../codegen/context/types.js").CodegenContext;',
  ])("rejects a forbidden upward edge: %s", (edge) => {
    const live = liveSources();
    verifySourceReceipts(live);
    const changed = { ...live, layouts: live.layouts + "\n" + edge };
    expect(() => verifySourceReceipts(changed)).toThrow();
  });
  it("rejects registration reordering rather than canonicalizing it away", () => {
    const live = liveSources();
    verifySourceReceipts(live);
    const declaration = "ctx.nativeBoxNumberTypeIdx = boxNumStructIdx;";
    const changed = {
      ...live,
      union: replaceOnce(
        replaceOnce(live.union, declaration, ""),
        "ctx.nativeBoxBooleanTypeIdx = boxBoolStructIdx;",
        "ctx.nativeBoxBooleanTypeIdx = boxBoolStructIdx;\n" + declaration,
      ),
    };
    expect(() => verifySourceReceipts(changed)).toThrow();
  });
});

describe("legacy source callers of the same canonical native number bodies", () => {
  it.each([
    ["boolean true", "Number(new Boolean(true))", 1],
    ["boolean false", "Number(new Boolean(false))", 0],
    ["StringToNumber", '(new String("3e9") as any) - 0', 3e9],
    ["StringToNumber exponent", '(new String(" 1.25e2 ") as any) - 0', 125],
  ] as const)("executes the actual standalone %s path without host imports", async (_label, expression, expected) => {
    const { compile } = await import("../src/index.js");
    const result = await compile(`export function main(): number { return ${expression}; }`, {
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    const module = await WebAssembly.compile(result.binary as BufferSource);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.main as () => number)()).toBe(expected);
  });
});
