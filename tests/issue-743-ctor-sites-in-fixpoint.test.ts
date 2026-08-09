// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #743 — `new F(…)` participates in the IR type-propagation fixpoint.
//
// The single-hop legacy scan gained `new`-site visibility in #4117 and was
// measured at 2 of 43 acorn slots, because acorn's ctor arguments are
// themselves untyped values forwarded from other untyped parameters. The
// fixpoint is the instrument that can see through that forwarding: once the
// chain's SEED is a literal, every hop narrows on iteration. These tests pin
// exactly that — the two-hop case is the one single-hop provably cannot do.
//
// Same flag as the legacy halves (`JS2WASM_FNCTOR_CTOR_PARAM_TYPES`): if the
// fixpoint saw ctor sites while `inferParamTypeFromCallSites` did not, the two
// would infer different signatures for the same fnctor and demote it through
// the "function typeIdx parity mismatch" IR fallback. The flag-off test pins
// that OFF really means invisible, not merely weaker.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildIrUnitTypeMap } from "../src/ir/propagate.js";
import { ts } from "../src/ts-api.js";

function fixture(source: string): {
  checker: ts.TypeChecker;
  file: ts.SourceFile;
  context: IrPlanningIdentityContext;
} {
  const files = new Map([
    ["/repo/a.ts", source],
    ["/repo/lib.d.ts", "declare var undefined: undefined;"],
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noImplicitAny: false,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(["/repo/a.ts"], options, host);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile("/repo/a.ts")!;
  const inventory = buildIrUnitInventory([file], { checker, entrySource: file });
  return { checker, file, context: buildIrPlanningIdentityContext(inventory) };
}

function unitId(context: IrPlanningIdentityContext, file: ts.SourceFile, name: string): IrUnitId {
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )!;
  return context.unitIdByDeclaration.get(declaration)!;
}

// A fnctor whose ctor param is only ever fed through `new`, one hop deep
// (single-hop CAN see this once it looks at `new` at all) and two hops deep
// (only the fixpoint can).
const TWO_HOP = `
  export {};
  function P(n) { const x = n; }
  function mk(v) { return new P(v); }
  function top() { return mk(42); }
`;

const saved = process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES;
beforeEach(() => {
  process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "1";
});
afterEach(() => {
  // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
  if (saved === undefined) delete process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES;
  else process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = saved;
});

describe("#743 — new-expression sites in the propagation fixpoint", () => {
  it("narrows a ctor param fed TRANSITIVELY through an untyped forwarder", () => {
    const { checker, file, context } = fixture(TWO_HOP);
    const map = buildIrUnitTypeMap([file], checker, context);
    // mk's own param narrows from mk(42) — pre-existing behaviour.
    expect(map.get(unitId(context, file, "mk"))?.params).toEqual([{ kind: "f64" }]);
    // P's param narrows ONLY if `new P(v)` is a call-graph edge AND the
    // fixpoint has already narrowed v. Two hops — the #743 case.
    expect(map.get(unitId(context, file, "P"))?.params).toEqual([{ kind: "f64" }]);
  });

  it("widens on conflicting ctor sites instead of guessing", () => {
    const { checker, file, context } = fixture(`
      export {};
      function P(n) { const x = n; }
      function a() { return new P(1); }
      function b() { return new P("s"); }
    `);
    const map = buildIrUnitTypeMap([file], checker, context);
    const param = map.get(unitId(context, file, "P"))?.params[0];
    // Disagreeing sites must never pick a winner. The exact widened atom is
    // the lattice's business (union or dynamic); the assertion is only that
    // it is NOT one of the two concrete claims.
    expect(param).not.toEqual({ kind: "f64" });
    expect(param).not.toEqual({ kind: "string" });
  });

  it("flag off: new-expression sites are invisible, exactly as before #743", () => {
    // (#743 defaults flip, 2026-08-08) OFF is a SPELLING now — unset is ON, so
    // deleting the variable here would silently test the flag-ON path.
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    const { checker, file, context } = fixture(TWO_HOP);
    const map = buildIrUnitTypeMap([file], checker, context);
    // mk still narrows (plain call). P must NOT — its only inflow is `new`.
    expect(map.get(unitId(context, file, "mk"))?.params).toEqual([{ kind: "f64" }]);
    expect(map.get(unitId(context, file, "P"))?.params).not.toEqual([{ kind: "f64" }]);
  });
});
