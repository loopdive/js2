// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Attach an ES-edition classification to each npm-compat package row.
//
// This is the layout-aware half of the classifier: `es-edition.mjs` knows how
// to read JavaScript, this file knows where the dogfood harnesses extract each
// pinned tarball. Every package lands at `<dir>/package/<entryFile>` where
// `<dir>` is either `tests/dogfood/.npm-compat/<name>` (catalog packages) or
// `tests/dogfood/.<name>` (packages with a bespoke harness), so both are tried
// and a package whose tarball is not extracted in this run reports
// `unavailable` rather than silently reading as ES5.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { BASELINE_EDITION, classifyPackage, ESNEXT, formatEdition } from "./es-edition.mjs";

const DOGFOOD = "tests/dogfood";

/** Where `<name>`'s pinned tarball may have been extracted, most specific first. */
export function packageRootCandidates(name, repoRoot) {
  return [join(repoRoot, DOGFOOD, ".npm-compat", name, "package"), join(repoRoot, DOGFOOD, `.${name}`, "package")];
}

/**
 * Classify one report row. Returns the classification, or a row carrying
 * `unavailable` with the reason — never throws, because an edition label is
 * metadata on a report whose real subject is compile/test results.
 */
export function classifyPackageRow(pkg, repoRoot, options = {}) {
  const entryFile = pkg?.entryFile;
  if (!entryFile) return { unavailable: "package row carries no entry file" };

  for (const root of packageRootCandidates(pkg.name, repoRoot)) {
    const entryPath = join(root, entryFile);
    if (!existsSync(entryPath)) continue;
    try {
      const classification = classifyPackage(entryPath, root, options);
      if (classification.unavailable) return classification;
      return {
        required: classification.required,
        requiredLabel: formatEdition(classification.required),
        syntax: classification.syntax,
        syntaxLabel: formatEdition(classification.syntax),
        builtins: classification.builtins,
        builtinsLabel: formatEdition(classification.builtins),
        evidence: classification.evidence,
        scannedFiles: classification.scannedFiles,
        externalDependencies: classification.externalDependencies,
        ...(classification.graphTruncated ? { graphTruncated: true } : {}),
        ...(classification.parseErrors.length > 0 ? { parseErrors: classification.parseErrors } : {}),
      };
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) };
    }
  }
  return { unavailable: "package tarball is not extracted in this run" };
}

/**
 * Corpus-level rollup: how many packages each edition accounts for, and which.
 * Ordered oldest edition first so the list reads as a timeline.
 */
export function esEditionRollup(packages) {
  const byEdition = new Map();
  const unclassified = [];
  for (const pkg of packages) {
    const edition = pkg.esEdition?.required;
    if (edition === undefined || edition === null) {
      unclassified.push(pkg.name);
      continue;
    }
    const key = formatEdition(edition);
    if (!byEdition.has(key)) byEdition.set(key, { edition, label: key, packages: [] });
    byEdition.get(key).packages.push(pkg.name);
  }

  const rank = (edition) => (edition === ESNEXT ? Number.MAX_SAFE_INTEGER : Number(edition) || 0);
  const editions = [...byEdition.values()]
    .sort((left, right) => rank(left.edition) - rank(right.edition))
    .map((entry) => ({ ...entry, count: entry.packages.length, packages: entry.packages.sort() }));

  return {
    // What the number means, stated where the number lives: the newest edition
    // any file in the package's own module graph requires — syntax the parser
    // must accept, or library surface the runtime must provide.
    method:
      "Newest ECMAScript edition required by the package's own module graph, from its published entry module. " +
      "Syntax is classified from the grammar; library surface is derived from TypeScript's lib.es<year>.*.d.ts declarations. " +
      "Bare prototype-method reads (`x.flat()`) cannot be attributed without types, so they are reported as evidence but never raise the edition.",
    baseline: formatEdition(BASELINE_EDITION),
    editions,
    unclassified: unclassified.sort(),
  };
}
