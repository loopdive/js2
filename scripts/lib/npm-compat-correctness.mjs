// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4127) The npm-compat CORRECTNESS axis.
 *
 * `compile.success` and `validation.validates` answer "did a valid module come
 * out". Neither answers "does it compute the right thing", and a reader sees
 * one row per package and reasonably reads a green one as "works".
 *
 * Four packages (acorn, marked, clsx, cookie) do run a differential workload
 * against a native-node oracle computed at run time, and report `tests`
 * `{ passed, total }`. Every catalogued package does not: its harness hardcodes
 * `diff.runnable = false` with "runtime differential harness not implemented",
 * so it has NO correctness signal at all — and, before this module, nothing on
 * the row said so.
 *
 * That is the gap this closes. A package is put in exactly one of three states,
 * and "we never checked" is never allowed to look like "we checked and it was
 * fine":
 *
 *   verified   — a workload ran against the node oracle and every op matched
 *   divergent  — a workload ran and at least one op did NOT match
 *   unverified — no workload exists; nothing is known about correctness
 *
 * The oracle stays "run it in native node right now" (see the dogfood
 * harnesses). Nothing here reads an expected value from a committed pin — the
 * `shasum`/`integrity` fields are npm-registry hashes of the INPUT tarball, and
 * that must stay true, or a miscompile could be ratified into the repo.
 */

/** @typedef {{ kind: string, status?: string, reason?: string|null, passed: number|null, total: number|null }} TestsField */

/**
 * Derive a package's correctness verdict from the `tests` field the dogfood
 * harnesses produce.
 *
 * @param {TestsField|null|undefined} tests
 * @param {{ compiles?: boolean }} [context]
 * @returns {{ status: "verified"|"divergent"|"unverified", passed?: number, total?: number, reason?: string }}
 */
export function correctnessVerdict(tests, context = {}) {
  if (!tests || typeof tests !== "object") {
    return {
      status: "unverified",
      reason:
        context.compiles === false
          ? "package does not compile, so no workload could run"
          : "no differential workload — compile/validation only; correctness is unknown",
    };
  }
  if (tests.status && tests.status !== "measured") {
    return {
      status: "unverified",
      reason:
        tests.reason ?? `workload '${tests.kind ?? "unknown"}' was ${tests.status}; no compiled result was measured`,
    };
  }
  const { passed, total } = tests;
  if (typeof passed !== "number" || typeof total !== "number") {
    return { status: "unverified", reason: `workload '${tests.kind ?? "unknown"}' reported no pass/total counts` };
  }
  if (total <= 0) {
    return { status: "unverified", reason: `workload '${tests.kind ?? "unknown"}' ran zero operations` };
  }
  // Strictly `passed === total`. A partial pass is DIVERGENT, not "mostly
  // fine": each divergence is a wrong answer, and the whole point of this axis
  // is that a wrong answer must not read as green.
  return passed === total
    ? { status: "verified", passed, total }
    : {
        status: "divergent",
        passed,
        total,
        reason: `${total - passed} of ${total} operations diverged from native node`,
      };
}

/**
 * Roll the per-package verdicts up for the summary block.
 *
 * `unverified` packages are COUNTED AND NAMED rather than folded into the
 * compatible set — a reader must be able to see how much of the corpus carries
 * no correctness evidence at all.
 *
 * @param {Array<{ name: string, correctness?: { status: string } }>} packages
 */
export function correctnessRollup(packages) {
  const names = { verified: [], divergent: [], unverified: [] };
  for (const pkg of packages) {
    const status = pkg.correctness?.status;
    if (status && Object.hasOwn(names, status)) names[status].push(pkg.name);
  }
  for (const list of Object.values(names)) list.sort();
  return {
    definition: {
      verified: "a differential workload ran against native Node and every operation matched",
      divergent: "a differential workload ran and at least one operation did NOT match native Node",
      unverified: "no differential workload exists — compile/validation only; correctness is UNKNOWN, not confirmed",
    },
    oracle: "native Node executing the same pinned package, computed at run time; never read from a committed pin",
    counts: {
      verified: names.verified.length,
      divergent: names.divergent.length,
      unverified: names.unverified.length,
    },
    verified: names.verified,
    divergent: names.divergent,
    unverified: names.unverified,
  };
}
