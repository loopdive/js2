// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Owned fills stay locked while the ledger can audit them. The real output
// pipeline (finalizePipelineModule: allocation-owner stamp, widening, prepared
// WIT; beginPreparedPresentationFinalization: copyModuleData) must accept owned
// ledger output and produce exactly the artifacts of the legacy fill.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreparedIrPipelinePresentation } from "../src/compiler.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { isPrivatelyCopiedFrozenArray } from "../src/wasm/physical/owned-function-data.js";
import type { CompileOptions } from "../src/index.js";

const LOOP = {
  "./entry.ts":
    "export function accumulate(seed: number, limit: number): number { let total = seed; for (let i = 0; i < limit; i++) total = total + i; return total; }",
};
// Mixed native/legacy presentation: finalized through the detached copy.
const MIXED = {
  "./a.ts": "export let left: number = 1; left = left + 1;",
  "./b.ts": "export let right: number = 10; right = right + 2;",
  "./entry.ts": `import { left } from "./a";
import { right } from "./b";
let phase: number = 0;
export function initial(): number { return left * 100 + right; }
function compute(seed: number): number { let total = 0; for (let i = 0; i < 4; i++) total = total + Math.imul(seed, i + 1); return total; }
export async function run(seed: number): Promise<number> { phase = 1; const first = await (seed + 1); phase = 2; return (await compute(first)) + initial(); }`,
};

function present(files: Record<string, string>, options: CompileOptions) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const result = runPreparedIrPipelinePresentation({
    userSourceFiles: ast.sourceFiles,
    entryAst: {
      sourceFile: ast.entryFile,
      checker: ast.checker,
      program: ast.program,
      diagnostics: ast.diagnostics,
      syntacticDiagnostics: ast.syntacticDiagnostics,
    },
    multiAst: ast,
    errors: [],
    codegenOptions: { link: [], sourceMap: false },
    sourcesContent: new Map(ast.sourceFiles.map((file) => [file.fileName, file.text])),
    diagnosticAnchor: ast.entryFile,
    options: { optimize: false, sourceMap: false, moduleName: "owned-finalization", ...options },
  });
  if (result.kind !== "artifacts") throw new Error(`${result.kind}: ${JSON.stringify(result).slice(0, 400)}`);
  return result;
}

/** Route every ledger fill through the owned path; producers stay unchanged. */
function presentOwned(files: Record<string, string>, options: CompileOptions) {
  const owned = vi.spyOn(PhysicalModuleReservations.prototype, "fillFunction").mockImplementation(function (
    this: PhysicalModuleReservations,
    token,
    definition,
  ) {
    this.fillOwnedFunction(token, definition);
  });
  const result = present(files, options);
  expect(owned).toHaveBeenCalled();
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe("owned ledger output through the real output pipeline", () => {
  it.each([
    ["allocation-owner stamp and widening", LOOP, { target: "standalone", standaloneAllocationOwnerExport: "__owner" }],
    ["prepared WIT", LOOP, { target: "gc", wit: true }],
    ["detached mixed finalization", MIXED, { target: "gc" }],
  ] as const)("%s matches legacy-fill artifacts", (_, files, options) => {
    const legacy = present(files, options as CompileOptions);
    const owned = presentOwned(files, options as CompileOptions);
    expect(owned.artifacts.success).toBe(true);
    expect(owned.artifacts.binary).toEqual(legacy.artifacts.binary);
    expect(owned.artifacts.wat).toBe(legacy.artifacts.wat);
    expect(owned.artifacts.wit).toBe(legacy.artifacts.wit);
    // Finalization rewrote released clones; the ledger's owned bodies stay locked.
    const bodies = owned.emission.module.functions.map((fn) => fn.body).filter(isPrivatelyCopiedFrozenArray);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(Object.isFrozen(body)).toBe(true);
  });
});
