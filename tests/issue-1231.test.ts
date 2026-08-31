// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1231 — typed object-literal facts are unconditional. The retired control is
// assembled below solely from fragments, leaving no live configuration spelling.

import { createHash } from "node:crypto";

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
  readonly watLinkedByTarget?: Readonly<Record<Target, boolean>>;
  readonly watRegistrationUsesByTarget?: Readonly<Partial<Record<Target, number>>>;
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
  readonly registrationUses: number;
  readonly body?: string;
  readonly reference?: string;
  readonly bodyText?: string;
  readonly readLinked: boolean;
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
    hostImports: ["env::__box_number", "env::__extern_get", "env::__unbox_number"],
    hostExtraExports: ["__vec_len", "__vec_get", "__is_vec", "__vec_mut_supported", "__vec_push", "__vec_pop"],
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
    watLinkedByTarget: { gc: true, standalone: false },
    watRegistrationUsesByTarget: { standalone: 1 },
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
    hostImports: ["env::__box_number", "env::__extern_get", "env::__get_undefined", "env::__unbox_number"],
    hostExtraExports: ["__vec_len", "__vec_get", "__is_vec", "__vec_mut_supported", "__vec_push", "__vec_pop"],
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

function expectedWatLink(fixture: Fixture, target: Target): boolean {
  return fixture.watLinkedByTarget?.[target] ?? true;
}

function inspectWat(fixture: Fixture, target: Target, wat: string): WatProjection {
  const fields = expectedWatFields(fixture, target);
  const matchingStructLines = wat.split("\n").filter((line) => {
    if (!line.includes("(type $") || !line.includes("(struct")) return false;
    const fieldNames = [...line.matchAll(/\(field \$([^\s()]+) /g)].map((match) => match[1]);
    return (
      fieldNames.length === fields.length &&
      fieldNames.every((name, index) => name === fields[index]?.name) &&
      fields.every((field) => line.includes(`(field $${field.name} (mut ${field.storage}))`))
    );
  });
  expect(matchingStructLines, `exact typed WAT struct for ${fixture.id}`).toHaveLength(1);
  const registration = matchingStructLines[0]!;
  const registrationName = registration.match(/^\s*\(type\s+(\$[^\s()]+)/)?.[1];
  if (!registrationName) throw new Error(`missing named typed-struct registration for ${fixture.id}/${target}`);
  const registrationUses = wat.split(registrationName).length - 1;
  if (!expectedWatLink(fixture, target)) {
    return { fields, registration, registrationUses, readLinked: registrationUses > 1 };
  }
  for (const name of fixture.names) {
    const body = extractFuncBody(wat, name);
    if (!body) continue;
    const created = [...body.matchAll(/struct\.new\s+(\d+)/g)].map((match) => match[1]!);
    const reference = created.find((candidate) => wat.includes(`struct.get ${candidate}`));
    if (reference !== undefined) {
      return {
        fields,
        registration,
        registrationUses,
        body: name,
        reference,
        bodyText: body,
        readLinked: true,
      };
    }
  }
  return { fields, registration, registrationUses, readLinked: false };
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

function assertExactProjection(
  fixture: Fixture,
  target: Target,
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
  expect(projection.wat.fields).toEqual(expectedWatFields(fixture, target));
  for (const field of projection.wat.fields) {
    expect(projection.wat.registration).toContain(`(field $${field.name} (mut ${field.storage}))`);
  }
  const expectedRegistrationUses = fixture.watRegistrationUsesByTarget?.[target];
  if (expectedRegistrationUses !== undefined) {
    expect(projection.wat.registrationUses).toBe(expectedRegistrationUses);
  }
  expect(projection.wat.readLinked).toBe(expectedWatLink(fixture, target));
  if (expectedWatLink(fixture, target)) {
    if (!projection.wat.body || !projection.wat.reference || !projection.wat.bodyText) {
      throw new Error(`missing linked source body for ${fixture.id}/${target}`);
    }
    expect(fixture.names).toContain(projection.wat.body);
    expect(projection.wat.reference).toMatch(/^\d+$/);
    expect(projection.wat.bodyText).toContain(`struct.new ${projection.wat.reference}`);
    expect(projection.wat.bodyText).not.toMatch(/call\s+\$__box_number(?:_import)?/);
    expect(projection.wat.bodyText).not.toMatch(/call\s+\$__unbox_number(?:_import)?/);
  } else {
    expect(projection.wat.body).toBeUndefined();
    expect(projection.wat.reference).toBeUndefined();
    expect(projection.wat.bodyText).toBeUndefined();
  }
  expect(projection.binaryHash).toMatch(/^[a-f0-9]{64}$/);
  expect(projection.runtime).toEqual(fixture.runtime);
  if (baseline) {
    expect(projection.outcomes).toEqual(baseline.outcomes);
    expect(projection.postClaimErrors).toEqual(baseline.postClaimErrors);
    expect(projection.wat).toEqual(baseline.wat);
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
    binaryHash: createHash("sha256").update(result.binary).digest("hex"),
    runtime,
  };
  assertExactProjection(fixture, target, staticProjection, projection);
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
            assertExactProjection(fixture, target, staticProjection, projection, baseline);
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
    await withStaleValue(undefined, async () => {
      const clean = await compile(source, {
        fileName: "issue-1231-annotated-point.ts",
        experimentalIR: true,
        optimize: true,
        target: "standalone",
        trackIrOutcomes: true,
      });
      expect(clean.success, clean.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(clean.irFirstSkipped ?? []).toEqual([]);
      expect(clean.irCompiledFuncs ?? []).toEqual(names);
      expect(names.map((name) => (clean.irOutcomes ?? []).find((outcome) => outcome.displayName === name))).toEqual(
        names.map((name) =>
          expect.objectContaining({
            displayName: name,
            kind: "emitted",
            stage: "patch",
            legacyBodyEmitted: true,
            irBodyEmitted: true,
          }),
        ),
      );
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

  it("rejects every independently-mutated exact projection", async () => {
    const fixture = FIXTURES[0]!;
    const staticProjection = inspectStaticFixture(fixture);
    const baseline = await withStaleValue(undefined, () => observeFixture(fixture, "gc", false));
    const assertBaseline = (candidate: ArtifactProjection) =>
      assertExactProjection(fixture, "gc", staticProjection, candidate, baseline);
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
    rejects("WAT body reassociation", (candidate) => {
      candidate.wat.body = "distance";
      candidate.wat.reference = "999";
    });
    rejects("flipped linked WAT allocation/read state", (candidate) => {
      candidate.wat.readLinked = false;
    });
    rejects("boxed WAT body", (candidate) => {
      candidate.wat.bodyText = "struct.new 1 call $__box_number struct.get 1";
    });
    rejects("binary drift", (candidate) => {
      candidate.binaryHash = "0".repeat(64);
    });
    rejects("runtime drift", (candidate) => {
      candidate.runtime[0].value = 999;
    });

    const unlinkedFixture = FIXTURES.find((candidate) => candidate.id === "user");
    if (!unlinkedFixture) throw new Error("missing standalone user registration control");
    const unlinkedStaticProjection = inspectStaticFixture(unlinkedFixture);
    const unlinkedBaseline = await withStaleValue(undefined, () =>
      observeFixture(unlinkedFixture, "standalone", false),
    );
    const flippedUnlinkedState = JSON.parse(JSON.stringify(unlinkedBaseline)) as DeepMutable<ArtifactProjection>;
    flippedUnlinkedState.wat.readLinked = true;
    expect(
      () =>
        assertExactProjection(
          unlinkedFixture,
          "standalone",
          unlinkedStaticProjection,
          flippedUnlinkedState,
          unlinkedBaseline,
        ),
      "flipped unlinked standalone registration state",
    ).toThrow();
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
      function make() { return new Box("ready"); }
      function other() { return new Box("other"); }
    `;
    const ast = analyzeSource(source, "issue-1231-fnctor.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], { checker: ast.checker, entrySource: ast.sourceFile });
    const identity = buildIrPlanningIdentityContext(inventory);
    const sourceId = inventory.sources[0]!.id;
    const boxConstructor = ast.sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "Box",
    );
    const make = ast.sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "make",
    );
    const other = ast.sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "other",
    );
    if (!boxConstructor || !make || !other) throw new Error("fnctor fixture declarations missing");
    const constructorUnitId = identity.unitIdByDeclaration.get(boxConstructor);
    const makeUnitId = identity.unitIdByDeclaration.get(make);
    if (!constructorUnitId || !makeUnitId) throw new Error("fnctor fixture identity missing");
    const newExpressions: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) newExpressions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast.sourceFile);
    const [exactSite, otherSite] = newExpressions;
    if (!exactSite || !otherSite) throw new Error("fnctor fixture allocations missing");
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
    const exactResolver = (site: ts.NewExpression, candidateSourceId: typeof sourceId) =>
      site === exactSite && candidateSourceId === sourceId ? admission : undefined;
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
            resolveFnctorAdmission: (site) => (site === otherSite ? admission : undefined),
          }).get(makeUnitId)?.returnType,
        ).not.toEqual(expected);
        expect(
          buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity, undefined, {
            resolveFnctorAdmission: (_site, candidateSourceId) =>
              candidateSourceId === ("foreign-source" as typeof sourceId) ? admission : undefined,
          }).get(makeUnitId)?.returnType,
        ).not.toEqual(expected);
        expect(
          buildIrUnitTypeMap([ast.sourceFile], ast.checker, identity, undefined, {
            resolveFnctorAdmission: () => (boxConstructor === other ? admission : undefined),
          }).get(makeUnitId)?.returnType,
        ).not.toEqual(expected);
      });
    }
  });
});
