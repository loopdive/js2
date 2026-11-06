#!/usr/bin/env node
// Keep publishing consumers supplied with the retired lane's last measured
// baseline. Copy bytes verbatim: never stamp the current SHA, rebuild a report,
// heal rows, or represent this snapshot as a measurement of the active run.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function preserveFrozenHostBaseline(source, destination) {
  const reportPath = join(source, "test262-current.json");
  const rowsPath = join(source, "test262-current.jsonl");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const rows = readFileSync(rowsPath, "utf8");
  if (!(report.summary?.pass >= 1000 && report.summary?.total >= 40000)) {
    throw new Error("Frozen JS-host report is missing or corrupt; refusing to publish it");
  }
  if (rows.trim().split("\n").length < 40000) {
    throw new Error("Frozen JS-host JSONL is truncated; refusing to publish it");
  }
  mkdirSync(destination, { recursive: true });
  copyFileSync(reportPath, join(destination, "test262-report-merged.json"));
  copyFileSync(rowsPath, join(destination, "test262-results-merged.jsonl"));
  console.log(
    `Preserved frozen JS-host snapshot: ${report.summary.pass}/${report.summary.total}; source SHA=${report.baseline_sha ?? "unknown"}; generated=${report.baseline_generated_at ?? "unknown"}. JS-host was not measured in this run.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3])
    throw new Error("Usage: preserve-frozen-host-baseline.mjs <baseline-dir> <output-dir>");
  preserveFrozenHostBaseline(process.argv[2], process.argv[3]);
}
