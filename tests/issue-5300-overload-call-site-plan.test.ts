// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5300 — a direct call to an overloaded function had no exact AST-site
// lowering plan.
//
// Measured on `origin/main` 4fa179f85f (2026-09-03): `targetForSymbol`
// (`src/ir/imported-functions.ts`) refused every symbol with more than one
// `FunctionDeclaration`, so an overload set produced no direct-call target, the
// call site got no plan, and the ALREADY-CLAIMED caller demoted post-claim with
// `ir/from-ast: direct call to "overloaded" has no exact AST-site plan` — an
// `unpatched-slot` invariant that fails the whole compile. Case (a) below is
// red on base for exactly that reason.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { makeIrImportedFunctionResolver } from "../src/ir/imported-functions.js";
import { ts } from "../src/ts-api.js";

/** Resolve the `overloaded`/`f` callee identifier through the real resolver. */
function resolveCallee(source: string, calleeName: string): { targetName: string } | undefined {
  const fileName = "/repo/entry.ts";
  const host: ts.CompilerHost = {
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
    getSourceFile: (name, languageVersion) =>
      name === fileName ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TS) : undefined,
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    directoryExists: (directoryName) => directoryName === "/repo",
    realpath: (path) => path,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([fileName], { noLib: true, strict: false, target: ts.ScriptTarget.ES2022 }, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const resolver = makeIrImportedFunctionResolver(program.getTypeChecker(), [sourceFile]);

  let callee: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) {
      callee = node.expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  expect(callee, `no call to ${calleeName} in the fixture`).toBeDefined();
  const target = resolver.resolveTopLevelFunctionValue(callee!);
  if (!target) return undefined;
  // The admitted declaration must be the bodied IMPLEMENTATION, never one of
  // the bodiless signatures — the IR emits one callable and that is the body.
  expect(target.declaration.body, "admitted an overload signature instead of the implementation").toBeDefined();
  return { targetName: target.targetName };
}

function rows(result: Awaited<ReturnType<typeof compile>>): readonly string[] {
  return (result.irOutcomes ?? []).map(
    (outcome) => `${outcome.displayName}:${outcome.kind}${outcome.kind === "emitted" ? "" : `/${outcome.code ?? "-"}`}`,
  );
}

describe("#5300 direct call to an overloaded function", () => {
  // (a) RED ON BASE — the compile fails there with `unpatched-slot`.
  it("gives a same-file compatible overload set an exact call-site plan", async () => {
    const result = await compile(
      `
function overloaded(value: number): number;
function overloaded(value: number): number { return value + 1; }
export function run(value: number): number { return overloaded(value); }
`,
      { fileName: "overloads.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    // The caller reaching `emitted` IS the observable proof that the
    // `overloaded(value)` site carried a direct-call plan: without one it
    // demotes post-claim (see the header note), which is an invariant row.
    expect(rows(result)).toEqual(["overloaded:emitted", "run:emitted", "<module-init>:non-executable/-"]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "run")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
  });

  // Compiling is not the contract — computing the right answer is. The IR emits
  // ONE callable for the set, so this is where an admission that silently picked
  // the wrong declaration, or lost an argument, would show up.
  it.each(["gc", "standalone"] as const)("runs an admitted overload set correctly on %s", async (target) => {
    const result = await compile(
      `
function overloaded(value: number): number;
function overloaded(value: number): number { return value * 2 + 1; }
export function run(value: number): number { return overloaded(value) + overloaded(value + 1); }
`,
      { fileName: "overloads-runtime.ts", target },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary!, result.importObject ?? {});
    const run = (instance.exports as Record<string, (value: number) => number>).run!;
    const reference = (value: number): number => value * 2 + 1 + ((value + 1) * 2 + 1);
    for (const value of [0, 1, 5, -3, 1_000_000]) expect(run(value)).toBe(reference(value));
  });

  it("admits the implementation of a compatible overload set as a direct-call target", () => {
    // RED ON BASE: `targetForSymbol` refused the set at `functions.length !== 1`.
    expect(
      resolveCallee(
        `
function overloaded(value: number): number;
function overloaded(value: number): number { return value + 1; }
export function run(value: number): number { return overloaded(value); }
`,
        "overloaded",
      ),
    ).toEqual({ targetName: "overloaded" });
  });

  // (b) GUARD, green on base by construction — measured 2026-09-03: a set whose
  // signatures diverge is refused on base too (by the blanket `functions.length
  // !== 1`), so no formulation of this case can be red. It pins that the #5300
  // admission does NOT widen to divergent sets: relaxing `overloadSignatureShape`
  // turns this red. The divergence here is both arity (1 vs 2 parameters) and
  // the optional parameter the implementation needs to accept both.
  const DIVERGENT = `
function f(a: number): number;
function f(a: number, b: number): number;
function f(a: number, b?: number): number { return a + (b ?? 0); }
export function run(value: number): number { return f(value); }
`;

  it("refuses an overload set whose signatures diverge", () => {
    expect(resolveCallee(DIVERGENT, "f")).toBeUndefined();
  });

  it("keeps a divergent overload set on the ordinary demote path, not an invariant", async () => {
    const result = await compile(DIVERGENT, { fileName: "divergent.ts", trackIrOutcomes: true });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(rows(result)).toEqual([
      "f:unsupported/param-shape-rejected",
      "run:unsupported/call-graph-closure",
      "<module-init>:non-executable/-",
    ]);
    expect(result.irOutcomes?.some((outcome) => outcome.kind === "invariant")).toBe(false);
  });

  // (c) Ambient signatures stay outside the executable unit inventory.
  it("ignores an ambient signature that merges into the overload set", () => {
    expect(
      resolveCallee(
        `
declare function ambient(value: number): number;
function ambient(value: number): number { return value + 1; }
export function run(value: number): number { return ambient(value); }
`,
        "ambient",
      ),
    ).toBeUndefined();
  });

  it("counts no unit for a standalone ambient declaration next to an overload set", async () => {
    // RED ON BASE for the same reason as (a): the compile fails outright.
    const result = await compile(
      `
declare function ambient(value: number): number;
function overloaded(value: number): number;
function overloaded(value: number): number { return value + 1; }
export function run(value: number): number { return overloaded(value); }
`,
      { fileName: "ambient-and-overloads.ts", trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(rows(result)).toEqual(["overloaded:emitted", "run:emitted", "<module-init>:non-executable/-"]);
  });
});
