// #5298 — the kind-neutrality gate's RECORD must key on quote identity, not on
// the quote's current line.
//
// `scripts/check-ir-kind-neutrality.mjs` R2 is sound: a verdict fails when its
// cited QUOTE is gone. What was brittle is what the baseline stored — every
// surviving quote was persisted as `file:<current line>`, so R4's table
// comparison diffed POSITIONS. Adding 14 comment lines to
// `src/ir/integration.ts` (PR #5525) moved the `forof.string` quote from 7347
// to 7361 and turned `quality` red on a PR that changed no kind, no verdict and
// no count.
//
// These tests run the real script via `execFileSync` against a SANDBOX COPY of
// `src/ir/` + the two script files, so they can edit evidence files without
// touching the working tree. The two behaviours are opposite sides of one
// property — the record must move when the evidence does, and only then:
//
//   (a) a line inserted ABOVE a cited quote  → gate stays GREEN
//       (red on base: this is the #5525 failure, reproduced there before the fix)
//   (b) a cited quote DELETED                → gate stays RED with the R2 message
//       (the fix must not buy (a) by weakening R2, which is the obvious wrong way
//        to make (a) pass)
//
// plus a direct pin on the persisted shape, so a future revert to line-pinned
// cites fails here rather than in someone else's `quality` run.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const REPO = process.cwd();
const SCRIPT = "scripts/check-ir-kind-neutrality.mjs";
const BASELINE = "scripts/ir-kind-neutrality-baseline.json";

// The sandbox lives under the repo's gitignored `.tmp/` (not os.tmpdir) so that
// `import("prettier")` inside the script still resolves by walking up to the
// repo's node_modules — the writer's format pass is part of what is under test.
const TMP_ROOT = path.join(REPO, ".tmp");

/** One kind whose evidence spans two files; the exact pair that broke on #5525. */
const KIND = "forof.string";
const QUOTE_FILE = "src/ir/dialect/js.ts";
const QUOTE = "Code-point extraction intent";
const DRIFT_FILE = "src/ir/integration.ts";
const DRIFT_QUOTE = "__str_charAt_cp";

let sandbox: string;

/** Run the gate in `dir`. Never throws: the exit code is the thing under test. */
function runGate(dir: string, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const readIn = (file: string) => readFileSync(path.join(sandbox, file), "utf8");
const writeIn = (file: string, text: string) => writeFileSync(path.join(sandbox, file), text);
const restore = (file: string) => cpSync(path.join(REPO, file), path.join(sandbox, file));

beforeAll(() => {
  mkdirSync(TMP_ROOT, { recursive: true });
  sandbox = mkdtempSync(path.join(TMP_ROOT, "issue-5298-"));
  mkdirSync(path.join(sandbox, "scripts"), { recursive: true });
  cpSync(path.join(REPO, "src/ir"), path.join(sandbox, "src/ir"), { recursive: true });
  for (const f of [SCRIPT, BASELINE]) cpSync(path.join(REPO, f), path.join(sandbox, f));
});

// Each case gets a pristine sandbox: without this a FAILING case leaves its
// edit behind and the next one reports a failure it did not cause — which is
// how (b) would read as "red on base" when what is red on base is (a).
beforeEach(() => {
  for (const f of [DRIFT_FILE, QUOTE_FILE, BASELINE]) restore(f);
});

afterAll(() => {
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

describe("#5298 kind-neutrality evidence is keyed by quote identity, not by line", () => {
  it("control: the untouched sandbox reproduces the committed baseline exactly", () => {
    const { code, out } = runGate(sandbox);
    expect(out).toContain("IR kind-neutrality gate: OK");
    expect(code).toBe(0);
  });

  it("(a) a line inserted ABOVE a cited quote does not move the record", () => {
    const before = readIn(DRIFT_FILE);
    const at = before.indexOf(DRIFT_QUOTE);
    expect(at, `${DRIFT_FILE} no longer contains ${DRIFT_QUOTE}`).toBeGreaterThan(-1);
    const lineBefore = before.slice(0, at).split("\n").length;

    // One comment line, far above the citation — the #5525 shape.
    const lines = before.split("\n");
    lines.splice(Math.max(0, lineBefore - 200), 0, "  // #5298 test: line-drift above a cited quote");
    writeIn(DRIFT_FILE, lines.join("\n"));

    const moved = readIn(DRIFT_FILE);
    const lineAfter = moved.slice(0, moved.indexOf(DRIFT_QUOTE)).split("\n").length;
    expect(lineAfter, "the quote must actually have moved for this test to mean anything").toBe(lineBefore + 1);

    const { code, out } = runGate(sandbox);
    expect(out).not.toContain("the verdict table no longer matches");
    expect(code).toBe(0);

    restore(DRIFT_FILE);
    expect(runGate(sandbox).code).toBe(0);
  });

  it("(b) a DELETED quote still fails R2, naming the kind and the quote", () => {
    const text = readIn(QUOTE_FILE);
    expect(text).toContain(QUOTE);
    writeIn(QUOTE_FILE, text.replace(QUOTE, "Code-unit extraction intent (#5298 test: quote removed)"));

    const { code, out } = runGate(sandbox);
    expect(code).toBe(1);
    expect(out).toContain("the cited evidence is gone");
    expect(out).toContain(`"${KIND}"`);
    expect(out).toContain(QUOTE);

    restore(QUOTE_FILE);
    expect(runGate(sandbox).code).toBe(0);
  });

  it("(c) the persisted record carries no `file:line` cite at all", () => {
    const baseline = JSON.parse(readIn(BASELINE)) as {
      kinds: Record<string, { declaredAt: string; evidence: string[] }>;
    };
    const entries = Object.entries(baseline.kinds);
    expect(entries.length).toBeGreaterThan(0);

    for (const [kind, entry] of entries) {
      expect(entry.declaredAt, `${kind}.declaredAt`).toMatch(/^[^#]+#[A-Za-z0-9_]+$/);
      for (const cite of entry.evidence) {
        // An absence claim has no position to pin and is carried verbatim.
        if (cite.startsWith("(absent from ")) continue;
        expect(cite, `${kind} evidence`).toMatch(/^[^#]+#[0-9a-f]{12}$/);
      }
    }
  });

  it("(d) --update-on-decrease writes prettier-clean JSON without a manual pass", () => {
    // Perturb a non-ratchet field so the table mismatches while nothing grew,
    // and write it in the raw `JSON.stringify` shape the old writer emitted.
    const baseline = JSON.parse(readIn(BASELINE)) as { kinds: Record<string, { why: string }> };
    baseline.kinds[KIND].why = "#5298 test: perturbed to force a table mismatch";
    writeIn(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);

    const { code, out } = runGate(sandbox, ["--update-on-decrease"]);
    expect(out).toContain("--update-on-decrease");
    expect(code).toBe(0);

    const written = readIn(BASELINE);
    const formatted = execFileSync(
      "node",
      [path.join(REPO, "node_modules/prettier/bin/prettier.cjs"), "--parser", "json"],
      {
        cwd: REPO,
        input: written,
        encoding: "utf8",
      },
    );
    expect(written).toBe(formatted);

    // …and the perturbation is gone: the writer re-derived the table.
    expect(written).not.toContain("#5298 test: perturbed");
    restore(BASELINE);
  });
});
