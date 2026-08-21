#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "../src/index.ts";

export const IR_CUTOVER_CORPUS_MANIFEST_SCHEMA = "js2-ir-cutover-corpus-manifest-v1";
export const IR_CUTOVER_CORPUS_RECEIPT_SCHEMA = "js2-ir-cutover-corpus-receipt-v1";
export const IR_CUTOVER_AUDIT_SCHEMA = "js2-ir-cutover-audit-v1";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
export const DEFAULT_MANIFEST_PATH = resolve(REPO_ROOT, "scripts/standalone-ir-cutover-corpus.json");
export const DEFAULT_OUTPUT_PATH = resolve(REPO_ROOT, ".tmp/standalone-ir-cutover-corpus.jsonl");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeManifestDigest(manifest) {
  const { digest: _digest, ...unsigned } = manifest;
  return `sha256:${sha256(canonicalJson(unsigned))}`;
}

export function loadCorpusManifest(path = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schema !== IR_CUTOVER_CORPUS_MANIFEST_SCHEMA) {
    throw new Error(`unsupported corpus manifest schema ${JSON.stringify(manifest.schema)}`);
  }
  const observedDigest = computeManifestDigest(manifest);
  if (manifest.digest !== observedDigest) {
    throw new Error(`corpus manifest digest mismatch: expected ${manifest.digest}, observed ${observedDigest}`);
  }
  return manifest;
}

function sourceFailure(source, bytes, digest) {
  if (bytes !== source.bytes) return `expected ${source.bytes} bytes, observed ${bytes}`;
  if (digest !== source.sha256) return `expected sha256:${source.sha256}, observed sha256:${digest}`;
  return undefined;
}

function auditEnvelope(result) {
  return {
    schema: IR_CUTOVER_AUDIT_SCHEMA,
    success: result.success,
    audit: result.irBodyRouteAudit,
  };
}

function appendReceipt(outputPath, receipt) {
  writeFileSync(outputPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "a" });
}

function failureReceipt(base, stage, message, envelope) {
  return {
    ...base,
    kind: "completion",
    success: false,
    failure: { stage, message },
    ...(envelope === undefined ? {} : { envelope }),
  };
}

export async function runCorpus(options = {}) {
  const manifestPath = resolve(options.manifestPath ?? DEFAULT_MANIFEST_PATH);
  const outputPath = resolve(options.outputPath ?? DEFAULT_OUTPUT_PATH);
  const manifest = options.manifest ?? loadCorpusManifest(manifestPath);
  const manifestDigest = computeManifestDigest(manifest);
  if (manifest.digest !== manifestDigest) {
    throw new Error(`corpus manifest digest mismatch: expected ${manifest.digest}, observed ${manifestDigest}`);
  }
  const runId = options.runId ?? randomUUID();
  const compileCase = options.compileCase ?? ((source, compileOptions) => compile(source, compileOptions));
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, "", "utf8");

  let failed = 0;
  const sourcesById = new Map(manifest.sources.map((source) => [source.id, source]));
  for (const corpusCase of manifest.cases) {
    const base = {
      schema: IR_CUTOVER_CORPUS_RECEIPT_SCHEMA,
      runId,
      manifestDigest,
      caseId: corpusCase.id,
    };
    appendReceipt(outputPath, { ...base, kind: "attempt" });
    const source = sourcesById.get(corpusCase.sourceId);
    if (!source) {
      failed++;
      appendReceipt(outputPath, failureReceipt(base, "manifest", `unknown source ${corpusCase.sourceId}`));
      continue;
    }

    let sourceText;
    try {
      sourceText = readFileSync(resolve(repoRoot, source.path), "utf8");
    } catch (cause) {
      failed++;
      appendReceipt(
        outputPath,
        failureReceipt(base, "source-read", cause instanceof Error ? cause.message : String(cause)),
      );
      continue;
    }
    const sourceBytes = Buffer.byteLength(sourceText, "utf8");
    const sourceSha256 = sha256(sourceText);
    const drift = sourceFailure(source, sourceBytes, sourceSha256);
    if (drift) {
      failed++;
      appendReceipt(outputPath, failureReceipt(base, "source-drift", `${source.path}: ${drift}`));
      continue;
    }

    let result;
    try {
      result = await compileCase(sourceText, {
        fileName: source.path,
        target: "standalone",
        trackIrOutcomes: true,
      });
    } catch (cause) {
      failed++;
      appendReceipt(
        outputPath,
        failureReceipt(base, "compile-threw", cause instanceof Error ? cause.message : String(cause)),
      );
      continue;
    }
    const envelope = result.irBodyRouteAudit === undefined ? undefined : auditEnvelope(result);
    if (result.success !== true) {
      failed++;
      const messages =
        (result.errors ?? []).map((item) => item.message).join(" | ") || "compile returned success:false";
      appendReceipt(outputPath, failureReceipt(base, "compile-failed", messages, envelope));
      continue;
    }
    if (envelope === undefined) {
      failed++;
      appendReceipt(outputPath, failureReceipt(base, "missing-audit", "compile returned no IR route audit"));
      continue;
    }
    appendReceipt(outputPath, {
      ...base,
      kind: "completion",
      success: true,
      source: { bytes: sourceBytes, sha256: sourceSha256 },
      envelope,
    });
  }
  return Object.freeze({
    ok: failed === 0,
    runId,
    manifestDigest,
    outputPath,
    attempts: manifest.cases.length,
    failed,
  });
}

function usage() {
  return [
    "Usage: node --import tsx scripts/run-standalone-ir-cutover-corpus.mjs [options]",
    "",
    "Options:",
    "  --manifest <path>  Pinned corpus manifest",
    "  --output <path>    Receipt JSONL output",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--manifest" || argument === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      const field = argument === "--manifest" ? "manifestPath" : "outputPath";
      if (options[field] !== undefined) throw new Error(`${argument} may be specified only once`);
      options[field] = value;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const report = await runCorpus(options);
  process.stdout.write(
    `Standalone IR cutover corpus: ${report.ok ? "PASS" : "FAIL"} (${report.attempts} attempts, ${report.failed} failed)\n` +
      `Manifest: ${report.manifestDigest}\nReceipts: ${report.outputPath}\n`,
  );
  return report.ok ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await runCli();
  } catch (cause) {
    process.stderr.write(
      `Standalone IR cutover corpus: ERROR\n${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  }
}
