// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import * as canonical from "../src/wasm/model/instruction-walk.js";
import * as legacy from "../src/codegen/walk-instructions.js";
import type { Instr } from "../src/wasm/model/instructions.js";

const originalSha256 = "d88b931eaa7f0451217cb85db0f713dd33447bfe393d37752a0e25eb4ee44e14";
const read = (path: string) => readFileSync(new URL("../src/" + path, import.meta.url), "utf8");
const parse = (text: string) => ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function reconstruct(core: string, facade: string): string {
  const c = parse(core),
    f = parse(facade);
  const functions = c.statements.filter(ts.isFunctionDeclaration);
  if (
    c.statements.length !== 5 ||
    functions.map((fn) => fn.name?.text).join(",") !==
      "walkInstructionArrays,walkInstructions,walkInstructionDag,walkChildren"
  )
    throw Error("canonical root population differs");
  if (functions[0]!.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    throw Error("private walker became public");
  if (!functions.slice(1).every((fn) => fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)))
    throw Error("missing public walker export");
  const imports = c.statements.filter(ts.isImportDeclaration);
  if (imports.length !== 1 || imports[0]!.getText(c) !== 'import type { Instr } from "./instructions.js";')
    throw Error("canonical import differs");
  const expected = [
    'import type { Instr, WasmModule } from "../ir/types.js";',
    'import { walkInstructionDag } from "../wasm/model/instruction-walk.js";',
    'export { walkInstructions, walkInstructionDag, walkChildren } from "../wasm/model/instruction-walk.js";',
  ];
  if (f.statements.length !== 4 || expected.some((text, i) => f.statements[i]!.getText(f) !== text))
    throw Error("compatibility imports/exports differ");
  const helper = f.statements[3];
  if (!helper || !ts.isFunctionDeclaration(helper) || helper.name?.text !== "allocatedStructTypeIndices")
    throw Error("missing retained allocation helper");
  const copyright = "// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n";
  if (facade.slice(0, f.statements[0]!.getStart(f)) !== copyright) throw Error("changed compatibility preamble");
  if (facade.slice(helper.end).trim() !== "" || core.slice(functions[3]!.end).trim() !== "")
    throw Error("changed trailing documentation");
  const insert = functions[3]!.getFullStart();
  const withHelper = core.slice(0, insert) + helper.getFullText(f) + core.slice(insert);
  return withHelper.slice(0, imports[0]!.getStart(c)) + expected[0] + withHelper.slice(imports[0]!.end);
}
function current() {
  return [read("wasm/model/instruction-walk.ts"), read("codegen/walk-instructions.ts")] as const;
}
function verify(rows: readonly [string, string]): string {
  const source = reconstruct(...rows);
  expect(hash(source)).toBe(originalSha256);
  return source;
}
function verifyWat(source: string): void {
  const sf = parse(source);
  const imports = sf.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (n) =>
        (n.moduleSpecifier as ts.StringLiteral).text === "../wasm/model/instruction-walk.js" ||
        n.importClause?.namedBindings?.getText(sf).includes("walkInstructions"),
    );
  if (
    imports.length !== 1 ||
    imports[0]!.getText(sf) !== 'import { walkInstructions } from "../wasm/model/instruction-walk.js";'
  )
    throw Error("WAT canonical walker binding differs");
  const aliases = sf.statements
    .filter(ts.isVariableStatement)
    .flatMap((n) => [...n.declarationList.declarations])
    .filter((n) => n.name.getText(sf) === "walkInstrs");
  if (aliases.length !== 1 || aliases[0]!.initializer?.getText(sf) !== "walkInstructions")
    throw Error("WAT walker alias substituted");
}

describe("canonical instruction walker full original receipt", () => {
  it("reconstructs the complete original file including private body, docs and retained helper", () => {
    verify(current());
  });
  for (const [index, from, to] of [
    [0, 'import type { Instr } from "./instructions.js";', ""],
    [0, '"./instructions.js"', '"../../ir/types.js"'],
    [0, "function walkInstructionArrays(", "export function walkInstructionArrays("],
    [0, "visitor(instr);", "visitor(instr); visitor(instr);"],
    [0, "if (visitedArrays?.has(child)) continue;", ""],
    [0, "j >= 0", "j > 0"],
    [0, "if (a.catchAll && Array.isArray(a.catchAll)) fn(a.catchAll);", ""],
    [0, "Walk finalized instruction IR as a graph", "Walk finalized instruction IR as a tree"],
    [1, 'typeof instr.typeIdx === "number"', 'typeof instr.typeIdx === "string"'],
    [1, '"../wasm/model/instruction-walk.js"', '"../wasm/model/missing-walk.js"'],
  ] as const)
    it(`rejects positive-first mutation ${index}:${from}`, () => {
      const rows = [...current()] as [string, string];
      verify(rows);
      expect(rows[index]).toContain(from);
      rows[index] = rows[index].replace(from, to);
      expect(() => verify(rows)).toThrow();
    });
  it("rejects a missing canonical root after a genuine positive", () => {
    const rows = current();
    verify(rows);
    expect(() => verify(["", rows[1]])).toThrow("canonical root population differs");
  });
  it("keeps the emitter on the canonical owner", () => {
    verify(current());
    verifyWat(read("emit/wat.ts"));
  });
  for (const [from, to] of [
    ['import { walkInstructions } from "../wasm/model/instruction-walk.js";', ""],
    ["import { walkInstructions }", "import { walkInstructionDag as walkInstructions }"],
    ["import { walkInstructions }", "import { walkInstructions as renamedWalker }"],
    ['"../wasm/model/instruction-walk.js"', '"../codegen/walk-instructions.js"'],
    ["const walkInstrs = walkInstructions;", "const walkInstrs = () => {};"],
  ] as const)
    it(`rejects positive-first WAT substitution ${to || "missing import"}`, () => {
      verify(current());
      const source = read("emit/wat.ts");
      verifyWat(source);
      expect(source).toContain(from);
      expect(() => verifyWat(source.replace(from, to))).toThrow();
    });
  for (const index of [0, 1] as const)
    it(`rejects an extra executable statement in owner ${index}`, () => {
      const rows = [...current()] as [string, string];
      verify(rows);
      rows[index] += "\nglobalThis.Object.freeze({});\n";
      expect(() => verify(rows)).toThrow();
    });
  it("rejects an extra executable statement inside the private walker", () => {
    const rows = [...current()] as [string, string];
    verify(rows);
    expect(rows[0]).toContain("visitor(instr);");
    rows[0] = rows[0].replace("visitor(instr);", "visitor(instr); globalThis.Object.freeze({});");
    expect(() => verify(rows)).toThrow();
  });
  for (const name of ["walkInstructions", "walkInstructionDag", "walkChildren"] as const)
    it(`preserves compatibility export identity ${name}`, () => {
      verify(current());
      expect(legacy[name]).toBe(canonical[name]);
    });
  it("does not expose the historically private helper", () => {
    verify(current());
    expect(Object.keys(canonical).sort()).toEqual(["walkChildren", "walkInstructionDag", "walkInstructions"]);
    expect(Object.keys(legacy).sort()).toEqual([
      "allocatedStructTypeIndices",
      "walkChildren",
      "walkInstructionDag",
      "walkInstructions",
    ]);
  });
});

function donor() {
  const source = verify(current());
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  new Function("exports", "require", output)(exports, (name: string) => {
    throw Error("unexpected donor runtime dependency " + name);
  });
  return exports as typeof legacy;
}
describe("original and canonical instruction traversal semantics", () => {
  it("invokes the visitor before discovering the possibly replaced child arrays", () => {
    const original = donor();
    for (const api of [original, canonical])
      for (const walk of [api.walkInstructions, api.walkInstructionDag]) {
        const root: Instr = { op: "block", blockType: { kind: "empty" }, body: [{ op: "nop" }] };
        const replacement: Instr[] = [{ op: "drop" }, { op: "return" }],
          seen: string[] = [];
        walk([root], (instr) => {
          seen.push(instr.op);
          if (instr === root) root.body = replacement;
        });
        expect(seen).toEqual(["block", "drop", "return"]);
        expect(root.body).toBe(replacement);
      }
  });
  it("propagates the exact thrown sentinel and stops visiting", () => {
    const original = donor();
    for (const api of [original, canonical])
      for (const walk of [api.walkInstructions, api.walkInstructionDag]) {
        const sentinel = Object.freeze({ sentinel: "visitor" }),
          seen: string[] = [];
        let caught: unknown;
        try {
          walk([{ op: "nop" }, { op: "drop" }], (instr) => {
            seen.push(instr.op);
            throw sentinel;
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(sentinel);
        expect(seen).toEqual(["nop"]);
      }
  });
  it("honors a caller-shared visited set across distinct roots and repeated roots", () => {
    const original = donor();
    for (const api of [original, canonical]) {
      const shared: Instr[] = [{ op: "nop" }],
        first: Instr[] = [{ op: "block", blockType: { kind: "empty" }, body: shared }],
        second: Instr[] = [{ op: "loop", blockType: { kind: "empty" }, body: shared }];
      const visited = new WeakSet<Instr[]>(),
        seen: string[] = [];
      for (const root of [first, second, first, shared])
        api.walkInstructionDag(root, (instr) => seen.push(instr.op), visited);
      expect(seen).toEqual(["block", "nop", "loop"]);
      expect(visited.has(first) && visited.has(second) && visited.has(shared)).toBe(true);
    }
  });
  it("preserves reverse-push marking when sibling child arrays share identity", () => {
    const original = donor();
    for (const api of [original, canonical]) {
      const shared: Instr[] = [{ op: "nop" }],
        middle: Instr[] = [{ op: "drop" }];
      const root: Instr[] = [
        {
          op: "try",
          blockType: { kind: "empty" },
          body: shared,
          catches: [{ tagIdx: 0, body: middle }],
          catchAll: shared,
        },
      ];
      const tree: string[] = [],
        dag: string[] = [];
      api.walkInstructions(root, (instr) => tree.push(instr.op));
      api.walkInstructionDag(root, (instr) => dag.push(instr.op));
      expect(tree).toEqual(["try", "nop", "drop", "nop"]);
      // The donor marks the rightmost shared array while pushing in reverse,
      // so the earlier occurrence is skipped before traversal begins.
      expect(dag).toEqual(["try", "drop", "nop"]);
    }
  });
  it("preserves preorder, sibling order, catches and catchAll", () => {
    const original = donor();
    const root: Instr[] = [
      {
        op: "try",
        blockType: { kind: "empty" },
        body: [{ op: "if", blockType: { kind: "empty" }, then: [{ op: "nop" }], else: [{ op: "drop" }] }],
        catches: [{ tagIdx: 0, body: [{ op: "return" }] }],
        catchAll: [{ op: "unreachable" }],
      },
    ];
    const before: string[] = [],
      after: string[] = [];
    original.walkInstructions(root, (i) => before.push(i.op));
    canonical.walkInstructions(root, (i) => after.push(i.op));
    expect(before).toEqual(["try", "if", "nop", "drop", "return", "unreachable"]);
    expect(after).toEqual(before);
  });
  it("distinguishes occurrence traversal from physical-array DAG traversal", () => {
    const original = donor(),
      shared: Instr[] = [{ op: "nop" }];
    const root: Instr[] = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
    for (const api of [original, canonical]) {
      const tree: string[] = [],
        dag: string[] = [];
      api.walkInstructions(root, (i) => tree.push(i.op));
      api.walkInstructionDag(root, (i) => dag.push(i.op));
      expect(tree).toEqual(["if", "nop", "nop"]);
      expect(dag).toEqual(["if", "nop"]);
    }
  });
  it("retains allocation census across shared function/global roots", () => {
    const original = donor(),
      shared: Instr[] = [{ op: "struct.new", typeIdx: 7 }];
    const module = {
      functions: [{ body: shared }, { body: shared }],
      globals: [{ init: shared }, { init: [{ op: "struct.new", typeIdx: 9 }] }],
    } as Parameters<typeof legacy.allocatedStructTypeIndices>[0];
    expect([...original.allocatedStructTypeIndices(module)]).toEqual([7, 9]);
    expect([...legacy.allocatedStructTypeIndices(module)]).toEqual([7, 9]);
  });
});
