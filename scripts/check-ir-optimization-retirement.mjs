#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const LEDGER_START = "<!-- ir-optimization-retirement-ledger:start -->";
export const LEDGER_END = "<!-- ir-optimization-retirement-ledger:end -->";
export const SOURCE_INVENTORY_MARKER = "<!-- ir-optimization-source-inventory:v1 -->";
export const SOURCE_INVENTORY_ANCHOR = "source-annotation-v1";

const OWNERSHIP_STATUSES = new Set(["lowering", "pass", "runtime-intent", "typed-unsupported"]);
const EVIDENCE_STATUSES = new Set(["verified", "pending", "not-applicable"]);
const EVIDENCE_KINDS = ["semantic", "outputShape", "performance"];
const OPTIMIZATION_ID = /^IR-OPT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SOURCE_INVENTORY_MARKER_PATTERN = /<!-- ir-optimization-source-inventory:([^\s]+) -->/g;
const SOURCE_INVENTORY_TAG = "irOptimizationOwner";
const REPO_OWNER = /^(?:src|plan\/issues|plan\/log|tests|scripts)\//;
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANONICAL_LEDGER = "plan/log/ir-optimization-retirement-ledger.md";

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

function validateOwner(errors, owner, path, { direct, repoRoot }) {
  if (!isRecord(owner)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (requireNonEmptyString(errors, owner.source, `${path}.source`)) {
    if (!REPO_OWNER.test(owner.source)) {
      errors.push(`${path}.source must be a repository-relative owner path`);
    } else if (!existsSync(resolve(repoRoot, owner.source))) {
      errors.push(`${path}.source does not exist`);
    }
  }
  requireNonEmptyString(errors, owner.symbol, `${path}.symbol`);
  if (direct && owner.anchor !== undefined && owner.anchor !== SOURCE_INVENTORY_ANCHOR) {
    errors.push(`${path}.anchor must be ${SOURCE_INVENTORY_ANCHOR} when present`);
  }
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

function validateRow(row, index, { repoRoot }) {
  const errors = [];
  const path = `row ${index + 1}`;
  if (!isRecord(row)) return [`${path} must be a JSON object`];

  if (requireNonEmptyString(errors, row.id, `${path}.id`) && !OPTIMIZATION_ID.test(row.id)) {
    errors.push(`${path}.id must match IR-OPT-<STABLE-UPPERCASE-ID>`);
  }
  if (requireNonEmptyString(errors, row.family, `${path}.family`) && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.family)) {
    errors.push(`${path}.family must be a lowercase slug`);
  }
  validateOwner(errors, row.directOwner, `${path}.directOwner`, { direct: true, repoRoot });

  const ir = row.irOwnership;
  if (!isRecord(ir)) {
    errors.push(`${path}.irOwnership must be an object`);
  } else {
    validateOwner(errors, ir.owner, `${path}.irOwnership.owner`, { direct: false, repoRoot });
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

export function validateLedgerText(text, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  let parsed;
  try {
    parsed = parseLedgerText(text);
  } catch (error) {
    return { rows: [], errors: [error.message] };
  }

  const errors = [...parsed.parseErrors];
  const seen = new Map();
  parsed.rows.forEach((row, index) => {
    errors.push(...validateRow(row, index, { repoRoot }));
    if (isRecord(row) && typeof row.id === "string") {
      const prior = seen.get(row.id);
      if (prior !== undefined) errors.push(`duplicate id ${row.id} in rows ${prior + 1} and ${index + 1}`);
      else seen.set(row.id, index);
    }
  });
  return { rows: parsed.rows, errors };
}

function repoRelativePath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function sourceFilesUnder(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(path);
    }
  };
  visit(root);
  return files;
}

function sourceAnnotationComment(tag) {
  if (typeof tag.comment === "string") return tag.comment.trim();
  if (Array.isArray(tag.comment)) {
    return tag.comment
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("")
      .trim();
  }
  return "";
}

function topLevelDeclarationSymbol(node) {
  if (!ts.isSourceFile(node.parent)) return "";
  if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isClassDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
    const declaration = node.declarationList.declarations[0];
    if (ts.isIdentifier(declaration.name)) return declaration.name.text;
  }
  return "";
}

/**
 * Read the v1 denominator from annotations attached to real top-level TypeScript
 * declarations. The file identity comes from the source path and the symbol
 * identity comes from the parsed declaration, never from comment text.
 */
export function collectDirectOptimizationAnchors(repoRoot = REPO_ROOT) {
  const anchors = [];
  const errors = [];
  const sourceRoot = resolve(repoRoot, "src/codegen");
  if (!existsSync(sourceRoot)) {
    return { anchors, errors: [`source inventory root ${repoRelativePath(repoRoot, sourceRoot)} does not exist`] };
  }

  for (const path of sourceFilesUnder(sourceRoot)) {
    const source = repoRelativePath(repoRoot, path);
    const sourceText = readFileSync(path, "utf8");
    if (!sourceText.includes(`@${SOURCE_INVENTORY_TAG}`)) continue;
    const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const tags = ts.getJSDocTags(node).filter((tag) => tag.tagName.text === SOURCE_INVENTORY_TAG);
      for (const tag of tags) {
        const id = sourceAnnotationComment(tag);
        const symbol = topLevelDeclarationSymbol(node);
        const line = sourceFile.getLineAndCharacterOfPosition(tag.getStart(sourceFile)).line + 1;
        const location = `${source}:${line}`;
        if (!OPTIMIZATION_ID.test(id)) {
          errors.push(`${location} @${SOURCE_INVENTORY_TAG} must name exactly one IR-OPT-<STABLE-UPPERCASE-ID>`);
          continue;
        }
        if (!symbol) {
          errors.push(`${location} @${SOURCE_INVENTORY_TAG} must annotate a named top-level declaration`);
          continue;
        }
        anchors.push({ id, source, symbol, line });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  anchors.sort(
    (a, b) => a.source.localeCompare(b.source) || a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id),
  );
  return { anchors, errors };
}

function sourceInventoryMarkers(text) {
  return [...text.matchAll(SOURCE_INVENTORY_MARKER_PATTERN)].map((match) => match[1]);
}

export function validateSourceInventory(text, rows, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const required = options.required === true;
  const errors = [];
  const markers = sourceInventoryMarkers(text);
  const annotatedRows = rows.filter((row) => row?.directOwner?.anchor === SOURCE_INVENTORY_ANCHOR);
  const shouldInspect = required || markers.length > 0 || annotatedRows.length > 0;
  if (!shouldInspect) return { anchors: [], errors, version: null };

  if (markers.length !== 1 || markers[0] !== "v1") {
    errors.push(
      markers.length === 0
        ? `source inventory requires exactly one ${SOURCE_INVENTORY_MARKER} marker`
        : `source inventory marker must appear exactly once with version v1`,
    );
  }

  const result = collectDirectOptimizationAnchors(repoRoot);
  errors.push(...result.errors);
  if (result.anchors.length === 0) {
    errors.push("source inventory v1 denominator must contain at least one annotated direct-codegen owner");
  }

  const anchorsById = new Map();
  const anchorsByIdentity = new Map();
  for (const anchor of result.anchors) {
    const priorId = anchorsById.get(anchor.id);
    if (priorId) {
      errors.push(
        `duplicate source inventory id ${anchor.id}: ${priorId.source}::${priorId.symbol} and ${anchor.source}::${anchor.symbol}`,
      );
    } else {
      anchorsById.set(anchor.id, anchor);
    }
    const identity = `${anchor.source}::${anchor.symbol}`;
    const priorIdentity = anchorsByIdentity.get(identity);
    if (priorIdentity) {
      errors.push(`duplicate source inventory identity ${identity}: ${priorIdentity.id} and ${anchor.id}`);
    } else {
      anchorsByIdentity.set(identity, anchor);
    }
  }

  const rowsById = new Map(rows.filter((row) => typeof row?.id === "string").map((row) => [row.id, row]));
  for (const anchor of result.anchors) {
    const row = rowsById.get(anchor.id);
    const identity = `${anchor.source}::${anchor.symbol}`;
    if (!row) {
      errors.push(`source inventory owner ${identity} references ${anchor.id}, which is omitted from the ledger`);
      continue;
    }
    if (row.directOwner?.anchor !== SOURCE_INVENTORY_ANCHOR) {
      errors.push(
        `${anchor.id} source inventory owner ${identity} is not declared with directOwner.anchor=${SOURCE_INVENTORY_ANCHOR}`,
      );
    }
    const ledgerIdentity = `${row.directOwner?.source ?? "<missing>"}::${row.directOwner?.symbol ?? "<missing>"}`;
    if (ledgerIdentity !== identity) {
      errors.push(`${anchor.id} source identity mismatch: annotation is ${identity}, ledger is ${ledgerIdentity}`);
    }
  }

  for (const row of annotatedRows) {
    const anchor = anchorsById.get(row.id);
    const ledgerIdentity = `${row.directOwner?.source ?? "<missing>"}::${row.directOwner?.symbol ?? "<missing>"}`;
    if (!anchor) {
      errors.push(`${row.id} ledger owner ${ledgerIdentity} has a dangling ${SOURCE_INVENTORY_ANCHOR} claim`);
    }
  }

  return { anchors: result.anchors, errors, version: markers.length === 1 && markers[0] === "v1" ? "v1" : null };
}

export function checkLedgerFile(path, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const text = readFileSync(path, "utf8");
  const result = validateLedgerText(text, { repoRoot });
  const canonicalPath = resolve(repoRoot, CANONICAL_LEDGER);
  const sourceInventory = validateSourceInventory(text, result.rows, {
    repoRoot,
    required: options.requireSourceInventory === true || resolve(path) === canonicalPath,
  });
  const errors = [...result.errors, ...sourceInventory.errors];
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `- ${error}`).join("\n"));
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
    sourceAnchors: sourceInventory.anchors.length,
    sourceInventoryVersion: sourceInventory.version,
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
      `IR optimization retirement ledger: ${summary.rows} rows, ${summary.complete} IR-owned, ${summary.retirementReady} retirement-ready, ${summary.sourceAnchors} source-anchored`,
    );
  } catch (error) {
    console.error(`IR optimization retirement ledger check failed:\n${error.message}`);
    process.exitCode = 1;
  }
}
