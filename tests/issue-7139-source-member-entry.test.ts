// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { ts } from "../src/ts-api.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareSourceClosureEntry } from "../src/ir/source-closure-entry.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { memberEntryInput, prepareMemberEntryProgram } from "./helpers/prepared-member-entries.js";

for (const decoded of [false, true])
  it(`executes original member bodies, strict receivers and per-allocation shared cells, decoded=${decoded}`, async () => {
    const fixture = prepareMemberEntryProgram();
    expect(JSON.stringify(fixture.inventory)).toBe(fixture.originalInventory);
    expect(fixture.program.inventory.allUnits).toHaveLength(5);
    expect(fixture.program.inventory.terminalUnits).toHaveLength(4);
    expect(fixture.program.derivedUnits).toEqual([]);
    for (const { entry, fn } of fixture.entries) {
      const record = fixture.inventory.allUnits.find((unit) => unit.id === fn.unitId)!;
      expect(record).toMatchObject({
        terminal: true,
        terminalOwnerId: fn.unitId,
        lexicalOwnerId: fixture.inventory.classes[0]!.id,
      });
      expect(fn.unitId).toBe(entry.unitId);
      expect(fn.parentId).toBeUndefined();
      expect(fn.role).toBeUndefined();
      expect(fn.sourceUnit).toBeUndefined();
      expect(fn.closureSubtype).toMatchObject({
        captureFieldTypes: [{ kind: "boxed" }],
        parameters: { count: 1, publicLength: 1 },
      });
      expect(
        fn.blocks
          .flatMap((block) => block.instrs)
          .filter(
            (i) =>
              i.kind === "call" &&
              i.target.binding.kind === "intrinsic" &&
              i.target.binding.symbol === "js.closure.receiver",
          ),
      ).toHaveLength(1);
    }
    const encoded = encodePreparedIrProgram(fixture.program);
    const program = decoded ? decodePreparedIrProgram(encoded) : fixture.program;
    expect(encodePreparedIrProgram(program)).toBe(encoded);
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    expect(new Set(outcome.run.emitted.emittedUnitIds)).toEqual(
      new Set(program.runtime[0]!.prepared.functions.map((fn) => fn.unitId)),
    );
    const run = outcome.run.exports.run as (seed: number) => number;
    expect([run(13), run(1), run(13)]).toEqual([117233136, 105221136, 117233136]);
    expect(outcome.run.emitted.module.functions.filter((fn) => fn.name === "__closure_receiver")).toHaveLength(1);
  });

it("continues refusing source class evaluation independently of typed member entry", () => {
  const fixture = memberEntryInput();
  expect(prepareWholeIrProgram(fixture.input)).toMatchObject({
    kind: "unsupported",
    code: "class-definition-execution-unsupported",
  });
});

for (const bypass of ["direct", "escape", "export"] as const)
  it(`refuses a receiver reader with an uninstalled ${bypass} route despite valid call sites`, () => {
    const { program } = prepareMemberEntryProgram(bypass);
    const source = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
    const requirements = planNativeInvocationRequirements(source, { utf8Storage: false })!;
    expect(requirements.gaps.some((gap) => gap.detail.includes("receiver entry"))).toBe(true);
    expect(acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"))).toMatchObject({
      kind: "unsupported",
    });
  });

it("rejects a copied entry and a different actual method owner", () => {
  const fixture = memberEntryInput(),
    { entry } = fixture.entries[0]!;
  const lower = (plan: typeof entry, ownerUnitId = entry.unitId) =>
    lowerFunctionAstToIr(entry.declaration, {
      ownerUnitId,
      funcName: "read",
      sourceClosureEntry: plan,
      checker: fixture.input.checker,
      identityContext: fixture.identity,
    });
  expect(() => lower({ ...entry })).toThrow(/unissued or copied/);
  expect(() => lower(entry, fixture.entries[1]!.entry.unitId)).toThrow(/foreign entry declaration or owner/);
  expect(() =>
    lowerFunctionAstToIr(entry.declaration, {
      ownerUnitId: entry.unitId,
      sourceClosureEntry: entry,
      selfParam: { type: { kind: "val", val: { kind: "externref" } } },
    }),
  ).toThrow(/conflicting/);
});

it("rejects missing, duplicate, foreign and unboxed mutable captures", () => {
  const fixture = memberEntryInput();
  const base = {
    identity: fixture.identity,
    checker: fixture.input.checker,
    declaration: fixture.declaration.members[0] as ts.MethodDeclaration,
  };
  const capture = {
    declaration: fixture.factory.parameters[0]!,
    fieldType: { kind: "boxed", inner: { kind: "val", val: { kind: "f64" } } },
  } as const;
  expect(() => prepareSourceClosureEntry({ ...base, captures: [] })).toThrow(/incomplete free/);
  expect(() => prepareSourceClosureEntry({ ...base, captures: [capture, capture] })).toThrow(/exact free/);
  expect(() =>
    prepareSourceClosureEntry({
      ...base,
      captures: [{ ...capture, declaration: memberEntryInput().factory.parameters[0]! }],
    }),
  ).toThrow(/exact free/);
  expect(() =>
    prepareSourceClosureEntry({ ...base, captures: [{ ...capture, fieldType: capture.fieldType.inner }] }),
  ).toThrow(/storage/);
});

it("retains lexical arrow this and the original receiver after nested abrupt completion", async () => {
  const { program, inventory } = prepareMemberEntryProgram(undefined, true);
  expect(inventory.allUnits).toHaveLength(7);
  const outcome = await replayProgram(
    decodePreparedIrProgram(encodePreparedIrProgram(program)),
    replayOptions("wasmgc", "standalone"),
  );
  if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
  const run = outcome.run.exports.run as (seed: number) => number;
  expect([run(13), run(1), run(13)]).toEqual([117233136, 105221136, 117233136]);
});

it("replays actual member units and capture/receiver state without the source frontend", () => {
  const { program } = prepareMemberEntryProgram();
  const parent = resolve(".tmp/7139-member-entry-replay");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "child-"));
  const encoded = join(directory, "program.json"),
    expected = join(directory, "expected.json");
  writeFileSync(encoded, encodePreparedIrProgram(program));
  writeFileSync(
    expected,
    JSON.stringify({
      targets: [{ backend: "wasmgc", target: "standalone" }],
      calls: [
        { export: "run", args: [13], expected: 117233136 },
        { export: "run", args: [1], expected: 105221136 },
        { export: "run", args: [13], expected: 117233136 },
      ],
    }),
  );
  const child = spawnSync(
    process.execPath,
    ["--max-old-space-size=4096", "--import", "tsx", "scripts/ir-whole-program-replay.mjs", encoded, expected],
    {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }),
  );
  if (child.error) throw child.error;
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr + child.stdout).toBe(0);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  expect(report.ok).toBe(true);
  expect(report.reencodedIdentical).toBe(true);
  expect(report.loadedModuleCount).toBeGreaterThan(0);
  expect(report.typescriptModules).toEqual([]);
  expect(report.frontendModules).toEqual([]);
});

it("revalidates captured declaration syntax, kind and actual parent membership", () => {
  for (const mutation of ["type", "kind", "detach"] as const) {
    const fixture = memberEntryInput(),
      { entry } = fixture.entries[0]!;
    const parameter = fixture.factory.parameters[0]!;
    if (mutation === "type")
      Object.assign(parameter, { type: ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword) });
    if (mutation === "kind") Object.assign(parameter, { kind: ts.SyntaxKind.VariableDeclaration });
    if (mutation === "detach")
      Object.assign(fixture.factory, {
        parameters: ts.factory.createNodeArray([
          ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            "seed",
            undefined,
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          ),
        ]),
      });
    expect(() => entry.assertCurrent(entry.declaration, entry.unitId)).toThrow(/changed captured declaration/);
  }
});

it("revalidates original member parameter kind, syntax and result syntax", () => {
  for (const mutation of ["parameter-kind", "parameter-type", "result-type"] as const) {
    const { entries } = memberEntryInput();
    const { entry } = entries[0]!;
    const parameter = entry.declaration.parameters[0]!;
    if (mutation === "parameter-kind") Object.assign(parameter, { kind: ts.SyntaxKind.VariableDeclaration });
    if (mutation === "parameter-type") Object.assign(parameter.type!, { kind: ts.SyntaxKind.StringKeyword });
    if (mutation === "result-type") Object.assign(entry.declaration.type!, { kind: ts.SyntaxKind.StringKeyword });
    expect(() => entry.assertCurrent(entry.declaration, entry.unitId)).toThrow(/changed source parameter or result/);
  }
});
