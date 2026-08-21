// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { rewriteEvalSuperCallWithMap } from "../src/compiler/validation.js";
import { elideDeadTopLevelBindings } from "../src/deadcode-elide.js";
import { preprocessImports } from "../src/import-resolver.js";
import { injectIteratorStaticsPrelude } from "../src/iterator-statics-prelude.js";
import { injectProcessStdinPrelude } from "../src/process-stdin-prelude.js";
import { PositionMap, type CompilerSourceOriginSpan } from "../src/position-map.js";
import { ts } from "../src/ts-api.js";
import {
  buildIrUnitInventory,
  compareIrIdentity,
  createDerivedIrClassId,
  createDerivedIrUnitId,
  createIrBindingId,
  createIrClassId,
  createIrSourceId,
  createIrUnitId,
  indexIrTerminalDeclarations,
  type IrUnitInventory,
} from "../src/ir/identity.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  requireIrPlanningOwnerUnitId,
  requireIrPlanningSourceId,
  type IrPlanningIdentityInvariantCode,
} from "../src/ir/index.js";

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function collectNodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function expectPlanningInvariant(fn: () => unknown, code: IrPlanningIdentityInvariantCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrPlanningIdentityInvariantError);
  expect(caught).toMatchObject({ code });
}

function taggedSyntheticInventory(entries: readonly { text: string; role: string }[]): IrUnitInventory {
  let text = "";
  const compilerOrigins: CompilerSourceOriginSpan[] = [];
  for (const entry of entries) {
    const start = text.length;
    text += `${entry.text}\n`;
    compilerOrigins.push({
      start,
      end: start + entry.text.length,
      origin: { producer: "iterator-statics-prelude", role: entry.role },
    });
  }
  const positionMap = new PositionMap([{ origStart: 0, origEnd: 0, newLength: text.length, compilerOrigins }]);
  const fixture = source("synthetic.ts", text);
  return buildIrUnitInventory([fixture], {
    entrySource: fixture,
    compilerOriginAt: (_sourceFile, offset) => positionMap.compilerOriginAtOutputOffset(offset),
  });
}

type LegacyProjectionKind = "function" | "class-member" | "module-init";
type LegacyProjectionStatus = "emitted" | "unsupported" | "invariant";

function expectedLegacyProjection(
  file: string,
  rows: readonly (readonly [label: string, unitKind: LegacyProjectionKind, status: LegacyProjectionStatus])[],
) {
  return rows.map(([label, unitKind, status]) => ({
    key: `${file}::${unitKind}::${label}#0`,
    label,
    ordinal: 0,
    unitKind,
    status,
  }));
}

describe("#3520 structural IR identity", () => {
  it("is checkout-root independent and dependency-first regardless of caller insertion order", () => {
    const make = (root: string, reverse: boolean): IrUnitInventory => {
      const entry = source(`${root}/project/src/a.ts`, `import { z } from "./z"; export function a() { return z(); }`);
      const dependency = source(`${root}/project/src/z.ts`, `export function z() { return 1; }`);
      const disconnected = source(`${root}/project/src/m.ts`, `export function m() { return 2; }`);
      const inputs = reverse ? [disconnected, dependency, entry] : [entry, dependency, disconnected];
      return buildIrUnitInventory(inputs, { entrySource: entry });
    };

    const left = make("/checkout-one", false);
    const reversed = make("/checkout-one", true);
    const otherRoot = make("/different/checkout-two", false);
    const identityRows = (inventory: IrUnitInventory) =>
      inventory.sources.map(({ sourceKey, kind, order, id }) => ({ sourceKey, kind, order, id }));

    expect(left.sources.map((record) => record.sourceKey)).toEqual(["z.ts", "a.ts", "m.ts"]);
    expect(identityRows(reversed)).toEqual(identityRows(left));
    expect(identityRows(otherRoot)).toEqual(identityRows(left));
    expect(reversed.terminalUnits.map((unit) => unit.id)).toEqual(left.terminalUnits.map((unit) => unit.id));
  });

  it("orders import-cycle members by the raw canonical source key", () => {
    const a = source("/repo/a.ts", `import { b } from "./b"; export function a() { return b(); }`);
    const b = source("/repo/b.ts", `import { a } from "./a"; export function b() { return a(); }`);
    const forward = buildIrUnitInventory([a, b], { entrySource: a });
    const reversed = buildIrUnitInventory([b, a], { entrySource: a });

    expect(forward.sources.map((record) => record.sourceKey)).toEqual(["a.ts", "b.ts"]);
    expect(reversed.sources.map(({ sourceKey, id }) => ({ sourceKey, id }))).toEqual(
      forward.sources.map(({ sourceKey, id }) => ({ sourceKey, id })),
    );
  });

  it("orders uniquely resolved bare module edges before their importers", () => {
    const entry = source("/repo/entry.ts", `import { z } from "z"; export function main() { return z(); }`);
    const dependency = source("/repo/z.ts", `export function z() { return 1; }`);
    const inventory = buildIrUnitInventory([entry, dependency], { entrySource: entry });

    expect(inventory.sources.map((record) => record.sourceKey)).toEqual(["z.ts", "entry.ts"]);
  });

  it("treats exact resolved dependency entries as authoritative", () => {
    const entry = source("/repo/a.ts", `import { z } from "./z"; export function a() { return z(); }`);
    const middle = source("/repo/m.ts", `export function m() { return 1; }`);
    const syntactic = source("/repo/z.ts", `export function z() { return 2; }`);

    const syntacticInventory = buildIrUnitInventory([entry, middle, syntactic], { entrySource: entry });
    const emptyExact = buildIrUnitInventory([entry, middle, syntactic], {
      entrySource: entry,
      resolvedDependencies: new Map([[entry, []]]),
    });
    const alternateExact = buildIrUnitInventory([entry, middle, syntactic], {
      entrySource: entry,
      resolvedDependencies: new Map([[entry, [middle]]]),
    });

    expect(syntacticInventory.sources.map((record) => record.sourceKey)).toEqual(["z.ts", "a.ts", "m.ts"]);
    expect(emptyExact.sources.map((record) => record.sourceKey)).toEqual(["a.ts", "m.ts", "z.ts"]);
    expect(alternateExact.sources.map((record) => record.sourceKey)).toEqual(["m.ts", "a.ts", "z.ts"]);
  });

  it("does not syntactically rebind a checker-resolved external module", () => {
    const entry = source("/repo/a.ts", `import { value } from "react"; export function a() { return value; }`);
    const unrelated = source("/repo/react.ts", `export const value = 1;`);
    const external = source("/node_modules/react/index.d.ts", `export declare const value: number;`);
    const externalDeclaration = external.statements[0]!;
    const checker = {
      getSymbolAtLocation: () => ({ flags: ts.SymbolFlags.ValueModule, declarations: [externalDeclaration] }),
    } as unknown as ts.TypeChecker;

    expect(
      buildIrUnitInventory([entry, unrelated], { entrySource: entry }).sources.map((row) => row.sourceKey),
    ).toEqual(["react.ts", "a.ts"]);
    expect(
      buildIrUnitInventory([entry, unrelated], { entrySource: entry, checker }).sources.map((row) => row.sourceKey),
    ).toEqual(["a.ts", "react.ts"]);
  });

  it("keeps external declaration-library keys independent of checkout roots and rejects collisions", () => {
    const make = (projectRoot: string, libraryRoot: string) => {
      const entry = source(
        `${projectRoot}/src/entry.ts`,
        `import { dep } from "./dep"; export function main() { return dep(); }`,
      );
      const dependency = source(`${projectRoot}/src/dep.ts`, `export function dep() { return 1; }`);
      const library = source(`${libraryRoot}/types/lib.external.d.ts`, `declare const externalValue: number;`);
      return buildIrUnitInventory([library, entry, dependency], { entrySource: entry });
    };
    const first = make("/checkout-one/project", "/sdk-one");
    const relocated = make("/different/checkout/project", "/relocated/sdk");
    const rows = (inventory: IrUnitInventory) =>
      inventory.sources.map(({ kind, sourceKey, id }) => ({ kind, sourceKey, id }));

    expect(rows(relocated)).toEqual(rows(first));
    expect(first.sources.find((record) => record.kind === "library")?.sourceKey).toBe("@library/lib.external.d.ts");

    const duplicateA = source("/sdk/types/lib.external.d.ts", `declare const a: number;`);
    const duplicateB = source("/sdk/types/lib.external.d.ts", `declare const b: number;`);
    expect(() => buildIrUnitInventory([duplicateA, duplicateB])).toThrow(/duplicate canonical IR source key/);
  });

  it("orders every canonical numeric ID component beyond one digit", () => {
    const sourceIds = Array.from({ length: 12 }, (_, order) =>
      createIrSourceId({ kind: order === 10 ? "entry" : "synthetic", order, sourceKey: `source-${order}.ts` }),
    );
    const owner = sourceIds[0]!;
    const regularUnits = Array.from({ length: 12 }, (_, ordinal) =>
      createIrUnitId({ sourceId: owner, lexicalOwnerId: null, kind: "top-level-function", ordinal }),
    );
    const derivedUnits = Array.from({ length: 12 }, (_, ordinal) =>
      createDerivedIrUnitId({ parentId: owner, role: "lifted-closure", ordinal }),
    );
    const regularClasses = Array.from({ length: 12 }, (_, ordinal) =>
      createIrClassId({ sourceId: owner, lexicalOwnerId: null, declarationKind: "declaration", ordinal }),
    );
    const derivedClasses = Array.from({ length: 12 }, (_, ordinal) =>
      createDerivedIrClassId({ parentId: owner, role: "compiler-class:import-wrapper:test", ordinal }),
    );
    const bindings = Array.from({ length: 12 }, (_, ordinal) =>
      createIrBindingId({ ownerId: owner, domain: "support", role: "test", ordinal }),
    );
    const expectCanonicalOrder = (ids: readonly Parameters<typeof compareIrIdentity>[0][]) =>
      expect([...ids].reverse().sort((a, b) => compareIrIdentity(a, b))).toEqual(ids);

    expectCanonicalOrder(sourceIds);
    expectCanonicalOrder(regularUnits);
    expectCanonicalOrder(derivedUnits);
    expectCanonicalOrder(regularClasses);
    expectCanonicalOrder(derivedClasses);
    expectCanonicalOrder(bindings);
    expect(sourceIds[2]! < sourceIds[10]!).toBe(true);
  });

  it("keeps tagged helper identities stable when unrelated compiler helpers reorder", () => {
    const first = taggedSyntheticInventory([
      { text: "function alpha() { return 1; }", role: "alpha-helper" },
      { text: "function beta() { return 2; }", role: "beta-helper" },
    ]);
    const reversed = taggedSyntheticInventory([
      { text: "function beta() { return 2; }", role: "beta-helper" },
      { text: "function alpha() { return 1; }", role: "alpha-helper" },
    ]);
    const idsByLabel = (inventory: IrUnitInventory) =>
      Object.fromEntries(inventory.terminalUnits.map((unit) => [unit.displayName, unit.id]));

    expect(idsByLabel(reversed)).toEqual(idsByLabel(first));
    expect(first.terminalUnits.every((unit) => unit.kind === "synthetic-support")).toBe(true);
  });

  it("uses producer roles rather than equal display labels as synthetic identity", () => {
    const inventory = taggedSyntheticInventory([
      { text: "function same() { return 1; }", role: "first-semantic-role" },
      { text: "function same() { return 2; }", role: "second-semantic-role" },
    ]);

    expect(inventory.terminalUnits.map((unit) => unit.displayName)).toEqual(["same", "same"]);
    expect(new Set(inventory.terminalUnits.map((unit) => unit.id)).size).toBe(2);
    expect(new Set(inventory.terminalUnits.map((unit) => unit.syntheticRole)).size).toBe(2);
  });

  it("propagates tagged insertion provenance through later replacements only", () => {
    const origin = { producer: "iterator-statics-prelude" as const, role: "helper" };
    const inserted = new PositionMap([
      {
        origStart: 0,
        origEnd: 0,
        newLength: 20,
        compilerOrigins: [{ start: 0, end: 20, origin }],
      },
    ]);
    const laterReplacement = new PositionMap([{ origStart: 4, origEnd: 8, newLength: 6 }]);
    const composed = laterReplacement.compose(inserted);
    const userReplacement = new PositionMap([{ origStart: 4, origEnd: 8, newLength: 6 }]);

    expect(composed.compilerOriginAtOutputOffset(5)).toEqual(origin);
    expect(userReplacement.compilerOriginAtOutputOffset(5)).toBeUndefined();
  });

  it("distinguishes same-offset node:path and timer insertions without name heuristics", () => {
    const text = `
      import { join } from "node:path";
      export function main() { setTimeout(() => {}, 1); return join("a", "b"); }
    `;
    const raw = source("path-timer.ts", text);
    const rawInventory = buildIrUnitInventory([raw], { entrySource: raw });
    const transformed = preprocessImports(text);
    const processed = source("path-timer.ts", transformed.source);
    const declaration = (name: string) =>
      processed.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      )!;

    expect(
      transformed.positionMap.compilerOriginAtOutputOffset(declaration("__js2wasm_path_join").getStart(processed)),
    ).toEqual({ producer: "node-path-prelude", role: "join" });
    expect(transformed.positionMap.compilerOriginAtOutputOffset(declaration("setTimeout").getStart(processed))).toEqual(
      { producer: "timer-shim", role: "set-timeout" },
    );
    expect(transformed.positionMap.compilerOriginAtOutputOffset(declaration("join").getStart(processed))).toEqual({
      producer: "node-path-binding",
      role: "named-join",
    });
    expect(
      transformed.positionMap.compilerOriginAtOutputOffset(declaration("main").getStart(processed)),
    ).toBeUndefined();

    const inventory = buildIrUnitInventory([processed], {
      entrySource: processed,
      compilerOriginAt: (_sourceFile, offset) => transformed.positionMap.compilerOriginAtOutputOffset(offset),
    });
    const timer = inventory.terminalUnits.find((unit) => unit.displayName === "setTimeout");
    const expectedTimerId = createDerivedIrUnitId({
      parentId: inventory.sources[0]!.id,
      role: "compiler-unit:timer-shim:set-timeout",
      ordinal: 0,
    });
    expect(timer).toMatchObject({
      id: expectedTimerId,
      terminal: true,
      terminalOwnerId: expectedTimerId,
      kind: "synthetic-support",
      syntheticRole: "compiler-unit:timer-shim:set-timeout",
    });
    expect(inventory.terminalUnits.find((unit) => unit.displayName === "main")?.id).toBe(
      rawInventory.terminalUnits.find((unit) => unit.displayName === "main")?.id,
    );
  });

  it("tags every typed Node builtin wrapper by semantic module and export", () => {
    const families = [
      ["http", ["get", "request"]],
      ["https", ["get", "request"]],
      ["crypto", ["randomBytes", "randomUUID"]],
      ["url", ["pathToFileURL", "fileURLToPath"]],
      ["module", ["createRequire"]],
      ["fs/promises", ["readFile", "writeFile", "unlink", "stat", "mkdir"]],
      ["os", ["platform", "release"]],
    ] as const;

    for (const [moduleName, names] of families) {
      const text = `import { ${names.join(", ")} } from "node:${moduleName}"; export function main() { return 1; }`;
      const transformed = preprocessImports(text);
      const processed = source(`${moduleName.replace(/\//g, "-")}.ts`, transformed.source);
      for (const name of names) {
        const wrapper = processed.statements.find(
          (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.body !== undefined && statement.name?.text === name,
        )!;
        expect(transformed.positionMap.compilerOriginAtOutputOffset(wrapper.getStart(processed))).toEqual({
          producer: "import-wrapper",
          role: `node-builtin:${moduleName}:${name}`,
        });
      }
    }

    expect(preprocessImports(`import randomBytes from "node:crypto";`).source).toContain(
      `function randomBytes(size: number): Uint8Array`,
    );
  });

  it("keeps user IDs stable through a typed Node wrapper and preserves its exact R0 projection", async () => {
    const text = `
      import { randomBytes } from "node:crypto";
      export class User { m() { return 1; } }
      export function helper() { return new User().m(); }
      export function main() { return helper(); }
    `;
    const raw = source("node-wrapper.ts", text);
    const rawInventory = buildIrUnitInventory([raw], { entrySource: raw });
    const transformed = preprocessImports(text);
    const processed = source("node-wrapper.ts", transformed.source);
    const inventory = buildIrUnitInventory([processed], {
      entrySource: processed,
      compilerOriginAt: (_sourceFile, offset) => transformed.positionMap.compilerOriginAtOutputOffset(offset),
    });
    const rawClass = rawInventory.classes.find((record) => record.displayName === "User")!;
    const processedClass = inventory.classes.find((record) => record.displayName === "User")!;

    expect(processedClass.id).toBe(rawClass.id);
    for (const label of ["User_m", "helper", "main"]) {
      expect(inventory.terminalUnits.find((unit) => unit.displayName === label)?.id).toBe(
        rawInventory.terminalUnits.find((unit) => unit.displayName === label)?.id,
      );
    }
    expect(inventory.terminalUnits.find((unit) => unit.displayName === "randomBytes")?.syntheticRole).toBe(
      "compiler-unit:import-wrapper:node-builtin:crypto:randomBytes",
    );

    const result = await compile(text, { fileName: "node-wrapper.ts", trackIrOutcomes: true });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const outcomeByLabel = new Map((result.irOutcomes ?? []).map((outcome) => [outcome.displayName, outcome]));
    expect(outcomeByLabel.get("User_m")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcomeByLabel.get("helper")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect(outcomeByLabel.get("main")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(
      (result.irOutcomes ?? []).map((outcome) => ({
        key: outcome.key,
        label: outcome.displayName,
        ordinal: outcome.ordinal,
        unitKind: outcome.unitKind,
        status: outcome.kind,
      })),
    ).toEqual(
      expectedLegacyProjection("node-wrapper.ts", [
        ["randomBytes", "function", "unsupported"],
        ["User_m", "class-member", "unsupported"],
        ["helper", "function", "emitted"],
        ["main", "function", "emitted"],
      ]),
    );
  });

  it("tags ambient import classes without inventing executable constructors", () => {
    const text = `
      import { EventEmitter } from "node:events";
      import * as sdk from "sdk";
      let client: sdk.Client;
      if (true) { class Local { m() { return 1; } } }
      export function main() { return client ? new EventEmitter() : null; }
    `;
    const raw = source("ambient-classes.ts", text);
    const rawInventory = buildIrUnitInventory([raw], { entrySource: raw });
    const transformed = preprocessImports(text);
    const processed = source("ambient-classes.ts", transformed.source);
    const inventory = buildIrUnitInventory([processed], {
      entrySource: processed,
      compilerOriginAt: (_sourceFile, offset) => transformed.positionMap.compilerOriginAtOutputOffset(offset),
    });
    const localBefore = rawInventory.classes.find((record) => record.displayName === "Local")!;
    const localAfter = inventory.classes.find((record) => record.displayName === "Local")!;
    const generated = inventory.classes.filter((record) => record.syntheticRole !== undefined);

    expect(localAfter.id).toBe(localBefore.id);
    expect(generated.map((record) => record.syntheticRole).sort()).toEqual([
      "compiler-class:import-wrapper:namespace-class:sdk:Client",
      "compiler-class:import-wrapper:node-builtin-class:events:EventEmitter",
    ]);
    for (const record of generated) {
      expect(inventory.allUnits.filter((unit) => unit.lexicalOwnerId === record.id)).toEqual([]);
    }
  });

  it("isolates eval/super throwing IIFEs from user function-expression ordinals", () => {
    const text = `export function main() { eval("super()"); const user = function user() { return 1; }; return user(); }`;
    const raw = source("eval-super.ts", text);
    const rawInventory = buildIrUnitInventory([raw], { entrySource: raw });
    const transformed = rewriteEvalSuperCallWithMap(text);
    const processed = source("eval-super.ts", transformed.source);
    const inventory = buildIrUnitInventory([processed], {
      entrySource: processed,
      compilerOriginAt: (_sourceFile, offset) => transformed.positionMap.compilerOriginAtOutputOffset(offset),
    });
    const generated = inventory.allUnits.find(
      (unit) => unit.syntheticRole === "compiler-unit:eval-super-rewrite:early-error-thrower",
    );

    expect(generated?.kind).toBe("function-expression");
    expect(inventory.allUnits.find((unit) => unit.displayName === "user")?.id).toBe(
      rawInventory.allUnits.find((unit) => unit.displayName === "user")?.id,
    );
    expect(inventory.terminalUnits.map((unit) => unit.legacyMatchName)).toEqual(["main"]);
  });

  it("distinguishes same names by source and lexical owner without using display labels", () => {
    const a = source(
      "/repo/a.ts",
      `
        export function same() { return 1; }
        export function outer() {
          function same() { return 2; }
          class C { m() { return same(); } }
          return new C().m();
        }
        export class C { m() { return 3; } }
      `,
    );
    const b = source(
      "/repo/b.ts",
      `
        export function same() { return 4; }
        export function outer() {
          function same() { return 5; }
          class C { m() { return same(); } }
          return new C().m();
        }
        export class C { m() { return 6; } }
      `,
    );
    const inventory = buildIrUnitInventory([b, a], { entrySource: b });
    const sameUnits = inventory.allUnits.filter((unit) => unit.displayName === "same");
    const cClasses = inventory.classes.filter((record) => record.displayName === "C");

    expect(sameUnits).toHaveLength(4);
    expect(new Set(sameUnits.map((unit) => unit.id)).size).toBe(4);
    expect(new Set(sameUnits.map((unit) => unit.sourceId)).size).toBe(2);
    expect(sameUnits.filter((unit) => unit.kind === "nested-function").every((unit) => unit.lexicalOwnerId)).toBe(true);
    expect(cClasses).toHaveLength(4);
    expect(new Set(cClasses.map((record) => record.id)).size).toBe(4);
    expect(cClasses.filter((record) => record.lexicalOwnerId !== null)).toHaveLength(2);
  });

  it("builds an exact read-only planning bijection for nested, closure, and class units", () => {
    const dependency = source(
      "/repo/dep.ts",
      `export function same() { return 1; } export class Same { m() { return 2; } }`,
    );
    const entry = source(
      "/repo/entry.ts",
      `
        import { same as dependencySame } from "./dep";
        export function same(value: number) {
          function same() { return dependencySame(); }
          const expression = function same() { return 2; };
          const arrow = () => expression() + same();
          const Anonymous = class {
            m() { return 1; }
            static m() { return 2; }
            get x() { return 3; }
            set x(value: number) {}
            static get x() { return 4; }
            static set x(value: number) {}
            ["computed"]() { return arrow(); }
          };
          return new Anonymous().m() + value;
        }
        const initialized = 1;
      `,
    );
    const inventory = buildIrUnitInventory([entry, dependency], { entrySource: entry });
    const context = buildIrPlanningIdentityContext(inventory);
    const moduleInitId = context.moduleInitUnitIdBySourceFile.get(entry)!;

    expect(context.inventory).toBe(inventory);
    expect(Object.isFrozen(context)).toBe(true);
    expect("set" in context.unitIdByDeclaration).toBe(false);
    expect("set" in context.classIdByDeclaration).toBe(false);
    expect(Reflect.ownKeys(context.unitIdByDeclaration)).toEqual([]);
    const immutableSize = context.unitIdByDeclaration.size;
    expect(Reflect.set(context.unitIdByDeclaration, "backingMap", new Map())).toBe(false);
    expect(context.unitIdByDeclaration.size).toBe(immutableSize);
    expect(context.declarationByUnitId.size).toBe(inventory.allUnits.length - 1);
    expect(context.unitIdByDeclaration.size).toBe(context.declarationByUnitId.size);
    expect(context.declarationByClassId.size).toBe(inventory.classes.length);
    expect(context.classIdByDeclaration.size).toBe(context.declarationByClassId.size);
    expect(context.terminalByUnitId.size).toBe(inventory.terminalUnits.length);

    for (const [declaration, id] of context.unitIdByDeclaration) {
      expect(context.declarationByUnitId.get(id)).toBe(declaration);
    }
    for (const [declaration, id] of context.classIdByDeclaration) {
      expect(context.declarationByClassId.get(id)).toBe(declaration);
    }
    for (const terminal of inventory.terminalUnits) {
      expect(context.terminalByUnitId.get(terminal.id)).toBe(terminal);
    }

    const namedSame = collectNodes(
      entry,
      (node): node is ts.FunctionDeclaration | ts.FunctionExpression =>
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === "same",
    );
    namedSame.push(
      ...collectNodes(
        dependency,
        (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "same",
      ),
    );
    const sameIds = namedSame.map((declaration) => context.unitIdByDeclaration.get(declaration)!);
    expect(namedSame).toHaveLength(4);
    expect(new Set(sameIds).size).toBe(namedSame.length);
    expect(new Set(sameIds.map((id) => inventory.allUnits.find((unit) => unit.id === id)!.sourceId)).size).toBe(2);

    const nested = namedSame.find(
      (declaration) => ts.isFunctionDeclaration(declaration) && !ts.isSourceFile(declaration.parent),
    )!;
    const expression = namedSame.find(ts.isFunctionExpression)!;
    const arrow = collectNodes(entry, ts.isArrowFunction)[0]!;
    expect(inventory.allUnits.find((unit) => unit.id === context.unitIdByDeclaration.get(nested))?.kind).toBe(
      "nested-function",
    );
    expect(inventory.allUnits.find((unit) => unit.id === context.unitIdByDeclaration.get(expression))?.kind).toBe(
      "function-expression",
    );
    expect(inventory.allUnits.find((unit) => unit.id === context.unitIdByDeclaration.get(arrow))?.kind).toBe(
      "arrow-function",
    );

    const anonymousClass = collectNodes(entry, ts.isClassExpression)[0]!;
    const anonymousClassId = context.classIdByDeclaration.get(anonymousClass)!;
    const implicitConstructorId = context.unitIdByDeclaration.get(anonymousClass)!;
    expect(inventory.classes.find((record) => record.id === anonymousClassId)).toMatchObject({
      declarationKind: "expression",
      displayName: "<anonymous-class>",
    });
    expect(inventory.allUnits.find((unit) => unit.id === implicitConstructorId)?.kind).toBe(
      "class-implicit-constructor",
    );

    const executableMembers = anonymousClass.members.filter(
      (member): member is ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
        (ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)) &&
        member.body !== undefined,
    );
    const executableMemberIds = executableMembers.map((member) => context.unitIdByDeclaration.get(member)!);
    expect(new Set(executableMemberIds).size).toBe(executableMembers.length);
    expect(
      executableMemberIds.map((id) => {
        return inventory.allUnits.find((unit) => unit.id === id)!.kind;
      }),
    ).toEqual([
      "class-instance-method",
      "class-static-method",
      "class-instance-getter",
      "class-instance-setter",
      "class-static-getter",
      "class-static-setter",
      "class-instance-method",
    ]);

    const entrySourceId = context.sourceIdBySourceFile.get(entry)!;
    expect(requireIrPlanningSourceId(context, entry)).toBe(entrySourceId);
    expectPlanningInvariant(
      () => requireIrPlanningSourceId(context, source(entry.fileName, entry.text)),
      "source-record-mismatch",
    );
    expect(context.sourceFileBySourceId.get(entrySourceId)).toBe(entry);
    expect(context.moduleInitUnitIdBySourceId.get(entrySourceId)).toBe(moduleInitId);
    expect(context.declarationByUnitId.has(moduleInitId)).toBe(false);
    expect(context.unitIdByDeclaration.has(entry)).toBe(false);
    expect(context.terminalByUnitId.get(moduleInitId)).toMatchObject({
      sourceId: entrySourceId,
      kind: "module-init",
      observedKind: "module-init",
    });
    expect(context.moduleInitUnitIdBySourceFile.has(dependency)).toBe(false);
    expect(indexIrTerminalDeclarations(entry, inventory).get(entry)).toBe(moduleInitId);
  });

  it("gives field evaluation, nested callable, and implicit-constructor units distinct AST anchors", () => {
    const fixture = source(
      "field-callables.ts",
      `
        class Fields {
          static fromArrow = () => 1;
          fromFunction = function () { return 2; };
        }
      `,
    );
    const inventory = buildIrUnitInventory([fixture], { entrySource: fixture });
    const context = buildIrPlanningIdentityContext(inventory);
    const declaration = collectNodes(fixture, ts.isClassDeclaration)[0]!;
    const staticField = collectNodes(fixture, ts.isPropertyDeclaration).find(
      (field) => ts.isIdentifier(field.name) && field.name.text === "fromArrow",
    )!;
    const instanceField = collectNodes(fixture, ts.isPropertyDeclaration).find(
      (field) => ts.isIdentifier(field.name) && field.name.text === "fromFunction",
    )!;
    const arrow = collectNodes(fixture, ts.isArrowFunction)[0]!;
    const expression = collectNodes(fixture, ts.isFunctionExpression)[0]!;
    const unitKindAt = (node: ts.Node) => context.unitByUnitId.get(context.unitIdByDeclaration.get(node)!)?.kind;

    expect(unitKindAt(declaration)).toBe("class-implicit-constructor");
    expect(unitKindAt(staticField)).toBe("class-static-field-initializer");
    expect(unitKindAt(instanceField)).toBe("class-instance-field-initializer");
    expect(unitKindAt(arrow)).toBe("arrow-function");
    expect(unitKindAt(expression)).toBe("function-expression");
    expect(requireIrPlanningOwnerUnitId(context, arrow.body)).toBe(context.moduleInitUnitIdBySourceFile.get(fixture));
    expect(requireIrPlanningOwnerUnitId(context, expression.body)).toBe(context.unitIdByDeclaration.get(declaration));
    expect(context.unitIdByDeclaration.size).toBe(context.declarationByUnitId.size);
    expect(context.declarationByUnitId.size).toBe(inventory.allUnits.length - 1);
  });

  it("keeps planning declaration identities stable when source input order reverses", () => {
    const makeRows = (reverse: boolean) => {
      const a = source(
        "/repo/a.ts",
        `import { same } from "./z"; export function outer() { const fn = () => same(); return fn(); }`,
      );
      const z = source(
        "/repo/z.ts",
        `export function same() { const nested = function same() { return 1; }; return nested(); }
         export class Same { m() { return 2; } }`,
      );
      const inventory = buildIrUnitInventory(reverse ? [z, a] : [a, z], { entrySource: a });
      const context = buildIrPlanningIdentityContext(inventory);
      return {
        sources: inventory.sources.map(({ id, sourceKey, order }) => ({ id, sourceKey, order })),
        units: inventory.allUnits.map((unit) => {
          const declaration = context.declarationByUnitId.get(unit.id);
          return {
            id: unit.id,
            sourceId: unit.sourceId,
            kind: unit.kind,
            declarationKind: declaration?.kind ?? null,
            declarationStart: declaration?.getStart(declaration.getSourceFile()) ?? null,
          };
        }),
        classes: inventory.classes.map((record) => {
          const declaration = context.declarationByClassId.get(record.id)!;
          return { id: record.id, sourceId: record.sourceId, declarationStart: declaration.getStart() };
        }),
      };
    };

    const forward = makeRows(false);
    const reversed = makeRows(true);
    expect(forward.units.length).toBeGreaterThan(3);
    expect(forward.classes.length).toBeGreaterThan(0);
    expect(reversed).toEqual(forward);
  });

  it("rejects duplicate or non-exact planning inventories deterministically", () => {
    const duplicateUnitSource = source(
      "duplicate-units.ts",
      `export function first() { return 1; } export function second() { return 2; }`,
    );
    const duplicateUnits = buildIrUnitInventory([duplicateUnitSource], {
      entrySource: duplicateUnitSource,
      canonicalUnitOrdinalAt: (_sourceFile, _start, _end, kind) => (kind === "top-level-function" ? 0 : undefined),
    });
    expectPlanningInvariant(() => buildIrPlanningIdentityContext(duplicateUnits), "duplicate-unit-id");

    const duplicateClassSource = source("duplicate-classes.ts", `declare class First {} declare class Second {}`);
    const duplicateClasses = buildIrUnitInventory([duplicateClassSource], {
      entrySource: duplicateClassSource,
      canonicalClassOrdinalAt: () => 0,
    });
    expectPlanningInvariant(() => buildIrPlanningIdentityContext(duplicateClasses), "duplicate-class-id");

    const exactSource = source("exact.ts", `export function main() { return 1; }`);
    const exact = buildIrUnitInventory([exactSource], { entrySource: exactSource });
    const copied = Object.freeze({
      sources: exact.sources,
      classes: exact.classes,
      allUnits: exact.allUnits,
      terminalUnits: exact.terminalUnits,
    }) satisfies IrUnitInventory;
    expectPlanningInvariant(() => buildIrPlanningIdentityContext(copied), "untracked-inventory");

    (exactSource as { fileName: string }).fileName = "renamed-after-inventory.ts";
    expectPlanningInvariant(() => buildIrPlanningIdentityContext(exact), "source-record-mismatch");
  });

  it("encodes static, instance, accessor, private, and computed members as distinct units", () => {
    const fixture = source(
      "/repo/members.ts",
      `
        const computed = "dynamic";
        class Shape {
          m() { return 1; }
          static m() { return 2; }
          get x() { return 3; }
          set x(value: number) {}
          static get x() { return 4; }
          static set x(value: number) {}
          #secret() { return 5; }
          [computed]() { return 6; }
        }
      `,
    );
    const inventory = buildIrUnitInventory([fixture], { entrySource: fixture });
    const members = inventory.terminalUnits.filter((unit) => unit.observedKind === "class-member");

    expect(members.map((unit) => unit.kind)).toEqual([
      "class-instance-method",
      "class-static-method",
      "class-instance-getter",
      "class-instance-setter",
      "class-static-getter",
      "class-static-setter",
      "class-instance-method",
      "class-instance-method",
    ]);
    expect(new Set(members.map((unit) => unit.id)).size).toBe(members.length);
    expect(members.filter((unit) => unit.legacyMatchName === "Shape_<computed>")).toHaveLength(2);
    expect(new Set(members.map((unit) => unit.legacyKey)).size).toBe(members.length);
  });

  it("keeps allUnits source-AST exhaustive while terminalUnits retain exact R0 outcome parity", async () => {
    const text = `
      export function outer(value: number): number {
        function nested(n: number) { return n + 1; }
        const arrow = (n: number) => n * 2;
        const object = { method(n: number) { return n - 1; } };
        const Local = class C { m(n: number) { return n; } };
        return nested(arrow(object.method(new Local().m(value))));
      }
      class Counter {
        m() { return 1; }
        static s() { return 2; }
        get x() { return 3; }
        set x(value: number) {}
      }
      const initialized = 1;
    `;
    const fixture = source("inventory.ts", text);
    const inventory = buildIrUnitInventory([fixture], { entrySource: fixture });
    const declarationIndex = indexIrTerminalDeclarations(fixture, inventory);
    const result = await compile(text, { fileName: "inventory.ts", trackIrOutcomes: true });
    const untracked = await compile(text, { fileName: "inventory.ts" });
    const outcomes = result.irOutcomes ?? [];
    const outerTerminal = inventory.terminalUnits.find((unit) => unit.legacyMatchName === "outer")!;
    const nestedClass = inventory.classes.find((record) => record.displayName === "C")!;
    const nestedMethod = inventory.terminalUnits.find((unit) => unit.legacyMatchName === "C_m@nested:237:247")!;

    expect(inventory.sources).toHaveLength(1);
    expect(inventory.classes).toHaveLength(2);
    expect(inventory.allUnits).toHaveLength(12);
    expect(inventory.terminalUnits).toHaveLength(7);
    expect(inventory.allUnits.length).toBeGreaterThan(inventory.terminalUnits.length);
    expect(nestedMethod).toMatchObject({
      kind: "class-instance-method",
      observedKind: "class-member",
      lexicalOwnerId: nestedClass.id,
      containingTerminalOwnerId: outerTerminal.id,
      terminalOwnerId: nestedMethod.id,
    });
    expect(inventory.terminalUnits.map((unit) => unit.legacyMatchName)).toEqual([
      "outer",
      "C_m@nested:237:247",
      "Counter_m",
      "Counter_s",
      "Counter_get_x",
      "Counter_set_x",
      "<module-init>",
    ]);
    expect(outcomes.map((outcome) => outcome.displayName)).toEqual(
      inventory.terminalUnits.map((unit) => unit.legacyMatchName),
    );
    expect(outcomes.map((outcome) => outcome.key)).toEqual(inventory.terminalUnits.map((unit) => unit.legacyKey));
    expect(outcomes.map((outcome) => outcome.unitId)).toEqual(inventory.terminalUnits.map((unit) => unit.id));
    expect(outcomes.map((outcome) => outcome.sourceId)).toEqual(inventory.terminalUnits.map((unit) => unit.sourceId));
    expect([...declarationIndex.values()]).toEqual(inventory.terminalUnits.map((unit) => unit.id));
    expect(declarationIndex.get(fixture)).toBe(inventory.terminalUnits.at(-1)!.id);
    expect(new Set(outcomes.map((outcome) => outcome.unitId)).size).toBe(outcomes.length);
    expect(result.binary).toEqual(untracked.binary);
    expect(
      inventory.allUnits
        .filter((unit) => !unit.terminal)
        .every((unit) => unit.terminalOwnerId !== null || unit.unownedReason === "no-r0-attempt-root"),
    ).toBe(true);
  });

  it("requires producer provenance before promoting a timer shim terminal", () => {
    const text = `// #1501 timer host-import shim (auto-injected)
function setTimeout(callback: () => void) { callback(); }
export function user() { return 1; }
`;
    const fixture = source("timer.ts", text);
    const raw = buildIrUnitInventory([fixture], { entrySource: fixture });
    const timerDeclaration = fixture.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "setTimeout",
    )!;
    const positionMap = new PositionMap([
      {
        origStart: 0,
        origEnd: 0,
        newLength: text.length,
        compilerOrigins: [
          {
            start: timerDeclaration.getStart(fixture),
            end: timerDeclaration.end,
            origin: { producer: "timer-shim", role: "set-timeout" },
          },
        ],
      },
    ]);
    const tagged = buildIrUnitInventory([fixture], {
      entrySource: fixture,
      compilerOriginAt: (_sourceFile, offset) => positionMap.compilerOriginAtOutputOffset(offset),
    });
    const rawTimer = raw.allUnits.find((unit) => unit.displayName === "setTimeout");
    const timer = tagged.allUnits.find((unit) => unit.displayName === "setTimeout");
    const expectedTimerId = createDerivedIrUnitId({
      parentId: tagged.sources[0]!.id,
      role: "compiler-unit:timer-shim:set-timeout",
      ordinal: 0,
    });

    expect(raw.terminalUnits.map((unit) => unit.legacyMatchName)).toEqual(["setTimeout", "user"]);
    expect(rawTimer).toMatchObject({
      terminal: true,
      kind: "top-level-function",
    });
    expect(rawTimer).not.toHaveProperty("syntheticRole");
    expect(tagged.terminalUnits.map((unit) => unit.legacyMatchName)).toEqual(["setTimeout", "user"]);
    expect(timer).toMatchObject({
      id: expectedTimerId,
      terminal: true,
      kind: "synthetic-support",
      syntheticRole: "compiler-unit:timer-shim:set-timeout",
      terminalOwnerId: expectedTimerId,
    });
  });

  it("isolates process.stdin classes and node:path object methods from user ordinals", () => {
    const stdinText = `
      class User { m() { return 1; } }
      export function main() { process.stdin; return new User().m(); }
    `;
    const stdinOriginal = source("stdin.ts", stdinText);
    const stdinOriginalInventory = buildIrUnitInventory([stdinOriginal], { entrySource: stdinOriginal });
    const stdinResult = injectProcessStdinPrelude(stdinText);
    const stdinProcessed = source("stdin.ts", stdinResult.source);
    const stdinProcessedInventory = buildIrUnitInventory([stdinProcessed], {
      entrySource: stdinProcessed,
      compilerOriginAt: (_sourceFile, offset) => stdinResult.positionMap.compilerOriginAtOutputOffset(offset),
    });

    for (const label of ["User_m", "main"]) {
      expect(stdinProcessedInventory.terminalUnits.find((unit) => unit.displayName === label)?.id).toBe(
        stdinOriginalInventory.terminalUnits.find((unit) => unit.displayName === label)?.id,
      );
    }
    expect(
      stdinProcessedInventory.classes.find((record) => record.displayName === "__Js2wasmReadable")?.syntheticRole,
    ).toBe("compiler-class:process-stdin-prelude:readable-class");

    const pathText = `
      import path from "node:path";
      const userObject = { userMethod() { return path.join("a", "b"); } };
      export function main() { return userObject.userMethod(); }
    `;
    const pathOriginal = source("path.ts", pathText);
    const pathOriginalInventory = buildIrUnitInventory([pathOriginal], { entrySource: pathOriginal });
    const pathResult = preprocessImports(pathText);
    const pathProcessed = source("path.ts", pathResult.source);
    const pathProcessedInventory = buildIrUnitInventory([pathProcessed], {
      entrySource: pathProcessed,
      compilerOriginAt: (_sourceFile, offset) => pathResult.positionMap.compilerOriginAtOutputOffset(offset),
    });

    for (const label of ["userMethod", "main"]) {
      expect(pathProcessedInventory.allUnits.find((unit) => unit.displayName === label)?.id).toBe(
        pathOriginalInventory.allUnits.find((unit) => unit.displayName === label)?.id,
      );
    }
    expect(
      pathProcessedInventory.allUnits
        .filter((unit) => unit.displayName === "join")
        .some((unit) => unit.syntheticRole === "compiler-unit:node-path-binding:default-join"),
    ).toBe(true);
  });

  it("keeps user class, member, and function IDs stable from raw source through every target", async () => {
    const text = `
      export class User {
        constructor() {}
        m() { return 1; }
      }
      export function helper() { return new User().m(); }
      export function main() { return helper() + Iterator.from([1]).next().value; }
    `;
    const raw = source("target-matrix.ts", text);
    const rawInventory = buildIrUnitInventory([raw], { entrySource: raw });
    const transformed = injectIteratorStaticsPrelude(text);
    const hostFreeSource = source("target-matrix.ts", transformed.source);
    const hostFreeInventory = buildIrUnitInventory([hostFreeSource], {
      entrySource: hostFreeSource,
      compilerOriginAt: (_sourceFile, offset) => transformed.positionMap.compilerOriginAtOutputOffset(offset),
    });
    const rawClass = rawInventory.classes.find((record) => record.displayName === "User")!;
    const hostFreeClass = hostFreeInventory.classes.find((record) => record.displayName === "User")!;
    const expectedIds = new Map(rawInventory.terminalUnits.map((unit) => [unit.displayName, unit.id] as const));

    expect(transformed.injected).toBe(true);
    expect(hostFreeClass.id).toBe(rawClass.id);
    for (const label of ["User_new", "User_m", "helper", "main"]) {
      expect(hostFreeInventory.terminalUnits.find((unit) => unit.displayName === label)?.id).toBe(
        expectedIds.get(label),
      );
    }

    for (const target of ["gc", "standalone", "wasi"] as const) {
      const result = await compile(text, {
        fileName: "target-matrix.ts",
        target,
        trackIrOutcomes: true,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      for (const label of ["User_new", "User_m", "helper", "main"]) {
        expect(result.irOutcomes?.find((outcome) => outcome.displayName === label)?.unitId).toBe(
          expectedIds.get(label),
        );
      }
    }
  });

  it("preserves retained support ordinals across host-free dead-binding elision", async () => {
    const text = `
      const dead = () => 0;
      const live = () => 1;
      export function main() { return live(); }
    `;
    const raw = source("dce-support.ts", text);
    const canonical = buildIrUnitInventory([raw], { entrySource: raw });
    const elision = elideDeadTopLevelBindings(text);
    const elided = source("dce-support.ts", elision.source);
    const unitOrdinals = new Map(
      canonical.allUnits.map((unit) => [
        `${unit.declarationStart}\u0000${unit.declarationEnd}\u0000${unit.kind}`,
        unit.ordinal,
      ]),
    );
    const classOrdinals = new Map(
      canonical.classes.map((record) => [
        `${record.declarationStart}\u0000${record.declarationEnd}\u0000${record.declarationKind}`,
        record.ordinal,
      ]),
    );
    const unanchored = buildIrUnitInventory([elided], { entrySource: elided });
    const anchored = buildIrUnitInventory([elided], {
      entrySource: elided,
      canonicalUnitOrdinalAt: (_sourceFile, declarationStart, declarationEnd, kind) =>
        unitOrdinals.get(`${declarationStart}\u0000${declarationEnd}\u0000${kind}`),
      canonicalClassOrdinalAt: (_sourceFile, declarationStart, declarationEnd, declarationKind) =>
        classOrdinals.get(`${declarationStart}\u0000${declarationEnd}\u0000${declarationKind}`),
    });
    const canonicalLive = canonical.allUnits.find((unit) => unit.displayName === "live")!;

    expect(elision.elided).toEqual(["dead"]);
    expect(unanchored.allUnits.find((unit) => unit.displayName === "live")?.id).not.toBe(canonicalLive.id);
    expect(anchored.allUnits.find((unit) => unit.displayName === "live")?.id).toBe(canonicalLive.id);
    expect(anchored.allUnits.some((unit) => unit.displayName === "dead")).toBe(false);

    const gc = await compile(text, { fileName: "dce-support.ts", target: "gc", trackIrOutcomes: true });
    const standalone = await compile(text, {
      fileName: "dce-support.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });
    expect(gc.success, JSON.stringify(gc.errors)).toBe(true);
    expect(standalone.success, JSON.stringify(standalone.errors)).toBe(true);
    for (const label of ["main", "<module-init>"]) {
      expect(standalone.irOutcomes?.find((outcome) => outcome.displayName === label)?.unitId).toBe(
        gc.irOutcomes?.find((outcome) => outcome.displayName === label)?.unitId,
      );
    }
  });

  it("keeps the user terminal ID stable across target-specific Iterator prelude injection", async () => {
    const text = `export function main() { return Iterator.from([1]).next().value; }`;
    const gc = await compile(text, { fileName: "iterator-target.ts", trackIrOutcomes: true });
    const standalone = await compile(text, {
      fileName: "iterator-target.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });
    const wasi = await compile(text, {
      fileName: "iterator-target.ts",
      target: "wasi",
      trackIrOutcomes: true,
    });
    const standaloneUntracked = await compile(text, { fileName: "iterator-target.ts", target: "standalone" });
    const wasiUntracked = await compile(text, { fileName: "iterator-target.ts", target: "wasi" });
    const gcOutcomes = gc.irOutcomes ?? [];
    const standaloneOutcomes = standalone.irOutcomes ?? [];
    const wasiOutcomes = wasi.irOutcomes ?? [];
    const gcMain = gcOutcomes.find((outcome) => outcome.displayName === "main")!;
    const standaloneMain = standaloneOutcomes.find((outcome) => outcome.displayName === "main")!;
    const wasiMain = wasiOutcomes.find((outcome) => outcome.displayName === "main")!;

    expect(gc.success).toBe(true);
    expect(standalone.success).toBe(true);
    expect(wasi.success).toBe(true);
    expect(gcOutcomes).toHaveLength(1);
    expect(standaloneOutcomes).toHaveLength(11);
    expect(wasiOutcomes).toHaveLength(11);
    expect(standaloneMain.unitId).toBe(gcMain.unitId);
    expect(wasiMain.unitId).toBe(gcMain.unitId);
    expect(standaloneMain.key).toBe(gcMain.key);
    expect(wasiMain.key).toBe(gcMain.key);
    expect(new Set(standaloneOutcomes.map((outcome) => outcome.unitId)).size).toBe(standaloneOutcomes.length);
    expect(new Set(wasiOutcomes.map((outcome) => outcome.unitId)).size).toBe(wasiOutcomes.length);
    expect(standalone.binary).toEqual(standaloneUntracked.binary);
    expect(wasi.binary).toEqual(wasiUntracked.binary);
  });

  it("preserves the exact R0 projection for every compiler source-prelude family", async () => {
    const assertProjection = async (
      fileName: string,
      text: string,
      options: CompileOptions,
      rows: readonly (readonly [string, LegacyProjectionKind, LegacyProjectionStatus])[],
    ) => {
      const result = await compile(text, { ...options, fileName, trackIrOutcomes: true });
      const projection = (result.irOutcomes ?? []).map((outcome) => ({
        key: outcome.key,
        label: outcome.displayName,
        ordinal: outcome.ordinal,
        unitKind: outcome.unitKind,
        status: outcome.kind,
      }));
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(projection).toEqual(expectedLegacyProjection(fileName, rows));
    };

    await assertProjection("timer-projection.ts", `export function main() { setTimeout(() => {}, 1); return 1; }`, {}, [
      ["setTimeout", "function", "emitted"],
      ["main", "function", "unsupported"],
    ]);
    await assertProjection(
      "path-projection.ts",
      `import { join } from "node:path"; export function main() { return join("a", "b"); }`,
      {},
      [
        ["__js2wasm_path_normStr", "function", "unsupported"],
        ["__js2wasm_path_normalize", "function", "unsupported"],
        ["__js2wasm_path_isAbsolute", "function", "emitted"],
        ["__js2wasm_path_join", "function", "unsupported"],
        ["__js2wasm_path_resolve", "function", "unsupported"],
        ["__js2wasm_path_dirname", "function", "emitted"],
        ["__js2wasm_path_basename", "function", "unsupported"],
        ["__js2wasm_path_extname", "function", "emitted"],
        ["__js2wasm_path_relative", "function", "unsupported"],
        ["join", "function", "unsupported"],
        ["main", "function", "unsupported"],
      ],
    );
    await assertProjection(
      "stdin-projection.ts",
      `export function main() { process.stdin; return 1; }`,
      { target: "wasi" },
      [
        ...[
          "avail",
          "ensure",
          "slice",
          "drainBytes",
          "emitChunk",
          "pump",
          "arm",
          "on",
          "read",
          "setEncoding",
          "pause",
          "resume",
          "destroy",
          "new",
        ].map((member) => [`__Js2wasmReadable_${member}`, "class-member", "unsupported"] as const),
        ["__js2wasm_stdin", "function", "unsupported"],
        ["main", "function", "unsupported"],
        ["<module-init>", "module-init", "unsupported"],
      ],
    );
    await assertProjection(
      "iterator-projection.ts",
      `export function main() { return Iterator.from([1]).next().value; }`,
      { target: "standalone" },
      [
        ...[
          "__j2wIterWrap",
          "__j2wIterCloseRev",
          "__j2wIterCloseAll",
          "__j2wIterReadMode",
          "__j2wIterRequireObject",
          "__j2wIterZipCore",
          "__js2wasm_Iterator_zip",
          "__js2wasm_Iterator_zipKeyed",
          "__js2wasm_Iterator_concat",
          "__js2wasm_Iterator_from",
          "main",
        ].map((label) => [label, "function", "unsupported"] as const),
      ],
    );
  });

  it("inventories implicit constructors and definition/call-time initializer closures under the right owner", () => {
    const fixture = source(
      "definition-expressions.ts",
      `
        class Empty {}
        class Derived extends ((factory: () => any) => factory())(() => class {}) {
          [(() => "computed")()]() {}
          method(value = () => 1, { nested = () => 2 } = {}) {}
        }
      `,
    );
    const inventory = buildIrUnitInventory([fixture], { entrySource: fixture });
    const implicitConstructors = inventory.allUnits.filter((unit) => unit.kind === "class-implicit-constructor");
    const arrows = inventory.allUnits.filter((unit) => unit.kind === "arrow-function");
    const method = inventory.terminalUnits.find((unit) => unit.legacyMatchName === "Derived_method")!;

    expect(inventory.sources).toHaveLength(1);
    expect(inventory.classes).toHaveLength(3);
    expect(inventory.allUnits).toHaveLength(10);
    expect(inventory.terminalUnits.map((unit) => unit.legacyMatchName)).toEqual([
      "Derived_<computed>",
      "Derived_method",
    ]);
    expect(implicitConstructors).toHaveLength(3);
    expect(
      implicitConstructors.every(
        (unit) => unit.terminalOwnerId === null && unit.unownedReason === "no-r0-attempt-root",
      ),
    ).toBe(true);
    expect(arrows.filter((unit) => unit.terminalOwnerId === null)).toHaveLength(3);
    expect(arrows.filter((unit) => unit.terminalOwnerId === method.id)).toHaveLength(2);
    expect(arrows.every((unit) => unit.lexicalOwnerId !== null)).toBe(true);
  });

  it("keeps export-assignment expressions unowned without manufacturing an R0 row", () => {
    const fixture = source("default-export.ts", `export default (() => 1);`);
    const inventory = buildIrUnitInventory([fixture], { entrySource: fixture });

    expect(inventory.terminalUnits).toEqual([]);
    expect(inventory.allUnits.map((unit) => unit.kind)).toEqual(["export-assignment", "arrow-function"]);
    expect(
      inventory.allUnits.every((unit) => unit.terminalOwnerId === null && unit.unownedReason === "no-r0-attempt-root"),
    ).toBe(true);
  });

  it("keeps heritage/computed/decorator expressions unowned beside an unrelated module-init root", () => {
    const fixture = source(
      "decorators.ts",
      `
        const unrelated = 1;
        @((target: unknown) => target)
        class Decorated extends (() => class {})() {
          @((target: unknown, key: string) => undefined)
          [(() => "method")()]() {}
        }
      `,
    );
    const inventory = buildIrUnitInventory([fixture], { entrySource: fixture });
    const decorators = inventory.allUnits.filter((unit) => unit.kind === "arrow-function");

    expect(inventory.terminalUnits.map((unit) => unit.legacyMatchName)).toEqual([
      "Decorated_<computed>",
      "<module-init>",
    ]);
    expect(decorators).toHaveLength(4);
    expect(
      decorators.every((unit) => unit.terminalOwnerId === null && unit.unownedReason === "no-r0-attempt-root"),
    ).toBe(true);
  });
});
