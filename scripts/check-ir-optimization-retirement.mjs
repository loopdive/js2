#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER_START = "<!-- ir-optimization-retirement-ledger:start -->";
export const LEDGER_END = "<!-- ir-optimization-retirement-ledger:end -->";

const OWNERSHIP_STATUSES = new Set(["lowering", "pass", "runtime-intent", "typed-unsupported"]);
const EVIDENCE_STATUSES = new Set(["verified", "pending", "not-applicable"]);
const EVIDENCE_KINDS = ["semantic", "outputShape", "performance"];
const REPO_OWNER = /^(?:src|plan\/issues|plan\/log|tests|scripts)\//;
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateOwner(errors, owner, path, { direct }) {
  if (!isRecord(owner)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (requireNonEmptyString(errors, owner.source, `${path}.source`)) {
    if (!REPO_OWNER.test(owner.source)) {
      errors.push(`${path}.source must be a repository-relative owner path`);
    } else if (!existsSync(resolve(REPO_ROOT, owner.source))) {
      errors.push(`${path}.source does not exist`);
    }
  }
  requireNonEmptyString(errors, owner.symbol, `${path}.symbol`);
  if (!direct && owner.source?.startsWith("src/codegen/")) {
    errors.push(`${path}.source cannot assign IR ownership to the direct codegen tree`);
  }
}

function validateEvidence(errors, evidence, rowPath) {
  if (!isRecord(evidence)) {
    errors.push(`${rowPath}.evidence must be an object`);
    return;
  }
  for (const kind of EVIDENCE_KINDS) {
    const entry = evidence[kind];
    const path = `${rowPath}.evidence.${kind}`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (!EVIDENCE_STATUSES.has(entry.status)) {
      errors.push(`${path}.status must be one of ${[...EVIDENCE_STATUSES].join(", ")}`);
    }
    requireNonEmptyString(errors, entry.reference, `${path}.reference`);
    if (entry.status === "not-applicable" && kind !== "performance") {
      errors.push(`${path}.status may be not-applicable only for performance evidence`);
    }
  }
}

function validateRow(row, index) {
  const errors = [];
  const path = `row ${index + 1}`;
  if (!isRecord(row)) return [`${path} must be a JSON object`];

  if (requireNonEmptyString(errors, row.id, `${path}.id`) && !/^IR-OPT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(row.id)) {
    errors.push(`${path}.id must match IR-OPT-<STABLE-UPPERCASE-ID>`);
  }
  if (requireNonEmptyString(errors, row.family, `${path}.family`) && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.family)) {
    errors.push(`${path}.family must be a lowercase slug`);
  }
  validateOwner(errors, row.directOwner, `${path}.directOwner`, { direct: true });

  const ir = row.irOwnership;
  if (!isRecord(ir)) {
    errors.push(`${path}.irOwnership must be an object`);
  } else {
    validateOwner(errors, ir.owner, `${path}.irOwnership.owner`, { direct: false });
    if (!OWNERSHIP_STATUSES.has(ir.status)) {
      errors.push(`${path}.irOwnership.status must be one of ${[...OWNERSHIP_STATUSES].join(", ")}`);
    }
    if (typeof ir.complete !== "boolean") {
      errors.push(`${path}.irOwnership.complete must be boolean`);
    }
    if (ir.status === "typed-unsupported" && ir.complete === true) {
      errors.push(`${path} cannot mark typed-unsupported IR ownership complete`);
    }
  }

  validateEvidence(errors, row.evidence, path);

  if (typeof row.retirementReady !== "boolean") {
    errors.push(`${path}.retirementReady must be boolean`);
  } else if (row.retirementReady) {
    if (!isRecord(ir) || ir.complete !== true || ir.status === "typed-unsupported") {
      errors.push(`${path} is retirement-ready without complete executable IR ownership`);
    }
    for (const kind of EVIDENCE_KINDS) {
      const status = row.evidence?.[kind]?.status;
      const accepted = status === "verified" || (kind === "performance" && status === "not-applicable");
      if (!accepted) {
        errors.push(`${path} is retirement-ready without accepted ${kind} evidence`);
      }
    }
  }

  return errors;
}

export function parseLedgerText(text) {
  const startCount = text.split(LEDGER_START).length - 1;
  const endCount = text.split(LEDGER_END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`ledger must contain exactly one start marker and one end marker`);
  }

  const start = text.indexOf(LEDGER_START) + LEDGER_START.length;
  const end = text.indexOf(LEDGER_END);
  if (end <= start) throw new Error("ledger end marker must follow start marker");

  const rows = [];
  const parseErrors = [];
  const lines = text.slice(start, end).split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (line === "" || line === "```jsonl" || line === "```") continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push(`ledger line ${lineIndex + 1}: invalid JSON (${error.message})`);
    }
  }
  if (rows.length === 0) parseErrors.push("ledger must contain at least one row");
  return { rows, parseErrors };
}

export function validateLedgerText(text) {
  let parsed;
  try {
    parsed = parseLedgerText(text);
  } catch (error) {
    return { rows: [], errors: [error.message] };
  }

  const errors = [...parsed.parseErrors];
  const seen = new Map();
  parsed.rows.forEach((row, index) => {
    errors.push(...validateRow(row, index));
    if (isRecord(row) && typeof row.id === "string") {
      const prior = seen.get(row.id);
      if (prior !== undefined) errors.push(`duplicate id ${row.id} in rows ${prior + 1} and ${index + 1}`);
      else seen.set(row.id, index);
    }
  });
  return { rows: parsed.rows, errors };
}

export function checkLedgerFile(path, options = {}) {
  const result = validateLedgerText(readFileSync(path, "utf8"));
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => `- ${error}`).join("\n"));
  }
  const notReady = result.rows.filter((row) => !row.retirementReady);
  if (options.requireReady === true && notReady.length > 0) {
    throw new Error(
      `retirement readiness required, but ${notReady.length}/${result.rows.length} rows are not ready:\n${notReady
        .map((row) => `- ${row.id}`)
        .join("\n")}`,
    );
  }
  return {
    rows: result.rows.length,
    complete: result.rows.filter((row) => row.irOwnership.complete).length,
    retirementReady: result.rows.filter((row) => row.retirementReady).length,
  };
}

function isMainModule() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const unknownOptions = args.filter((arg) => arg.startsWith("--") && arg !== "--require-ready");
  if (unknownOptions.length > 0) {
    console.error(`Unknown option(s): ${unknownOptions.join(", ")}`);
    process.exitCode = 1;
  }
  const path =
    args.find((arg) => !arg.startsWith("--")) ??
    fileURLToPath(new URL("../plan/log/ir-optimization-retirement-ledger.md", import.meta.url));
  try {
    const summary = checkLedgerFile(path, { requireReady: args.includes("--require-ready") });
    console.log(
      `IR optimization retirement ledger: ${summary.rows} rows, ${summary.complete} IR-owned, ${summary.retirementReady} retirement-ready`,
    );
  } catch (error) {
    console.error(`IR optimization retirement ledger check failed:\n${error.message}`);
    process.exitCode = 1;
  }
}
