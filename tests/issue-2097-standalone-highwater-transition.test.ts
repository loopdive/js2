// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2097 -- authenticated raw endpoint transition manifest.
 *
 * The small policy is a test-only seam. The production builder and executable
 * accept the immutable, audited 48,735-row policy from the implementation.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST,
  STANDALONE_HIGHWATER_TRANSITION_POLICY,
  buildStandaloneHighwaterTransitionManifest,
  buildStandaloneHighwaterTransitionManifestForTest,
  isStandaloneHostFreePass,
  renderStandaloneHighwaterTransitionManifestForTest,
  runTransitionManifestCliForTest,
  transitionRowsSha256,
  verifyStandaloneHighwaterTransitionManifest,
  verifyStandaloneHighwaterTransitionManifestForTest,
} from "../scripts/standalone-highwater-transition-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/standalone-highwater-transition-manifest.mjs");
const HIGHWATER = resolve(ROOT, "benchmarks/results/test262-standalone-highwater.json");
const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const KEYS = ["test/a.js", "test/b.js", "test/c.js"];

type Status = "pass" | "fail" | "compile_error" | "compile_timeout" | "skip";
type Row = {
  category?: string;
  compile_ms?: number;
  error?: string;
  error_category?: string;
  error_signature?: string;
  exec_ms?: number;
  file: string;
  host_import_leak_class?: string;
  imports?: string[];
  oracle_lane?: string;
  oracle_version?: number;
  poison_healed?: boolean;
  reached_test?: boolean;
  retried?: boolean;
  retry_count?: number | null;
  scope?: string;
  scope_official?: boolean;
  scope_reason?: string;
  status: Status;
  strict?: string;
  timestamp?: string;
};
type Endpoint = {
  commitSha: string;
  jsonl: Buffer;
  mode: { include_proposals: 0 | 1; label: string; target: "standalone" };
  report: Buffer;
  reportValue: Record<string, unknown>;
};
type Inputs = {
  baseline: { jsonl: Buffer; report: Buffer };
  candidate: { jsonl: Buffer; report: Buffer };
  expectedKeys: Buffer;
};

function descriptor(bytes: Buffer) {
  return {
    bytes: bytes.byteLength,
    gitBlob: createHash("sha1")
      .update(Buffer.from("blob " + bytes.byteLength + "\0", "utf8"))
      .update(bytes)
      .digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonRoundTrippedNullProtoMember(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify({ ...value, ["__proto__"]: null })) as Record<string, unknown>;
}

function rawHostFreePass(row: Row) {
  return row.status === "pass" && row.imports === undefined && row.host_import_leak_class === undefined;
}

function fullSummary(rows: readonly Row[]) {
  const summary = {
    total: rows.length,
    pass: 0,
    fail: 0,
    compile_error: 0,
    compile_timeout: 0,
    skip: 0,
    compilable: 0,
    host_free_pass: 0,
    stale: 0,
  };
  for (const entry of rows) {
    summary[entry.status]++;
    if (rawHostFreePass(entry)) summary.host_free_pass++;
  }
  summary.compilable = summary.pass + summary.fail;
  return summary;
}

function report(commitSha: string, rows: readonly Row[], mode: Endpoint["mode"], timestamp = "2026-08-30T12:00:00Z") {
  return {
    baseline_generated_at: "2026-08-30T11:00:00Z",
    baseline_sha: commitSha,
    categories: {},
    error_categories: {},
    full_summary: fullSummary(rows),
    hard_errors: [],
    mode,
    official_summary: {},
    oracle_version: 13,
    root_cause_map: {},
    scope_summaries: {},
    skip_reasons: {},
    strict_summary: {},
    summary: {},
    timestamp,
  };
}

function row(file: string, status: Status, extra: Partial<Row> = {}): Row {
  const base: Row = {
    category: "built-ins/Array",
    compile_ms: 4,
    exec_ms: 1,
    file,
    oracle_lane: "honest",
    oracle_version: 13,
    reached_test: status !== "compile_timeout",
    scope: "standard",
    scope_official: true,
    status,
    strict: "both",
    timestamp: "30.8.2026, 13:09:50",
  };
  if (status !== "pass") {
    base.error = status === "compile_timeout" ? "timeout after 30s" : "returned 2";
    base.error_category = status === "compile_timeout" ? "timeout" : "assertion_fail";
    base.error_signature = status + ":" + base.error_category;
  }
  return { ...base, ...extra };
}

function jsonl(rows: readonly Row[]) {
  return Buffer.from(rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function endpoint(
  commitSha: string,
  rows: readonly Row[],
  mode: Endpoint["mode"],
  reportValue = report(commitSha, rows, mode),
): Endpoint {
  return {
    commitSha,
    jsonl: jsonl(rows),
    mode,
    report: Buffer.from(JSON.stringify(reportValue) + "\n", "utf8"),
    reportValue,
  };
}

function withRows(value: Endpoint, rows: readonly Row[]) {
  return { ...value, jsonl: jsonl(rows) };
}

function withReport(value: Endpoint, reportValue: Record<string, unknown>) {
  return { ...value, report: Buffer.from(JSON.stringify(reportValue) + "\n", "utf8"), reportValue };
}

function makePolicy(
  baseline: Endpoint,
  candidate: Endpoint,
  keys = KEYS,
  options: {
    pinned?: { baseline?: Record<string, unknown>; candidate?: Record<string, unknown> };
    producerSchema?: { baseline?: string; candidate?: string };
  } = {},
) {
  const keyText = [...keys].sort().join("\n") + "\n";
  const endpointPolicy = (value: Endpoint, kind: "baseline" | "candidate") => ({
    testedCommitSha: value.commitSha,
    baselineStoreCommitSha: (kind === "baseline" ? "c" : "d").repeat(40),
    baselineStoreTreeSha: (kind === "baseline" ? "e" : "f").repeat(40),
    paths: { jsonl: "test262-standalone-current.jsonl", report: "test262-standalone-current.json" },
    jsonl: descriptor(value.jsonl),
    report: descriptor(value.report),
    oracle: { version: 13, lane: "honest", fastRev: null },
    producerSchema: options.producerSchema?.[kind] ?? PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST,
    mode: value.mode,
    fullSummary: options.pinned?.[kind] ?? value.reportValue.full_summary,
  });
  return {
    id: "issue-2097-test-policy-v1",
    expectedKeyCensus: {
      count: keys.length,
      sortedKeysSha256: createHash("sha256").update(keyText, "utf8").digest("hex"),
    },
    endpoints: {
      baseline: endpointPolicy(baseline, "baseline"),
      candidate: endpointPolicy(candidate, "candidate"),
    },
  };
}

function inputs(baseline: Endpoint, candidate: Endpoint, keys = KEYS): Inputs {
  return {
    baseline: { jsonl: baseline.jsonl, report: baseline.report },
    candidate: { jsonl: candidate.jsonl, report: candidate.report },
    expectedKeys: Buffer.from(keys.join("\n") + "\n", "utf8"),
  };
}

function fixture() {
  const baselineRows = [
    row("test/a.js", "pass"),
    row("test/b.js", "fail", { poison_healed: true, retried: true, retry_count: 1, scope_reason: "baseline retry" }),
    row("test/c.js", "compile_error", {
      imports: ["env::z", "env::a", "env::a"],
      host_import_leak_class: "host_import",
    }),
  ];
  const candidateRows = [
    row("test/a.js", "compile_timeout", {
      compile_ms: 30_000,
      exec_ms: 0,
      error: "timeout \ud800 after 30s",
      error_category: "timeout",
      error_signature: "compile_timeout:timeout",
      imports: ["env::b", "env::a", "env::a"],
      host_import_leak_class: "host_import",
    }),
    row("test/b.js", "pass", { retried: true, retry_count: 1, scope_reason: "candidate retry" }),
    row("test/c.js", "fail", {
      error: "non-transition detail",
      error_category: "other",
      error_signature: "fail:other",
    }),
  ];
  const baseline = endpoint(BASE_SHA, baselineRows, {
    target: "standalone",
    include_proposals: 0,
    label: "official test262 (default scope)",
  });
  const candidate = endpoint(CANDIDATE_SHA, candidateRows, {
    target: "standalone",
    include_proposals: 1,
    label: "official test262 + proposals",
  });
  return {
    baseline,
    baselineRows,
    candidate,
    candidateRows,
    policy: makePolicy(baseline, candidate),
    raw: inputs(baseline, candidate),
  };
}

function buildTest(raw: Inputs, policy: ReturnType<typeof makePolicy>) {
  return buildStandaloneHighwaterTransitionManifestForTest(raw, policy);
}

describe("#2097 authenticated raw standalone transition manifest", () => {
  it("uses the exact empty-import and null-leak host-free predicate", () => {
    expect(isStandaloneHostFreePass({ status: "pass", imports: [], host_import_leak_class: null })).toBe(true);
    expect(isStandaloneHostFreePass({ status: "pass", imports: ["env::x"], host_import_leak_class: null })).toBe(false);
    expect(isStandaloneHostFreePass({ status: "pass", imports: [], host_import_leak_class: "host_import" })).toBe(
      false,
    );
    expect(isStandaloneHostFreePass({ status: "pass", host_import_leak_class: null })).toBe(false);
  });

  it("pins every exact production-policy value and recursively freezes it", () => {
    expect(STANDALONE_HIGHWATER_TRANSITION_POLICY).toEqual({
      id: "issue-2097-standalone-highwater-transition-v1",
      expectedKeyCensus: {
        count: 48735,
        sortedKeysSha256: "d5da0c8e80b17c9617275dd9d2feb84288b4ec9fd7d03578a763995648d85c6f",
      },
      endpoints: {
        baseline: {
          testedCommitSha: "fc6fd3b5f3df1fbce731bf74c391aca41fcd08c2",
          baselineStoreCommitSha: "9657d806b1d6ed0f54256c74b390f232677bd8e4",
          baselineStoreTreeSha: "135a3c26544ea44409d93e8f3b9e7d6bfcc3326b",
          paths: { jsonl: "test262-standalone-current.jsonl", report: "test262-standalone-current.json" },
          jsonl: {
            bytes: 23209263,
            sha256: "d3341cf6b6dbcc237f18f1461dc97dcddf1f2cbbfb944496d7ae73e8489adb87",
            gitBlob: "f762926801f85f7bb630b53e9d727647ecc45d94",
          },
          report: {
            bytes: 108028,
            sha256: "e5626e5a57a37d9e29a051be0d5175e7771dd1cf5bf237065e43fbb586d82147",
            gitBlob: "3b34346a96caef48484f939a7ca6d0c030802ccb",
          },
          oracle: { version: 13, lane: "honest", fastRev: null },
          producerSchema: "test262-record-result-v13-honest",
          mode: { target: "standalone", include_proposals: 0, label: "official test262 (default scope)" },
          fullSummary: {
            total: 48735,
            pass: 33876,
            fail: 9506,
            compile_error: 5227,
            compile_timeout: 12,
            skip: 114,
            compilable: 43382,
            host_free_pass: 33876,
            stale: 0,
          },
        },
        candidate: {
          testedCommitSha: "01fb67624e2f645b7e92dd9f8e47478e3face9ba",
          baselineStoreCommitSha: "f0d6b57da9362471decffeb6f3d98d650d477bd5",
          baselineStoreTreeSha: "aa8f1f95b9d3da3c5ae60d3a71abe53d23733e50",
          paths: { jsonl: "test262-standalone-current.jsonl", report: "test262-standalone-current.json" },
          jsonl: {
            bytes: 23482700,
            sha256: "5d6cb6e5a39fbb6e20c9ac655a1cc6987d6555c222ad42aab9dbb70b0ec23ff3",
            gitBlob: "3b99ba94b2a1a8625f869a84464bd497eeb732c0",
          },
          report: {
            bytes: 110636,
            sha256: "8738617eefa12fe0bc54ddfb7773d21635b9bb6b68850a1b09ed4e3cc5584b20",
            gitBlob: "7a033b31cb16947a1d1bfcbba2ddabe1a2734b62",
          },
          oracle: { version: 13, lane: "honest", fastRev: null },
          producerSchema: "test262-record-result-v13-honest",
          mode: { target: "standalone", include_proposals: 1, label: "official test262 + proposals" },
          fullSummary: {
            total: 48735,
            pass: 32581,
            fail: 10122,
            compile_error: 5755,
            compile_timeout: 163,
            skip: 114,
            compilable: 42703,
            host_free_pass: 32581,
            stale: 0,
          },
        },
      },
    });

    const assertRecursivelyFrozen = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) assertRecursivelyFrozen(child);
    };
    assertRecursivelyFrozen(STANDALONE_HIGHWATER_TRANSITION_POLICY);
  });

  it("uses a fixed production policy and a clearly test-only generic seam", () => {
    const { baseline, candidate, policy, raw } = fixture();
    expect(() => buildStandaloneHighwaterTransitionManifest(raw)).toThrow(/raw-jsonl-evidence-mismatch/);
    const manifest = buildTest(raw, policy);
    expect(manifest).toMatchObject({
      policy_id: "issue-2097-test-policy-v1",
      schema: "standalone-highwater-transition-manifest-v3",
      census: {
        expected_key_count: 3,
        expected_keys_sha256: "b777649a9cc531fb2a5317cb966d18829d52e577d41518639a54a5d4b69ac464",
      },
    });
    expect(manifest.endpoints).toEqual({
      baseline: {
        evidence: {
          baseline_store_commit_sha: "c".repeat(40),
          baseline_store_tree_sha: "e".repeat(40),
          commit_sha: BASE_SHA,
          oracle: { fast_rev: null, lane: "honest", version: 13 },
          paths: { jsonl: "test262-standalone-current.jsonl", report: "test262-standalone-current.json" },
          pinned_full_summary: {
            compilable: 2,
            compile_error: 1,
            compile_timeout: 0,
            fail: 1,
            host_free_pass: 1,
            pass: 1,
            skip: 0,
            stale: 0,
            total: 3,
          },
          producer_schema: PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST,
          raw_jsonl: {
            bytes: 1111,
            git_blob: "c765b83a4e3eec5f35ac3fef395be5c2bed51aa6",
            sha256: "7fa44a8342d56d44b58400a564e0ebc6026dc417f368178d98173f2499e42bb8",
          },
          raw_report: {
            bytes: 563,
            git_blob: "28c8ec7664799d760fed6c56b4d2ac6462945f21",
            sha256: "9eaa9c0afbdba1f80edad3a6f372203b8a763c8570156087c6b59357a4fe9a18",
          },
          row_field_count: 21,
          row_fields_sha256: "1247f0f0e7e247d395bdbc3e2d9bfd9bca032eee3cac8534a7c41de63856e607",
          semantic_row_count: 3,
          semantic_rows_sha256: "355ac27f327aef3948705d22f0c8961fc98183d7e31fb5a29f693a1dca685a65",
        },
        metadata: baseline.reportValue,
      },
      candidate: {
        evidence: {
          baseline_store_commit_sha: "d".repeat(40),
          baseline_store_tree_sha: "f".repeat(40),
          commit_sha: CANDIDATE_SHA,
          oracle: { fast_rev: null, lane: "honest", version: 13 },
          paths: { jsonl: "test262-standalone-current.jsonl", report: "test262-standalone-current.json" },
          pinned_full_summary: {
            compilable: 2,
            compile_error: 0,
            compile_timeout: 1,
            fail: 1,
            host_free_pass: 1,
            pass: 1,
            skip: 0,
            stale: 0,
            total: 3,
          },
          producer_schema: PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST,
          raw_jsonl: {
            bytes: 1093,
            git_blob: "17d51a91ed6686cccd7771598822f90847e80f48",
            sha256: "29b2ae42e508396862cb93182e09a5cd309b8835d7bcae56616ab5ba629e9841",
          },
          raw_report: {
            bytes: 559,
            git_blob: "67d133d281b2ab81bf33f702f0267b9416b6a96f",
            sha256: "732a19dac746312b0f3f6bb2838f650d3db235643451fda72c121acd78a57cbf",
          },
          row_field_count: 20,
          row_fields_sha256: "cba9ae15f664144b4875938b3d2a85c4dff67d37e27246bafb474648649936bb",
          semantic_row_count: 3,
          semantic_rows_sha256: "39e73fa298afc3a2cda3da62d7d96ca2ddc21f82d8f6fbd4a5814566d4350237",
        },
        metadata: candidate.reportValue,
      },
    });
    expect(manifest.summary).toEqual({
      baseline_host_free_pass: 1,
      candidate_host_free_pass: 1,
      net_host_free_pass: 0,
      raw_host_free_improvements: 1,
      raw_host_free_regressions: 1,
    });
    expect(manifest.transitions).toEqual([
      {
        baseline: {
          category: "built-ins/Array",
          error: null,
          error_category: null,
          error_signature: null,
          host_free_pass: true,
          host_import_leak_class: null,
          imports: [],
          imports_evidence: "authenticated_producer_omission",
          oracle_fast_rev: null,
          oracle_lane: "honest",
          oracle_version: 13,
          poison_healed: null,
          reached_test: true,
          retried: null,
          retry_count: null,
          scope: "standard",
          scope_official: true,
          scope_reason: null,
          status: "pass",
          strict: "both",
          timestamp: "30.8.2026, 13:09:50",
          timing: { compile_ms: 4, exec_ms: 1 },
        },
        candidate: {
          category: "built-ins/Array",
          error: "timeout \ud800 after 30s",
          error_category: "timeout",
          error_signature: "compile_timeout:timeout",
          host_free_pass: false,
          host_import_leak_class: "host_import",
          imports: ["env::a", "env::b"],
          imports_evidence: "explicit_nonempty",
          oracle_fast_rev: null,
          oracle_lane: "honest",
          oracle_version: 13,
          poison_healed: null,
          reached_test: false,
          retried: null,
          retry_count: null,
          scope: "standard",
          scope_official: true,
          scope_reason: null,
          status: "compile_timeout",
          strict: "both",
          timestamp: "30.8.2026, 13:09:50",
          timing: { compile_ms: 30_000, exec_ms: 0 },
        },
        file: "test/a.js",
        kind: "raw_host_free_regression",
      },
      {
        baseline: {
          category: "built-ins/Array",
          error: "returned 2",
          error_category: "assertion_fail",
          error_signature: "fail:assertion_fail",
          host_free_pass: false,
          host_import_leak_class: null,
          imports: [],
          imports_evidence: "authenticated_producer_omission",
          oracle_fast_rev: null,
          oracle_lane: "honest",
          oracle_version: 13,
          poison_healed: true,
          reached_test: true,
          retried: true,
          retry_count: 1,
          scope: "standard",
          scope_official: true,
          scope_reason: "baseline retry",
          status: "fail",
          strict: "both",
          timestamp: "30.8.2026, 13:09:50",
          timing: { compile_ms: 4, exec_ms: 1 },
        },
        candidate: {
          category: "built-ins/Array",
          error: null,
          error_category: null,
          error_signature: null,
          host_free_pass: true,
          host_import_leak_class: null,
          imports: [],
          imports_evidence: "authenticated_producer_omission",
          oracle_fast_rev: null,
          oracle_lane: "honest",
          oracle_version: 13,
          poison_healed: null,
          reached_test: true,
          retried: true,
          retry_count: 1,
          scope: "standard",
          scope_official: true,
          scope_reason: "candidate retry",
          status: "pass",
          strict: "both",
          timestamp: "30.8.2026, 13:09:50",
          timing: { compile_ms: 4, exec_ms: 1 },
        },
        file: "test/b.js",
        kind: "raw_host_free_improvement",
      },
    ]);
    expect(manifest.transition_rows_sha256).toBe("12eea49dcdd52fa3a6da88a2188583482d722d6ad5521c8e2f7e7b210be39d88");
  });

  it("rejects raw byte changes before parse while retaining the original descriptor", () => {
    const { policy, raw } = fixture();
    const mutated: Inputs = {
      ...raw,
      baseline: { ...raw.baseline, jsonl: Buffer.concat([raw.baseline.jsonl, Buffer.from(" ")]) },
    };
    expect(() => buildTest(mutated, policy)).toThrow(
      /raw-jsonl-evidence-mismatch: baseline jsonl does not match the immutable #2097 raw descriptor/,
    );
    const reportMutated: Inputs = {
      ...raw,
      candidate: { ...raw.candidate, report: Buffer.concat([raw.candidate.report, Buffer.from(" ")]) },
    };
    expect(() => buildTest(reportMutated, policy)).toThrow(
      /raw-report-evidence-mismatch: candidate report does not match the immutable #2097 raw descriptor/,
    );
  });

  it("authenticates each expected raw descriptor member independently", () => {
    const { policy, raw } = fixture();
    const corruptions: Array<["bytes" | "gitBlob" | "sha256", number | string]> = [
      ["bytes", policy.endpoints.baseline.jsonl.bytes + 1],
      ["sha256", "0".repeat(64)],
      ["gitBlob", "0".repeat(40)],
    ];

    for (const [field, replacement] of corruptions) {
      const corruptPolicy = clone(policy);
      (corruptPolicy.endpoints.baseline.jsonl as Record<string, number | string>)[field] = replacement;
      expect(() => buildTest(raw, corruptPolicy)).toThrow(
        /raw-jsonl-evidence-mismatch: baseline jsonl does not match the immutable #2097 raw descriptor/,
      );
    }
  });

  it("enforces exact report keys, per-endpoint mode, and all full_summary constraints", () => {
    const { baseline, candidate, policy, raw } = fixture();
    const extra = clone(candidate.reportValue);
    extra.unpinned = true;
    const extraCandidate = withReport(candidate, extra);
    expect(() => buildTest(inputs(baseline, extraCandidate), makePolicy(baseline, extraCandidate))).toThrow(
      /report-key-universe-mismatch/,
    );

    const historicLane = clone(candidate.reportValue);
    historicLane.oracle_lane = "honest";
    const historicLaneCandidate = withReport(candidate, historicLane);
    expect(() =>
      buildTest(inputs(baseline, historicLaneCandidate), makePolicy(baseline, historicLaneCandidate)),
    ).toThrow(/report-key-universe-mismatch/);

    const contradictoryLane = clone(candidate.reportValue);
    contradictoryLane.oracle_lane = "fast-nativeharness";
    const contradictoryLaneCandidate = withReport(candidate, contradictoryLane);
    expect(() =>
      buildTest(inputs(baseline, contradictoryLaneCandidate), makePolicy(baseline, contradictoryLaneCandidate)),
    ).toThrow(/oracle-provenance-mismatch/);

    const contradictoryFastRevision = clone(candidate.reportValue);
    contradictoryFastRevision.oracle_fast_rev = 1;
    const contradictoryFastCandidate = withReport(candidate, contradictoryFastRevision);
    expect(() =>
      buildTest(inputs(baseline, contradictoryFastCandidate), makePolicy(baseline, contradictoryFastCandidate)),
    ).toThrow(/oracle-provenance-mismatch/);

    const wrongMode = clone(candidate.reportValue);
    (wrongMode.mode as { include_proposals: number }).include_proposals = 0;
    const wrongModeCandidate = withReport(candidate, wrongMode);
    expect(() => buildTest(inputs(baseline, wrongModeCandidate), makePolicy(baseline, wrongModeCandidate))).toThrow(
      /report-mode-mismatch/,
    );

    const extraMode = clone(candidate.reportValue);
    (extraMode.mode as Record<string, unknown>).extra = true;
    const extraModeCandidate = withReport(candidate, extraMode);
    expect(() => buildTest(inputs(baseline, extraModeCandidate), makePolicy(baseline, extraModeCandidate))).toThrow(
      /malformed-metadata/,
    );

    const missingMode = clone(candidate.reportValue);
    (missingMode.mode as Record<string, unknown>).label = undefined;
    const missingModeCandidate = withReport(candidate, missingMode);
    expect(() => buildTest(inputs(baseline, missingModeCandidate), makePolicy(baseline, missingModeCandidate))).toThrow(
      /malformed-metadata/,
    );

    const extraSummary = clone(candidate.reportValue);
    (extraSummary.full_summary as Record<string, unknown>).extra = 0;
    const extraSummaryCandidate = withReport(candidate, extraSummary);
    expect(() =>
      buildTest(inputs(baseline, extraSummaryCandidate), makePolicy(baseline, extraSummaryCandidate)),
    ).toThrow(/malformed-report-summary/);

    const inconsistentTotal = clone(candidate.reportValue);
    (inconsistentTotal.full_summary as Record<string, number>).total = 4;
    const inconsistentTotalCandidate = withReport(candidate, inconsistentTotal);
    expect(() =>
      buildTest(
        inputs(baseline, inconsistentTotalCandidate),
        makePolicy(baseline, inconsistentTotalCandidate, KEYS, {
          pinned: { candidate: candidate.reportValue.full_summary as Record<string, unknown> },
        }),
      ),
    ).toThrow(/malformed-report-summary: candidate report full_summary total does not equal all status buckets/);

    const wrongHostField = clone(candidate.reportValue);
    const changedSummary = wrongHostField.full_summary as Record<string, unknown>;
    changedSummary.host_free = changedSummary.host_free_pass;
    changedSummary.host_free_pass = undefined;
    const wrongHostCandidate = withReport(candidate, wrongHostField);
    expect(() => buildTest(inputs(baseline, wrongHostCandidate), makePolicy(baseline, wrongHostCandidate))).toThrow(
      /malformed-report-summary/,
    );

    expect(() => buildTest(raw, policy)).not.toThrow();
  });

  it("rejects internally coherent report vectors that disagree with parsed JSONL", () => {
    const { baseline, candidate } = fixture();
    const vectors: Array<{
      expected: RegExp;
      name: string;
      update: (summary: Record<string, number>) => void;
    }> = [
      {
        name: "host-free count",
        update(summary) {
          summary.host_free_pass = 0;
        },
        expected: /report-jsonl-summary-mismatch: candidate report host_free_pass does not match parsed JSONL/,
      },
      {
        name: "status counts",
        update(summary) {
          summary.pass = 0;
          summary.fail = 2;
          summary.host_free_pass = 0;
          summary.compilable = 2;
        },
        expected: /report-jsonl-summary-mismatch: candidate report fail does not match parsed JSONL/,
      },
      {
        name: "compilable count",
        update(summary) {
          summary.pass = 0;
          summary.fail = 1;
          summary.compile_error = 1;
          summary.host_free_pass = 0;
          summary.compilable = 1;
        },
        expected: /report-jsonl-summary-mismatch: candidate report compilable does not match parsed JSONL/,
      },
    ];

    for (const vector of vectors) {
      const reportValue = clone(candidate.reportValue);
      vector.update(reportValue.full_summary as Record<string, number>);
      const reportCandidate = withReport(candidate, reportValue);
      expect(() => buildTest(inputs(baseline, reportCandidate), makePolicy(baseline, reportCandidate))).toThrow(
        vector.expected,
      );
    }
  });

  it("reconciles full_summary against parsed rows, including status, compilable, host-free, and stale", () => {
    const { baseline, candidate, candidateRows } = fixture();
    const changedStatus = clone(candidateRows);
    changedStatus[2].status = "compile_error";
    const statusCandidate = withRows(candidate, changedStatus);
    expect(() => buildTest(inputs(baseline, statusCandidate), makePolicy(baseline, statusCandidate))).toThrow(
      /report-jsonl-summary-mismatch: candidate report compilable does not match parsed JSONL/,
    );

    const changedHostFree = clone(candidateRows);
    changedHostFree[1].imports = ["env::leak"];
    changedHostFree[1].host_import_leak_class = "host_import";
    const hostCandidate = withRows(candidate, changedHostFree);
    expect(() => buildTest(inputs(baseline, hostCandidate), makePolicy(baseline, hostCandidate))).toThrow(
      /non-host-free-pass/,
    );

    const stale = clone(candidate.reportValue);
    (stale.full_summary as Record<string, number>).stale = 1;
    const staleCandidate = withReport(candidate, stale);
    expect(() =>
      buildTest(
        inputs(baseline, staleCandidate),
        makePolicy(baseline, staleCandidate, KEYS, {
          pinned: { candidate: candidate.reportValue.full_summary as Record<string, unknown> },
        }),
      ),
    ).toThrow(/malformed-report-summary/);
  });

  it("fails closed on provenance, field-universe, and key-census drift", () => {
    const { baseline, baselineRows, candidate, candidateRows, policy, raw } = fixture();
    const wrongOracle = clone(candidateRows);
    wrongOracle[1].oracle_lane = "fast-nativeharness";
    const oracleCandidate = withRows(candidate, wrongOracle);
    expect(() => buildTest(inputs(baseline, oracleCandidate), makePolicy(baseline, oracleCandidate))).toThrow(
      /oracle-provenance-mismatch/,
    );

    const wrongOracleVersion = clone(candidateRows);
    wrongOracleVersion[1].oracle_version = 12;
    const oracleVersionCandidate = withRows(candidate, wrongOracleVersion);
    expect(() =>
      buildTest(inputs(baseline, oracleVersionCandidate), makePolicy(baseline, oracleVersionCandidate)),
    ).toThrow(/oracle-provenance-mismatch: candidate JSONL line 2 contradicts the pinned v13 honest provenance/);

    const nullRetryCount = clone(candidateRows);
    nullRetryCount[1].retry_count = null;
    const nullRetryCandidate = withRows(candidate, nullRetryCount);
    expect(() => buildTest(inputs(baseline, nullRetryCandidate), makePolicy(baseline, nullRetryCandidate))).toThrow(
      /malformed-row: candidate JSONL line 2 has invalid retry_count/,
    );

    const missingPoisonField = clone(baselineRows);
    missingPoisonField[1].poison_healed = undefined;
    const missingPoisonBaseline = withRows(baseline, missingPoisonField);
    expect(() =>
      buildTest(inputs(missingPoisonBaseline, candidate), makePolicy(missingPoisonBaseline, candidate)),
    ).toThrow(/field-universe-mismatch: baseline JSONL does not have the authenticated v13 field universe/);

    const unknownProducerPolicy = makePolicy(baseline, candidate, KEYS, {
      producerSchema: { candidate: "test-only-unknown-producer" },
    });
    expect(() => buildTest(raw, unknownProducerPolicy)).toThrow(
      /unauthenticated-import-omission: candidate JSONL line 2 omitted imports under unknown producer/,
    );

    const unknown = clone(candidateRows) as Array<Row & { unknown_field?: string }>;
    unknown[2].unknown_field = "must not be ignored";
    const unknownCandidate = withRows(candidate, unknown);
    expect(() => buildTest(inputs(baseline, unknownCandidate), makePolicy(baseline, unknownCandidate))).toThrow(
      /unrecognized-row-field/,
    );

    const duplicateBaseline = withRows(baseline, [...baselineRows, baselineRows[0]]);
    expect(() => buildTest(inputs(duplicateBaseline, candidate), makePolicy(duplicateBaseline, candidate))).toThrow(
      /duplicate-key/,
    );

    const missingImportPair = clone(candidateRows);
    missingImportPair[0].imports = undefined;
    const partialCandidate = withRows(candidate, missingImportPair);
    expect(() => buildTest(inputs(baseline, partialCandidate), makePolicy(baseline, partialCandidate))).toThrow(
      /inconsistent-import-evidence/,
    );

    const wrongKeys: Inputs = { ...raw, expectedKeys: Buffer.from("test/a.js\ntest/b.js\n", "utf8") };
    expect(() => buildTest(wrongKeys, policy)).toThrow(/expected-key-census-mismatch/);

    const droppedCandidate = withRows(candidate, candidateRows.slice(0, 2));
    expect(() => buildTest(inputs(baseline, droppedCandidate), makePolicy(baseline, droppedCandidate))).toThrow(
      /dropped-key/,
    );

    const foreignCandidate = withRows(candidate, [...candidateRows, row("test/foreign.js", "compile_error")]);
    expect(() => buildTest(inputs(baseline, foreignCandidate), makePolicy(baseline, foreignCandidate))).toThrow(
      /foreign-key/,
    );

    const wrongReportSha = clone(baseline.reportValue);
    wrongReportSha.baseline_sha = "9".repeat(40);
    const wrongShaBaseline = withReport(baseline, wrongReportSha);
    expect(() => buildTest(inputs(wrongShaBaseline, candidate), makePolicy(wrongShaBaseline, candidate))).toThrow(
      /wrong-endpoint-sha/,
    );

    const negativeTiming = clone(candidateRows);
    negativeTiming[0].compile_ms = -1;
    const negativeCandidate = withRows(candidate, negativeTiming);
    expect(() => buildTest(inputs(baseline, negativeCandidate), makePolicy(baseline, negativeCandidate))).toThrow(
      /malformed-timing/,
    );

    const missingTimeoutTiming = clone(candidateRows);
    missingTimeoutTiming[0].compile_ms = undefined;
    const missingTimingCandidate = withRows(candidate, missingTimeoutTiming);
    expect(() =>
      buildTest(inputs(baseline, missingTimingCandidate), makePolicy(baseline, missingTimingCandidate)),
    ).toThrow(/malformed-timing/);
  });

  it("binds an authenticated raw status rewrite instead of accepting a semantic alias", () => {
    const { baseline, candidate, candidateRows, policy, raw } = fixture();
    const original = buildTest(raw, policy);
    const rewrittenRows = clone(candidateRows);
    rewrittenRows[2].status = "compile_error";
    const rewrittenCandidate = endpoint(CANDIDATE_SHA, rewrittenRows, candidate.mode);
    const rewrittenPolicy = makePolicy(baseline, rewrittenCandidate);
    const rewrittenRaw = inputs(baseline, rewrittenCandidate);
    const rewritten = buildTest(rewrittenRaw, rewrittenPolicy);
    expect(rewritten.endpoints.candidate.evidence.semantic_rows_sha256).not.toBe(
      original.endpoints.candidate.evidence.semantic_rows_sha256,
    );
    const descriptorOnlyPolicy = clone(policy);
    descriptorOnlyPolicy.endpoints.candidate.jsonl = descriptor(rewrittenCandidate.jsonl);
    expect(() =>
      verifyStandaloneHighwaterTransitionManifestForTest(original, rewrittenRaw, descriptorOnlyPolicy),
    ).toThrow(/raw-jsonl-evidence-mismatch: candidate manifest JSONL descriptor contradicts policy/);
  });

  it("binds non-transition row timestamp, scope, and retry metadata through authenticated rebuild", () => {
    const { baseline, candidate, candidateRows, policy, raw } = fixture();
    const original = buildTest(raw, policy);
    const mutations: Array<{ name: string; update: (entry: Row) => void }> = [
      {
        name: "timestamp",
        update(entry) {
          entry.timestamp = "30.8.2026, 13:09:51";
        },
      },
      {
        name: "scope",
        update(entry) {
          entry.scope = "proposal";
        },
      },
      {
        name: "retry",
        update(entry) {
          entry.retried = true;
          entry.retry_count = 2;
        },
      },
    ];

    for (const mutation of mutations) {
      const rewrittenRows = clone(candidateRows);
      mutation.update(rewrittenRows[2]);
      const rewrittenCandidate = withRows(candidate, rewrittenRows);
      const rewrittenPolicy = makePolicy(baseline, rewrittenCandidate);
      const rewrittenRaw = inputs(baseline, rewrittenCandidate);
      const rewritten = buildTest(rewrittenRaw, rewrittenPolicy);
      expect(rewritten.transitions).toEqual(original.transitions);
      expect(rewritten.endpoints.candidate.evidence.semantic_rows_sha256).not.toBe(
        original.endpoints.candidate.evidence.semantic_rows_sha256,
      );

      const descriptorBridged = clone(original);
      descriptorBridged.endpoints.candidate.evidence.raw_jsonl = rewritten.endpoints.candidate.evidence.raw_jsonl;
      expect(() =>
        verifyStandaloneHighwaterTransitionManifestForTest(descriptorBridged, rewrittenRaw, rewrittenPolicy),
      ).toThrow(
        /manifest-authenticated-evidence-mismatch: manifest does not exactly reproduce authenticated raw endpoint evidence/,
      );
    }
  });

  it("keeps structural semantic digests order-stable while raw descriptors remain order-sensitive", () => {
    const { baseline, baselineRows, candidate, candidateRows, policy, raw } = fixture();
    const original = buildTest(raw, policy);
    const reorderedBaseline = withRows(baseline, [...baselineRows].reverse());
    const reorderedCandidate = withRows(candidate, [...candidateRows].reverse());
    const reorderedPolicy = makePolicy(reorderedBaseline, reorderedCandidate);
    const reordered = buildTest(inputs(reorderedBaseline, reorderedCandidate, [...KEYS].reverse()), reorderedPolicy);
    expect(reordered.transition_rows_sha256).toBe(original.transition_rows_sha256);
    expect(reordered.endpoints.baseline.evidence.semantic_rows_sha256).toBe(
      original.endpoints.baseline.evidence.semantic_rows_sha256,
    );
    expect(reordered.endpoints.candidate.evidence.semantic_rows_sha256).toBe(
      original.endpoints.candidate.evidence.semantic_rows_sha256,
    );
    expect(reordered.endpoints.baseline.evidence.raw_jsonl.sha256).not.toBe(
      original.endpoints.baseline.evidence.raw_jsonl.sha256,
    );
    expect(
      renderStandaloneHighwaterTransitionManifestForTest(
        reordered,
        inputs(reorderedBaseline, reorderedCandidate, [...KEYS].reverse()),
        reorderedPolicy,
      ),
    ).not.toBe(renderStandaloneHighwaterTransitionManifestForTest(original, raw, policy));
  });

  it("requires raw inputs for verification and rejects semantic, metadata, and absolute-summary rewrites", () => {
    const { policy, raw } = fixture();
    const manifest = buildTest(raw, policy);
    expect(verifyStandaloneHighwaterTransitionManifestForTest(manifest, raw, policy)).toEqual(manifest);
    expect(() => verifyStandaloneHighwaterTransitionManifest(manifest)).toThrow(
      /missing-build-inputs: acceptance verification requires authenticated raw build inputs/,
    );
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(manifest, undefined, policy)).toThrow(
      /missing-build-inputs: acceptance verification requires authenticated raw build inputs/,
    );

    const semantic = clone(manifest);
    semantic.endpoints.candidate.evidence.semantic_rows_sha256 = "0".repeat(64);
    const timestamp = clone(manifest);
    timestamp.endpoints.candidate.metadata.timestamp = "2026-08-30T12:00:01Z";
    const categories = clone(manifest);
    categories.endpoints.candidate.metadata.categories = { rewritten: { source: "non-transition metadata" } };
    const absolute = clone(manifest);
    absolute.summary.baseline_host_free_pass++;
    absolute.summary.candidate_host_free_pass++;

    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(semantic, raw, policy)).toThrow(
      /manifest-authenticated-evidence-mismatch: manifest does not exactly reproduce authenticated raw endpoint evidence/,
    );
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(timestamp, raw, policy)).toThrow(
      /manifest-authenticated-evidence-mismatch: manifest does not exactly reproduce authenticated raw endpoint evidence/,
    );
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(categories, raw, policy)).toThrow(
      /manifest-authenticated-evidence-mismatch: manifest does not exactly reproduce authenticated raw endpoint evidence/,
    );
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(absolute, raw, policy)).toThrow(
      /pinned-summary-mismatch: manifest absolute or transition summary contradicts policy/,
    );
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(semantic, undefined, policy)).toThrow(
      /missing-build-inputs: acceptance verification requires authenticated raw build inputs/,
    );

    const transitionRewrite = clone(manifest);
    transitionRewrite.transitions[0].baseline.timestamp = "changed";
    transitionRewrite.transition_rows_sha256 = transitionRowsSha256(transitionRewrite.transitions);
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(transitionRewrite, raw, policy)).toThrow(
      /manifest-authenticated-evidence-mismatch/,
    );
  });

  it("preserves JSON-round-tripped __proto__ members through authenticated verification", () => {
    const { policy, raw } = fixture();
    const manifest = buildTest(raw, policy);

    const poisonedPaths = clone(manifest);
    poisonedPaths.endpoints.baseline.evidence.paths = jsonRoundTrippedNullProtoMember(
      poisonedPaths.endpoints.baseline.evidence.paths,
    );
    expect(Object.prototype.hasOwnProperty.call(poisonedPaths.endpoints.baseline.evidence.paths, "__proto__")).toBe(
      true,
    );
    expect((poisonedPaths.endpoints.baseline.evidence.paths as Record<string, unknown>).__proto__).toBeNull();
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(poisonedPaths, raw, policy)).toThrow(
      /policy-evidence-mismatch: baseline manifest paths contradict policy/,
    );

    const poisonedCategories = clone(manifest);
    poisonedCategories.endpoints.candidate.metadata.categories = jsonRoundTrippedNullProtoMember(
      poisonedCategories.endpoints.candidate.metadata.categories,
    );
    expect(
      Object.prototype.hasOwnProperty.call(poisonedCategories.endpoints.candidate.metadata.categories, "__proto__"),
    ).toBe(true);
    expect(
      (poisonedCategories.endpoints.candidate.metadata.categories as Record<string, unknown>).__proto__,
    ).toBeNull();
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(poisonedCategories, raw, policy)).toThrow(
      /manifest-authenticated-evidence-mismatch: manifest does not exactly reproduce authenticated raw endpoint evidence/,
    );

    const poisonedTransition = clone(manifest);
    poisonedTransition.transitions[0].baseline = jsonRoundTrippedNullProtoMember(
      poisonedTransition.transitions[0].baseline,
    );
    expect(Object.prototype.hasOwnProperty.call(poisonedTransition.transitions[0].baseline, "__proto__")).toBe(true);
    expect((poisonedTransition.transitions[0].baseline as Record<string, unknown>).__proto__).toBeNull();
    expect(() => verifyStandaloneHighwaterTransitionManifestForTest(poisonedTransition, raw, policy)).toThrow(
      /manifest-authenticated-evidence-mismatch: manifest does not exactly reproduce authenticated raw endpoint evidence/,
    );
  });

  it("uses raw-only CLI arguments, returns one JSON document on success, and frames errors on stderr", () => {
    const { policy, raw } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "issue-2097-transition-"));
    const highwaterBefore = readFileSync(HIGHWATER, "utf8");
    const baselineJsonl = join(directory, "baseline.jsonl");
    const candidateJsonl = join(directory, "candidate.jsonl");
    const baselineReport = join(directory, "baseline-report.json");
    const candidateReport = join(directory, "candidate-report.json");
    const keys = join(directory, "keys.txt");
    const argv = [
      "--baseline-jsonl",
      baselineJsonl,
      "--candidate-jsonl",
      candidateJsonl,
      "--baseline-report",
      baselineReport,
      "--candidate-report",
      candidateReport,
      "--expected-keys",
      keys,
    ];
    try {
      writeFileSync(baselineJsonl, raw.baseline.jsonl);
      writeFileSync(candidateJsonl, raw.candidate.jsonl);
      writeFileSync(baselineReport, raw.baseline.report);
      writeFileSync(candidateReport, raw.candidate.report);
      writeFileSync(keys, raw.expectedKeys);
      const output = runTransitionManifestCliForTest(argv, policy);
      expect(output.endsWith("\n")).toBe(true);
      expect(JSON.parse(output).policy_id).toBe("issue-2097-test-policy-v1");

      const fixedPolicyProof = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
      expect(fixedPolicyProof.status).toBe(2);
      expect(fixedPolicyProof.stdout).toBe("");
      expect(fixedPolicyProof.stderr).toMatch(
        /^standalone-highwater-transition-manifest: raw-jsonl-evidence-mismatch: baseline jsonl does not match the immutable #2097 raw descriptor/,
      );

      writeFileSync(baselineJsonl, Buffer.concat([raw.baseline.jsonl, Buffer.from(" ")]));
      expect(() => runTransitionManifestCliForTest(argv, policy)).toThrow(
        /raw-jsonl-evidence-mismatch: baseline jsonl does not match the immutable #2097 raw descriptor/,
      );

      const rejectedArgument = spawnSync(process.execPath, [CLI, ...argv, "--baseline-expected", "forbidden.json"], {
        encoding: "utf8",
      });
      expect(rejectedArgument.status).toBe(2);
      expect(rejectedArgument.stdout).toBe("");
      expect(rejectedArgument.stderr).toMatch(/^standalone-highwater-transition-manifest: invalid-arguments:/);
      expect(readFileSync(HIGHWATER, "utf8")).toBe(highwaterBefore);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
