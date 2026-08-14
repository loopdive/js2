// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4411) TS7 frontend feasibility probe — the numbers behind the `TsFacade`
 * design, reproducible instead of quoted from a session.
 *
 * Reports, for `typescript@7` vs `typescript@5`:
 *
 *  - **cost to a typed program.** TS5 pays for parsing and checking lib.d.ts
 *    in JS; TS7 does it in Go and ships the result over IPC.
 *  - **per-query checker cost, batched and unbatched.** `Checker.getTypeAtLocation`
 *    takes an ARRAY, so a compile's ~15k queries are a handful of round trips.
 *    This is the measurement that overturned the earlier "TS7's IPC checker is
 *    too slow for the hot path" call.
 *  - **AST node count under both parsers**, as a first parity signal.
 *
 * `--surface` additionally prints the porting surface: SyntaxKind name/value
 * alignment, the `First*`/`Last*` range markers the codebase relies on, and
 * `ts.factory` coverage.
 *
 * Usage:
 *   npx tsx scripts/audit-ts7-api-surface.mts [--surface]
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts5 from "typescript";

const SRC = `
export function fib(n: number): number { return n < 2 ? n : fib(n-1) + fib(n-2); }
export class Box<T> { constructor(private v: T) {} get(): T { return this.v; } }
const xs = [1,2,3].map(x => x * 2).filter(x => x > 2);
export const total = xs.reduce((a, b) => a + b, 0);
`.repeat(20);

const dir = mkdtempSync(join(tmpdir(), "ts7probe-"));
const file = join(dir, "probe.ts");
writeFileSync(file, SRC);
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { target: "esnext", strict: true }, include: ["*.ts"] }),
);

let t = performance.now();
for (let i = 0; i < 20; i++) ts5.createSourceFile("probe.ts", SRC, ts5.ScriptTarget.ESNext, true);
const ts5Parse = (performance.now() - t) / 20;

t = performance.now();
const prog = ts5.createProgram([file], { target: ts5.ScriptTarget.ESNext, strict: true });
const checker5 = prog.getTypeChecker();
const ts5Program = performance.now() - t;
const sf5 = prog.getSourceFile(file)!;
const nodes5: ts5.Node[] = [];
const walk5 = (n: ts5.Node) => {
  nodes5.push(n);
  n.forEachChild(walk5);
};
walk5(sf5);
t = performance.now();
for (const n of nodes5) {
  try {
    checker5.getTypeAtLocation(n);
  } catch {
    /* parentless */
  }
}
const ts5QueryAll = performance.now() - t;

const { API } = await import("typescript7/unstable/sync");
t = performance.now();
const api = new API({ cwd: dir });
const apiCtor = performance.now() - t;

t = performance.now();
const snapshot = api.updateSnapshot({ openFiles: [file] } as never);
const snap = performance.now() - t;

const project = snapshot.getDefaultProjectForFile(file) ?? snapshot.getProjects()[0];
t = performance.now();
const sf7 = project!.program.getSourceFile(file)!;
const sfMs = performance.now() - t;

const nodes7: unknown[] = [];
const walk7 = (n: { forEachChild(cb: (c: never) => void): void }) => {
  nodes7.push(n);
  n.forEachChild(walk7 as never);
};
try {
  walk7(sf7 as never);
} catch {
  /* fall back to statements */
}

const checker7 = project!.checker;
t = performance.now();
checker7.getTypeAtLocation(sf7.statements[0] as never);
const firstQuery = performance.now() - t;

const one = sf7.statements[0] as never;
t = performance.now();
for (let i = 0; i < 200; i++) checker7.getTypeAtLocation(one);
const cachedQuery = (performance.now() - t) / 200;

const sample = nodes7.slice(0, 500) as never[];
t = performance.now();
for (const n of sample) checker7.getTypeAtLocation(n);
const unbatchedPer = (performance.now() - t) / sample.length;

t = performance.now();
checker7.getTypeAtLocation(sample);
const batchedTotal = performance.now() - t;

console.log(
  JSON.stringify(
    {
      bytes: SRC.length,
      ts5NodeCount: nodes5.length,
      ts7NodeCount: nodes7.length,
      ts5ParseMs: +ts5Parse.toFixed(2),
      ts5ProgramPlusCheckerMs: +ts5Program.toFixed(2),
      ts5QueryAllNodesMs: +ts5QueryAll.toFixed(2),
      ts7ApiCtorMs: +apiCtor.toFixed(2),
      ts7SnapshotMs: +snap.toFixed(2),
      ts7GetSourceFileMs: +sfMs.toFixed(2),
      ts7FirstQueryMs: +firstQuery.toFixed(2),
      ts7RepeatQueryMs: +cachedQuery.toFixed(4),
      ts7UnbatchedPerQueryMs: +unbatchedPer.toFixed(4),
      ts7Batched500TotalMs: +batchedTotal.toFixed(2),
      ts7BatchedPerQueryMs: +(batchedTotal / sample.length).toFixed(4),
    },
    null,
    2,
  ),
);
api.close();

// ── Porting surface (--surface) ───────────────────────────────────────
//
// Whether a `TsFacade` can present one interface over both frontends comes
// down to three things: do the kind NAMES line up (the values do not), do the
// `First*`/`Last*` range markers survive (the codebase does ~20 range checks
// on them), and does `ts.factory` map across.
if (process.argv.includes("--surface")) {
  const astMod = await import("typescript7/unstable/ast");
  const factory7 = await import("typescript7/unstable/ast/factory");
  const K7 = astMod.SyntaxKind as unknown as Record<string, number | string>;
  const K5 = ts5.SyntaxKind as unknown as Record<string, number | string>;
  const names = (t: Record<string, number | string>) => Object.keys(t).filter((k) => Number.isNaN(Number(k)));
  const n5 = names(K5);
  const n7 = names(K7);

  let sameValue = 0;
  let differentValue = 0;
  for (const n of n7) {
    if (!(n in K5)) continue;
    if (K5[n] === K7[n]) sameValue++;
    else differentValue++;
  }

  const markers = n5.filter((n) => /^(First|Last)/.test(n));
  const factoryKeys = new Set(Object.keys(factory7));
  // The constructors `src/` actually calls today.
  const usedFactory = [
    "createCallExpression",
    "createPropertyAccessExpression",
    "createIdentifier",
    "createStringLiteral",
    "createObjectLiteralExpression",
    "createExpressionStatement",
    "createVariableStatement",
    "createToken",
    "createNodeArray",
    "createNewExpression",
    "createBlock",
    "createBinaryExpression",
    "createThis",
    "createPropertyAssignment",
    "createParameterDeclaration",
    "createVariableDeclaration",
    "createVariableDeclarationList",
    "createNumericLiteral",
  ];

  console.log(
    JSON.stringify(
      {
        kindNamesTs5: n5.length,
        kindNamesTs7: n7.length,
        sharedNames: n7.filter((n) => n in K5).length,
        sameNumericValue: sameValue,
        differentNumericValue: differentValue,
        onlyInTs5: n5.filter((n) => !(n in K7)),
        onlyInTs7: n7.filter((n) => !(n in K5)),
        firstLastMarkers: markers.length,
        firstLastMissingInTs7: markers.filter((m) => !(m in K7)),
        factoryExportsTs7: factoryKeys.size,
        factoryUsedBySrc: usedFactory.length,
        factoryMissingInTs7: usedFactory.filter((f) => !factoryKeys.has(f)),
        // No parser in the JS package — only a scanner. This is the hard boundary
        // behind the Node-lane-only policy (#1029): reaching an AST needs a live
        // tsgo subprocess, which the browser and the synchronous runtime-eval
        // re-entry cannot spawn.
        ts7ParserExports: Object.keys(astMod).filter((k) => /^(parse|createSourceFile)/i.test(k)),
        ts7ScannerExports: Object.keys(astMod).filter((k) => /scanner/i.test(k)),
      },
      null,
      2,
    ),
  );
}
