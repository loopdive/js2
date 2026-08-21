// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4412) Decide whether a finished test262 run may append to
 * `benchmarks/results/runs/index.json`.
 *
 * That file is COMMITTED and drives the report page's conformance trend graph,
 * so only a FULL-CORPUS run belongs in it. The append used to be
 * unconditional-on-completion, with no notion of a scoped run: with
 * `TEST262_PATH_FILTER` or a narrowed `TEST262_LOCAL_SHARD_GLOB`, a partial
 * run posted a partial total as if it were a full pass. Measured 2026-08-14, a
 * single-shard local run wrote `pass: 1902 / total: 2713` next to real
 * ~30,000-test entries, and a 32-invocation sharded experiment would have
 * written 32 such rows. Nothing in CI catches this — the row is well-formed,
 * just wrong — so the guard has to live at the write site.
 *
 * Lives in its own file rather than inline in `run-test262-vitest.sh` so the
 * decision is unit-testable; a guard nobody can test is a guard that rots.
 *
 * Exit code is the answer: 0 = publish, 1 = skip. The reason goes to stdout.
 *
 * Usage (from the runner):
 *   node scripts/should-publish-run-history.mjs
 */

import { pathToFileURL } from "node:url";

/** The unnarrowed default in `run-test262-vitest.sh`. */
export const FULL_SHARD_GLOB = "tests/test262-local-shard*.test.ts";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ publish: boolean; reason: string }}
 */
export function shouldPublishRunHistory(env) {
  const explicit = env.TEST262_PUBLISH_HISTORY;
  // An explicit 0 wins over everything: "do not record this run".
  if (explicit === "0") return { publish: false, reason: "TEST262_PUBLISH_HISTORY=0" };

  const filter = (env.TEST262_PATH_FILTER ?? "").trim();
  // A file-fed exact-path filter scopes the run exactly like the env-var
  // filter does (it exists because ~9k paths do not fit in an env var — see
  // matchesPathFilter in tests/test262-runner.ts). Without this arm, the
  // first ES5-subset run appended `8616/9029` beside the ~43k full-corpus
  // rows — precisely the #4412 failure mode this script exists to refuse.
  const filterFile = (env.TEST262_PATH_FILTER_FILE ?? "").trim();
  const glob = (env.TEST262_LOCAL_SHARD_GLOB ?? "").trim();
  let scope = "";
  if (filter) scope = `TEST262_PATH_FILTER=${filter}`;
  else if (filterFile) scope = `TEST262_PATH_FILTER_FILE=${filterFile}`;
  else if (glob && glob !== FULL_SHARD_GLOB) scope = `TEST262_LOCAL_SHARD_GLOB=${glob}`;

  // An explicit 1 forces the append even for a deliberately scoped run, but
  // still says so, because the resulting row will not be comparable.
  if (explicit === "1") {
    return {
      publish: true,
      reason: scope ? `TEST262_PUBLISH_HISTORY=1 overrides scope (${scope})` : "full-corpus run",
    };
  }
  if (scope) return { publish: false, reason: `scoped run (${scope})` };
  return { publish: true, reason: "full-corpus run" };
}

// Only act as a CLI when invoked directly, so the test can import it freely.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { publish, reason } = shouldPublishRunHistory(process.env);
  console.log(reason);
  process.exit(publish ? 0 : 1);
}
