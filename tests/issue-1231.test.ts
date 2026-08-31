// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1231 — typed object-literal facts are unconditional. The retired control is
// assembled below solely from fragments, leaving no live configuration spelling.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import {
  buildIrUnitTypeMap,
  buildTypeMap,
  irFnctorInputStringAtom,
  type IrFnctorAdmission,
  type LatticeAtom,
  type LatticeType,
  type TypeMapEntry,
} from "../src/ir/propagate.js";
import { planIrCompilationByIdentity } from "../src/ir/select-identity.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const STALE_OBJECT_FACT_KEY = ["JS2WASM", "IR", "OBJECT", "SHAPES"].join("_");
const DIRECT_BODY_POISON_KEY = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const TARGETS = ["gc", "standalone"] as const;
const STALE_VALUES = [undefined, "0", "1", "false"] as const;

type Target = (typeof TARGETS)[number];
type StaleValue = (typeof STALE_VALUES)[number];

const F64 = { kind: "f64" } as const;
const STRING = { kind: "string" } as const;
const DYNAMIC = { kind: "dynamic" } as const;
const UNKNOWN = { kind: "unknown" } as const;

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface TypeRow {
  readonly name: string;
  readonly entry: TypeMapEntry;
}

interface WatField {
  readonly name: string;
  readonly storage: string;
}

interface WatRegistrationExpectation {
  readonly declarationOrdinal: number;
}

type OptimizationArm = "unoptimized" | "optimized";

interface FinalBinaryFunctionExpectation {
  readonly exportName: string;
  readonly allocationCount: number;
  readonly readFields: readonly number[];
  readonly calls?: readonly string[];
}

interface FinalBinaryStructExpectation {
  readonly storage: readonly string[];
  readonly functions: readonly FinalBinaryFunctionExpectation[];
}

interface RuntimeExpectation {
  readonly name: string;
  readonly args: readonly number[];
  readonly value: number;
}

interface OutcomeExpectation {
  readonly name: string;
  readonly kind: "emitted" | "unsupported";
  readonly code?: string;
  readonly detailByTarget?: Readonly<Record<Target, string>>;
}

interface Fixture {
  readonly id: string;
  readonly fileName: string;
  readonly source: string;
  readonly names: readonly string[];
  readonly typeRows: readonly TypeRow[];
  readonly watFields: readonly WatField[];
  readonly standaloneWatFields?: readonly WatField[];
  readonly watRegistrationByTarget: Readonly<Partial<Record<Target, WatRegistrationExpectation>>>;
  readonly finalBinaryByTarget?: Readonly<
    Partial<Record<Target, Readonly<Partial<Record<OptimizationArm, FinalBinaryStructExpectation>>>>>
  >;
  readonly hostFields: readonly string[];
  readonly runtime: readonly RuntimeExpectation[];
  readonly outcomes: readonly OutcomeExpectation[];
  readonly emitted: readonly string[];
  readonly hostImports: readonly string[];
  readonly hostExtraExports?: readonly string[];
  readonly standaloneExports: readonly string[];
}

interface SourceQualifiedTypeRow {
  readonly sourceId: string;
  readonly unitId: string;
  readonly displayName: string;
  readonly entry: TypeMapEntry;
}

interface SourceQualifiedSelection {
  readonly sourceId: string;
  readonly unitId: string;
  readonly displayName: string;
}

interface OutcomeProjection {
  readonly sourceId: string | undefined;
  readonly unitId: string | undefined;
  readonly displayName: string;
  readonly unitKind: string;
  readonly kind: "emitted" | "unsupported";
  readonly code?: string;
  readonly detail?: string;
  readonly stage: "patch" | "resolve" | "build";
  readonly legacyBodyEmitted: boolean;
  readonly irBodyEmitted: boolean;
  readonly backend: string;
  readonly target: Target;
}

interface WatProjection {
  readonly fields: readonly WatField[];
  readonly registration: string;
  readonly registrationName: string;
  readonly declarationOrdinal: number;
}

interface FinalBinaryFunctionProjection {
  readonly exportName: string;
  readonly functionSymbol: string;
  readonly allocationCount: number;
  readonly readFields: readonly number[];
  readonly calls: readonly string[];
}

interface FinalBinaryProjection {
  readonly sha256: string;
  readonly typeSymbol: string;
  readonly storage: readonly string[];
  readonly functions: readonly FinalBinaryFunctionProjection[];
}

interface ArtifactProjection {
  readonly typeRows: readonly SourceQualifiedTypeRow[];
  readonly selection: readonly SourceQualifiedSelection[];
  readonly outcomes: readonly OutcomeProjection[];
  readonly compiled: readonly string[];
  readonly skipped: readonly string[];
  readonly postClaimErrors: readonly { readonly kind: string; readonly func: string; readonly message: string }[];
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly wat: WatProjection;
  readonly finalBinary?: FinalBinaryProjection;
  readonly binaryHash: string;
  readonly runtime: readonly RuntimeExpectation[];
}

interface StaticFixtureProjection {
  readonly sourceId: string;
  readonly typeRows: readonly SourceQualifiedTypeRow[];
  readonly selection: readonly SourceQualifiedSelection[];
  readonly unitIdByName: ReadonlyMap<string, string>;
}

type DeepMutable<T> = T extends readonly (infer Value)[]
  ? DeepMutable<Value>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function objectShape(fields: readonly [string, LatticeAtom][]): LatticeType {
  return { kind: "object", fields: fields.map(([name, type]) => ({ name, type })) };
}

const POINT_SHAPE = objectShape([
  ["x", F64],
  ["y", F64],
]);
const USER_SHAPE = objectShape([
  ["age", F64],
  ["name", STRING],
]);

function row(name: string, params: readonly LatticeType[], returnType: LatticeType): TypeRow {
  return { name, entry: { params, returnType } };
}

function parityDetail(ir: number, legacy: number): string {
  return `function typeIdx parity mismatch: IR=${ir}, legacy=${legacy} — keeping legacy body`;
}

function parityDetails(
  gc: readonly [ir: number, legacy: number],
  standalone: readonly [ir: number, legacy: number],
): Readonly<Record<Target, string>> {
  return {
    gc: parityDetail(...gc),
    standalone: parityDetail(...standalone),
  };
}

function watRegistration(declarationOrdinal: number): WatRegistrationExpectation {
  return { declarationOrdinal };
}

function finalBinaryStruct(
  storage: readonly string[],
  functions: readonly FinalBinaryFunctionExpectation[],
): FinalBinaryStructExpectation {
  return { storage, functions };
}

const DATA_STRUCT_BRIDGE_TAIL = [
  "__is_data_struct",
  "$d0",
  "__struct_field_names",
  "$d1",
  "__\u0000js2_data_struct_host_bridge_marker",
  "$dt",
  "__\u0000js2_data_struct_host_bridge_bindings",
  "$du",
  "__\u0000js2_data_struct_host_bridge_token",
  "$dv",
  "__\u0000js2_data_struct_host_bridge",
  "$dm",
] as const;

function hostObjectExports(
  names: readonly string[],
  fields: readonly string[],
  extras: readonly string[] = [],
): readonly string[] {
  return [
    ...names,
    ...fields.map((field) => `__sget_${field}`),
    ...fields.map((field) => `__sset_${field}`),
    ...extras,
    ...DATA_STRUCT_BRIDGE_TAIL,
  ];
}

const FIXTURES: readonly Fixture[] = [
  {
    id: "point",
    fileName: "issue-1231-point.ts",
    source: `
      export function createPoint(x, y) { return { x: x, y: y }; }
      export function distance(p) { return p.x * p.x + p.y * p.y; }
      export function run() { return distance(createPoint(3, 4)); }
    `,
    names: ["createPoint", "distance", "run"],
    typeRows: [row("createPoint", [F64, F64], POINT_SHAPE), row("distance", [POINT_SHAPE], F64), row("run", [], F64)],
    watFields: [
      { name: "x", storage: "f64" },
      { name: "y", storage: "f64" },
    ],
    watRegistrationByTarget: {
      gc: watRegistration(13),
      standalone: watRegistration(83),
    },
    finalBinaryByTarget: {
      gc: {
        unoptimized: finalBinaryStruct(
          ["f64", "f64"],
          [
            { exportName: "createPoint", allocationCount: 0, readFields: [] },
            { exportName: "distance", allocationCount: 0, readFields: [] },
            { exportName: "run", allocationCount: 1, readFields: [0, 0, 1, 1] },
          ],
        ),
        optimized: finalBinaryStruct(
          ["f64", "f64"],
          [
            { exportName: "createPoint", allocationCount: 0, readFields: [] },
            { exportName: "distance", allocationCount: 0, readFields: [] },
            { exportName: "run", allocationCount: 0, readFields: [] },
          ],
        ),
      },
      standalone: {
        unoptimized: finalBinaryStruct(
          ["f64", "f64"],
          [
            { exportName: "createPoint", allocationCount: 0, readFields: [] },
            { exportName: "distance", allocationCount: 0, readFields: [] },
            { exportName: "run", allocationCount: 1, readFields: [0, 0, 1, 1] },
          ],
        ),
        optimized: finalBinaryStruct(
          ["f64", "f64"],
          [
            { exportName: "createPoint", allocationCount: 0, readFields: [] },
            { exportName: "distance", allocationCount: 0, readFields: [] },
            { exportName: "run", allocationCount: 0, readFields: [] },
          ],
        ),
      },
    },
    hostFields: ["x", "y"],
    runtime: [{ name: "run", args: [], value: 25 }],
    outcomes: [
      {
        name: "createPoint",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([22, 11], [124, 45]),
      },
      {
        name: "distance",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([23, 12], [125, 50]),
      },
      { name: "run", kind: "emitted" },
    ],
    emitted: ["run"],
    hostImports: ["env::__box_number", "env::__extern_get", "env::__new_TypeError", "env::__unbox_number"],
    hostExtraExports: [
      "__vec_len",
      "__vec_get",
      "__is_vec",
      "__vec_mut_supported",
      "__vec_push",
      "__vec_pop",
      "__exn_tag",
    ],
    standaloneExports: [
      "createPoint",
      "__box_number",
      "__box_boolean",
      "__box_bigint",
      "__typeof_number",
      "__unbox_number",
      "__typeof_boolean",
      "__unbox_boolean",
      "__typeof_bigint",
      "__to_bigint",
      "__any_box_null",
      "__any_box_undefined",
      "__dynamic_boundary_tag",
      "distance",
      "run",
      "__exn_tag",
    ],
  },
  {
    id: "user",
    fileName: "issue-1231-user.ts",
    source: `
      export function createUser(name, age) { return { name: name, age: age }; }
      export function getAge(user) { return user.age; }
      export function run() { return getAge(createUser("Alice", 30)); }
    `,
    names: ["createUser", "getAge", "run"],
    typeRows: [row("createUser", [STRING, F64], USER_SHAPE), row("getAge", [USER_SHAPE], F64), row("run", [], F64)],
    watFields: [
      { name: "age", storage: "f64" },
      { name: "name", storage: "externref" },
    ],
    standaloneWatFields: [
      { name: "age", storage: "f64" },
      { name: "name", storage: "(ref null 6)" },
    ],
    watRegistrationByTarget: {
      gc: watRegistration(14),
      standalone: watRegistration(83),
    },
    hostFields: ["name", "age"],
    runtime: [{ name: "run", args: [], value: 30 }],
    outcomes: [
      {
        name: "createUser",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([22, 11], [123, 45]),
      },
      {
        name: "getAge",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([23, 12], [124, 55]),
      },
      {
        name: "run",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([24, 13], [125, 91]),
      },
    ],
    emitted: [],
    hostImports: [
      "env::__box_number",
      "env::__extern_get",
      "env::__get_undefined",
      "env::__new_TypeError",
      "env::__unbox_number",
    ],
    hostExtraExports: [
      "__vec_len",
      "__vec_get",
      "__is_vec",
      "__vec_mut_supported",
      "__vec_push",
      "__vec_pop",
      "__exn_tag",
    ],
    standaloneExports: [
      "createUser",
      "__box_number",
      "__box_boolean",
      "__box_bigint",
      "__typeof_number",
      "__unbox_number",
      "__typeof_boolean",
      "__unbox_boolean",
      "__typeof_bigint",
      "__to_bigint",
      "__any_box_null",
      "__any_box_undefined",
      "__dynamic_boundary_tag",
      "getAge",
      "run",
      "__exn_tag",
    ],
  },
  {
    id: "vec2-add",
    fileName: "issue-1231-vec2-add.ts",
    source: `
      export function vec2(x, y) { return { x: x, y: y }; }
      export function add(ax, ay, bx, by) { return vec2(ax + bx, ay + by); }
      export function runX() { return add(1, 2, 3, 4).x; }
      export function runY() { return add(1, 2, 3, 4).y; }
    `,
    names: ["vec2", "add", "runX", "runY"],
    typeRows: [
      row("vec2", [F64, F64], POINT_SHAPE),
      row("add", [F64, F64, F64, F64], POINT_SHAPE),
      row("runX", [], F64),
      row("runY", [], F64),
    ],
    watFields: [
      { name: "x", storage: "f64" },
      { name: "y", storage: "f64" },
    ],
    watRegistrationByTarget: {
      gc: watRegistration(7),
      standalone: watRegistration(84),
    },
    hostFields: ["x", "y"],
    runtime: [
      { name: "runX", args: [], value: 4 },
      { name: "runY", args: [], value: 6 },
    ],
    outcomes: [
      {
        name: "vec2",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([22, 11], [124, 45]),
      },
      {
        name: "add",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([23, 12], [125, 122]),
      },
      {
        name: "runX",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([24, 13], [126, 91]),
      },
      {
        name: "runY",
        kind: "unsupported",
        code: "abi-signature-parity",
        detailByTarget: parityDetails([24, 13], [126, 91]),
      },
    ],
    emitted: [],
    hostImports: ["env::__box_number", "env::__host_add", "env::__unbox_number"],
    standaloneExports: [
      "vec2",
      "__box_number",
      "__box_boolean",
      "__box_bigint",
      "__typeof_number",
      "__unbox_number",
      "__typeof_boolean",
      "__unbox_boolean",
      "__typeof_bigint",
      "__to_bigint",
      "__any_box_null",
      "__any_box_undefined",
      "__dynamic_boundary_tag",
      "add",
      "runX",
      "runY",
      "__exn_tag",
    ],
  },
];

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = previous;
}

async function withEnvValue<T>(key: string, value: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
  try {
    expect(process.env[key]).toBe(value);
    const result = await action();
    expect(process.env[key]).toBe(value);
    return result;
  } finally {
    restoreEnv(key, previous);
  }
}

function assertComputedStaleKey(): void {
  expect(STALE_OBJECT_FACT_KEY).toHaveLength(24);
  expect(createHash("sha256").update(STALE_OBJECT_FACT_KEY).digest("hex")).toBe(
    "2e7e87334a747b163cb457a4999c560fbcb40b762ed4f580c0fa29d0f7e20989",
  );
}

async function withStaleValue<T>(value: StaleValue, action: () => Promise<T>): Promise<T> {
  assertComputedStaleKey();
  return withEnvValue(STALE_OBJECT_FACT_KEY, value, action);
}

function expectedOutcomeDetail(outcome: OutcomeExpectation, target: Target): string {
  const detail = outcome.detailByTarget?.[target];
  if (!detail) throw new Error(`missing exact ${target} refusal detail for ${outcome.name}`);
  return detail;
}

function expectedOutcomeRows(
  fixture: Fixture,
  target: Target,
  staticProjection: StaticFixtureProjection,
): OutcomeProjection[] {
  return fixture.outcomes.map((expected) => {
    const unitId = staticProjection.unitIdByName.get(expected.name);
    if (!unitId) throw new Error(`missing exact terminal identity for ${expected.name}`);
    return {
      sourceId: staticProjection.sourceId,
      unitId,
      displayName: expected.name,
      unitKind: "function",
      kind: expected.kind,
      ...(expected.code === undefined ? {} : { code: expected.code }),
      ...(expected.kind === "unsupported" ? { detail: expectedOutcomeDetail(expected, target) } : {}),
      stage: expected.kind === "emitted" ? "patch" : "resolve",
      legacyBodyEmitted: true,
      irBodyEmitted: expected.kind === "emitted",
      backend: "wasmgc",
      target,
    };
  });
}

function inspectStaticFixture(fixture: Fixture): StaticFixtureProjection {
  const ast = analyzeSource(fixture.source, fixture.fileName);
  const compatibilityMap = buildTypeMap(ast.sourceFile, ast.checker);
  expect([...compatibilityMap.keys()]).toEqual(fixture.names);
  expect(
    fixture.names.map((name) => {
      const entry = compatibilityMap.get(name);
      if (!entry) throw new Error(`missing TypeMap entry for ${name}`);
      return { name, entry };
    }),
  ).toEqual(fixture.typeRows);

  const inventory = buildIrUnitInventory([ast.sourceFile], { checker: ast.checker, entrySource: ast.sourceFile });
  const identity = buildIrPlanningIdentityContext(inventory);
  const source = inventory.sources[0];
  if (!source) throw new Error("fixture has no exact source record");
  const unitIdByName = new Map<string, string>();
  for (const name of fixture.names) {
    const units = inventory.terminalUnits.filter((unit) => unit.sourceId === source.id && unit.displayName === name);
    expect(units, `terminal identity for ${name}`).toHaveLength(1);
    unitIdByName.set(name, units[0]!.id);
  }
  const selection = fixture.names.map((displayName) => ({
    sourceId: source.id,
    unitId: unitIdByName.get(displayName)!,
    displayName,
  }));
  expect([...planIrCompilation(ast.sourceFile, { experimentalIR: true }, compatibilityMap).funcs]).toEqual(
    fixture.names,
  );
  const unitMap = buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity);
  const identitySelection = planIrCompilationByIdentity(ast.sourceFile, identity, { experimentalIR: true }, unitMap);
  expect(
    [...identitySelection.funcs.values()].map((unit) => ({
      sourceId: source.id,
      unitId: unit.unitId,
      displayName: unit.displayName,
    })),
  ).toEqual(selection);
  return {
    sourceId: source.id,
    typeRows: fixture.names.map((displayName) => ({
      sourceId: source.id,
      unitId: unitIdByName.get(displayName)!,
      displayName,
      entry: compatibilityMap.get(displayName)!,
    })),
    selection,
    unitIdByName,
  };
}

function extractFuncBody(wat: string, funcName: string): string | null {
  const start = wat.search(new RegExp(`\\(func\\s+\\$${funcName}\\b`));
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  return null;
}

function expectedWatFields(fixture: Fixture, target: Target): readonly WatField[] {
  return target === "standalone" ? (fixture.standaloneWatFields ?? fixture.watFields) : fixture.watFields;
}

function expectedWatRegistration(fixture: Fixture, target: Target): WatRegistrationExpectation {
  const registration = fixture.watRegistrationByTarget[target];
  if (!registration) throw new Error(`missing exact typed-struct registration for ${fixture.id}/${target}`);
  return registration;
}

function parseWatTypeDeclarations(
  wat: string,
): readonly { readonly ordinal: number; readonly name: string; readonly text: string }[] {
  const declarations: { ordinal: number; name: string; text: string }[] = [];
  for (const line of wat.split("\n")) {
    const name = line.match(/^\s*\(type\s+(\$[^\s()]+)/)?.[1];
    if (!name) continue;
    declarations.push({ ordinal: declarations.length, name, text: line });
  }
  return declarations;
}

function inspectWat(
  fixture: Fixture,
  target: Target,
  wat: string,
  registrationExpectation = expectedWatRegistration(fixture, target),
): WatProjection {
  const fields = expectedWatFields(fixture, target);
  const matchingStructDeclarations = parseWatTypeDeclarations(wat).filter((declaration) => {
    if (!declaration.text.includes("(struct")) return false;
    const fieldNames = [...declaration.text.matchAll(/\(field \$([^\s()]+) /g)].map((match) => match[1]);
    return (
      fieldNames.length === fields.length &&
      fieldNames.every((name, index) => name === fields[index]?.name) &&
      fields.every((field) => declaration.text.includes(`(field $${field.name} (mut ${field.storage}))`))
    );
  });
  expect(matchingStructDeclarations, `exact typed WAT struct for ${fixture.id}`).toHaveLength(1);
  const registration = matchingStructDeclarations[0]!;
  expect(registration.ordinal, `typed-struct declaration ordinal for ${fixture.id}/${target}`).toBe(
    registrationExpectation.declarationOrdinal,
  );
  return {
    fields,
    registration: registration.text,
    registrationName: registration.name,
    declarationOrdinal: registration.ordinal,
  };
}

type BinaryenWatNode = string | readonly BinaryenWatNode[];
type BinaryenWatList = readonly BinaryenWatNode[];

interface BinaryenDisassembly {
  readonly sha256: string;
  readonly wat: string;
}

interface FinalBinaryTypeIdentity {
  readonly typeSymbol: string;
  readonly storage: readonly string[];
}

interface ResolvedFinalBinaryFunction {
  readonly exportName: string;
  readonly functionSymbol: string;
  readonly body: BinaryenWatList;
}

const FINAL_BINARY_DISASSEMBLY_BY_SHA = new Map<string, BinaryenDisassembly>();
const WASM_DIS_PATH = (() => {
  try {
    return createRequire(import.meta.url).resolve("binaryen/bin/wasm-dis");
  } catch (error) {
    throw new Error(`cannot resolve binaryen/bin/wasm-dis: ${String(error)}`);
  }
})();
const WASM_DIS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function isBinaryenWatList(node: BinaryenWatNode): node is BinaryenWatList {
  return Array.isArray(node);
}

function binaryenWatHead(node: BinaryenWatNode): string | undefined {
  return isBinaryenWatList(node) && typeof node[0] === "string" ? node[0] : undefined;
}

function requireBinaryenWatAtom(node: BinaryenWatNode | undefined, context: string): string {
  if (typeof node !== "string") throw new Error(`missing exact Binaryen WAT atom for ${context}`);
  return node;
}

function tokenizeBinaryenWat(wat: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < wat.length) {
    const current = wat[index]!;
    if (/\s/u.test(current)) {
      index++;
      continue;
    }
    if (current === ";" && wat[index + 1] === ";") {
      index += 2;
      while (index < wat.length && wat[index] !== "\n") index++;
      continue;
    }
    if (current === "(" && wat[index + 1] === ";") {
      index += 2;
      let depth = 1;
      while (index < wat.length && depth > 0) {
        if (wat[index] === "(" && wat[index + 1] === ";") {
          depth++;
          index += 2;
        } else if (wat[index] === ";" && wat[index + 1] === ")") {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      if (depth !== 0) throw new Error("unterminated Binaryen WAT block comment");
      continue;
    }
    if (current === "(" || current === ")") {
      tokens.push(current);
      index++;
      continue;
    }
    if (current === '"') {
      const start = index++;
      let closed = false;
      while (index < wat.length) {
        if (wat[index] === "\\") {
          index += 2;
          continue;
        }
        if (wat[index++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("unterminated Binaryen WAT string");
      tokens.push(wat.slice(start, index));
      continue;
    }
    const start = index;
    while (index < wat.length) {
      const next = wat[index]!;
      if (/\s/u.test(next) || next === "(" || next === ")" || (next === ";" && wat[index + 1] === ";")) break;
      index++;
    }
    if (start === index) throw new Error(`invalid Binaryen WAT token at offset ${index}`);
    tokens.push(wat.slice(start, index));
  }
  return tokens;
}

function parseBinaryenWatExpression(wat: string): BinaryenWatList {
  const tokens = tokenizeBinaryenWat(wat);
  let index = 0;
  const parseNode = (): BinaryenWatNode => {
    const token = tokens[index++];
    if (token === undefined) throw new Error("unexpected end of Binaryen WAT");
    if (token === ")") throw new Error("unexpected Binaryen WAT closing parenthesis");
    if (token !== "(") return token;
    const nodes: BinaryenWatNode[] = [];
    while (tokens[index] !== ")") {
      if (tokens[index] === undefined) throw new Error("unterminated Binaryen WAT expression");
      nodes.push(parseNode());
    }
    index++;
    return nodes;
  };
  const roots: BinaryenWatNode[] = [];
  while (index < tokens.length) roots.push(parseNode());
  if (roots.length !== 1 || !isBinaryenWatList(roots[0])) {
    throw new Error("expected one Binaryen WAT expression");
  }
  return roots[0];
}

function renderBinaryenWat(node: BinaryenWatNode): string {
  return typeof node === "string" ? node : `(${node.map(renderBinaryenWat).join(" ")})`;
}

interface BinaryenTextForm {
  readonly head: string;
  readonly text: string;
}

function skipBinaryenWatTrivia(wat: string, start: number): number {
  let index = start;
  while (index < wat.length) {
    if (/\s/u.test(wat[index]!)) {
      index++;
      continue;
    }
    if (wat[index] === ";" && wat[index + 1] === ";") {
      index += 2;
      while (index < wat.length && wat[index] !== "\n") index++;
      continue;
    }
    if (wat[index] === "(" && wat[index + 1] === ";") {
      index += 2;
      let depth = 1;
      while (index < wat.length && depth > 0) {
        if (wat[index] === "(" && wat[index + 1] === ";") {
          depth++;
          index += 2;
        } else if (wat[index] === ";" && wat[index + 1] === ")") {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      if (depth !== 0) throw new Error("unterminated Binaryen WAT block comment");
      continue;
    }
    break;
  }
  return index;
}

function readBinaryenWatAtom(wat: string, start: number): { readonly atom: string; readonly end: number } {
  const index = skipBinaryenWatTrivia(wat, start);
  if (wat[index] === undefined || wat[index] === "(" || wat[index] === ")") {
    throw new Error(`expected Binaryen WAT atom at offset ${index}`);
  }
  if (wat[index] === '"') {
    const stringStart = index;
    let cursor = index + 1;
    while (cursor < wat.length) {
      if (wat[cursor] === "\\") {
        cursor += 2;
      } else if (wat[cursor++] === '"') {
        return { atom: wat.slice(stringStart, cursor), end: cursor };
      }
    }
    throw new Error("unterminated Binaryen WAT string");
  }
  let cursor = index;
  while (cursor < wat.length) {
    const current = wat[cursor]!;
    if (/\s/u.test(current) || current === "(" || current === ")" || (current === ";" && wat[cursor + 1] === ";")) {
      break;
    }
    cursor++;
  }
  if (cursor === index) throw new Error(`invalid Binaryen WAT atom at offset ${index}`);
  return { atom: wat.slice(index, cursor), end: cursor };
}

function scanBinaryenWatExpressionEnd(wat: string, start: number): number {
  if (wat[start] !== "(") throw new Error(`expected Binaryen WAT expression at offset ${start}`);
  let depth = 0;
  let index = start;
  while (index < wat.length) {
    if (wat[index] === '"') {
      index = readBinaryenWatAtom(wat, index).end;
      continue;
    }
    if (wat[index] === ";" && wat[index + 1] === ";") {
      index = skipBinaryenWatTrivia(wat, index);
      continue;
    }
    if (wat[index] === "(" && wat[index + 1] === ";") {
      index = skipBinaryenWatTrivia(wat, index);
      continue;
    }
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return index + 1;
    index++;
  }
  throw new Error("unterminated Binaryen WAT expression");
}

function topLevelBinaryenForms(wat: string): readonly BinaryenTextForm[] {
  const moduleStart = skipBinaryenWatTrivia(wat, 0);
  if (wat[moduleStart] !== "(") throw new Error("missing Binaryen WAT module");
  const moduleHead = readBinaryenWatAtom(wat, moduleStart + 1);
  if (moduleHead.atom !== "module") throw new Error("expected Binaryen WAT module");
  const moduleEnd = scanBinaryenWatExpressionEnd(wat, moduleStart);
  if (skipBinaryenWatTrivia(wat, moduleEnd) !== wat.length) throw new Error("trailing Binaryen WAT content");
  const forms: BinaryenTextForm[] = [];
  let index = moduleHead.end;
  while (true) {
    index = skipBinaryenWatTrivia(wat, index);
    if (index === moduleEnd - 1) return forms;
    if (index >= moduleEnd || wat[index] !== "(")
      throw new Error(`invalid Binaryen WAT module form at offset ${index}`);
    const head = readBinaryenWatAtom(wat, index + 1);
    const end = scanBinaryenWatExpressionEnd(wat, index);
    forms.push({ head: head.atom, text: wat.slice(index, end) });
    index = end;
  }
}

function directBinaryenTextForms(disassembly: BinaryenDisassembly, head: string): readonly BinaryenTextForm[] {
  return topLevelBinaryenForms(disassembly.wat).filter((form) => form.head === head);
}

function binaryenTextFormSymbol(form: BinaryenTextForm): string | undefined {
  const head = readBinaryenWatAtom(form.text, 1);
  if (head.atom !== form.head) throw new Error(`mismatched Binaryen WAT form head ${form.head}`);
  const symbolStart = skipBinaryenWatTrivia(form.text, head.end);
  if (form.text[symbolStart] === "(") return undefined;
  return readBinaryenWatAtom(form.text, symbolStart).atom;
}

function exactlyOne<T>(values: readonly T[], description: string): T {
  if (values.length !== 1) throw new Error(`expected exactly one ${description}, received ${values.length}`);
  return values[0]!;
}

function sameOrderedStorage(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((storage, index) => storage === right[index]);
}

function mutableStructStorage(type: BinaryenWatList): readonly string[] | undefined {
  if (binaryenWatHead(type) !== "type" || type.length !== 3 || !isBinaryenWatList(type[2])) return undefined;
  const struct = type[2];
  if (binaryenWatHead(struct) !== "struct") return undefined;
  const storage: string[] = [];
  for (const field of struct.slice(1)) {
    if (!isBinaryenWatList(field) || binaryenWatHead(field) !== "field" || field.length < 2) return undefined;
    const mutable = field[field.length - 1];
    if (!isBinaryenWatList(mutable) || binaryenWatHead(mutable) !== "mut" || mutable.length !== 2) return undefined;
    storage.push(renderBinaryenWat(mutable[1]!));
  }
  return storage;
}

function resolveFinalBinaryType(
  disassembly: BinaryenDisassembly,
  expectedStorage: readonly string[],
): FinalBinaryTypeIdentity {
  const matches = directBinaryenTextForms(disassembly, "type")
    .map((form) => {
      const type = parseBinaryenWatExpression(form.text);
      const typeSymbol = requireBinaryenWatAtom(type[1], "struct type identity");
      const storage = mutableStructStorage(type);
      return storage !== undefined && sameOrderedStorage(storage, expectedStorage)
        ? { typeSymbol, storage }
        : undefined;
    })
    .filter((candidate): candidate is FinalBinaryTypeIdentity => candidate !== undefined);
  return exactlyOne(matches, `final Binaryen struct with mutable layout ${expectedStorage.join(",")}`);
}

function resolveFinalBinaryFunction(disassembly: BinaryenDisassembly, exportName: string): ResolvedFinalBinaryFunction {
  const exportForm = exactlyOne(
    directBinaryenTextForms(disassembly, "export").filter((form) => {
      const parsed = parseBinaryenWatExpression(form.text);
      return parsed[1] === JSON.stringify(exportName);
    }),
    `final Binaryen export ${JSON.stringify(exportName)}`,
  );
  const parsedExport = parseBinaryenWatExpression(exportForm.text);
  const descriptor = parsedExport[2];
  if (!isBinaryenWatList(descriptor) || binaryenWatHead(descriptor) !== "func") {
    throw new Error(`final Binaryen export ${exportName} is not a function`);
  }
  const functionSymbol = requireBinaryenWatAtom(descriptor[1], `exported function ${exportName}`);
  const bodyForm = exactlyOne(
    directBinaryenTextForms(disassembly, "func").filter((form) => binaryenTextFormSymbol(form) === functionSymbol),
    `final Binaryen function ${functionSymbol} for export ${exportName}`,
  );
  const body = parseBinaryenWatExpression(bodyForm.text);
  return { exportName, functionSymbol, body };
}

function censusFinalBinaryTypeUse(
  body: BinaryenWatList,
  typeSymbol: string,
): Pick<FinalBinaryFunctionProjection, "allocationCount" | "readFields" | "calls"> {
  let allocationCount = 0;
  const readFields: number[] = [];
  const calls: string[] = [];
  const visit = (node: BinaryenWatNode): void => {
    if (!isBinaryenWatList(node)) return;
    if (binaryenWatHead(node) === "struct.new" && node[1] === typeSymbol) allocationCount++;
    if (binaryenWatHead(node) === "struct.get" && node[1] === typeSymbol) {
      const fieldIndex = requireBinaryenWatAtom(node[2], `struct.get field for ${typeSymbol}`);
      if (!/^(?:0|[1-9]\d*)$/u.test(fieldIndex)) {
        throw new Error(`non-numeric final Binaryen struct.get field ${fieldIndex} for ${typeSymbol}`);
      }
      readFields.push(Number(fieldIndex));
    }
    if (binaryenWatHead(node) === "call") {
      const target = requireBinaryenWatAtom(node[1], "direct final Binaryen call target");
      if (target[0] !== "$" || target.length === 1) {
        throw new Error(`invalid direct final Binaryen call target ${target}`);
      }
      calls.push(target);
    }
    for (const child of node) visit(child);
  };
  visit(body);
  return { allocationCount, readFields, calls };
}

function inspectFinalBinaryDisassembly(
  disassembly: BinaryenDisassembly,
  expected: FinalBinaryStructExpectation,
  fixtureExportNames: readonly string[],
): FinalBinaryProjection {
  const type = resolveFinalBinaryType(disassembly, expected.storage);
  const exportNames = expected.functions.map((entry) => entry.exportName);
  if (new Set(exportNames).size !== exportNames.length) throw new Error("duplicate final Binaryen export expectation");
  if (new Set(fixtureExportNames).size !== fixtureExportNames.length) throw new Error("duplicate fixture export name");
  if (exportNames.some((name) => !fixtureExportNames.includes(name))) {
    throw new Error("final Binaryen expectation names a non-fixture export");
  }
  if (exportNames.length !== fixtureExportNames.length) {
    throw new Error("final Binaryen expectation must freeze every fixture export");
  }
  const expectedByExport = new Map(expected.functions.map((entry) => [entry.exportName, entry]));
  const functions: FinalBinaryFunctionProjection[] = [];
  for (const exportName of fixtureExportNames) {
    const resolved = resolveFinalBinaryFunction(disassembly, exportName);
    const observed = {
      exportName,
      functionSymbol: resolved.functionSymbol,
      ...censusFinalBinaryTypeUse(resolved.body, type.typeSymbol),
    };
    const expectedFunction = expectedByExport.get(exportName);
    if (!expectedFunction) {
      if (observed.allocationCount !== 0 || observed.readFields.length !== 0) {
        throw new Error(`unfrozen exact final Binaryen type use in export ${exportName}`);
      }
      continue;
    }
    functions.push(observed);
  }
  if (new Set(functions.map((entry) => entry.functionSymbol)).size !== functions.length) {
    throw new Error("duplicate final Binaryen function identity for exact exports");
  }
  return { sha256: disassembly.sha256, typeSymbol: type.typeSymbol, storage: type.storage, functions };
}

function disassembleFinalBinary(binary: Uint8Array): BinaryenDisassembly {
  const sha256 = createHash("sha256").update(binary).digest("hex");
  const cached = FINAL_BINARY_DISASSEMBLY_BY_SHA.get(sha256);
  if (cached) return cached;
  const result = spawnSync(process.execPath, [WASM_DIS_PATH, "-", "--all-features"], {
    input: binary,
    maxBuffer: WASM_DIS_MAX_OUTPUT_BYTES,
  });
  const stderr = result.stderr;
  const diagnostic =
    stderr.length === 0
      ? "no stderr diagnostic"
      : (() => {
          try {
            return new TextDecoder("utf-8", { fatal: true }).decode(stderr).trim() || "empty stderr diagnostic";
          } catch {
            return "non-UTF-8 stderr diagnostic";
          }
        })();
  if (result.error) throw new Error(`wasm-dis spawn failed: ${result.error.message}; ${diagnostic}`);
  if (result.signal) throw new Error(`wasm-dis terminated by ${result.signal}; ${diagnostic}`);
  if (result.status !== 0) throw new Error(`wasm-dis exited ${String(result.status)}; ${diagnostic}`);
  if (stderr.length !== 0) throw new Error(`wasm-dis reported a diagnostic: ${diagnostic}`);
  if (result.stdout.length === 0) throw new Error("wasm-dis produced no stdout");
  let wat: string;
  try {
    wat = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    throw new Error("wasm-dis stdout is not valid UTF-8");
  }
  if (wat.trim().length === 0) throw new Error("wasm-dis produced empty text");
  const disassembly = { sha256, wat };
  FINAL_BINARY_DISASSEMBLY_BY_SHA.set(sha256, disassembly);
  return disassembly;
}

function inspectFinalBinary(
  binary: Uint8Array,
  expected: FinalBinaryStructExpectation,
  fixtureExportNames: readonly string[],
): FinalBinaryProjection {
  return inspectFinalBinaryDisassembly(disassembleFinalBinary(binary), expected, fixtureExportNames);
}

function inspectFinalBinaryText(
  wat: string,
  expected: FinalBinaryStructExpectation,
  fixtureExportNames: readonly string[],
): FinalBinaryProjection {
  return inspectFinalBinaryDisassembly(
    { sha256: createHash("sha256").update(wat).digest("hex"), wat },
    expected,
    fixtureExportNames,
  );
}

function optimizationArm(optimize: boolean): OptimizationArm {
  return optimize ? "optimized" : "unoptimized";
}

function expectedFinalBinary(
  fixture: Fixture,
  target: Target,
  optimize: boolean,
): FinalBinaryStructExpectation | undefined {
  return fixture.finalBinaryByTarget?.[target]?.[optimizationArm(optimize)];
}

function normalizeOutcome(outcome: IrObservedOutcome): OutcomeProjection {
  if (outcome.kind === "emitted") {
    return {
      sourceId: outcome.sourceId,
      unitId: outcome.unitId,
      displayName: outcome.displayName,
      unitKind: outcome.unitKind,
      kind: "emitted",
      stage: outcome.stage,
      legacyBodyEmitted: outcome.legacyBodyEmitted,
      irBodyEmitted: outcome.irBodyEmitted,
      backend: outcome.backend,
      target: outcome.target as Target,
    };
  }
  return {
    sourceId: outcome.sourceId,
    unitId: outcome.unitId,
    displayName: outcome.displayName,
    unitKind: outcome.unitKind,
    kind: "unsupported",
    code: outcome.code,
    detail: outcome.detail,
    stage: outcome.stage,
    legacyBodyEmitted: outcome.legacyBodyEmitted,
    irBodyEmitted: outcome.irBodyEmitted,
    backend: outcome.backend,
    target: outcome.target as Target,
  };
}

async function instantiate(
  result: CompileResult,
  target: Target,
): Promise<Record<string, (...args: number[]) => number>> {
  const imports = target === "standalone" ? {} : buildImports(result.imports, ENV_STUB, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  if (target !== "standalone") imports.setExports?.(exports);
  return exports;
}

function expectedExports(fixture: Fixture, target: Target): readonly string[] {
  if (target === "standalone") return fixture.standaloneExports;
  return hostObjectExports(fixture.names, fixture.hostFields, fixture.hostExtraExports);
}

function expectedPostClaimErrors(fixture: Fixture, target: Target): ArtifactProjection["postClaimErrors"] {
  return fixture.outcomes
    .filter((outcome) => outcome.kind === "unsupported")
    .map((outcome) => ({
      kind: "build",
      func: outcome.name,
      message: expectedOutcomeDetail(outcome, target),
    }));
}

function assertExactWatProjection(fixture: Fixture, target: Target, wat: WatProjection): void {
  // Custom WAT corroborates source field names only. Its declaration ordinals
  // and numeric operands are not authoritative after final binary layout.
  expect(wat.fields).toEqual(expectedWatFields(fixture, target));
  for (const field of wat.fields) {
    expect(wat.registration).toContain(`(field $${field.name} (mut ${field.storage}))`);
  }
  const registration = expectedWatRegistration(fixture, target);
  expect(wat.declarationOrdinal).toBe(registration.declarationOrdinal);
  expect(wat.registrationName).toMatch(/^\$/u);
}

function assertExactFinalBinaryProjection(
  fixture: Fixture,
  target: Target,
  optimize: boolean,
  projection: ArtifactProjection,
): void {
  const expected = expectedFinalBinary(fixture, target, optimize);
  if (!expected) {
    expect(projection.finalBinary).toBeUndefined();
    return;
  }
  if (!projection.finalBinary) throw new Error(`missing final Binaryen projection for ${fixture.id}/${target}`);
  expect(projection.finalBinary.sha256).toBe(projection.binaryHash);
  expect(projection.finalBinary.typeSymbol).toMatch(/^\$/u);
  expect(projection.finalBinary.storage).toEqual(expected.storage);
  expect(
    projection.finalBinary.functions.map(({ exportName, allocationCount, readFields }) => ({
      exportName,
      allocationCount,
      readFields,
    })),
  ).toEqual(
    expected.functions.map(({ exportName, allocationCount, readFields }) => ({
      exportName,
      allocationCount,
      readFields,
    })),
  );
  for (const expectedFunction of expected.functions) {
    if (expectedFunction.calls === undefined) continue;
    const observed = exactlyOne(
      projection.finalBinary.functions.filter((entry) => entry.exportName === expectedFunction.exportName),
      `final Binaryen projection for export ${expectedFunction.exportName}`,
    );
    expect(observed.calls).toEqual(expectedFunction.calls);
  }
  expect(new Set(projection.finalBinary.functions.map((entry) => entry.functionSymbol)).size).toBe(
    projection.finalBinary.functions.length,
  );
}

function assertExactProjection(
  fixture: Fixture,
  target: Target,
  optimize: boolean,
  staticProjection: StaticFixtureProjection,
  projection: ArtifactProjection,
  baseline?: ArtifactProjection,
): void {
  expect(projection.typeRows).toEqual(staticProjection.typeRows);
  expect(projection.selection).toEqual(staticProjection.selection);
  expect(projection.outcomes).toEqual(expectedOutcomeRows(fixture, target, staticProjection));
  expect(projection.compiled).toEqual(fixture.emitted);
  expect(projection.skipped).toEqual([]);
  expect(projection.postClaimErrors).toEqual(expectedPostClaimErrors(fixture, target));
  expect(projection.imports).toEqual(target === "gc" ? fixture.hostImports : []);
  expect(projection.exports).toEqual(expectedExports(fixture, target));
  assertExactWatProjection(fixture, target, projection.wat);
  expect(projection.binaryHash).toMatch(/^[a-f0-9]{64}$/);
  assertExactFinalBinaryProjection(fixture, target, optimize, projection);
  expect(projection.runtime).toEqual(fixture.runtime);
  if (baseline) {
    expect(projection.outcomes).toEqual(baseline.outcomes);
    expect(projection.postClaimErrors).toEqual(baseline.postClaimErrors);
    expect(projection.wat).toEqual(baseline.wat);
    expect(projection.finalBinary).toEqual(baseline.finalBinary);
    expect(projection.binaryHash).toBe(baseline.binaryHash);
  }
}

async function observeFixture(fixture: Fixture, target: Target, optimize: boolean): Promise<ArtifactProjection> {
  const staticProjection = inspectStaticFixture(fixture);
  const result = await compile(fixture.source, {
    fileName: fixture.fileName,
    experimentalIR: true,
    optimize,
    emitWat: true,
    target,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const exports = await instantiate(result, target);
  const runtime = fixture.runtime.map((expected) => {
    const fn = exports[expected.name];
    expect(fn, `runtime export ${expected.name}`).toBeTypeOf("function");
    return { ...expected, value: fn!(...expected.args) };
  });
  const finalBinaryExpectation = expectedFinalBinary(fixture, target, optimize);
  const binaryHash = createHash("sha256").update(result.binary).digest("hex");
  const projection: ArtifactProjection = {
    typeRows: staticProjection.typeRows,
    selection: staticProjection.selection,
    outcomes: (result.irOutcomes ?? []).map(normalizeOutcome),
    compiled: [...(result.irCompiledFuncs ?? [])],
    skipped: [...(result.irFirstSkipped ?? [])],
    postClaimErrors: result.irPostClaimErrors ?? [],
    imports: result.imports.map((entry) => `${entry.module}::${entry.name}`).sort(),
    exports: WebAssembly.Module.exports(new WebAssembly.Module(result.binary)).map((entry) => entry.name),
    wat: inspectWat(fixture, target, result.wat),
    ...(finalBinaryExpectation === undefined
      ? {}
      : { finalBinary: inspectFinalBinary(result.binary, finalBinaryExpectation, fixture.names) }),
    binaryHash,
    runtime,
  };
  assertExactProjection(fixture, target, optimize, staticProjection, projection);
  return projection;
}

describe("#1231 unconditional object-literal facts", () => {
  for (const fixture of FIXTURES) {
    it(`keeps ${fixture.id} identical for every stale setting, target, and optimization arm`, async () => {
      for (const target of TARGETS) {
        for (const optimize of [false, true]) {
          let baseline: ArtifactProjection | undefined;
          for (const staleValue of STALE_VALUES) {
            const projection = await withStaleValue(staleValue, () => observeFixture(fixture, target, optimize));
            if (baseline === undefined) {
              baseline = projection;
              continue;
            }
            const staticProjection = inspectStaticFixture(fixture);
            assertExactProjection(fixture, target, optimize, staticProjection, projection, baseline);
            expect(projection).toEqual(baseline);
          }
        }
      }
    }, 120_000);
  }

  it("records the annotated point's exact dual-body route before poisoning it", async () => {
    const source = `
      type Point = { x: number; y: number };
      export function createPoint(x: number, y: number): Point { return { x: x, y: y }; }
      export function distance(point: Point): number { return point.x * point.x + point.y * point.y; }
      export function run(): number { return distance(createPoint(3, 4)); }
    `;
    const names = ["createPoint", "distance", "run"];
    const annotatedFixture: Fixture = {
      ...FIXTURES[0]!,
      id: "annotated-point",
      fileName: "issue-1231-annotated-point.ts",
      source,
      typeRows: [row("createPoint", [F64, F64], DYNAMIC), row("distance", [DYNAMIC], F64), row("run", [], F64)],
      outcomes: names.map((name) => ({ name, kind: "emitted" })),
      emitted: names,
      watRegistrationByTarget: {
        standalone: watRegistration(31),
      },
      finalBinaryByTarget: {
        standalone: {
          optimized: finalBinaryStruct(
            ["f64", "f64"],
            [
              { exportName: "createPoint", allocationCount: 1, readFields: [], calls: [] },
              { exportName: "distance", allocationCount: 0, readFields: [0, 1], calls: [] },
              { exportName: "run", allocationCount: 0, readFields: [], calls: [] },
            ],
          ),
        },
      },
    };
    const staticProjection = inspectStaticFixture(annotatedFixture);
    await withStaleValue(undefined, async () => {
      const clean = await compile(source, {
        fileName: annotatedFixture.fileName,
        experimentalIR: true,
        optimize: true,
        target: "standalone",
        emitWat: true,
        trackIrOutcomes: true,
      });
      expect(clean.success, clean.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(clean.binary)).toBe(true);
      expect(clean.irFirstSkipped ?? []).toEqual([]);
      expect(clean.irCompiledFuncs ?? []).toEqual(names);
      expect((clean.irOutcomes ?? []).map(normalizeOutcome)).toEqual(
        expectedOutcomeRows(annotatedFixture, "standalone", staticProjection),
      );
      const wat = inspectWat(annotatedFixture, "standalone", clean.wat);
      assertExactWatProjection(annotatedFixture, "standalone", wat);
      const finalBinaryExpectation = expectedFinalBinary(annotatedFixture, "standalone", true);
      if (!finalBinaryExpectation) throw new Error("missing annotated final Binaryen expectation");
      const finalBinary = inspectFinalBinary(clean.binary, finalBinaryExpectation, names);
      expect(finalBinary.typeSymbol).toBe("$0");
      expect(finalBinary.storage).toEqual(["f64", "f64"]);
      expect(
        finalBinary.functions.map(({ exportName, allocationCount, readFields, calls }) => ({
          exportName,
          allocationCount,
          readFields,
          calls,
        })),
      ).toEqual(finalBinaryExpectation.functions);
      for (const name of names) {
        const body = extractFuncBody(clean.wat, name);
        if (!body) throw new Error(`annotated point is missing final WAT body ${name}`);
        expect(body).not.toMatch(/call\s+\$__box_number(?:_import)?/);
        expect(body).not.toMatch(/call\s+\$__unbox_number(?:_import)?/);
      }
      const exports = await instantiate(clean, "standalone");
      expect(exports.run, "annotated standalone run export").toBeTypeOf("function");
      expect(exports.run!()).toBe(25);
      await withEnvValue(DIRECT_BODY_POISON_KEY, names.join(","), async () => {
        const poisoned = await compile(source, {
          fileName: "issue-1231-annotated-point-poison.ts",
          experimentalIR: true,
          optimize: true,
          target: "standalone",
          trackIrOutcomes: true,
        });
        expect(poisoned.success).toBe(false);
        const messages = poisoned.errors.map((error) => error.message).join("\n");
        for (const name of names) expect(messages).toContain(`injected direct function-body poison: ${name}`);
      });
    });
  }, 120_000);

  it("keeps direct-body poison as an explicit hybrid-route negative control", async () => {
    for (const fixture of FIXTURES) {
      await withStaleValue(undefined, async () =>
        withEnvValue(DIRECT_BODY_POISON_KEY, fixture.names.join(","), async () => {
          const result = await compile(fixture.source, {
            fileName: `${fixture.id}-direct-body-control.ts`,
            experimentalIR: true,
            optimize: true,
            target: "standalone",
            trackIrOutcomes: true,
          });
          expect(result.success).toBe(false);
          const messages = result.errors.map((error) => error.message).join("\n");
          for (const name of fixture.names) expect(messages).toContain(`injected direct function-body poison: ${name}`);
        }),
      );
    }
  }, 120_000);

  it("keeps an unused exact Binaryen type unlinked from unrelated final-byte operations", () => {
    const expected = finalBinaryStruct(
      ["f64", "f64"],
      [{ exportName: "run", allocationCount: 0, readFields: [], calls: [] }],
    );
    const disassembly = `
      (module
        (type $0 (struct (field (mut f64)) (field (mut f64))))
        (type $1 (struct (field (mut i32)) (field (mut i32))))
        (export "run" (func $1))
        (func $1 (local $value (ref null $1))
          (drop
            (struct.get $1 0
              (struct.new $1
                (i32.const 3)
                (i32.const 4)
              )
            )
          )
        )
      )
    `;
    const projection = inspectFinalBinaryText(disassembly, expected, ["run"]);
    expect(projection.typeSymbol).toBe("$0");
    expect(projection.functions).toEqual([
      { exportName: "run", functionSymbol: "$1", allocationCount: 0, readFields: [], calls: [] },
    ]);

    const wrongUsedLayout = disassembly.replace(
      "(type $1 (struct (field (mut i32)) (field (mut i32))))",
      "(type $1 (struct (field (mut f64)) (field (mut i32))))",
    );
    expect(inspectFinalBinaryText(wrongUsedLayout, expected, ["run"]).functions).toEqual(projection.functions);

    const collidingUsedLayout = disassembly.replace(
      "(type $1 (struct (field (mut i32)) (field (mut i32))))",
      "(type $1 (struct (field (mut f64)) (field (mut f64))))",
    );
    expect(() => inspectFinalBinaryText(collidingUsedLayout, expected, ["run"])).toThrow(
      "expected exactly one final Binaryen struct",
    );
  });

  it("rejects every independently-mutated exact projection", async () => {
    const fixture = FIXTURES[0]!;
    const staticProjection = inspectStaticFixture(fixture);
    const baseline = await withStaleValue(undefined, () => observeFixture(fixture, "gc", false));
    const assertBaseline = (candidate: ArtifactProjection) =>
      assertExactProjection(fixture, "gc", false, staticProjection, candidate, baseline);
    assertBaseline(baseline);
    const rejects = (label: string, mutate: (candidate: DeepMutable<ArtifactProjection>) => void): void => {
      const candidate = JSON.parse(JSON.stringify(baseline)) as DeepMutable<ArtifactProjection>;
      mutate(candidate);
      expect(() => assertBaseline(candidate), label).toThrow();
    };

    rejects("wrong TypeMap atom", (candidate) => {
      candidate.typeRows[0].entry.returnType = STRING;
    });
    rejects("wrong TypeMap source", (candidate) => {
      candidate.typeRows[0].sourceId = "foreign-source";
    });
    rejects("wrong TypeMap unit", (candidate) => {
      candidate.typeRows[0].unitId = "foreign-unit";
    });
    rejects("missing selected unit", (candidate) => {
      candidate.selection.pop();
    });
    rejects("duplicate selected unit", (candidate) => {
      candidate.selection.push(candidate.selection[0]!);
    });
    rejects("foreign selected unit", (candidate) => {
      candidate.selection[0].unitId = "foreign-unit";
    });
    rejects("missing outcome", (candidate) => {
      candidate.outcomes.pop();
    });
    rejects("duplicate outcome", (candidate) => {
      candidate.outcomes.push(candidate.outcomes[0]!);
    });
    rejects("foreign outcome", (candidate) => {
      candidate.outcomes[0].sourceId = "foreign-source";
    });
    rejects("wrong outcome reason", (candidate) => {
      candidate.outcomes[0].code = "wrong-reason";
    });
    rejects("wrong outcome detail", (candidate) => {
      candidate.outcomes[0].detail = "wrong-detail";
    });
    rejects("wrong outcome stage", (candidate) => {
      candidate.outcomes[0].stage = "patch";
    });
    rejects("wrong outcome body flags", (candidate) => {
      candidate.outcomes[0].legacyBodyEmitted = false;
    });
    rejects("import drift", (candidate) => {
      candidate.imports.push("env::foreign");
    });
    rejects("export drift", (candidate) => {
      candidate.exports.push("foreign");
    });
    rejects("WAT declaration ordinal drift", (candidate) => {
      candidate.wat.declarationOrdinal++;
    });
    rejects("final Binaryen type identity drift", (candidate) => {
      if (!candidate.finalBinary) throw new Error("missing final Binaryen baseline");
      candidate.finalBinary.typeSymbol = "$foreign";
    });
    rejects("final Binaryen storage layout drift", (candidate) => {
      if (!candidate.finalBinary) throw new Error("missing final Binaryen baseline");
      candidate.finalBinary.storage[1] = "i32";
    });
    rejects("final Binaryen export-function identity drift", (candidate) => {
      if (!candidate.finalBinary) throw new Error("missing final Binaryen baseline");
      candidate.finalBinary.functions[0]!.functionSymbol = "$foreign";
    });
    rejects("final Binaryen allocation census drift", (candidate) => {
      const run = candidate.finalBinary?.functions.find((entry) => entry.exportName === "run");
      if (!run) throw new Error("missing final Binaryen run baseline");
      run.allocationCount = 0;
    });
    rejects("final Binaryen read-field census drift", (candidate) => {
      const run = candidate.finalBinary?.functions.find((entry) => entry.exportName === "run");
      if (!run) throw new Error("missing final Binaryen run baseline");
      run.readFields[0] = 999;
    });
    rejects("final Binaryen direct-call census drift", (candidate) => {
      const run = candidate.finalBinary?.functions.find((entry) => entry.exportName === "run");
      if (!run) throw new Error("missing final Binaryen run baseline");
      run.calls.push("$foreign");
    });
    rejects("missing final Binaryen projection", (candidate) => {
      candidate.finalBinary = undefined;
    });
    rejects("binary drift", (candidate) => {
      candidate.binaryHash = "0".repeat(64);
    });
    rejects("runtime drift", (candidate) => {
      candidate.runtime[0].value = 999;
    });
  }, 120_000);
});

describe("#1231 bounded lattice and refusal controls", () => {
  it("keeps structural joins and records the checker-object compatibility projection", () => {
    const left = objectShape([["value", F64]]);
    const right = objectShape([["value", F64]]);
    const different = objectShape([["value", STRING]]);
    expect(left).toEqual(right);
    expect(left).not.toEqual(different);

    const ast = analyzeSource("function known(value: { x: number }) { return value; }", "issue-1231-checker-object.ts");
    const entry = buildTypeMap(ast.sourceFile, ast.checker).get("known");
    expect(entry).toEqual({ params: [DYNAMIC], returnType: DYNAMIC });
    const inventory = buildIrUnitInventory([ast.sourceFile], { checker: ast.checker, entrySource: ast.sourceFile });
    const identity = buildIrPlanningIdentityContext(inventory);
    expect([...buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity).values()]).toEqual([
      { params: [DYNAMIC], returnType: DYNAMIC },
    ]);
    const selection = planIrCompilation(
      ast.sourceFile,
      { experimentalIR: true, trackFallbacks: true },
      new Map([["known", entry!]]),
    );
    expect([...selection.funcs]).toEqual([]);
    expect(selection.fallbacks).toEqual([{ name: "known", reason: "return-type-not-resolvable" }]);
  });

  it("retains every conservative projection with its exact selector refusal", () => {
    const controls = [
      {
        name: "polymorphic",
        source: 'function wrap(v) { return { value: v }; } function run() { wrap(1); return wrap("x"); }',
        returnKinds: [
          ["wrap", "dynamic"],
          ["run", "dynamic"],
        ],
        selected: [],
        fallbacks: [
          ["wrap", "param-type-not-resolvable"],
          ["run", "call-graph-closure"],
        ],
      },
      {
        name: "open-world",
        source: "export function open(value) { return { value: value }; }",
        returnKinds: [["open", "dynamic"]],
        selected: [],
        fallbacks: [["open", "param-type-not-resolvable"]],
      },
      {
        name: "empty",
        source: "function empty() { return {}; }",
        returnKinds: [["empty", "dynamic"]],
        selected: [],
        fallbacks: [["empty", "body-shape-rejected"]],
      },
      {
        name: "spread",
        source: "function spread(value) { return { ...value }; }",
        returnKinds: [["spread", "dynamic"]],
        selected: [],
        fallbacks: [["spread", "body-shape-rejected"]],
      },
      {
        name: "method",
        source: "function method() { return { value() { return 1; } }; }",
        returnKinds: [["method", "dynamic"]],
        selected: [],
        fallbacks: [["method", "body-shape-rejected"]],
      },
      {
        name: "accessor",
        source: "function accessor() { return { get value() { return 1; } }; }",
        returnKinds: [["accessor", "dynamic"]],
        selected: [],
        fallbacks: [["accessor", "body-shape-rejected"]],
      },
      {
        name: "computed",
        source: "function computed(key) { return { [key]: 1 }; }",
        returnKinds: [["computed", "dynamic"]],
        selected: [],
        fallbacks: [["computed", "body-shape-rejected"]],
      },
      {
        name: "duplicate",
        source: "function duplicate() { return { value: 1, value: 2 }; }",
        returnKinds: [["duplicate", "dynamic"]],
        selected: [],
        fallbacks: [["duplicate", "body-shape-rejected"]],
      },
      {
        name: "depth-four",
        source: "function deep() { return { a: { b: { c: { d: 0 } } } }; }",
        returnKinds: [["deep", "dynamic"]],
        selected: [],
        fallbacks: [["deep", "return-type-not-resolvable"]],
      },
      {
        name: "missing-field",
        source: "function sum(point) { return point.x + point.y; } function run() { return sum({ x: 1 }); }",
        returnKinds: [
          ["sum", "dynamic"],
          ["run", "dynamic"],
        ],
        selected: [],
        fallbacks: [
          ["sum", "return-type-not-resolvable"],
          ["run", "call-graph-closure"],
        ],
      },
      {
        name: "optional-property",
        source: "function read(point) { return point?.x; } function run() { return read({ x: 1 }); }",
        returnKinds: [
          ["read", "dynamic"],
          ["run", "dynamic"],
        ],
        selected: [],
        fallbacks: [
          ["read", "return-type-not-resolvable"],
          ["run", "call-graph-closure"],
        ],
      },
      {
        name: "optional-element",
        source: 'function read(point) { return point?.["x"]; } function run() { return read({ x: 1 }); }',
        returnKinds: [
          ["read", "dynamic"],
          ["run", "dynamic"],
        ],
        selected: [],
        fallbacks: [
          ["read", "return-type-not-resolvable"],
          ["run", "call-graph-closure"],
        ],
      },
      {
        name: "union-receiver",
        source:
          'function read(value) { return value.x; } function run(flag) { return read(flag ? { x: 1 } : { x: "x" }); }',
        returnKinds: [
          ["read", "dynamic"],
          ["run", "dynamic"],
        ],
        selected: [],
        fallbacks: [
          ["read", "param-type-not-resolvable"],
          ["run", "call-graph-closure"],
        ],
      },
      {
        name: "dynamic-receiver",
        source: "function read(value) { return value.x; }",
        returnKinds: [["read", "dynamic"]],
        selected: ["read"],
        fallbacks: [],
      },
    ];
    for (const control of controls) {
      const ast = analyzeSource(control.source, `issue-1231-refusal-${control.name}.ts`);
      const map = buildTypeMap(ast.sourceFile, ast.checker);
      const selection = planIrCompilation(ast.sourceFile, { experimentalIR: true, trackFallbacks: true }, map);
      expect(
        [...map.entries()].map(([name, entry]) => [name, entry.returnType.kind]),
        control.name,
      ).toEqual(control.returnKinds);
      expect([...selection.funcs], control.name).toEqual(control.selected);
      expect(
        (selection.fallbacks ?? []).map((fallback) => [fallback.name, fallback.reason]),
        control.name,
      ).toEqual(control.fallbacks);
    }
  });

  it("accepts exact literal keys and records every nonliteral element projection", () => {
    const accepted = `
      function keys(value) { return { identifier: value, "quoted": value, 7: value }; }
      function stringElement(value) { return value["x"]; }
      function templateElement(value) { return value[\`x\`]; }
      function run() { return keys(1).identifier + stringElement({ x: 2 }) + templateElement({ x: 3 }); }
    `;
    const ast = analyzeSource(accepted, "issue-1231-literal-keys.ts");
    const map = buildTypeMap(ast.sourceFile, ast.checker);
    const xShape = objectShape([["x", F64]]);
    const keyShape = objectShape([
      ["7", F64],
      ["identifier", F64],
      ["quoted", F64],
    ]);
    expect([...map.entries()]).toEqual([
      ["keys", { params: [F64], returnType: keyShape }],
      ["stringElement", { params: [xShape], returnType: F64 }],
      ["templateElement", { params: [xShape], returnType: F64 }],
      ["run", { params: [], returnType: F64 }],
    ]);
    const acceptedSelection = planIrCompilation(ast.sourceFile, { experimentalIR: true, trackFallbacks: true }, map);
    expect([...acceptedSelection.funcs]).toEqual(["keys", "stringElement", "templateElement", "run"]);
    expect(acceptedSelection.fallbacks).toEqual([]);

    const nonLiteralElements = [
      {
        name: "numeric",
        source: "function read(value) { return value[0]; }",
        entry: { params: [UNKNOWN], returnType: DYNAMIC },
        selected: ["read"],
        fallbacks: [],
      },
      {
        name: "dynamic",
        source: "function read(value, key) { return value[key]; }",
        entry: { params: [UNKNOWN, UNKNOWN], returnType: DYNAMIC },
        selected: ["read"],
        fallbacks: [],
      },
      {
        name: "computed",
        source: "function read(value, key) { return value[`${key}`]; }",
        entry: { params: [UNKNOWN, UNKNOWN], returnType: DYNAMIC },
        selected: [],
        fallbacks: [["read", "param-type-not-resolvable"]],
      },
      {
        name: "other",
        source: "function read(value) { return value[1 + 1]; }",
        entry: { params: [UNKNOWN], returnType: DYNAMIC },
        selected: [],
        fallbacks: [["read", "param-type-not-resolvable"]],
      },
    ];
    for (const control of nonLiteralElements) {
      const rejected = analyzeSource(control.source, `issue-1231-element-${control.name}.ts`);
      const rejectedMap = buildTypeMap(rejected.sourceFile, rejected.checker);
      expect(rejectedMap.get("read"), control.name).toEqual(control.entry);
      const selection = planIrCompilation(
        rejected.sourceFile,
        { experimentalIR: true, trackFallbacks: true },
        rejectedMap,
      );
      expect([...selection.funcs], control.name).toEqual(control.selected);
      expect(
        (selection.fallbacks ?? []).map((fallback) => [fallback.name, fallback.reason]),
        control.name,
      ).toEqual(control.fallbacks);
    }
  });

  it("keeps primitive, any, unknown, never, union, and enum projections exact", () => {
    const source = `
      enum Phase { First, Second }
      function numberValue(value: number): number { return value; }
      function stringValue(value: string): string { return value; }
      function boolValue(value: boolean): boolean { return value; }
      function anyValue(value: any) { return value; }
      function unknownValue(value: unknown) { return value; }
      function neverValue(): never { throw new Error("never"); }
      function unionValue(value: number | string) { return value; }
      function enumValue(value: Phase) { return value; }
    `;
    const ast = analyzeSource(source, "issue-1231-seed-controls.ts");
    const map = buildTypeMap(ast.sourceFile, ast.checker);
    const BOOL = { kind: "bool" } as const;
    expect([...map.entries()]).toEqual([
      ["numberValue", { params: [F64], returnType: F64 }],
      ["stringValue", { params: [DYNAMIC], returnType: DYNAMIC }],
      ["boolValue", { params: [BOOL], returnType: BOOL }],
      ["anyValue", { params: [DYNAMIC], returnType: DYNAMIC }],
      ["unknownValue", { params: [DYNAMIC], returnType: DYNAMIC }],
      ["neverValue", { params: [], returnType: DYNAMIC }],
      ["unionValue", { params: [DYNAMIC], returnType: DYNAMIC }],
      ["enumValue", { params: [DYNAMIC], returnType: DYNAMIC }],
    ]);
    const selection = planIrCompilation(ast.sourceFile, { experimentalIR: true, trackFallbacks: true }, map);
    expect([...selection.funcs]).toEqual(["numberValue", "stringValue", "boolValue", "anyValue"]);
    expect(selection.fallbacks).toEqual([
      { name: "unknownValue", reason: "param-type-not-resolvable" },
      { name: "neverValue", reason: "return-type-not-resolvable" },
      { name: "unionValue", reason: "param-type-not-resolvable" },
      { name: "enumValue", reason: "return-type-not-resolvable" },
    ]);
  });
});

describe("#1231 source-local fnctor propagation option", () => {
  it("admits only the exact NewExpression/source/constructor proof under absent and stale settings", async () => {
    const source = `
      function Box(input) { this.input = input; }
      function OtherBox(input) { this.input = input; }
      function make() { return new Box("ready"); }
      function other() { return new Box("other"); }
      function otherConstructor() { return new OtherBox("wrong"); }
    `;
    const ast = analyzeSource(source, "issue-1231-fnctor.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], { checker: ast.checker, entrySource: ast.sourceFile });
    const identity = buildIrPlanningIdentityContext(inventory);
    const sourceId = inventory.sources[0]!.id;
    const boxConstructor = ast.sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "Box",
    );
    const otherConstructor = ast.sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "OtherBox",
    );
    const make = ast.sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "make",
    );
    const other = ast.sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "other",
    );
    if (!boxConstructor || !otherConstructor || !make || !other) throw new Error("fnctor fixture declarations missing");
    const constructorUnitId = identity.unitIdByDeclaration.get(boxConstructor);
    const otherConstructorUnitId = identity.unitIdByDeclaration.get(otherConstructor);
    const makeUnitId = identity.unitIdByDeclaration.get(make);
    if (!constructorUnitId || !otherConstructorUnitId || !makeUnitId)
      throw new Error("fnctor fixture identity missing");
    const newExpressions: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) newExpressions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast.sourceFile);
    const [exactSite, otherSite, otherConstructorSite] = newExpressions;
    if (!exactSite || !otherSite || !otherConstructorSite) throw new Error("fnctor fixture allocations missing");
    const admission: IrFnctorAdmission = {
      kind: "fnctor-admission",
      sourceId,
      constructorUnitId,
      constructorDeclaration: boxConstructor,
      constructorSite: exactSite,
      shape: { kind: "fnctor-shape", fields: [{ name: "input", type: "string" }] },
      proof: {
        sameSource: true,
        approved: true,
        reserved: true,
        directConstructor: true,
        fixedUnconditionalInput: true,
        noAlias: true,
        noReassignment: true,
        noEscape: true,
        noCrossSourceCollision: true,
      },
    };
    const wrongSourceAdmission: IrFnctorAdmission = { ...admission, sourceId: "foreign-source" };
    const wrongConstructorAdmission: IrFnctorAdmission = {
      ...admission,
      constructorUnitId: otherConstructorUnitId,
      constructorDeclaration: otherConstructor,
    };
    const wrongSiteAdmission: IrFnctorAdmission = { ...admission, constructorSite: otherSite };
    const resolveNewExpressionConstructor = (site: ts.NewExpression): ts.FunctionDeclaration | undefined => {
      const symbol = ast.checker.getSymbolAtLocation(site.expression);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.find(ts.isFunctionDeclaration);
      return declaration && ts.isFunctionDeclaration(declaration) ? declaration : undefined;
    };
    const guardedResolver =
      (resolvedAdmission: IrFnctorAdmission) => (site: ts.NewExpression, candidateSourceId: typeof sourceId) => {
        const constructorDeclaration = resolveNewExpressionConstructor(site);
        const constructorUnitId = constructorDeclaration
          ? identity.unitIdByDeclaration.get(constructorDeclaration)
          : undefined;
        if (
          candidateSourceId !== sourceId ||
          resolvedAdmission.sourceId !== sourceId ||
          site !== resolvedAdmission.constructorSite ||
          constructorDeclaration !== resolvedAdmission.constructorDeclaration ||
          constructorUnitId !== resolvedAdmission.constructorUnitId
        ) {
          return undefined;
        }
        return resolvedAdmission;
      };
    const exactResolver = guardedResolver(admission);
    expect(exactResolver(exactSite, sourceId)).toBe(admission);
    expect(exactResolver(otherSite, sourceId)).toBeUndefined();
    expect(exactResolver(otherConstructorSite, sourceId)).toBeUndefined();
    expect(guardedResolver(wrongSourceAdmission)(exactSite, sourceId)).toBeUndefined();
    expect(guardedResolver(wrongConstructorAdmission)(exactSite, sourceId)).toBeUndefined();
    const expected = irFnctorInputStringAtom();

    for (const staleValue of [undefined, "0"] as const) {
      await withStaleValue(staleValue, async () => {
        const exact = buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity, undefined, {
          resolveFnctorAdmission: exactResolver,
        });
        expect(exact.get(makeUnitId)?.returnType).toEqual(expected);
        expect(buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity).get(makeUnitId)?.returnType).not.toEqual(
          expected,
        );
        expect(
          buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity, undefined, {
            resolveFnctorAdmission: guardedResolver(wrongSiteAdmission),
          }).get(makeUnitId)?.returnType,
        ).not.toEqual(expected);
        expect(
          buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity, undefined, {
            resolveFnctorAdmission: guardedResolver(wrongSourceAdmission),
          }).get(makeUnitId)?.returnType,
        ).not.toEqual(expected);
        expect(
          buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity, undefined, {
            resolveFnctorAdmission: guardedResolver(wrongConstructorAdmission),
          }).get(makeUnitId)?.returnType,
        ).not.toEqual(expected);
      });
    }
  });
});
