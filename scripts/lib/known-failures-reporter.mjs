// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6783) Crash-safe vitest reporter for scripts/known-failures-gate.mjs.
//
// vitest's built-in JSON reporter writes ONE file when the run ends. A worker
// that dies of OOM takes the whole run with it — measured on the post-merge
// issue-tests detector (run 36962288398, 2026-10-02): 4 of 12 shards ended
// "Reached heap limit" → ERR_IPC_CHANNEL_CLOSED → "vitest produced no JSON
// report", so every file in those shards, red or green, went unmeasured and
// the merge job never ran.
//
// This reporter appends one JSON line per event to $KNOWN_FAILURES_PROGRESS
// as it happens:
//
//   {"event":"start","file":"<abs path>"}
//   {"event":"end","file":"<abs path>","entry":{...}}
//
// `entry` has the exact shape of one `testResults[]` element of the JSON
// reporter (name / status / message / assertionResults with fullName and
// failureMessages), so scripts/equivalence-gate.mjs `summarizeReport` reads
// it unchanged. After a crash the gate knows which files finished (their
// results are on disk), which were in flight (start without end — re-run them
// alone) and which never started (queue them again).

import { appendFileSync } from "node:fs";

const STATUS = {
  fail: "failed",
  only: "pending",
  pass: "passed",
  run: "pending",
  skip: "skipped",
  todo: "todo",
  queued: "pending",
};

function collectTests(task, out) {
  for (const child of task.tasks || []) {
    if (child.type === "test") out.push(child);
    else collectTests(child, out);
  }
  return out;
}

/** One file task → one JSON-reporter `testResults[]` entry (vitest 3.2 shape). */
function toEntry(file) {
  const assertionResults = collectTests(file, []).map((t) => {
    // Same walk as vitest's JsonReporter, so test ids match a JSON report.
    const ancestors = [];
    for (let s = t.suite; s; s = s.suite) ancestors.unshift(s.name);
    return {
      ancestorTitles: ancestors,
      fullName: t.name ? [...ancestors, t.name].join(" ") : ancestors.join(" "),
      status: STATUS[t.result?.state || t.mode] || "skipped",
      title: t.name,
      duration: t.result?.duration,
      failureMessages: t.result?.errors?.map((e) => e.stack || e.message) || [],
    };
  });
  const hasFailedTests = assertionResults.some((a) => a.status === "failed");
  return {
    name: file.filepath,
    status: file.result?.state === "fail" || hasFailedTests ? "failed" : "passed",
    message: file.result?.errors?.[0]?.message ?? "",
    assertionResults,
  };
}

export default class KnownFailuresReporter {
  constructor() {
    this.out = process.env.KNOWN_FAILURES_PROGRESS || "";
    this.done = 0;
    this.red = 0;
    this.ended = new Set();
  }

  write(record) {
    if (this.out) appendFileSync(this.out, `${JSON.stringify(record)}\n`);
  }

  // A worker picked the file up — before it imports (collects) it, so a file
  // whose import kills the worker is still named as in flight.
  onTestModuleQueued(testModule) {
    this.write({ event: "start", file: testModule.moduleId });
  }

  onTestModuleStart(testModule) {
    this.write({ event: "start", file: testModule.moduleId });
  }

  // A file whose import or collection fails never reaches onTestModuleEnd;
  // it surfaces here, with the error on its task, when the run ends normally.
  onTestRunEnd(testModules) {
    for (const testModule of testModules || []) {
      if (this.ended.has(testModule.moduleId) || !testModule.task?.result?.state) continue;
      this.onTestModuleEnd(testModule);
    }
  }

  onTestModuleEnd(testModule) {
    if (this.ended.has(testModule.moduleId)) return;
    this.ended.add(testModule.moduleId);
    const entry = toEntry(testModule.task);
    this.write({ event: "end", file: testModule.moduleId, entry });
    this.done++;
    if (entry.status === "failed") {
      this.red++;
      const failed = entry.assertionResults.filter((a) => a.status === "failed").length;
      process.stdout.write(`  red: ${entry.name} (${failed ? `${failed} failed` : entry.message || "file-level"})\n`);
    }
    if (this.done % 50 === 0) process.stdout.write(`  … ${this.done} file(s) finished, ${this.red} red\n`);
  }
}
