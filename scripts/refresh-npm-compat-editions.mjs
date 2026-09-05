#!/usr/bin/env node
// Refresh syntax metadata without re-running compiler/performance measurements.
import { readFileSync, writeFileSync } from "node:fs";
import { measurePackageSyntax } from "./lib/npm-compat-editions.mjs";

const measured = new Map();
for (const file of ["../benchmarks/results/npm-compat.json", "../website/public/benchmarks/results/npm-compat.json"]) {
  const url = new URL(file, import.meta.url);
  const report = JSON.parse(readFileSync(url, "utf8"));
  for (const pkg of report.packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!measured.has(key)) measured.set(key, await measurePackageSyntax(pkg));
    pkg.esSyntax = measured.get(key);
    console.log(`${pkg.name}@${pkg.version}: ${pkg.esSyntax.edition ?? "unknown"} (${pkg.esSyntax.files} files)`);
  }
  writeFileSync(url, JSON.stringify(report, null, 2) + "\n");
}
