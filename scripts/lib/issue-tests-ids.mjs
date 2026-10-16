// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7014) Per-TEST id reduction for scripts/issue-tests-gate.mjs (#3008).
//
// The gate used to run a whole ~390-file shard in ONE vitest fork and read
// vitest's JSON reporter, which writes only when the run ends. Heap grew
// across files until the fork died at its 1 GB limit, the report was never
// written, and the shard was lost — 7 of 12 shards in issue-tests run
// 38797187257. The gate now runs files through known-failures-gate's
// crash-safe runner (#6783), which yields Map<rel, {entry} | {crash}>; this
// module turns that into the gate's per-test id sets.

const isUnexpectedPass = (a) => (a.failureMessages || []).some((m) => /Expect test to fail/i.test(m));
const firstLine = (m) =>
  String(m || "")
    .split("\n")
    .find((l) => l.trim()) || "";

/** The gate's test id: `<repo-relative file> :: <full test name>`. */
export function testId(fileRelPath, fullName) {
  return `${fileRelPath} :: ${fullName}`;
}

/**
 * Reduce runner results for `files` to { failing, passing, unexpectedPasses,
 * messages }.
 *
 * - A file that died even when re-run alone is ONE failing id
 *   `<file> :: <crash>`; a file that reached no result at all is
 *   `<file> :: <not-run>`. Both gate like any other failure, so a runner loss
 *   can never read as green, and neither erases the rest of the shard.
 * - A file that failed with zero assertions (import / syntax / collect error)
 *   is `<file> :: <collect>`, as before.
 * - (#3340) An `it.fails` test whose body unexpectedly PASSES goes to
 *   `unexpectedPasses`, never `failing`, so the baseline cannot absorb it.
 * - `messages` maps each failing id to the first line of its error (≤300
 *   chars), so a shard partial is enough to triage what went red.
 */
export function resultsToIds(files, results) {
  const failing = new Set();
  const passing = new Set();
  const unexpectedPasses = new Set();
  const messages = {};
  const fail = (id, msg) => {
    failing.add(id);
    messages[id] = firstLine(msg).slice(0, 300);
  };
  for (const rel of files) {
    const r = results.get(rel);
    if (!r) {
      fail(testId(rel, "<not-run>"), "file reached no vitest result (runner loss)");
      continue;
    }
    if (r.crash) {
      fail(testId(rel, "<crash>"), r.crash);
      continue;
    }
    const asserts = r.entry.assertionResults || [];
    if (r.entry.status === "failed" && asserts.length === 0) {
      fail(testId(rel, "<collect>"), r.entry.message);
      continue;
    }
    // Hook/suite failures remain red independently of the assertion verdicts.
    if (
      r.entry.status === "failed" &&
      (r.entry.message || r.entry.fileFailureMessages?.length || !asserts.some((a) => a.status === "failed"))
    ) {
      fail(
        testId(rel, "<file>"),
        r.entry.fileFailureMessages?.[0] || r.entry.message || "file failed outside its assertions",
      );
    }
    for (const a of asserts) {
      const id = testId(rel, a.fullName || a.title);
      if (a.status === "failed") {
        if (isUnexpectedPass(a)) unexpectedPasses.add(id);
        else fail(id, (a.failureMessages || [])[0]);
      } else if (a.status === "passed") passing.add(id);
    }
  }
  return { failing, passing, unexpectedPasses, messages };
}
