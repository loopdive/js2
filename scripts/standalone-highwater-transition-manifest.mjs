#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2097 -- read-only, fail-closed standalone high-water transition evidence.
// Production acceptance uses the immutable policy below. It receives raw
// endpoint bytes and a raw expected-key census only; no caller-supplied
// descriptor can replace the policy's commits, blobs, vector, or mode.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST262_VERDICT_STATUSES } from "./validate-test262-completeness.mjs";

export const TRANSITION_MANIFEST_SCHEMA = "standalone-highwater-transition-manifest-v3";
export const PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST = "test262-record-result-v13-honest";

const OWN = Object.prototype.hasOwnProperty;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const STATUS_BUCKETS = Object.freeze(["pass", "fail", "compile_error", "compile_timeout", "skip"]);
const STATUS_BUCKET_SET = new Set(STATUS_BUCKETS);
const STRICT_VALUES = new Set(["only", "no", "both"]);
const SCOPE_VALUES = new Set(["standard", "annex_b", "proposal"]);
const BASELINE_ROW_FIELDS = Object.freeze([
  "category",
  "compile_ms",
  "error",
  "error_category",
  "error_signature",
  "exec_ms",
  "file",
  "host_import_leak_class",
  "imports",
  "oracle_lane",
  "oracle_version",
  "poison_healed",
  "reached_test",
  "retried",
  "retry_count",
  "scope",
  "scope_official",
  "scope_reason",
  "status",
  "strict",
  "timestamp",
]);
const CANDIDATE_ROW_FIELDS = Object.freeze(BASELINE_ROW_FIELDS.filter((field) => field !== "poison_healed"));
const ROW_FIELD_SETS = {
  baseline: new Set(BASELINE_ROW_FIELDS),
  candidate: new Set(CANDIDATE_ROW_FIELDS),
};
const REPORT_TOP_LEVEL_FIELDS = Object.freeze([
  "baseline_generated_at",
  "baseline_sha",
  "categories",
  "error_categories",
  "full_summary",
  "hard_errors",
  "mode",
  "official_summary",
  "oracle_version",
  "root_cause_map",
  "scope_summaries",
  "skip_reasons",
  "strict_summary",
  "summary",
  "timestamp",
]);
const FULL_SUMMARY_FIELDS = Object.freeze([
  "compilable",
  "compile_error",
  "compile_timeout",
  "fail",
  "host_free_pass",
  "pass",
  "skip",
  "stale",
  "total",
]);
const MODE_FIELDS = Object.freeze(["include_proposals", "label", "target"]);
const MANIFEST_SUMMARY_FIELDS = Object.freeze([
  "baseline_host_free_pass",
  "candidate_host_free_pass",
  "net_host_free_pass",
  "raw_host_free_improvements",
  "raw_host_free_regressions",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// `baseline_sha` is the tested compiler commit. `baselineStore*` identifies
// the immutable js2wasm-baselines object that supplied the raw endpoint.
export const STANDALONE_HIGHWATER_TRANSITION_POLICY = deepFreeze({
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
      producerSchema: PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST,
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
      producerSchema: PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST,
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

export class TransitionManifestError extends Error {
  constructor(code, message, details = undefined) {
    super(code + ": " + message);
    this.name = "TransitionManifestError";
    this.code = code;
    this.details = details;
  }
}

function refuse(code, message, details = undefined) {
  throw new TransitionManifestError(code, message, details);
}

function hasOwn(value, key) {
  return OWN.call(value, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function assertExactKeys(value, expectedKeys, code, label) {
  if (!isPlainObject(value)) refuse(code, label + " must be a plain object");
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (!sameList(actual, expected)) refuse(code, label + " has unexpected fields: " + actual.join(", "));
}

function canonicalJson(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("malformed-metadata", label + " has a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalJson(item, label + "[" + index + "]"));
  if (!isPlainObject(value)) refuse("malformed-metadata", label + " must contain JSON values only");
  const out = {};
  // Assignment to an ordinary object's `__proto__` key changes its prototype
  // instead of preserving the JSON member. Define each own member explicitly
  // so canonicalization remains a lossless JSON round trip for every key.
  for (const key of Object.keys(value).sort(compareText)) {
    Object.defineProperty(out, key, {
      configurable: true,
      enumerable: true,
      value: canonicalJson(value[key], label + "." + key),
      writable: true,
    });
  }
  return out;
}

export function stableStringify(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("noncanonical-json", "cannot serialize a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (!isPlainObject(value)) refuse("noncanonical-json", "cannot serialize a non-JSON object");
  return (
    "{" +
    Object.keys(value)
      .sort(compareText)
      .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))
      .join(",") +
    "}"
  );
}

function sameCanonical(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

function gitBlobSha1(bytes) {
  return createHash("sha1")
    .update(Buffer.from("blob " + bytes.byteLength + "\0", "utf8"))
    .update(bytes)
    .digest("hex");
}

function canonicalCommitSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA.test(value))
    refuse("wrong-endpoint-sha", label + " must be a lowercase 40-hex SHA");
  return value;
}

function canonicalRawDescriptor(value, label) {
  assertExactKeys(value, ["bytes", "gitBlob", "sha256"], "malformed-raw-evidence", label);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0)
    refuse("malformed-raw-evidence", label + " has invalid bytes");
  if (typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256))
    refuse("malformed-raw-evidence", label + " has invalid SHA-256");
  if (typeof value.gitBlob !== "string" || !GIT_SHA.test(value.gitBlob))
    refuse("malformed-raw-evidence", label + " has invalid Git blob");
  return { bytes: value.bytes, sha256: value.sha256, gitBlob: value.gitBlob };
}

function emittedRawDescriptor(value) {
  return { bytes: value.bytes, git_blob: value.gitBlob, sha256: value.sha256 };
}

function canonicalEmittedRawDescriptor(value, label) {
  assertExactKeys(value, ["bytes", "git_blob", "sha256"], "malformed-raw-evidence", label);
  return canonicalRawDescriptor({ bytes: value.bytes, gitBlob: value.git_blob, sha256: value.sha256 }, label);
}

function canonicalOracle(value, label) {
  assertExactKeys(value, ["fastRev", "lane", "version"], "malformed-oracle-provenance", label);
  if (value.version !== 13 || value.lane !== "honest" || value.fastRev !== null) {
    refuse("producer-schema-provenance", label + " must be v13/honest/null");
  }
  return { fastRev: null, lane: "honest", version: 13 };
}

function emittedOracle(value) {
  return { fast_rev: value.fastRev, lane: value.lane, version: value.version };
}

function canonicalEmittedOracle(value, label) {
  assertExactKeys(value, ["fast_rev", "lane", "version"], "malformed-oracle-provenance", label);
  return canonicalOracle({ fastRev: value.fast_rev, lane: value.lane, version: value.version }, label);
}

function canonicalMode(value, label) {
  assertExactKeys(value, MODE_FIELDS, "malformed-metadata", label);
  if (value.target !== "standalone") refuse("malformed-metadata", label + " target must be standalone");
  if (value.include_proposals !== 0 && value.include_proposals !== 1)
    refuse("malformed-metadata", label + " include_proposals must be 0 or 1");
  if (typeof value.label !== "string" || value.label.length === 0)
    refuse("malformed-metadata", label + " label must be nonempty text");
  return { include_proposals: value.include_proposals, label: value.label, target: value.target };
}

function canonicalFullSummary(value, label) {
  assertExactKeys(value, FULL_SUMMARY_FIELDS, "malformed-report-summary", label);
  const out = {};
  for (const key of FULL_SUMMARY_FIELDS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0)
      refuse("malformed-report-summary", label + " has invalid " + key);
    out[key] = value[key];
  }
  if (out.total !== out.pass + out.fail + out.compile_error + out.compile_timeout + out.skip) {
    refuse("malformed-report-summary", label + " total does not equal all status buckets");
  }
  if (out.compilable !== out.pass + out.fail)
    refuse("malformed-report-summary", label + " compilable must equal pass + fail");
  if (out.host_free_pass > out.pass) refuse("malformed-report-summary", label + " host_free_pass exceeds pass");
  if (out.stale !== 0) refuse("malformed-report-summary", label + " stale must be zero");
  return out;
}

export function canonicalFileIdentity(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim())
    refuse("malformed-file", label + " has invalid file identity");
  if (
    /[\0\r\n]/.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("//")
  ) {
    refuse("malformed-file", label + " is not canonical");
  }
  if (value.split("/").some((part) => part === "" || part === "." || part === ".."))
    refuse("malformed-file", label + " is not canonical");
  return value;
}

function canonicalPolicyEndpoint(value, endpoint, allowUnknownProducerSchema) {
  assertExactKeys(
    value,
    [
      "baselineStoreCommitSha",
      "baselineStoreTreeSha",
      "fullSummary",
      "jsonl",
      "mode",
      "oracle",
      "paths",
      "producerSchema",
      "report",
      "testedCommitSha",
    ],
    "malformed-policy",
    endpoint + " endpoint policy",
  );
  if (typeof value.producerSchema !== "string" || value.producerSchema.length === 0)
    refuse("unknown-producer-schema", endpoint + " policy producer schema is unknown");
  if (!allowUnknownProducerSchema && value.producerSchema !== PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST)
    refuse("unknown-producer-schema", endpoint + " policy producer schema is unknown");
  assertExactKeys(value.paths, ["jsonl", "report"], "malformed-policy", endpoint + " policy paths");
  return {
    baselineStoreCommitSha: canonicalCommitSha(value.baselineStoreCommitSha, endpoint + " store commit"),
    baselineStoreTreeSha: canonicalCommitSha(value.baselineStoreTreeSha, endpoint + " store tree"),
    fullSummary: canonicalFullSummary(value.fullSummary, endpoint + " policy full_summary"),
    jsonl: canonicalRawDescriptor(value.jsonl, endpoint + " policy JSONL"),
    mode: canonicalMode(value.mode, endpoint + " policy mode"),
    oracle: canonicalOracle(value.oracle, endpoint + " policy oracle"),
    paths: {
      jsonl: canonicalFileIdentity(value.paths.jsonl, endpoint + " policy JSONL path"),
      report: canonicalFileIdentity(value.paths.report, endpoint + " policy report path"),
    },
    producerSchema: value.producerSchema,
    report: canonicalRawDescriptor(value.report, endpoint + " policy report"),
    testedCommitSha: canonicalCommitSha(value.testedCommitSha, endpoint + " tested commit"),
  };
}

function canonicalPolicy(value, allowUnknownProducerSchema = false) {
  assertExactKeys(value, ["endpoints", "expectedKeyCensus", "id"], "malformed-policy", "transition policy");
  assertExactKeys(value.endpoints, ["baseline", "candidate"], "malformed-policy", "policy endpoints");
  assertExactKeys(value.expectedKeyCensus, ["count", "sortedKeysSha256"], "malformed-policy", "policy key census");
  if (!Number.isSafeInteger(value.expectedKeyCensus.count) || value.expectedKeyCensus.count <= 0)
    refuse("malformed-policy", "policy key count is invalid");
  if (
    typeof value.expectedKeyCensus.sortedKeysSha256 !== "string" ||
    !SHA256_HEX.test(value.expectedKeyCensus.sortedKeysSha256)
  )
    refuse("malformed-policy", "policy key digest is invalid");
  if (typeof value.id !== "string" || value.id.length === 0) refuse("malformed-policy", "policy id is invalid");
  const out = {
    id: value.id,
    expectedKeyCensus: {
      count: value.expectedKeyCensus.count,
      sortedKeysSha256: value.expectedKeyCensus.sortedKeysSha256,
    },
    endpoints: {
      baseline: canonicalPolicyEndpoint(value.endpoints.baseline, "baseline", allowUnknownProducerSchema),
      candidate: canonicalPolicyEndpoint(value.endpoints.candidate, "candidate", allowUnknownProducerSchema),
    },
  };
  for (const endpoint of ["baseline", "candidate"]) {
    if (out.endpoints[endpoint].fullSummary.total !== out.expectedKeyCensus.count) {
      refuse("malformed-policy", endpoint + " policy total does not match the key census");
    }
  }
  return out;
}

function rawBytes(value, label) {
  if (!Buffer.isBuffer(value)) refuse("missing-raw-build-input", label + " must be a raw Buffer");
  return Buffer.from(value);
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    refuse(
      "malformed-raw-evidence",
      label + " is not strict UTF-8: " + (error instanceof Error ? error.message : String(error)),
    );
  }
}

function rawDescriptor(bytes) {
  return { bytes: bytes.byteLength, sha256: sha256Bytes(bytes), gitBlob: gitBlobSha1(bytes) };
}

function authenticateRaw(bytes, expected, endpoint, kind) {
  const actual = rawDescriptor(bytes);
  if (!sameCanonical(actual, expected)) {
    refuse(
      "raw-" + kind + "-evidence-mismatch",
      endpoint + " " + kind + " does not match the immutable #2097 raw descriptor",
      { actual, expected },
    );
  }
}

function canonicalBuildInputs(value) {
  assertExactKeys(value, ["baseline", "candidate", "expectedKeys"], "missing-raw-build-input", "build inputs");
  const endpoint = (item, label) => {
    assertExactKeys(item, ["jsonl", "report"], "missing-raw-build-input", label + " input");
    return { jsonl: rawBytes(item.jsonl, label + " JSONL"), report: rawBytes(item.report, label + " report") };
  };
  return {
    baseline: endpoint(value.baseline, "baseline"),
    candidate: endpoint(value.candidate, "candidate"),
    expectedKeys: rawBytes(value.expectedKeys, "expected key census"),
  };
}

function requiredText(value, field, label) {
  if (typeof value !== "string" || value.length === 0) refuse("malformed-row", label + " has invalid " + field);
  return value;
}

function optionalText(record, field, label) {
  return hasOwn(record, field) ? requiredText(record[field], field, label) : null;
}

function requiredBoolean(record, field, label) {
  if (typeof record[field] !== "boolean") refuse("malformed-row", label + " has invalid " + field);
  return record[field];
}

function optionalBoolean(record, field, label) {
  return hasOwn(record, field) ? requiredBoolean(record, field, label) : null;
}

function optionalNumber(record, field, label) {
  if (!hasOwn(record, field)) return null;
  if (!Number.isSafeInteger(record[field]) || record[field] < 0)
    refuse("malformed-timing", label + " has invalid " + field);
  return record[field];
}

function canonicalImports(record, expected, label) {
  const hasImports = hasOwn(record, "imports");
  const hasLeak = hasOwn(record, "host_import_leak_class");
  if (!hasImports && !hasLeak) {
    if (expected.producerSchema !== PRODUCER_SCHEMA_TEST262_RECORD_RESULT_V13_HONEST)
      refuse("unauthenticated-import-omission", label + " omitted imports under unknown producer");
    return { imports: [], host_import_leak_class: null, imports_evidence: "authenticated_producer_omission" };
  }
  if (!hasImports || !hasLeak || !Array.isArray(record.imports) || record.imports.length === 0) {
    refuse("inconsistent-import-evidence", label + " must provide a nonempty imports/leak pair");
  }
  if (typeof record.host_import_leak_class !== "string" || record.host_import_leak_class.length === 0) {
    refuse("inconsistent-import-evidence", label + " has invalid host_import_leak_class");
  }
  const seen = new Set();
  const imports = [];
  for (let index = 0; index < record.imports.length; index++) {
    const item = record.imports[index];
    if (typeof item !== "string" || item.length === 0 || /[\0\r\n]/.test(item))
      refuse("inconsistent-import-evidence", label + " has invalid imports[" + index + "]");
    if (!seen.has(item)) {
      seen.add(item);
      imports.push(item);
    }
  }
  return {
    imports: imports.sort(compareText),
    host_import_leak_class: record.host_import_leak_class,
    imports_evidence: "explicit_nonempty",
  };
}

export function isStandaloneHostFreePass(row) {
  return (
    row?.status === "pass" &&
    Array.isArray(row.imports) &&
    row.imports.length === 0 &&
    row.host_import_leak_class === null
  );
}

function canonicalRow(record, endpoint, expected, line, observedFields) {
  const label = endpoint + " JSONL line " + line;
  if (!isPlainObject(record)) refuse("malformed-row", label + " must be a plain object");
  for (const field of Object.keys(record)) {
    if (!ROW_FIELD_SETS[endpoint].has(field))
      refuse("unrecognized-row-field", label + " contains unsupported field " + field);
    observedFields.add(field);
  }
  if (record.oracle_version !== expected.oracle.version || record.oracle_lane !== expected.oracle.lane) {
    refuse("oracle-provenance-mismatch", label + " contradicts the pinned v13 honest provenance");
  }
  if (
    typeof record.status !== "string" ||
    !TEST262_VERDICT_STATUSES.has(record.status) ||
    !STATUS_BUCKET_SET.has(record.status)
  ) {
    refuse("malformed-status", label + " has unknown status " + JSON.stringify(record.status));
  }
  if (!SCOPE_VALUES.has(record.scope) || !STRICT_VALUES.has(record.strict))
    refuse("malformed-row", label + " has invalid scope or strict mode");
  const hasRetryCount = hasOwn(record, "retry_count");
  const retryCount = hasRetryCount ? record.retry_count : null;
  if (hasRetryCount && (!Number.isSafeInteger(retryCount) || retryCount <= 0))
    refuse("malformed-row", label + " has invalid retry_count");
  const retried = optionalBoolean(record, "retried", label);
  if ((retried === null) !== (retryCount === null) || (retried !== null && retried !== true))
    refuse("malformed-row", label + " has inconsistent retry evidence");
  const imports = canonicalImports(record, expected, label);
  // The report builder does not count an imported/leaky raw `pass` as a
  // standalone pass. Current pinned streams contain none; reject one rather
  // than silently letting it masquerade as a non-host-free pass here.
  if (record.status === "pass" && imports.imports_evidence === "explicit_nonempty") {
    refuse("non-host-free-pass", label + " is pass despite explicit host-import evidence");
  }
  const row = {
    category: requiredText(record.category, "category", label),
    error: optionalText(record, "error", label),
    error_category: optionalText(record, "error_category", label),
    error_signature: optionalText(record, "error_signature", label),
    file: canonicalFileIdentity(record.file, label),
    host_free_pass: false,
    host_import_leak_class: imports.host_import_leak_class,
    imports: imports.imports,
    imports_evidence: imports.imports_evidence,
    oracle_fast_rev: expected.oracle.fastRev,
    oracle_lane: expected.oracle.lane,
    oracle_version: expected.oracle.version,
    poison_healed: endpoint === "baseline" ? optionalBoolean(record, "poison_healed", label) : null,
    reached_test: requiredBoolean(record, "reached_test", label),
    retried,
    retry_count: retryCount,
    scope: record.scope,
    scope_official: requiredBoolean(record, "scope_official", label),
    scope_reason: optionalText(record, "scope_reason", label),
    status: record.status,
    strict: record.strict,
    timestamp: requiredText(record.timestamp, "timestamp", label),
    timing: {
      compile_ms: optionalNumber(record, "compile_ms", label),
      exec_ms: optionalNumber(record, "exec_ms", label),
    },
  };
  if (row.status === "compile_timeout" && row.timing.compile_ms === null)
    refuse("malformed-timing", label + " timeout has no compile_ms");
  row.host_free_pass = isStandaloneHostFreePass(row);
  return row;
}

function expectedRowFields(endpoint) {
  return endpoint === "baseline" ? BASELINE_ROW_FIELDS : CANDIDATE_ROW_FIELDS;
}

function fieldSetSha256(fields) {
  return sha256Text([...fields].sort(compareText).join("\n") + "\n");
}

function parseJsonl(bytes, endpoint, expected) {
  const rows = new Map();
  const observedFields = new Set();
  const lines = decodeUtf8(bytes, endpoint + " JSONL").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    if (text === "" && index === lines.length - 1) continue;
    if (text.trim() === "") refuse("blank-record", endpoint + " JSONL line " + (index + 1) + " is blank");
    let record;
    try {
      record = JSON.parse(text);
    } catch (error) {
      refuse(
        "malformed-json",
        endpoint +
          " JSONL line " +
          (index + 1) +
          " is invalid JSON: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    const row = canonicalRow(record, endpoint, expected, index + 1, observedFields);
    if (rows.has(row.file)) refuse("duplicate-key", endpoint + " JSONL repeats " + row.file);
    rows.set(row.file, { line: index + 1, row });
  }
  if (rows.size === 0) refuse("empty-endpoint", endpoint + " JSONL contains no rows");
  if (!sameList([...observedFields].sort(compareText), expectedRowFields(endpoint).slice().sort(compareText))) {
    refuse("field-universe-mismatch", endpoint + " JSONL does not have the authenticated v13 field universe");
  }
  return rows;
}

function parseReport(bytes, endpoint, expected) {
  let metadata;
  try {
    metadata = JSON.parse(decodeUtf8(bytes, endpoint + " report"));
  } catch (error) {
    refuse(
      "malformed-report-json",
      endpoint + " report is invalid JSON: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!isPlainObject(metadata)) refuse("malformed-metadata", endpoint + " report must be a plain object");
  // Historical reports omit these fields. A contradiction gets its specific
  // error before the exact historical key universe rejects the expansion.
  if (hasOwn(metadata, "oracle_lane") && metadata.oracle_lane !== expected.oracle.lane)
    refuse("oracle-provenance-mismatch", endpoint + " report oracle_lane contradicts policy");
  if (hasOwn(metadata, "oracle_fast_rev") && metadata.oracle_fast_rev !== expected.oracle.fastRev)
    refuse("oracle-provenance-mismatch", endpoint + " report oracle_fast_rev contradicts policy");
  assertExactKeys(metadata, REPORT_TOP_LEVEL_FIELDS, "report-key-universe-mismatch", endpoint + " report");
  if (metadata.baseline_sha !== expected.testedCommitSha)
    refuse("wrong-endpoint-sha", endpoint + " report baseline_sha contradicts policy");
  if (metadata.oracle_version !== expected.oracle.version)
    refuse("oracle-provenance-mismatch", endpoint + " report oracle_version contradicts policy");
  if (
    typeof metadata.baseline_generated_at !== "string" ||
    metadata.baseline_generated_at.length === 0 ||
    typeof metadata.timestamp !== "string" ||
    metadata.timestamp.length === 0
  ) {
    refuse("malformed-metadata", endpoint + " report timestamps must be nonempty text");
  }
  const mode = canonicalMode(metadata.mode, endpoint + " report mode");
  if (!sameCanonical(mode, expected.mode)) refuse("report-mode-mismatch", endpoint + " report mode contradicts policy");
  const fullSummary = canonicalFullSummary(metadata.full_summary, endpoint + " report full_summary");
  if (!sameCanonical(fullSummary, expected.fullSummary))
    refuse("pinned-summary-mismatch", endpoint + " report full_summary contradicts policy");
  return canonicalJson(metadata, endpoint + " report");
}

function parseExpectedKeys(bytes) {
  const lines = decodeUtf8(bytes, "expected key census").split(/\r?\n/);
  const keys = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === "" && index === lines.length - 1) continue;
    if (line.trim() === "") refuse("missing-expected-census", "expected key census line " + (index + 1) + " is blank");
    keys.push(canonicalFileIdentity(line, "expected key census line " + (index + 1)));
  }
  const sorted = [...new Set(keys)].sort(compareText);
  if (keys.length === 0 || sorted.length !== keys.length)
    refuse("duplicate-expected-key", "expected key census is empty or duplicates a path");
  return sorted;
}

export function parseExpectedKeyCensus(text) {
  if (typeof text !== "string") refuse("missing-expected-census", "expected key census must be text");
  return parseExpectedKeys(Buffer.from(text, "utf8"));
}

function assertKeyPolicy(keys, policy) {
  if (
    keys.length !== policy.expectedKeyCensus.count ||
    sha256Text(keys.join("\n") + "\n") !== policy.expectedKeyCensus.sortedKeysSha256
  ) {
    refuse("expected-key-census-mismatch", "expected key census does not match immutable #2097 policy");
  }
}

function assertCensus(rows, keys, endpoint) {
  const expected = new Set(keys);
  for (const key of keys) if (!rows.has(key)) refuse("dropped-key", endpoint + " is missing " + key);
  for (const key of rows.keys()) if (!expected.has(key)) refuse("foreign-key", endpoint + " has foreign " + key);
}

function summarizeRows(rows) {
  const summary = {
    total: rows.size,
    pass: 0,
    fail: 0,
    compile_error: 0,
    compile_timeout: 0,
    skip: 0,
    compilable: 0,
    host_free_pass: 0,
    stale: 0,
  };
  for (const { row } of rows.values()) {
    summary[row.status]++;
    if (row.host_free_pass) summary.host_free_pass++;
  }
  summary.compilable = summary.pass + summary.fail;
  return summary;
}

function assertReportReconciles(metadata, rows, policy, endpoint) {
  const actual = summarizeRows(rows);
  for (const key of FULL_SUMMARY_FIELDS) {
    if (metadata.full_summary[key] !== actual[key])
      refuse("report-jsonl-summary-mismatch", endpoint + " report " + key + " does not match parsed JSONL");
  }
  if (
    actual.total !== policy.expectedKeyCensus.count ||
    !sameCanonical(actual, policy.endpoints[endpoint].fullSummary)
  ) {
    refuse("pinned-summary-mismatch", endpoint + " parsed JSONL does not match immutable endpoint vector");
  }
}

function canonicalSemanticRowsJsonl(rows) {
  return (
    [...rows.values()]
      .map((entry) => entry.row)
      .sort((a, b) => compareText(a.file, b.file))
      .map(stableStringify)
      .join("\n") + "\n"
  );
}

export function semanticRowsSha256(rows) {
  if (!(rows instanceof Map)) refuse("malformed-manifest", "semantic rows must be a parsed map");
  return sha256Text(canonicalSemanticRowsJsonl(rows));
}

// Structural-only compatibility digest. It never authenticates raw bytes and
// is not used by public acceptance, render, or the fixed-policy CLI.
export const endpointRowsSha256StructuralOnly = semanticRowsSha256;

function buildEndpoint(raw, policyEndpoint, endpoint) {
  authenticateRaw(raw.jsonl, policyEndpoint.jsonl, endpoint, "jsonl");
  authenticateRaw(raw.report, policyEndpoint.report, endpoint, "report");
  const metadata = parseReport(raw.report, endpoint, policyEndpoint);
  const rows = parseJsonl(raw.jsonl, endpoint, policyEndpoint);
  return { metadata, rows };
}

function endpointEvidence(policyEndpoint, endpointData, endpoint) {
  const fields = expectedRowFields(endpoint);
  return {
    baseline_store_commit_sha: policyEndpoint.baselineStoreCommitSha,
    baseline_store_tree_sha: policyEndpoint.baselineStoreTreeSha,
    commit_sha: policyEndpoint.testedCommitSha,
    oracle: emittedOracle(policyEndpoint.oracle),
    paths: { ...policyEndpoint.paths },
    pinned_full_summary: { ...policyEndpoint.fullSummary },
    producer_schema: policyEndpoint.producerSchema,
    raw_jsonl: emittedRawDescriptor(policyEndpoint.jsonl),
    raw_report: emittedRawDescriptor(policyEndpoint.report),
    row_field_count: fields.length,
    row_fields_sha256: fieldSetSha256(fields),
    semantic_row_count: endpointData.rows.size,
    semantic_rows_sha256: semanticRowsSha256(endpointData.rows),
  };
}

function transitionKind(baseline, candidate) {
  if (baseline.host_free_pass && !candidate.host_free_pass) return "raw_host_free_regression";
  if (!baseline.host_free_pass && candidate.host_free_pass) return "raw_host_free_improvement";
  return null;
}

function transitionEvidence(row) {
  const evidence = { ...row };
  delete evidence.file;
  return evidence;
}

export function canonicalTransitionRowsJsonl(rows) {
  if (!Array.isArray(rows)) refuse("malformed-manifest", "transitions must be an array");
  return rows.map(stableStringify).join("\n") + (rows.length ? "\n" : "");
}

export function transitionRowsSha256(rows) {
  return sha256Text(canonicalTransitionRowsJsonl(rows));
}

function buildWithPolicy(rawBuildInputs, suppliedPolicy, allowUnknownProducerSchema = false) {
  const policy = canonicalPolicy(suppliedPolicy, allowUnknownProducerSchema);
  const raw = canonicalBuildInputs(rawBuildInputs);
  // Authenticate both raw endpoint streams before parsing any untrusted census
  // text. This keeps a byte mutation diagnostic independent of census shape.
  const baseline = buildEndpoint(raw.baseline, policy.endpoints.baseline, "baseline");
  const candidate = buildEndpoint(raw.candidate, policy.endpoints.candidate, "candidate");
  const keys = parseExpectedKeys(raw.expectedKeys);
  assertKeyPolicy(keys, policy);
  assertCensus(baseline.rows, keys, "baseline");
  assertCensus(candidate.rows, keys, "candidate");
  assertReportReconciles(baseline.metadata, baseline.rows, policy, "baseline");
  assertReportReconciles(candidate.metadata, candidate.rows, policy, "candidate");
  const transitions = [];
  for (const file of keys) {
    const before = baseline.rows.get(file).row;
    const after = candidate.rows.get(file).row;
    const kind = transitionKind(before, after);
    if (kind)
      transitions.push({ baseline: transitionEvidence(before), candidate: transitionEvidence(after), file, kind });
  }
  transitions.sort((a, b) => compareText(a.file, b.file));
  const regressions = transitions.filter((row) => row.kind === "raw_host_free_regression").length;
  const improvements = transitions.filter((row) => row.kind === "raw_host_free_improvement").length;
  const baselineHostFreePass = policy.endpoints.baseline.fullSummary.host_free_pass;
  const candidateHostFreePass = policy.endpoints.candidate.fullSummary.host_free_pass;
  return {
    schema: TRANSITION_MANIFEST_SCHEMA,
    policy_id: policy.id,
    census: {
      expected_key_count: policy.expectedKeyCensus.count,
      expected_keys_sha256: policy.expectedKeyCensus.sortedKeysSha256,
    },
    endpoints: {
      baseline: {
        evidence: endpointEvidence(policy.endpoints.baseline, baseline, "baseline"),
        metadata: baseline.metadata,
      },
      candidate: {
        evidence: endpointEvidence(policy.endpoints.candidate, candidate, "candidate"),
        metadata: candidate.metadata,
      },
    },
    summary: {
      baseline_host_free_pass: baselineHostFreePass,
      candidate_host_free_pass: candidateHostFreePass,
      net_host_free_pass: candidateHostFreePass - baselineHostFreePass,
      raw_host_free_improvements: improvements,
      raw_host_free_regressions: regressions,
    },
    transition_rows_sha256: transitionRowsSha256(transitions),
    transitions,
  };
}

export function buildStandaloneHighwaterTransitionManifest(rawBuildInputs) {
  return buildWithPolicy(rawBuildInputs, STANDALONE_HIGHWATER_TRANSITION_POLICY);
}

// TEST-ONLY seam: small fixtures cannot reproduce the immutable 48,735-row
// baseline. It also permits an explicitly unknown fixture producer so the
// unauthenticated-import-omission refusal remains directly testable.
// Production builder, renderer, verifier, and CLI never call this.
export function buildStandaloneHighwaterTransitionManifestForTest(rawBuildInputs, testPolicy) {
  return buildWithPolicy(rawBuildInputs, testPolicy, true);
}

function validateManifestEndpointEvidence(value, policyEndpoint, endpoint) {
  assertExactKeys(
    value,
    [
      "baseline_store_commit_sha",
      "baseline_store_tree_sha",
      "commit_sha",
      "oracle",
      "paths",
      "pinned_full_summary",
      "producer_schema",
      "raw_jsonl",
      "raw_report",
      "row_field_count",
      "row_fields_sha256",
      "semantic_row_count",
      "semantic_rows_sha256",
    ],
    "malformed-endpoint-evidence",
    endpoint + " manifest evidence",
  );
  if (
    value.baseline_store_commit_sha !== policyEndpoint.baselineStoreCommitSha ||
    value.baseline_store_tree_sha !== policyEndpoint.baselineStoreTreeSha ||
    value.commit_sha !== policyEndpoint.testedCommitSha ||
    value.producer_schema !== policyEndpoint.producerSchema
  ) {
    refuse("policy-evidence-mismatch", endpoint + " manifest evidence contradicts policy");
  }
  if (!sameCanonical(canonicalEmittedOracle(value.oracle, endpoint + " manifest oracle"), policyEndpoint.oracle))
    refuse("oracle-provenance-mismatch", endpoint + " manifest oracle contradicts policy");
  if (!sameCanonical(canonicalJson(value.paths, endpoint + " manifest paths"), policyEndpoint.paths))
    refuse("policy-evidence-mismatch", endpoint + " manifest paths contradict policy");
  if (
    !sameCanonical(
      canonicalFullSummary(value.pinned_full_summary, endpoint + " manifest summary"),
      policyEndpoint.fullSummary,
    )
  )
    refuse("pinned-summary-mismatch", endpoint + " manifest pinned summary contradicts policy");
  if (
    !sameCanonical(canonicalEmittedRawDescriptor(value.raw_jsonl, endpoint + " manifest JSONL"), policyEndpoint.jsonl)
  )
    refuse("raw-jsonl-evidence-mismatch", endpoint + " manifest JSONL descriptor contradicts policy");
  if (
    !sameCanonical(
      canonicalEmittedRawDescriptor(value.raw_report, endpoint + " manifest report"),
      policyEndpoint.report,
    )
  )
    refuse("raw-report-evidence-mismatch", endpoint + " manifest report descriptor contradicts policy");
  const fields = expectedRowFields(endpoint);
  if (
    value.row_field_count !== fields.length ||
    value.row_fields_sha256 !== fieldSetSha256(fields) ||
    value.semantic_row_count !== policyEndpoint.fullSummary.total ||
    typeof value.semantic_rows_sha256 !== "string" ||
    !SHA256_HEX.test(value.semantic_rows_sha256)
  ) {
    refuse("malformed-endpoint-evidence", endpoint + " manifest evidence has an invalid field/semantic census");
  }
}

// Structural-only canonicalization is intentionally private. It cannot see raw
// inputs and must never be used for acceptance; verify/render always rebuild.
function validateManifestStructureOnly(manifest, policy) {
  if (!isPlainObject(manifest)) refuse("malformed-manifest", "manifest must be a plain object");
  assertExactKeys(
    manifest,
    ["census", "endpoints", "policy_id", "schema", "summary", "transition_rows_sha256", "transitions"],
    "malformed-manifest",
    "manifest",
  );
  if (manifest.schema !== TRANSITION_MANIFEST_SCHEMA || manifest.policy_id !== policy.id)
    refuse("policy-evidence-mismatch", "manifest schema or policy id is wrong");
  assertExactKeys(
    manifest.census,
    ["expected_key_count", "expected_keys_sha256"],
    "malformed-manifest",
    "manifest census",
  );
  if (
    manifest.census.expected_key_count !== policy.expectedKeyCensus.count ||
    manifest.census.expected_keys_sha256 !== policy.expectedKeyCensus.sortedKeysSha256
  )
    refuse("expected-key-census-mismatch", "manifest census contradicts policy");
  assertExactKeys(manifest.endpoints, ["baseline", "candidate"], "malformed-manifest", "manifest endpoints");
  for (const endpoint of ["baseline", "candidate"]) {
    const item = manifest.endpoints[endpoint];
    assertExactKeys(item, ["evidence", "metadata"], "malformed-manifest", endpoint + " manifest endpoint");
    validateManifestEndpointEvidence(item.evidence, policy.endpoints[endpoint], endpoint);
    parseReport(Buffer.from(stableStringify(item.metadata), "utf8"), endpoint, policy.endpoints[endpoint]);
  }
  assertExactKeys(manifest.summary, MANIFEST_SUMMARY_FIELDS, "malformed-manifest", "manifest summary");
  const baseline = policy.endpoints.baseline.fullSummary.host_free_pass;
  const candidate = policy.endpoints.candidate.fullSummary.host_free_pass;
  if (
    manifest.summary.baseline_host_free_pass !== baseline ||
    manifest.summary.candidate_host_free_pass !== candidate ||
    manifest.summary.net_host_free_pass !== candidate - baseline ||
    !Number.isSafeInteger(manifest.summary.raw_host_free_improvements) ||
    manifest.summary.raw_host_free_improvements < 0 ||
    !Number.isSafeInteger(manifest.summary.raw_host_free_regressions) ||
    manifest.summary.raw_host_free_regressions < 0 ||
    manifest.summary.net_host_free_pass !==
      manifest.summary.raw_host_free_improvements - manifest.summary.raw_host_free_regressions
  ) {
    refuse("pinned-summary-mismatch", "manifest absolute or transition summary contradicts policy");
  }
  if (
    !Array.isArray(manifest.transitions) ||
    typeof manifest.transition_rows_sha256 !== "string" ||
    !SHA256_HEX.test(manifest.transition_rows_sha256)
  ) {
    refuse("malformed-manifest", "manifest transitions are invalid");
  }
  return canonicalJson(manifest, "manifest");
}

function verifyWithPolicy(manifest, rawBuildInputs, suppliedPolicy, allowUnknownProducerSchema = false) {
  if (rawBuildInputs === undefined)
    refuse("missing-build-inputs", "acceptance verification requires authenticated raw build inputs");
  const policy = canonicalPolicy(suppliedPolicy, allowUnknownProducerSchema);
  const structural = validateManifestStructureOnly(manifest, policy);
  const rebuilt = buildWithPolicy(rawBuildInputs, policy, allowUnknownProducerSchema);
  if (!sameCanonical(structural, rebuilt))
    refuse(
      "manifest-authenticated-evidence-mismatch",
      "manifest does not exactly reproduce authenticated raw endpoint evidence",
    );
  return rebuilt;
}

export function verifyStandaloneHighwaterTransitionManifest(manifest, rawBuildInputs) {
  return verifyWithPolicy(manifest, rawBuildInputs, STANDALONE_HIGHWATER_TRANSITION_POLICY);
}

// TEST-ONLY companion to buildStandaloneHighwaterTransitionManifestForTest.
export function verifyStandaloneHighwaterTransitionManifestForTest(manifest, rawBuildInputs, testPolicy) {
  return verifyWithPolicy(manifest, rawBuildInputs, testPolicy, true);
}

export function renderStandaloneHighwaterTransitionManifest(manifest, rawBuildInputs) {
  return stableStringify(verifyStandaloneHighwaterTransitionManifest(manifest, rawBuildInputs)) + "\n";
}

// TEST-ONLY companion to the generic fixture policy seam.
export function renderStandaloneHighwaterTransitionManifestForTest(manifest, rawBuildInputs, testPolicy) {
  return (
    stableStringify(verifyStandaloneHighwaterTransitionManifestForTest(manifest, rawBuildInputs, testPolicy)) + "\n"
  );
}

function cliUsage() {
  return [
    "Usage: node scripts/standalone-highwater-transition-manifest.mjs \\",
    "  --baseline-jsonl <endpoint.jsonl> --candidate-jsonl <endpoint.jsonl> \\",
    "  --baseline-report <endpoint-report.json> --candidate-report <endpoint-report.json> \\",
    "  --expected-keys <canonical-test262-paths.txt>",
    "",
    "The immutable #2097 policy authenticates raw JSONL/report bytes before parsing.",
  ].join("\n");
}

function parseCliArgs(argv) {
  const values = {};
  const allowed = new Set([
    "--baseline-jsonl",
    "--candidate-jsonl",
    "--baseline-report",
    "--candidate-report",
    "--expected-keys",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!allowed.has(key)) refuse("invalid-arguments", "unknown argument " + key);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) refuse("invalid-arguments", key + " requires a value");
    if (hasOwn(values, key)) refuse("invalid-arguments", key + " was supplied more than once");
    values[key] = value;
  }
  for (const key of allowed) if (!hasOwn(values, key)) refuse("invalid-arguments", "missing required " + key);
  return values;
}

function rawBuildInputsFromCli(argv) {
  const args = parseCliArgs(argv);
  if (args.help) return { help: true };
  return {
    baseline: {
      jsonl: readFileSync(resolve(args["--baseline-jsonl"])),
      report: readFileSync(resolve(args["--baseline-report"])),
    },
    candidate: {
      jsonl: readFileSync(resolve(args["--candidate-jsonl"])),
      report: readFileSync(resolve(args["--candidate-report"])),
    },
    expectedKeys: readFileSync(resolve(args["--expected-keys"])),
  };
}

function runCliWithPolicy(argv, policy, allowUnknownProducerSchema = false) {
  const rawBuildInputs = rawBuildInputsFromCli(argv);
  if (rawBuildInputs.help) return cliUsage();
  const manifest = buildWithPolicy(rawBuildInputs, policy, allowUnknownProducerSchema);
  return stableStringify(verifyWithPolicy(manifest, rawBuildInputs, policy, allowUnknownProducerSchema)) + "\n";
}

export function runTransitionManifestCli(argv = process.argv.slice(2)) {
  return runCliWithPolicy(argv, STANDALONE_HIGHWATER_TRANSITION_POLICY);
}

// TEST-ONLY: the executable entry point below never accepts this policy seam.
export function runTransitionManifestCliForTest(argv, testPolicy) {
  return runCliWithPolicy(argv, testPolicy, true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(runTransitionManifestCli());
  } catch (error) {
    process.stderr.write(
      "standalone-highwater-transition-manifest: " + (error instanceof Error ? error.message : String(error)) + "\n",
    );
    process.exitCode = 2;
  }
}
