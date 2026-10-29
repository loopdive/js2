// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7143 slice B0 — pins `scripts/measure-legacy-reach.mjs` on a two-file fixture
 * and the corpus extractor on an inline vitest body.
 *
 * The fixture numbers are the compiler's routing today: `host.ts` touches
 * `document`, which the standalone target cannot claim (legacy body), while
 * `claimed.ts` is IR-emitted everywhere. If the IR learns to claim `host.ts`,
 * the standalone `demoted` counts below drop — update them in that PR.
 */
import { describe, expect, it } from "vitest";
import { extractTestSources, loadCorpus } from "../scripts/legacy-reach-corpus.mjs";
import { aggregate, measureEntry, ratchetGrowth } from "../scripts/measure-legacy-reach.mjs";

const FIXTURE_DIR = "tests/fixtures/legacy-reach";

describe("#7143 measure-legacy-reach", () => {
  it("measures units, demotes and per-kind reach on the fixture", async () => {
    const entries = await loadCorpus([FIXTURE_DIR]);
    expect(entries.map((e) => e.id)).toEqual([
      "files:tests/fixtures/legacy-reach/claimed.ts",
      "files:tests/fixtures/legacy-reach/host.ts",
    ]);
    const rows = [];
    const failures = [];
    for (const entry of entries) {
      const r = await measureEntry(entry, ["standalone"]);
      rows.push(...r.rows);
      failures.push(...r.failures);
    }
    const { standalone } = aggregate(rows, failures, ["standalone"]);
    expect({ ...standalone, kinds: undefined }).toEqual({
      units: 4, // sum, paint, and one <module-init> per file
      demoted: 1,
      synthetic: 0,
      unmatched: 0,
      compileFailures: 0,
      reasons: { "host-surface-unavailable": 1 },
      kinds: undefined,
    });
    expect(standalone.kinds.ReturnStatement).toEqual({
      units: 2,
      demoted: 1,
      reasons: { "host-surface-unavailable": 1 },
    });
    expect(standalone.kinds.PostfixUnaryExpression).toEqual({
      units: 2,
      demoted: 1,
      reasons: { "host-surface-unavailable": 1 },
    });
    expect(standalone.kinds.StringLiteral).toEqual({
      units: 1,
      demoted: 1,
      reasons: { "host-surface-unavailable": 1 },
    });
    expect(standalone.kinds.PlusEqualsToken).toEqual({ units: 1, demoted: 0, reasons: {} });
    expect(rows.filter((r) => r.demoted).map((r) => r.unit)).toEqual(["function:paint@2"]);
  });

  it("flags a kind whose demoted count grew", () => {
    const kinds = (n: number) => ({ units: 3, demoted: n, reasons: {} });
    const baseline = { targets: { standalone: { demoted: 1, kinds: { IfStatement: kinds(1) } } } };
    const same = { standalone: { demoted: 1, kinds: { IfStatement: kinds(1) } } };
    const grown = { standalone: { demoted: 2, kinds: { IfStatement: kinds(1), ThrowStatement: kinds(1) } } };
    expect(ratchetGrowth(baseline, same)).toEqual([]);
    expect(ratchetGrowth(baseline, grown)).toEqual([
      "standalone: total demoted 1 → 2",
      "standalone: ThrowStatement demoted 0 → 1",
    ]);
  });

  it("extracts literal program sources from a vitest body", () => {
    const body = [
      "const SRC = `export function a(): number { return 1; }`;",
      "it('x', async () => {",
      "  await assertEquivalent(`export function b(): number { return 2; }`, []);",
      "  await compileToWasm(SRC);",
      "  await compile('export function c(): number { return 3; }');",
      "  await compileToWasm(`export function d(): number { return ${n}; }`);", // substitution: skipped
      "  expect('not a source').toBe('x');", // not a compile helper: skipped
      "});",
    ].join("\n");
    expect(extractTestSources("x.test.ts", body)).toEqual([
      "export function b(): number { return 2; }",
      "export function a(): number { return 1; }",
      "export function c(): number { return 3; }",
    ]);
  });
});
