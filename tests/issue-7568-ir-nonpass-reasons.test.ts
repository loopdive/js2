// #7568 — the IR edition report ranks why rows do not pass. Synthetic rows
// only: the assertions are about grouping, order and the section's shape, never
// about counts of the real corpus (#7380).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NO_MESSAGE,
  buildNonPassReasons,
  nonPassReason,
  propertyHelperReader,
  renderNonPassReasons,
} from "../scripts/lib/test262-nonpass-reasons.ts";
import { REGRESSION_EXIT_CODE } from "../scripts/test262-edition-scope.ts";

const TAIL = "; no matching owned static SyntaxError negative verdict is available; PREPARED_TRANSPORT_INVALID: x";
const es5 = (i: number) => `test/built-ins/Object/create/15.2.3.5-1-${i}.js`;
const HELPER_FILES = new Set([es5(1), es5(2)]);

/** [file, status, error] — 13 edition rows; the malformed ones are appended separately. */
const ROWS: [string, string, unknown][] = [
  [es5(1), "compile_error", `L1:1 ir/from-ast: identifier "Array" is not in scope in <module-init>${TAIL}`],
  [es5(2), "compile_error", `L7:3 ir/from-ast: identifier "Array" is not in scope in <module-init>__closure_4${TAIL}`],
  [es5(3), "compile_error", `L1:1 ir/from-ast: identifier "Array" is not in scope (<module-init>)`],
  [es5(4), "compile_error", `L1:1 ir/from-ast: identifier "Object" is not in scope in <module-init>${TAIL}`],
  [es5(5), "compile_error", `L1:1 ir/from-ast: direct call to "eval" has no exact AST-site plan in <module-init>`],
  [
    es5(6),
    "compile_error",
    `L1:1 dynamic operation new Boolean (a wrapper object; #7350 B3bc) has no Prepared intrinsic${TAIL}`,
  ],
  [
    es5(7),
    "fail",
    "aborted in unlowerable unit truncate: ir/from-ast: Math.floor arg must be f64, got dynamic (truncate) [in truncate() ← __module_init_chunk_1 ← <module-init>]",
  ],
  [
    es5(8),
    "fail",
    "aborted in unlowerable unit SwitchTest: ir/from-ast: Math.floor arg must be f64, got dynamic (SwitchTest) [in SwitchTest() ← <module-init>]",
  ],
  [es5(9), "fail", "returned 2 — assert #1 at L10: assert.throws(TypeError, function() { x(); });"],
  [es5(10), "fail", 'returned 3 — assert #2 at L44: assert.throws(TypeError, function() { "abc"; });'],
  [es5(11), "fail", { not: "a string" }],
  [es5(12), "compile_timeout", undefined],
  [es5(13), "pass", undefined],
];
const PATHS = new Set(ROWS.map(([file]) => file));
const rowObjects = () => ROWS.map(([file, status, error]) => ({ file, status, error }));
const MALFORMED = ["a string row", [], { status: "fail" }, { file: 7, status: "fail" }];

describe("#7568 reason normalisation", () => {
  it("keeps the name that is the cause and drops positions, units and the transport tail", () => {
    expect(nonPassReason(ROWS[0][2])).toBe('ir/from-ast: identifier "Array" is not in scope');
    expect(nonPassReason(ROWS[5][2])).toBe(
      "dynamic operation new Boolean (a wrapper object; ## B3bc) has no Prepared intrinsic",
    );
  });

  it("replaces values and test-local names, keeps operators and keywords", () => {
    expect(nonPassReason("L1:1 ir/from-ast: empty array 'arrObj' escapes (<module-init>)")).toBe(
      "ir/from-ast: empty array '…' escapes",
    );
    expect(nonPassReason('expected number but got "abc"; tail')).toBe('expected number but got "…"');
    expect(nonPassReason('bad key "a b c"')).toBe('bad key "…"');
    expect(nonPassReason("operand types for '&' in <module-init>")).toBe("operand types for '&'");
    expect(nonPassReason("'this' reference outside a method")).toBe("'this' reference outside a method");
  });

  it("groups rows without an error text under one placeholder", () => {
    expect([undefined, "", "  ", 42].map(nonPassReason)).toEqual([NO_MESSAGE, NO_MESSAGE, NO_MESSAGE, NO_MESSAGE]);
  });
});

describe("#7568 ranking", () => {
  const ranked = () => buildNonPassReasons([...rowObjects(), ...MALFORMED], PATHS, (file) => HELPER_FILES.has(file));

  it("groups one cause across files and lines, ranked by count then reason", () => {
    const r = ranked();
    expect(r.totalRows).toBe(13);
    expect(r.statuses.map((s) => [s.status, s.rows, s.distinct])).toEqual([
      ["compile_error", 6, 4],
      ["fail", 5, 3],
      ["compile_timeout", 1, 1],
    ]);
    const ce = r.statuses[0];
    expect(ce.reasons.map((g) => [g.count, g.reason])).toEqual([
      [3, 'ir/from-ast: identifier "Array" is not in scope'],
      [1, "dynamic operation new Boolean (a wrapper object; ## B3bc) has no Prepared intrinsic"],
      [1, 'ir/from-ast: direct call to "eval" has no exact AST-site plan'],
      [1, 'ir/from-ast: identifier "Object" is not in scope'],
    ]);
    expect(ce.reasons[0]).toMatchObject({ share: 3 / 13, propertyHelper: 2, examples: [es5(1), es5(2), es5(3)] });
    expect(ce.propertyHelper).toBe(2);
    expect(r.statuses[1].reasons.map((g) => [g.count, g.reason])).toEqual([
      [2, "aborted in unlowerable unit <unit>: ir/from-ast: Math.floor arg must be f64, got dynamic"],
      [2, "assertion failed: assert.throws(TypeError, …)"],
      [1, NO_MESSAGE],
    ]);
    expect(r.statuses[2].reasons.map((g) => g.reason)).toEqual([NO_MESSAGE]);
  });

  it("ranks the missing built-ins of compile errors only", () => {
    expect(ranked().missingBuiltins).toEqual([
      { name: "Array", count: 3 },
      { name: "Object", count: 1 },
      { name: "eval", count: 1 },
      { name: "new Boolean", count: 1 },
    ]);
  });

  it("renders within 120 lines of at most 240 characters, however many reasons", () => {
    const files = Array.from({ length: 900 }, (_, i) => `test/f${i}.js`);
    const rows = files.map((file, i) => ({
      file,
      status: ["compile_error", "fail", "compile_timeout"][i % 3],
      error: `identifier "Name${i % 300}${"x".repeat(200)}" is not in scope`,
    }));
    const lines = renderNonPassReasons(buildNonPassReasons(rows, new Set(files), () => false));
    expect(lines.length).toBeLessThanOrEqual(120);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(240);
    expect(lines[0]).toBe("## Why rows do not pass (#7568)");
  });
});

describe("#7568 report CLI", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "issue-7568-"));
    for (const [file] of ROWS) {
      const includes = HELPER_FILES.has(file) ? "\nincludes: [propertyHelper.js]" : "";
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `/*---\nes5id: 15.2.3.5-1-1${includes}\n---*/\nassert(true);\n`);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const write = (dir: string, rows: unknown[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const meta = { scope: "edition", edition: "ES5", sourceSha: dir, test262Sha: "t", evalEngine: "quickjs" };
    writeFileSync(join(dir, "scope.json"), JSON.stringify(meta));
  };
  const report = (run: string, baselineDir: string) =>
    spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/test262-edition-scope.ts",
        "report",
        ...["--results", join(run, "results.jsonl"), "--meta", join(run, "scope.json"), "--test262", root],
        ...["--baseline-dir", baselineDir, "--summary", join(run, "s.md"), "--json", join(run, "r.json")],
      ],
      { encoding: "utf-8" },
    );

  it("reads propertyHelper.js from the test's frontmatter", () => {
    const uses = propertyHelperReader(root);
    expect([es5(1), es5(3), "test/absent.js"].map(uses)).toEqual([true, false, false]);
  });

  it("prints the section to the log, the summary and the JSON; malformed rows keep the exit code", () => {
    const run = join(root, "run");
    write(run, [...rowObjects(), ...MALFORMED]);
    const clean = report(run, join(root, "absent"));
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("## Why rows do not pass (#7568)");
    expect(readFileSync(join(run, "s.md"), "utf-8")).toContain('identifier "Array" is not in scope');
    const json = JSON.parse(readFileSync(join(run, "r.json"), "utf-8"));
    expect(json.nonPassReasons.missingBuiltins[0]).toEqual({ name: "Array", count: 3 });

    const base = join(root, "base");
    write(
      base,
      rowObjects().map((r) => ({ ...r, status: "pass" })),
    );
    expect(report(run, base).status).toBe(REGRESSION_EXIT_CODE);
  });
});
