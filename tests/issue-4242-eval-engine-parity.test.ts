// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4242 Phase 1 (P1-S1) — unit tests for `scripts/eval-engine-parity.mjs`.
 *
 * Driven entirely by SYNTHETIC jsonl fixtures: the gate logic is what needs
 * proving here, and a real test262 run is a later slice (P1-S3). Every case
 * below is a way the gate could wrongly say PROCEED on data that does not
 * support it.
 *
 * The load-bearing one is `tier-pinning`: an "interpreter" run that forgot
 * `TEST262_FULL_RUNTIME_EVAL=1` actually measured the REFUSAL tier, where every
 * dynamic-code call throws TypeError, so quickjs wins in a landslide that means
 * nothing. That comparison MUST be rejected, not merely annotated.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BUCKET_ORDER,
  buildParityArtifact,
  classifyFlip,
  composeRules,
  DEFAULT_RULES,
  evaluateGate,
  extractTierFromLog,
  main,
  parseAcceptedResiduals,
  parseResultsJsonl,
  parseTierAnnouncement,
  renderMarkdown,
  validateRules,
  // @ts-expect-error — plain .mjs script, no type declarations by design.
} from "../scripts/eval-engine-parity.mjs";

// ── fixture helpers ──────────────────────────────────────────────────────────

type Row = { file: string; status: string; error?: string };

function jsonl(rows: Row[]): string {
  return `${rows.map((r) => JSON.stringify({ timestamp: "x", category: "c", scope: "standard", ...r })).join("\n")}\n`;
}

function results(rows: Row[], path = "synthetic.jsonl") {
  return { ...parseResultsJsonl(jsonl(rows)), path };
}

const QUICKJS_TIER = parseTierAnnouncement(
  "QUICKJS (artifact 0c848fd169d8, adapter key 24b25990cf116fd5) — DEFAULT engine (#4242)",
);
const INTERPRETER_TIER = parseTierAnnouncement(
  "INTERPRETER (key abc123, TEST262_FULL_RUNTIME_EVAL=1) — authoritative CI-comparable standalone tier (#2928 E7)",
);
const REFUSAL_TIER = parseTierAnnouncement(
  "REFUSAL (key def456; interpreter abc123) — fast local diagnostic only, NOT CI-comparable",
);

const EVAL = "test/language/eval-code/direct";
const FILES = {
  a: `${EVAL}/a.js`,
  b: `${EVAL}/b.js`,
  c: `${EVAL}/c.js`,
  varEnv: `${EVAL}/var-env-lower-lex-catch-non-strict.js`,
};

/** Build an artifact from row lists, with tiers defaulting to the valid pinning. */
function artifactOf(opts: {
  quickjs: Row[];
  interpreter: Row[];
  baseline?: Row[];
  tiers?: { quickjs: unknown; interpreter: unknown };
  mode?: string;
  manifest?: Set<string>;
  expectedFiles?: Set<string>;
  expectedCount?: number;
}) {
  const inferredExpectedFiles = new Set([...opts.quickjs, ...opts.interpreter].map((row) => row.file));
  return buildParityArtifact({
    quickjs: results(opts.quickjs, "quickjs.jsonl"),
    interpreter: results(opts.interpreter, "interpreter.jsonl"),
    baseline: opts.baseline ? results(opts.baseline, "baseline.jsonl") : null,
    tiers: opts.tiers ?? { quickjs: QUICKJS_TIER, interpreter: INTERPRETER_TIER },
    mode: opts.mode ?? "scoped",
    manifest: opts.manifest ?? null,
    expectedFiles: opts.expectedFiles ?? (opts.expectedCount === undefined ? inferredExpectedFiles : null),
    expectedCount: opts.expectedCount ?? null,
    now: "2026-08-09T00:00:00.000Z",
  });
}

const gateOf = (artifact: unknown, accepted: unknown = { entries: [], present: false }) =>
  evaluateGate(artifact, accepted);

// A clean net-positive baseline scenario reused by several cases.
const CLEAN = {
  quickjs: [
    { file: FILES.a, status: "pass" },
    { file: FILES.b, status: "pass" },
    { file: FILES.c, status: "pass" },
  ],
  interpreter: [
    { file: FILES.a, status: "pass" },
    { file: FILES.b, status: "fail", error: "new.target is not allowed here" },
    { file: FILES.c, status: "pass" },
  ],
  baseline: [
    { file: FILES.a, status: "pass" },
    { file: FILES.b, status: "fail" },
    { file: FILES.c, status: "pass" },
  ],
};

// ── tier provenance ──────────────────────────────────────────────────────────

describe("tier provenance", () => {
  it("parses the three real selection messages, bare or log-prefixed", () => {
    expect(QUICKJS_TIER.tier).toBe("QUICKJS");
    expect(INTERPRETER_TIER.tier).toBe("INTERPRETER");
    expect(REFUSAL_TIER.tier).toBe("REFUSAL");
    expect(parseTierAnnouncement("[test262] runtime-eval tier: INTERPRETER (key k) — x").tier).toBe("INTERPRETER");
  });

  it("returns null for absent / empty / unrecognized announcements", () => {
    for (const bad of [undefined, null, "", "   ", "engine: quickjs", "TURBO (key k)"]) {
      expect(parseTierAnnouncement(bad as string).tier).toBeNull();
    }
  });

  it("extracts a tier from a run log and refuses a log announcing two tiers", () => {
    const log = ["vitest ...", "[test262] runtime-eval tier: QUICKJS (artifact deadbeef) — x", "done"].join("\n");
    expect(extractTierFromLog(log).tier).toBe("QUICKJS");
    const mixed = extractTierFromLog(
      "[test262] runtime-eval tier: QUICKJS (a) — x\n[test262] runtime-eval tier: REFUSAL (b) — y",
    );
    expect(mixed.tier).toBeNull();
    expect(mixed.conflict).toEqual(["QUICKJS", "REFUSAL"]);
    expect(extractTierFromLog("no announcement here").tier).toBeNull();
  });
});

// ── the load-bearing rejection ───────────────────────────────────────────────

describe("tier-pinning invariant (the fake-landslide guard)", () => {
  it("REJECTS a quickjs-vs-REFUSAL comparison even though it looks like a huge win", () => {
    // Every eval test fails under REFUSAL, so quickjs "wins" 3-0. That number is
    // an artifact of the missing TEST262_FULL_RUNTIME_EVAL=1, not of the engine.
    const artifact = artifactOf({
      quickjs: [
        { file: FILES.a, status: "pass" },
        { file: FILES.b, status: "pass" },
        { file: FILES.c, status: "pass" },
      ],
      interpreter: [
        { file: FILES.a, status: "fail", error: "TypeError: dynamic code is refused" },
        { file: FILES.b, status: "fail", error: "TypeError: dynamic code is refused" },
        { file: FILES.c, status: "fail", error: "TypeError: dynamic code is refused" },
      ],
      baseline: CLEAN.baseline,
      tiers: { quickjs: QUICKJS_TIER, interpreter: REFUSAL_TIER },
    });
    expect(artifact.summary.net_vs_interpreter).toBe(3); // the fake landslide
    expect(artifact.admissible).toBe(false);

    const gate = gateOf(artifact);
    expect(gate.verdict).toBe("BLOCKED");
    expect(gate.reason).toMatch(/tier-pinning/);
    expect(gate.reason).toMatch(/REFUSAL/);
    expect(gate.reason).toMatch(/FAKE landslide/);
  });

  it("BLOCKS a missing or unparseable tier announcement on either side", () => {
    const absent = { tier: null, raw: null };
    for (const tiers of [
      { quickjs: absent, interpreter: INTERPRETER_TIER },
      { quickjs: QUICKJS_TIER, interpreter: absent },
      { quickjs: absent, interpreter: absent },
    ]) {
      const gate = gateOf(artifactOf({ ...CLEAN, tiers }));
      expect(gate.verdict).toBe("BLOCKED");
      expect(gate.reasons.some((r: string) => r.includes("NO PARSEABLE TIER"))).toBe(true);
    }
  });

  it("BLOCKS when the engines are swapped (quickjs run announcing INTERPRETER)", () => {
    const gate = gateOf(artifactOf({ ...CLEAN, tiers: { quickjs: INTERPRETER_TIER, interpreter: QUICKJS_TIER } }));
    expect(gate.verdict).toBe("BLOCKED");
    expect(gate.reasons.filter((r: string) => r.startsWith("tier-pinning"))).toHaveLength(2);
  });

  it("admits the correctly pinned pair", () => {
    const artifact = artifactOf(CLEAN);
    expect(artifact.admissible).toBe(true);
    expect(gateOf(artifact).verdict).toBe("PROCEED");
  });
});

// ── bucketing ────────────────────────────────────────────────────────────────

describe("bucket taxonomy", () => {
  const classify = (kind: "win" | "loss", file: string, failingError: string, failingStatus = "fail") =>
    classifyFlip({ file, kind, failingStatus, failingError, otherError: "" }, DEFAULT_RULES).bucket;

  it("routes each named family to its bucket", () => {
    expect(classify("win", FILES.a, "assertion failed")).toBe("genuine-win");
    expect(classify("loss", FILES.a, "new.target is not allowed")).toBe("scope-fidelity");
    expect(classify("loss", FILES.varEnv, "unexpected binding")).toBe("scope-fidelity");
    expect(classify("loss", FILES.a, "instanceof across the membrane failed")).toBe("membrane-residual");
    expect(classify("loss", FILES.a, "defineProperty on wrapper threw")).toBe("membrane-residual");
    expect(classify("loss", "test/annexB/built-ins/Function/x.js", "nope")).toBe("engine-difference");
    expect(classify("loss", FILES.a, 'Import #3 module="js2wasm:runtime-eval"')).toBe("harness-infra");
    expect(classify("loss", FILES.a, "some novel message")).toBe("unattributed");
    expect(BUCKET_ORDER).toContain("unattributed");
  });

  it("classifies a harness break as harness-infra even when quickjs 'wins' it", () => {
    // Ordering guard: with `win` first, a quickjs pass against an interpreter
    // LINK ERROR would launder an instrument break into a genuine win.
    expect(
      classifyFlip(
        {
          file: FILES.a,
          kind: "win",
          failingStatus: "fail",
          failingError: "LinkError: unknown import",
          otherError: "",
        },
        DEFAULT_RULES,
      ).bucket,
    ).toBe("harness-infra");
    expect(classify("loss", FILES.a, "anything", "compile_timeout")).toBe("harness-infra");
  });

  it("inserts --rules entries before the catch-all but after harness-infra", () => {
    const extra = [
      { id: "X1", bucket: "engine-difference", kind: "loss", errorPatterns: ["novel message"], description: "x" },
    ];
    const composed = composeRules(validateRules(extra));
    expect(composed[composed.length - 1].bucket).toBe("unattributed");
    expect(
      classifyFlip(
        { file: FILES.a, kind: "loss", failingStatus: "fail", failingError: "some novel message", otherError: "" },
        composed,
      ).bucket,
    ).toBe("engine-difference");
    expect(
      classifyFlip(
        { file: FILES.a, kind: "loss", failingStatus: "fail", failingError: "LinkError novel message", otherError: "" },
        composed,
      ).bucket,
    ).toBe("harness-infra");
  });

  it("refuses malformed rules files", () => {
    expect(() => validateRules({} as never)).toThrow(/must contain a JSON array/);
    expect(() => validateRules([{ id: "A", bucket: "nope", kind: "loss" }])).toThrow(/not one of/);
    expect(() => validateRules([{ id: "A", bucket: "engine-difference", kind: "sideways" }])).toThrow(/win\|loss\|any/);
    expect(() =>
      validateRules([{ id: "A", bucket: "engine-difference", kind: "loss", errorPatterns: ["("] }]),
    ).toThrow();
  });
});

// ── net / acceptance ─────────────────────────────────────────────────────────

describe("gate: net and accepted-residuals", () => {
  const NET_NEGATIVE = {
    quickjs: [
      { file: FILES.a, status: "pass" },
      { file: FILES.b, status: "fail", error: "new.target is not allowed here" },
      { file: FILES.varEnv, status: "fail", error: "binding mismatch" },
    ],
    interpreter: [
      { file: FILES.a, status: "pass" },
      { file: FILES.b, status: "pass" },
      { file: FILES.varEnv, status: "pass" },
    ],
    baseline: [
      { file: FILES.a, status: "pass" },
      { file: FILES.b, status: "pass" },
      { file: FILES.varEnv, status: "pass" },
    ],
  };

  it("PASSES a clean net-positive run", () => {
    const gate = gateOf(artifactOf(CLEAN));
    expect(gate.verdict).toBe("PROCEED");
    expect(gate.reasons).toEqual([]);
    expect(gate.reason).toMatch(/net \+1/);
  });

  it("BLOCKS net-negative with no accepted-residuals", () => {
    const artifact = artifactOf(NET_NEGATIVE);
    expect(artifact.summary.net_vs_interpreter).toBe(-2);
    const gate = gateOf(artifact);
    expect(gate.verdict).toBe("BLOCKED");
    expect(gate.unaccepted_negative_buckets).toEqual(["scope-fidelity"]);
    expect(gate.reason).toMatch(/no accepted-residuals entry for net-negative bucket `scope-fidelity`/);
  });

  it("PASSES net-negative when an approved residual covers the bucket", () => {
    const accepted = parseAcceptedResiduals(
      [
        "```jsonc",
        "// accepted-residuals (#4242) — parsed by eval-engine-parity.mjs --gate",
        '[ { "bucket": "scope-fidelity", "count_ceiling": 13,',
        '    "rationale": "var-env EvalDeclarationInstantiation approximation, #4238 §4 residual 2",',
        '    "approved_by": "project-lead", "date": "2026-08-09" } ]',
        "```",
      ].join("\n"),
    );
    expect(accepted.present).toBe(true);
    expect(gateOf(artifactOf(NET_NEGATIVE), accepted).verdict).toBe("PROCEED");
  });

  it("BLOCKS when the approved ceiling is below the observed losses", () => {
    const accepted = {
      present: true,
      entries: [
        {
          bucket: "scope-fidelity",
          count_ceiling: 1,
          rationale: "r",
          approved_by: "project-lead",
          date: "2026-08-09",
        },
      ],
    };
    const gate = gateOf(artifactOf(NET_NEGATIVE), accepted);
    expect(gate.verdict).toBe("BLOCKED");
    expect(gate.reason).toMatch(/above its approved count_ceiling 1/);
  });

  it("refuses a malformed or never-acceptable accepted-residuals block", () => {
    expect(() => parseAcceptedResiduals("```jsonc\n// accepted-residuals (#4242)\n[ {, ]\n```")).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      parseAcceptedResiduals(
        '```jsonc\n// accepted-residuals (#4242)\n[ { "bucket": "scope-fidelity", "count_ceiling": 2 } ]\n```',
      ),
    ).toThrow(/missing a non-empty `rationale`/);
    expect(() =>
      parseAcceptedResiduals(
        [
          "```jsonc",
          "// accepted-residuals (#4242)",
          '[ { "bucket": "unattributed", "count_ceiling": 2, "rationale": "r",',
          '    "approved_by": "project-lead", "date": "d" } ]',
        ].join("\n") + "\n```",
      ),
    ).toThrow(/can never be accepted/);
    expect(parseAcceptedResiduals("# an issue file with no block").present).toBe(false);
    const issue = readFileSync(
      join(import.meta.dirname ?? ".", "..", "plan", "issues", "4242-quickjs-eval-default-flip.md"),
      "utf8",
    );
    expect(parseAcceptedResiduals(issue)).toEqual({ present: false, entries: [] });
  });
});

// ── never-acceptable buckets ─────────────────────────────────────────────────

describe("gate: unattributed and harness-infra always block", () => {
  it("BLOCKS an unattributed loss even when the net is positive", () => {
    const artifact = artifactOf({
      quickjs: [
        { file: FILES.a, status: "pass" },
        { file: FILES.b, status: "pass" },
        { file: FILES.c, status: "fail", error: "some novel message nobody triaged" },
      ],
      interpreter: [
        { file: FILES.a, status: "fail", error: "old residual" },
        { file: FILES.b, status: "fail", error: "old residual" },
        { file: FILES.c, status: "pass" },
      ],
      baseline: [
        { file: FILES.a, status: "fail" },
        { file: FILES.b, status: "fail" },
        { file: FILES.c, status: "pass" },
      ],
    });
    expect(artifact.summary.net_vs_interpreter).toBe(1); // net POSITIVE
    expect(artifact.buckets.unattributed.losses).toBe(1);
    const gate = gateOf(artifact);
    expect(gate.verdict).toBe("BLOCKED");
    expect(gate.reason).toMatch(/unattributed: 1 loss\(es\)/);
  });

  it("BLOCKS a harness-infra loss and cannot be excused by an approval", () => {
    const artifact = artifactOf({
      quickjs: [
        { file: FILES.a, status: "fail", error: 'Import #2 module="js2wasm:runtime-eval" function="__eval"' },
        { file: FILES.b, status: "pass" },
      ],
      interpreter: [
        { file: FILES.a, status: "pass" },
        { file: FILES.b, status: "pass" },
      ],
      baseline: [
        { file: FILES.a, status: "pass" },
        { file: FILES.b, status: "pass" },
      ],
    });
    expect(artifact.buckets["harness-infra"].losses).toBe(1);
    const accepted = {
      present: true,
      entries: [{ bucket: "harness-infra", count_ceiling: 99, rationale: "r", approved_by: "project-lead", date: "d" }],
    };
    const gate = gateOf(artifact, accepted);
    expect(gate.verdict).toBe("BLOCKED");
    expect(gate.reasons.some((r: string) => r.includes("the measurement itself is broken"))).toBe(true);
  });
});

// ── set integrity, baseline sanity, full mode ────────────────────────────────

describe("gate: input integrity", () => {
  it("BLOCKS when the two runs did not execute the same files", () => {
    const gate = gateOf(
      artifactOf({
        quickjs: [
          { file: FILES.a, status: "pass" },
          { file: FILES.b, status: "pass" },
        ],
        interpreter: [{ file: FILES.a, status: "pass" }],
        baseline: [{ file: FILES.a, status: "pass" }],
      }),
    );
    expect(gate.verdict).toBe("BLOCKED");
    expect(gate.reason).toMatch(/not like-with-like/);

    // Equal engine sets are not sufficient: both processes can be killed after
    // writing the same short prefix. Pin the requested population separately.
    const expectedFiles = new Set([FILES.a, FILES.b, FILES.c]);
    for (const sharedRows of [[], [{ file: FILES.a, status: "pass" }]]) {
      const artifact = artifactOf({
        quickjs: sharedRows,
        interpreter: sharedRows,
        baseline: CLEAN.baseline,
        expectedFiles,
      });
      expect(artifact.set_mismatch.count).toBe(0);
      expect(artifact.expected_set.complete).toBe(false);
      const gate = gateOf(artifact);
      expect(gate.verdict).toBe("BLOCKED");
      expect(gate.reasons.some((reason: string) => reason.includes("requested files set"))).toBe(true);
    }

    const expectationless = buildParityArtifact({
      quickjs: results(CLEAN.quickjs, "q.jsonl"),
      interpreter: results(CLEAN.interpreter, "i.jsonl"),
      baseline: results(CLEAN.baseline, "b.jsonl"),
      tiers: { quickjs: QUICKJS_TIER, interpreter: INTERPRETER_TIER },
      now: "2026-08-09T00:00:00.000Z",
    });
    expect(gateOf(expectationless).reason).toMatch(/no valid expected measurement set\/count was recorded/);
  });

  it("BLOCKS when no baseline cross-check was supplied", () => {
    const gate = gateOf(artifactOf({ quickjs: CLEAN.quickjs, interpreter: CLEAN.interpreter }));
    expect(gate.verdict).toBe("BLOCKED");
    expect(gate.reason).toMatch(/no standalone baseline supplied/);

    // A partial baseline cannot cross-check the rows it does not contain.
    const artifact = artifactOf({
      quickjs: CLEAN.quickjs,
      interpreter: CLEAN.interpreter,
      baseline: CLEAN.baseline.slice(0, 2),
    });
    expect(artifact.sanity.baseline_missing_files).toBe(1);
    const partialGate = gateOf(artifact);
    expect(partialGate.verdict).toBe("BLOCKED");
    expect(partialGate.reason).toMatch(/baseline is missing 1 measured file/);
  });

  it("BLOCKS when the interpreter run drifts too far from the promoted baseline", () => {
    const rows = (statuses: string[]) => statuses.map((status, idx) => ({ file: `${EVAL}/f${idx}.js`, status }));
    const passing = rows(Array.from({ length: 12 }, () => "pass"));
    const artifact = buildParityArtifact({
      quickjs: results(passing, "q.jsonl"),
      interpreter: results(passing, "i.jsonl"),
      baseline: results(rows(Array.from({ length: 12 }, () => "fail")), "b.jsonl"),
      tiers: { quickjs: QUICKJS_TIER, interpreter: INTERPRETER_TIER },
      expectedFiles: new Set(passing.map((row) => row.file)),
      now: "2026-08-09T00:00:00.000Z",
    });
    expect(artifact.sanity.interpreter_vs_baseline_flips).toBe(12);
    expect(gateOf(artifact).reason).toMatch(/not trustworthy; re-run/);
    expect(evaluateGate(artifact, { entries: [], present: false }, { driftTolerance: 20 }).verdict).toBe("PROCEED");
  });

  it("BLOCKS a full-mode run that moves anything outside the eval-dependent manifest", () => {
    const outside = "test/built-ins/Array/prototype/map/x.js";
    const artifact = artifactOf({
      quickjs: [
        { file: FILES.a, status: "pass" },
        { file: outside, status: "fail", error: "unrelated" },
      ],
      interpreter: [
        { file: FILES.a, status: "pass" },
        { file: outside, status: "pass" },
      ],
      baseline: [
        { file: FILES.a, status: "pass" },
        { file: outside, status: "pass" },
      ],
      mode: "full",
      manifest: new Set([FILES.a]),
    });
    expect(artifact.set.files).toBe(1);
    expect(artifact.outside_set_delta).toEqual({ count: 1, files: [outside] });
    expect(gateOf(artifact).reason).toMatch(/outside-set delta/);
  });
});

// ── artifact / markdown shape ────────────────────────────────────────────────

describe("artifact and markdown", () => {
  it("is deterministic and sorted", () => {
    const shuffled = { ...CLEAN, quickjs: [...CLEAN.quickjs].reverse() };
    const a = artifactOf(CLEAN);
    const b = artifactOf(shuffled);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.buckets)).toEqual(BUCKET_ORDER);
    expect(a.generatedAt).toBe("2026-08-09T00:00:00.000Z");
  });

  it("records provenance, per-flip attribution and neutral status changes", () => {
    const artifact = artifactOf({
      quickjs: [{ file: FILES.a, status: "compile_error", error: "CE: unsupported" }],
      interpreter: [{ file: FILES.a, status: "fail", error: "assertion" }],
      baseline: [{ file: FILES.a, status: "fail" }],
    });
    expect(artifact.summary.net_vs_interpreter).toBe(0);
    expect(artifact.flips).toEqual([]);
    expect(artifact.neutral_status_changes).toEqual({ count: 1, files: [FILES.a] });
    expect(artifact.inputs.interpreter.tier_announcement).toMatch(/^INTERPRETER/);
  });

  it("renders a markdown table that flags an inadmissible comparison", () => {
    const good = renderMarkdown(artifactOf(CLEAN));
    expect(good).toContain("| genuine-win | 1 | 0 | +1 |");
    expect(good).toContain("**net vs interpreter: +1**");
    expect(good).not.toContain("INADMISSIBLE");
    const bad = renderMarkdown(artifactOf({ ...CLEAN, tiers: { quickjs: QUICKJS_TIER, interpreter: REFUSAL_TIER } }));
    expect(bad).toContain("INADMISSIBLE");
  });
});

// ── CLI ──────────────────────────────────────────────────────────────────────

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-parity-"));
  const write = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const quickjsPath = write("quickjs.jsonl", jsonl(CLEAN.quickjs));
  const interpreterPath = write("interpreter.jsonl", jsonl(CLEAN.interpreter));
  const baselinePath = write("baseline.jsonl", jsonl(CLEAN.baseline));
  const expectedPath = write("expected.txt", `${CLEAN.quickjs.map((row) => row.file).join("\n")}\n`);
  const emptyIssue = write("issue.md", "# no accepted-residuals block here\n");

  const run = (args: string[]) => {
    let out = "";
    let err = "";
    const code = main(args, { out: (s: string) => (out += s), err: (s: string) => (err += s) });
    return { code, out, err, lastErrLine: err.trimEnd().split("\n").pop() };
  };

  const baseArgs = [
    "--quickjs",
    quickjsPath,
    "--interpreter",
    interpreterPath,
    "--baseline",
    baselinePath,
    "--expected-files",
    expectedPath,
    "--issue",
    emptyIssue,
    "--now",
    "2026-08-09T00:00:00.000Z",
    "--quickjs-tier",
    QUICKJS_TIER.raw,
    "--interpreter-tier",
    INTERPRETER_TIER.raw,
  ];

  it("exits 0 and puts the verdict on the last stderr line, JSON on stdout", () => {
    const { code, out, lastErrLine } = run([...baseArgs, "--gate", "--json"]);
    expect(code).toBe(0);
    expect(lastErrLine).toMatch(/^eval-engine-parity: OK — /);
    const artifact = JSON.parse(out);
    expect(artifact.gate.verdict).toBe("PROCEED");
    expect(artifact.gate.accepted_residuals.present).toBe(false);
    expect(artifact.schema_version).toBe(1);
    expect(run([...baseArgs.slice(0, 6), "--expected-count", "3", ...baseArgs.slice(8), "--gate"]).code).toBe(0);
  });

  it("exits 1 with the blocking reason as the last line for a refusal-tier diff", () => {
    const { code, lastErrLine } = run([...baseArgs.slice(0, -1), REFUSAL_TIER.raw, "--gate"]);
    expect(code).toBe(1);
    expect(lastErrLine).toMatch(/^eval-engine-parity: BLOCKED — tier-pinning/);
  });

  it("blocks a refusal-tier diff even without --gate (no inadmissible artifact passes)", () => {
    const { code, lastErrLine } = run([...baseArgs.slice(0, -1), REFUSAL_TIER.raw]);
    expect(code).toBe(1);
    expect(lastErrLine).toMatch(/BLOCKED — tier-pinning/);
  });

  it("REFUSES missing tier provenance, unknown args, and stdout collisions", () => {
    const noTier = run([
      "--quickjs",
      quickjsPath,
      "--interpreter",
      interpreterPath,
      "--gate",
      "--baseline",
      baselinePath,
      "--expected-files",
      expectedPath,
    ]);
    expect(noTier.code).toBe(2);
    expect(noTier.lastErrLine).toMatch(/REFUSED — missing tier provenance for the quickjs run/);
    expect(run(["--bogus"]).code).toBe(2);
    expect(run([...baseArgs, "--json", "--markdown"]).lastErrLine).toMatch(/REFUSED — --json and --markdown/);
    expect(run(["--quickjs", quickjsPath, "--gate"]).lastErrLine).toMatch(/REFUSED — --interpreter/);
    expect(run([...baseArgs, "--gate", "--drift-tolerance", "lots"]).code).toBe(2);
    expect(run([...baseArgs, "--gate", "--expected-count", "3"]).lastErrLine).toMatch(
      /REFUSED — pass only one of --expected-files \/ --expected-count/,
    );
    expect(run([...baseArgs.slice(0, 6), ...baseArgs.slice(8), "--gate"]).lastErrLine).toMatch(
      /REFUSED — --gate requires --expected-files/,
    );
    expect(run([...baseArgs.slice(0, 6), "--expected-count", "0", ...baseArgs.slice(8), "--gate"]).code).toBe(2);
    expect(run([]).code).toBe(2);
  });

  it("REFUSES a --gate without a baseline, and an unreadable results file", () => {
    const noBaseline = run([...baseArgs.slice(0, 4), ...baseArgs.slice(6), "--gate"]);
    expect(noBaseline.code).toBe(2);
    expect(noBaseline.lastErrLine).toMatch(/--gate requires --baseline/);
    const missing = run([...baseArgs.slice(0, 1), join(dir, "nope.jsonl"), ...baseArgs.slice(2), "--gate"]);
    expect(missing.code).toBe(2);
    expect(missing.lastErrLine).toMatch(/results file not found/);
  });

  it("writes artifact + markdown files and re-gates a stored artifact", () => {
    const jsonOut = join(dir, "out", "parity.json");
    const mdOut = join(dir, "out", "parity.md");
    expect(run([...baseArgs, "--gate", "--json-out", jsonOut, "--markdown-out", mdOut]).code).toBe(0);
    const regated = run(["--gate", "--diff-json", jsonOut, "--issue", emptyIssue]);
    expect(regated.code).toBe(0);
    expect(regated.lastErrLine).toMatch(/^eval-engine-parity: OK/);
  });

  it("runs as a real subprocess with the documented exit codes", () => {
    const script = join(import.meta.dirname ?? ".", "..", "scripts", "eval-engine-parity.mjs");
    const stderrOf = (args: string[]) => {
      try {
        execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" });
        return { code: 0, stderr: "" };
      } catch (err) {
        const e = err as { status: number; stderr: string };
        return { code: e.status, stderr: e.stderr };
      }
    };
    expect(stderrOf([...baseArgs, "--gate"]).code).toBe(0);
    const blocked = stderrOf([...baseArgs.slice(0, -1), REFUSAL_TIER.raw, "--gate"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr.trimEnd().split("\n").pop()).toMatch(/^eval-engine-parity: BLOCKED — tier-pinning/);
  });
});

// ── provider-cache handoff ──────────────────────────────────────────────────

describe("QuickJS provider cache-only handoff", () => {
  it("refuses a missing artifact without trying to build or mutating its directory", () => {
    const emptyArtifactDir = mkdtempSync(join(tmpdir(), "quickjs-require-cache-empty-"));
    const script = join(import.meta.dirname ?? ".", "..", "scripts", "build-quickjs-eval-provider.mjs");

    let status: number | null | undefined;
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, "--require-cache"], {
        encoding: "utf8",
        env: {
          ...process.env,
          JS2WASM_QUICKJS_ARTIFACT_DIR: emptyArtifactDir,
        },
        stdio: "pipe",
      });
    } catch (err) {
      const failure = err as { status?: number | null; stderr?: string };
      status = failure.status;
      stderr = failure.stderr ?? "";
    }

    expect(status).toBe(1);
    expect(stderr).toMatch(/required quickjs artifact cache entry is missing/);
    expect(stderr).not.toMatch(/artifact cache MISS|building \(key/);
    expect(readdirSync(emptyArtifactDir)).toEqual([]);
  });
});

// ── default-engine CI plumbing ──────────────────────────────────────────────

describe("QuickJS default-readiness CI wiring", () => {
  const root = join(import.meta.dirname ?? ".", "..");
  const sharded = readFileSync(join(root, ".github", "workflows", "test262-sharded.yml"), "utf8");
  const scheduled = readFileSync(join(root, ".github", "workflows", "quickjs-wasi-artifact.yml"), "utf8");
  const refresh = readFileSync(join(root, ".github", "workflows", "refresh-baseline.yml"), "utf8");
  const interpreterLane = readFileSync(join(root, ".github", "workflows", "eval-interpreter-lane.yml"), "utf8");
  const issueTests = readFileSync(join(root, ".github", "workflows", "issue-tests.yml"), "utf8");
  const interpreterFloor = JSON.parse(
    readFileSync(join(root, "benchmarks", "results", "eval-interpreter-lane-floor.json"), "utf8"),
  ) as { pass: number; total: number; tolerance: number };
  const runner = readFileSync(join(root, "scripts", "run-test262-vitest.sh"), "utf8");

  it("makes QuickJS the default while exposing the kept interpreter selector", () => {
    expect(sharded).toMatch(/eval_engine:\n(?:.*\n){0,5}\s+default: quickjs\n\s+type: choice/);
    expect(sharded).toContain("JS2WASM_EVAL_ENGINE: ${{ inputs.eval_engine || 'quickjs' }}");
    expect(runner).toContain('EVAL_ENGINE="${JS2WASM_EVAL_ENGINE:-quickjs}"');
    expect(sharded).toContain("- interpreter");
  });

  it("distributes and cache-only verifies exactly the selected full provider", () => {
    expect(sharded).toContain("quickjs-wasi-${{ steps.quickjs-key.outputs.cache_hash }}");
    expect(sharded).toContain(".test262-cache/quickjs-artifact-*/");
    expect(sharded).toContain(".test262-cache/quickjs-eval-adapter-*.wasm");
    expect(sharded.match(/build-quickjs-eval-provider\.mjs --require-cache/g)).toHaveLength(2);
    expect(sharded.match(/build-runtime-eval-provider\.mjs --require-full-cache/g)).toHaveLength(2);
  });

  it("keeps explicit interpreter dispatches measurement-only after the flip", () => {
    expect(sharded).toContain("inputs.eval_engine == 'interpreter'");
    expect(sharded).toMatch(/promote-baseline:[\s\S]*inputs\.eval_engine == 'interpreter'/);
  });

  it("runs scheduled baseline refreshes on the same QuickJS default", () => {
    expect(refresh).toContain("JS2WASM_EVAL_ENGINE: quickjs");
    expect(refresh).toContain("build-quickjs-eval-provider.mjs");
    expect(refresh).toContain("build-quickjs-eval-provider.mjs --require-cache");
    expect(refresh).toContain(".test262-cache/quickjs-eval-adapter-*.wasm");
    expect(refresh).not.toContain("build-runtime-eval-provider.mjs --require-full-cache");
  });

  it("keeps a weekly native-interpreter anti-rot lane with a bounded floor", () => {
    expect(interpreterLane).toContain("JS2WASM_EVAL_ENGINE: interpreter");
    expect(interpreterLane).toContain('TEST262_FULL_RUNTIME_EVAL: "1"');
    expect(interpreterLane).toContain("TEST262_PATH_FILTER: language/eval-code/");
    expect(interpreterLane).toContain("tests/issue-4242-no-removal.test.ts");
    expect(interpreterFloor).toMatchObject({ pass: 782, total: 816, tolerance: 3 });
  });

  it("pins the broad toolchain-light root-test detector to the kept interpreter", () => {
    expect(issueTests).toMatch(/shard:\n[\s\S]*?JS2WASM_EVAL_ENGINE: interpreter/);
  });

  it("provisions submodules and runs all QuickJS engine suites in the scheduled lane", () => {
    expect(scheduled).toMatch(/pull_request:\n\s+paths:/);
    for (const path of [
      "scripts/quickjs-eval-provider.mjs",
      "scripts/runtime-eval-provider.mjs",
      "tests/quickjs-eval-membrane.test.ts",
      ".github/workflows/quickjs-wasi-artifact.yml",
    ]) {
      expect(scheduled).toContain(`- "${path}"`);
    }
    expect(scheduled.match(/submodules: recursive/g)).toHaveLength(2);
    for (const suite of [
      "tests/quickjs-eval-provider.test.ts",
      "tests/quickjs-eval-membrane.test.ts",
      "tests/issue-4307-closure-carrier-wrap.test.ts",
    ]) {
      expect(scheduled).toContain(suite);
    }
    expect(scheduled).toContain("quickjsArtifactCacheKey");
    expect(scheduled).toContain("build-quickjs-eval-provider.mjs --require-cache");
    expect(scheduled).toMatch(/\.tmp\/quickjs-artifact[\s\S]*include-hidden-files: true/);
  });
});
