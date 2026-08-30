// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4617 C1 — the neutral declaration-fact schema and its temporary TypeScript
// adapter, exercised WITHOUT the compiler pipeline so every mutation is one
// fact at a time. The production route consumption lives in
// tests/issue-4590-bench-loop-prepared-cutover.test.ts.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createDeclarationSnapshotRecorder,
  createDeclarationSnapshotReplayOracle,
  type DeclarationQueryOracle,
  type DeclarationSnapshotIdentity,
} from "../src/checker/oracle-declaration-snapshot.js";
import { multiPreparedDeclarationRoleClassifier } from "../src/codegen/multi-prepared-function-value-declaration-replay.js";
import type { IrSourceId, IrUnitId } from "../src/ir/identity.js";
import {
  canonicalizeSemanticDeclarationSnapshot,
  parseSemanticDeclarationSnapshot,
  SEMANTIC_DECLARATION_SNAPSHOT_VERSION,
  SemanticDeclarationSnapshotError,
  serializeSemanticDeclarationSnapshot,
  validateSemanticDeclarationSnapshot,
  type SemanticDeclarationSnapshot,
} from "../src/ir/semantic-declaration-snapshot.js";
import { ts } from "../src/ts-api.js";

// `t` is declared twice in the exact reduction body: one binding whose
// declaration POPULATION has two members, both in the closed role vocabulary.
const SOURCE = [
  'import { helper } from "./helper.ts";',
  "export function reducer(): number {",
  "  let s = 0;",
  "  var t = 0;",
  "  var t = 1;",
  "  for (let i = 0; i < 10; i++) s = (s + i) | 0;",
  "  return s + t;",
  "}",
  "export function withParam(p: number): number {",
  "  return p;",
  "}",
  "export function use(): void {",
  "  helper(reducer);",
  "}",
  "",
].join("\n");

const SOURCE_ID = "ir-source:test:0000:source:a.ts" as IrSourceId;

interface Fixture {
  readonly sourceFile: ts.SourceFile;
  readonly identity: DeclarationSnapshotIdentity;
  readonly roleOf: ReturnType<typeof multiPreparedDeclarationRoleClassifier>;
  readonly live: DeclarationQueryOracle;
  readonly nodes: {
    readonly reducer: ts.FunctionDeclaration;
    readonly seed: ts.VariableDeclaration;
    readonly twinFirst: ts.VariableDeclaration;
    readonly twinSecond: ts.VariableDeclaration;
    readonly importSpecifier: ts.ImportSpecifier;
    readonly seedRead: ts.Identifier;
    readonly reducerValueUse: ts.Identifier;
    readonly helperCallee: ts.Identifier;
    readonly twinRead: ts.Identifier;
    readonly paramRead: ts.Identifier;
  };
}

function functionAt(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!found) throw new Error(`missing fixture function ${name}`);
  return found;
}

function identifiersNamed(root: ts.Node, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

function variableDeclarations(root: ts.Node, name: string): ts.VariableDeclaration[] {
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

function makeFixture(): Fixture {
  const sourceFile = ts.createSourceFile("a.ts", SOURCE, ts.ScriptTarget.ES2022, true);
  const reducer = functionAt(sourceFile, "reducer");
  const withParam = functionAt(sourceFile, "withParam");
  const use = functionAt(sourceFile, "use");
  const seed = variableDeclarations(reducer, "s")[0]!;
  const [twinFirst, twinSecond] = variableDeclarations(reducer, "t") as [
    ts.VariableDeclaration,
    ts.VariableDeclaration,
  ];
  const importDeclaration = sourceFile.statements[0] as ts.ImportDeclaration;
  const importSpecifier = (importDeclaration.importClause!.namedBindings as ts.NamedImports).elements[0]!;
  const returnStatement = reducer.body!.statements.find(ts.isReturnStatement)!;
  const seedRead = identifiersNamed(returnStatement, "s")[0]!;
  const twinRead = identifiersNamed(returnStatement, "t")[0]!;
  const paramRead = identifiersNamed(withParam.body!, "p")[0]!;
  const [helperCallee, reducerValueUse] = [
    identifiersNamed(use.body!, "helper")[0]!,
    identifiersNamed(use.body!, "reducer")[0]!,
  ];

  const identity: DeclarationSnapshotIdentity = {
    sourceIdBySourceFile: new Map([[sourceFile, SOURCE_ID]]),
    sourceFileBySourceId: new Map([[SOURCE_ID, sourceFile]]),
    unitIdByDeclaration: new Map<ts.Node, IrUnitId>([
      [reducer, "ir-unit:test:reducer" as IrUnitId],
      [withParam, "ir-unit:test:withParam" as IrUnitId],
      [use, "ir-unit:test:use" as IrUnitId],
    ]),
  };

  const answers = new Map<ts.Node, readonly ts.Declaration[]>([
    [seedRead, [seed]],
    [twinRead, [twinFirst, twinSecond]],
    [reducerValueUse, [reducer]],
    [helperCallee, [importSpecifier]],
    [paramRead, [withParam.parameters[0]!]],
  ]);
  const live: DeclarationQueryOracle = {
    valueDeclarationOf: (node) => answers.get(node)?.[0],
    declarationsOf: (node) => answers.get(node) ?? [],
  };

  return {
    sourceFile,
    identity,
    roleOf: multiPreparedDeclarationRoleClassifier(reducer.body!),
    live,
    nodes: {
      reducer,
      seed,
      twinFirst,
      twinSecond,
      importSpecifier,
      seedRead,
      reducerValueUse,
      helperCallee,
      twinRead,
      paramRead,
    },
  };
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function captureSites(fixture: Fixture, sites: readonly ts.Node[]) {
  const recorder = createDeclarationSnapshotRecorder({
    delegate: fixture.live,
    identity: fixture.identity,
    roleOf: fixture.roleOf,
  });
  for (const site of sites) recorder.oracle.valueDeclarationOf(site);
  return recorder.finalize();
}

function replay(fixture: Fixture, snapshot: SemanticDeclarationSnapshot): DeclarationQueryOracle {
  return createDeclarationSnapshotReplayOracle({ snapshot, identity: fixture.identity, roleOf: fixture.roleOf });
}

function raw(snapshot: SemanticDeclarationSnapshot): Record<string, unknown> {
  return JSON.parse(serializeSemanticDeclarationSnapshot(snapshot)) as Record<string, unknown>;
}

function expectSnapshotError(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected a SemanticDeclarationSnapshotError(${code})`).toBeInstanceOf(
    SemanticDeclarationSnapshotError,
  );
  expect((thrown as SemanticDeclarationSnapshotError).code).toBe(code);
}

describe("#4617 C1 semantic declaration snapshot", () => {
  it("produces identical canonical bytes and digest under a reordered capture traversal", () => {
    const forward = makeFixture();
    const reverse = makeFixture();
    const forwardSites = [
      forward.nodes.seedRead,
      forward.nodes.helperCallee,
      forward.nodes.reducerValueUse,
      forward.nodes.twinRead,
    ];
    const reverseSites = [
      reverse.nodes.twinRead,
      reverse.nodes.reducerValueUse,
      reverse.nodes.helperCallee,
      reverse.nodes.seedRead,
    ];
    const first = captureSites(forward, forwardSites);
    const second = captureSites(reverse, reverseSites);

    expect(second.bytes).toBe(first.bytes);
    expect(digest(second.bytes)).toBe(digest(first.bytes));
    // Parsing and reserializing must reproduce the same bytes.
    expect(serializeSemanticDeclarationSnapshot(parseSemanticDeclarationSnapshot(first.bytes))).toBe(first.bytes);
    expect(first.snapshot.version).toBe(SEMANTIC_DECLARATION_SNAPSHOT_VERSION);
    expect(first.snapshot.queries).toHaveLength(4);
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.queries[0])).toBe(true);
    // A capture with a different site population is a DIFFERENT snapshot: the
    // determinism claim above is not the trivial "any two snapshots match".
    const narrow = makeFixture();
    expect(captureSites(narrow, [narrow.nodes.seedRead]).bytes).not.toBe(first.bytes);
  });

  it("rejects a reversed two-declaration population as non-canonical", () => {
    const fixture = makeFixture();
    const { bytes, snapshot } = captureSites(fixture, [fixture.nodes.twinRead]);
    const query = snapshot.queries[0]!;
    expect(query.declarations).toHaveLength(2);
    expect(query.declarations[0]!.start).toBeLessThan(query.declarations[1]!.start);
    expect(replay(fixture, snapshot).declarationsOf(fixture.nodes.twinRead)).toEqual([
      fixture.nodes.twinFirst,
      fixture.nodes.twinSecond,
    ]);

    const mutated = raw(snapshot);
    const queries = mutated.queries as Array<{ declarations: unknown[] }>;
    queries[0]!.declarations = [...queries[0]!.declarations].reverse();
    expectSnapshotError(() => parseSemanticDeclarationSnapshot(JSON.stringify(mutated)), "non-canonical-order");
    // The unreversed bytes still parse, so the rejection is about ORDER only.
    expect(serializeSemanticDeclarationSnapshot(parseSemanticDeclarationSnapshot(bytes))).toBe(bytes);
  });

  it("fails closed on unknown versions, fields, roles, ranges, and duplicate records", () => {
    const fixture = makeFixture();
    const { snapshot } = captureSites(fixture, [fixture.nodes.seedRead, fixture.nodes.helperCallee]);
    const mutate = (apply: (value: Record<string, unknown>) => void): (() => unknown) => {
      const value = raw(snapshot);
      apply(value);
      return () => parseSemanticDeclarationSnapshot(JSON.stringify(value));
    };
    const queriesOf = (value: Record<string, unknown>) =>
      value.queries as Array<{
        site: Record<string, unknown>;
        valueDeclaration: Record<string, unknown> | null;
        declarations: Array<Record<string, unknown>>;
      }>;

    expectSnapshotError(
      mutate((value) => void (value.version = "semantic-declaration-snapshot/0")),
      "unsupported-version",
    );
    expectSnapshotError(
      mutate((value) => void (value.generatedBy = "test")),
      "unknown-field",
    );
    expectSnapshotError(
      mutate((value) => void (queriesOf(value)[0]!.declarations[0]!.role = "parameter")),
      "unknown-role",
    );
    expectSnapshotError(
      mutate((value) => void (queriesOf(value)[0]!.site.end = queriesOf(value)[0]!.site.start)),
      "invalid-range",
    );
    expectSnapshotError(
      mutate((value) => void (queriesOf(value)[0]!.site.start = -1)),
      "invalid-range",
    );
    expectSnapshotError(
      mutate((value) => void queriesOf(value).unshift(structuredClone(queriesOf(value)[0]!))),
      "duplicate-query",
    );
    expectSnapshotError(
      mutate((value) => {
        const query = queriesOf(value)[0]!;
        query.declarations = [...query.declarations, structuredClone(query.declarations[0]!)];
      }),
      "duplicate-declaration",
    );
    expectSnapshotError(
      mutate((value) => void (queriesOf(value)[0]!.declarations = [])),
      "value-declaration-not-in-population",
    );
    // The unmutated snapshot is accepted, so the eight rejections above are not
    // a schema that rejects everything.
    expect(validateSemanticDeclarationSnapshot(raw(snapshot)).queries).toHaveLength(2);
  });

  it("serves only recorded facts and never guesses a missing one", () => {
    const fixture = makeFixture();
    const nullOracle: DeclarationQueryOracle = { valueDeclarationOf: () => undefined, declarationsOf: () => [] };
    const recorder = createDeclarationSnapshotRecorder({
      delegate: nullOracle,
      identity: fixture.identity,
      roleOf: fixture.roleOf,
    });
    recorder.oracle.valueDeclarationOf(fixture.nodes.seedRead);
    const empty = recorder.finalize();
    const emptyReplay = replay(fixture, empty.snapshot);
    // An explicit null answer and an explicit empty population are FACTS.
    expect(emptyReplay.valueDeclarationOf(fixture.nodes.seedRead)).toBeUndefined();
    expect(emptyReplay.declarationsOf(fixture.nodes.seedRead)).toEqual([]);
    // An ABSENT query is not an answer.
    expectSnapshotError(() => emptyReplay.valueDeclarationOf(fixture.nodes.helperCallee), "missing-query");
    expectSnapshotError(() => emptyReplay.declarationsOf(fixture.nodes.twinRead), "missing-query");

    const captured = captureSites(fixture, [fixture.nodes.helperCallee, fixture.nodes.reducerValueUse]);
    const replayed = replay(fixture, captured.snapshot);
    expect(replayed.valueDeclarationOf(fixture.nodes.helperCallee)).toBe(fixture.nodes.importSpecifier);
    expect(replayed.declarationsOf(fixture.nodes.helperCallee)).toEqual([fixture.nodes.importSpecifier]);
    expect(replayed.valueDeclarationOf(fixture.nodes.reducerValueUse)).toBe(fixture.nodes.reducer);
  });

  it("fails closed on a copied SourceFile, a stale inventory, and drifted references", () => {
    const fixture = makeFixture();
    const { snapshot } = captureSites(fixture, [fixture.nodes.helperCallee, fixture.nodes.reducerValueUse]);

    const copy = ts.createSourceFile("a.ts", SOURCE, ts.ScriptTarget.ES2022, true);
    const copied: DeclarationSnapshotIdentity = {
      ...fixture.identity,
      sourceFileBySourceId: new Map([[SOURCE_ID, copy]]),
    };
    expectSnapshotError(
      () => createDeclarationSnapshotReplayOracle({ snapshot, identity: copied, roleOf: fixture.roleOf }),
      "stale-source",
    );

    const stale: DeclarationSnapshotIdentity = { ...fixture.identity, sourceIdBySourceFile: new Map() };
    expectSnapshotError(
      () => createDeclarationSnapshotReplayOracle({ snapshot, identity: stale, roleOf: fixture.roleOf }),
      "stale-source",
    );

    const uninventoried: DeclarationSnapshotIdentity = { ...fixture.identity, unitIdByDeclaration: new Map() };
    expectSnapshotError(
      () => createDeclarationSnapshotReplayOracle({ snapshot, identity: uninventoried, roleOf: fixture.roleOf }),
      "stale-source",
    );

    const drift = (apply: (declaration: Record<string, unknown>) => void, code: string): void => {
      const value = raw(snapshot);
      const queries = value.queries as Array<{
        valueDeclaration: Record<string, unknown>;
        declarations: Array<Record<string, unknown>>;
      }>;
      const target = queries.find((query) => query.valueDeclaration.role === "named-import-specifier")!;
      apply(target.valueDeclaration);
      target.declarations = [structuredClone(target.valueDeclaration)];
      expectSnapshotError(
        () =>
          createDeclarationSnapshotReplayOracle({
            snapshot: parseSemanticDeclarationSnapshot(JSON.stringify(value)),
            identity: fixture.identity,
            roleOf: fixture.roleOf,
          }),
        code,
      );
    };
    drift((declaration) => void (declaration.end = (declaration.end as number) + 1), "unresolved-declaration");
    drift((declaration) => void (declaration.role = "top-level-function"), "unresolved-declaration");
    drift((declaration) => void (declaration.sourceId = "ir-source:test:0000:source:other.ts"), "stale-source");
    // The untampered identity still replays, so the five rejections are drift.
    expect(replay(fixture, snapshot).valueDeclarationOf(fixture.nodes.helperCallee)).toBe(
      fixture.nodes.importSpecifier,
    );
  });

  it("treats a changed capture answer and an out-of-vocabulary role as invariants", () => {
    const fixture = makeFixture();
    let flipped = false;
    const flipping: DeclarationQueryOracle = {
      valueDeclarationOf: () => (flipped ? fixture.nodes.twinFirst : fixture.nodes.seed),
      declarationsOf: () => (flipped ? [fixture.nodes.twinFirst] : [fixture.nodes.seed]),
    };
    const recorder = createDeclarationSnapshotRecorder({
      delegate: flipping,
      identity: fixture.identity,
      roleOf: fixture.roleOf,
    });
    expect(recorder.oracle.valueDeclarationOf(fixture.nodes.seedRead)).toBe(fixture.nodes.seed);
    flipped = true;
    expectSnapshotError(() => recorder.oracle.valueDeclarationOf(fixture.nodes.seedRead), "capture-answer-changed");

    // A parameter is outside the closed v1 role vocabulary: it is refused at
    // capture rather than recorded as an untyped reference.
    const parameterRecorder = createDeclarationSnapshotRecorder({
      delegate: fixture.live,
      identity: fixture.identity,
      roleOf: fixture.roleOf,
    });
    expectSnapshotError(
      () => parameterRecorder.oracle.valueDeclarationOf(fixture.nodes.paramRead),
      "unsupported-declaration-role",
    );

    // A node from an unregistered source never reaches a record at all.
    const foreign = ts.createSourceFile("b.ts", "export const x = 1;\n", ts.ScriptTarget.ES2022, true);
    expectSnapshotError(
      () => parameterRecorder.oracle.valueDeclarationOf(identifiersNamed(foreign, "x")[0]!),
      "stale-source",
    );

    // Canonicalization of a hand-built population still validates.
    expect(canonicalizeSemanticDeclarationSnapshot([]).queries).toEqual([]);
  });
});
