// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Synthetic only: no js2 compiler, historical fixture, pool, or provider executes.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLocalAdmission,
  treeSnapshot,
  requestPlan,
  runControlledSequence,
  auditControlledHistoryTrace,
  selectTrialTraces,
  SEED,
} from "./issue-5807-controlled-history.mjs";
import { TARGET } from "./issue-5807-observation-trace.mjs";

const runtime = { node: "v25.9.0", platform: "darwin", arch: "arm64" };
const env = {
  REPLAY_OBSERVATION_TRACE: "1",
  COMPILER_POOL_SIZE: "1",
  TEST262_WORKER_MAX_OLD_SPACE_SIZE: "1024",
  TEST262_ORACLE_MODE: "honest",
  TEST262_SEMANTIC_PROVIDERS: "auto",
  TEST262_REALM_CANARY: "recycle",
  TEST262_TARGET: "gc",
  TEST262_TZ: "UTC",
  JS2WASM_TEMPORAL_CACHE: ".test262-cache/temporal",
};
const fixtures = {
  seed: { path: SEED, primary: "synthetic-seed", strict: "synthetic-seed-strict", options: { temporal: true } },
  target: {
    path: TARGET,
    primary: "synthetic-target",
    strict: "synthetic-target-strict",
    options: { temporal: false },
  },
};
test("local admission positive control", () => {
  for (const mode of ["alone", "seeded"]) assertLocalAdmission(mode, runtime, env);
});
for (const [key, value] of [
  ["node", "v22.23.2"],
  ["platform", "linux"],
  ["arch", "x64"],
])
  test(`reject runtime drift ${key}`, () => {
    assert.throws(() => assertLocalAdmission("alone", { ...runtime, [key]: value }, env), /explicit local/);
  });
test("reject unknown mode", () => assert.throws(() => assertLocalAdmission("both", runtime, env), /alone\|seeded/));
for (const key of Object.keys(env))
  test(`reject missing admission ${key}`, () => {
    const changed = { ...env };
    delete changed[key];
    assert.throws(() => assertLocalAdmission("seeded", runtime, changed));
  });
for (const [key, value] of [
  ["NODE_OPTIONS", "--import other.mjs"],
  ["NODE_PATH", "/other"],
  ["GIT_DIR", "/other"],
  ["TEST262_FULL_RUNTIME_EVAL", "1"],
  ["JS2WASM_TEST262_TEMPORAL", "0"],
])
  test(`reject unsafe override ${key}`, () => {
    assert.throws(() => assertLocalAdmission("alone", runtime, { ...env, [key]: value }));
  });
test("plan has only fixed original paths and at most four variants", () => {
  assert.equal(requestPlan("alone", fixtures).length, 1);
  assert.equal(requestPlan("seeded", fixtures).length, 2);
  assert.deepEqual(
    requestPlan("seeded", fixtures).flatMap((f) => f.variants.map((v) => v.label)),
    [SEED, SEED + " [strict rerun]", TARGET, TARGET + " [strict rerun]"],
  );
});
test("plan rejects missing strict variant", () => {
  assert.throws(() => requestPlan("alone", { ...fixtures, target: { ...fixtures.target, strict: undefined } }));
});
test("plan rejects changed fixture path", () => {
  assert.throws(() => requestPlan("alone", { ...fixtures, target: { ...fixtures.target, path: "test/other.js" } }));
});

async function sequence(mode, statuses) {
  const calls = [],
    records = [],
    checkpoints = [];
  let active = false;
  const result = await runControlledSequence(
    requestPlan(mode, fixtures),
    {
      async runTest(source, options, timeout) {
        assert.equal(active, false, "overlapping synthetic calls");
        active = true;
        await Promise.resolve();
        active = false;
        calls.push({ source, options, timeout });
        return statuses.shift();
      },
    },
    (r) => records.push(r),
    async (r) => checkpoints.push(r.length),
  );
  return { result, calls, records, checkpoints };
}
test("alone is primary plus conditional strict, serial 30s calls", async () => {
  const r = await sequence("alone", [{ status: "pass" }, { status: "pass" }]);
  assert.equal(r.result.expectedVariantCount, 2);
  assert.deepEqual(r.checkpoints, [1, 2]);
  assert.ok(r.calls.every((c) => c.timeout === 30_000));
  assert.deepEqual(
    r.calls.map((c) => c.source),
    [fixtures.target.primary, fixtures.target.strict],
  );
});
test("seeded is at most four requests, unchanged source strings", async () => {
  const r = await sequence(
    "seeded",
    Array.from({ length: 4 }, () => ({ status: "pass" })),
  );
  assert.equal(r.result.expectedVariantCount, 4);
  assert.deepEqual(
    r.calls.map((c) => c.source),
    [fixtures.seed.primary, fixtures.seed.strict, fixtures.target.primary, fixtures.target.strict],
  );
});
test("target primary failure does not manufacture strict or retry", async () => {
  const r = await sequence("alone", [{ status: "fail", error: "opaque" }]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.result.expectedVariantCount, 1);
});
test("seed primary failure stops before strict and target, preserves raw", async () => {
  let calls = 0;
  const rows = [];
  await assert.rejects(
    runControlledSequence(
      requestPlan("seeded", fixtures),
      {
        async runTest() {
          calls++;
          return { status: "fail", error: "seed" };
        },
      },
      (r) => rows.push(r),
      () => {},
    ),
    /seed failed/,
  );
  assert.equal(calls, 1);
  assert.equal(rows[0].raw.error, "seed");
});
test("seed strict failure stops before target", async () => {
  let calls = 0;
  await assert.rejects(
    runControlledSequence(
      requestPlan("seeded", fixtures),
      {
        async runTest() {
          return { status: ++calls === 1 ? "pass" : "fail" };
        },
      },
      () => {},
      () => {},
    ),
    /seed failed/,
  );
  assert.equal(calls, 2);
});
test("recycle fails immediately, without own retry", async () => {
  await assert.rejects(sequence("alone", [{ status: "pass", recycle: true }]), /recycling/);
});
test("checkpoint rejection prevents next dispatch", async () => {
  let calls = 0;
  await assert.rejects(
    runControlledSequence(
      requestPlan("seeded", fixtures),
      {
        async runTest() {
          calls++;
          return { status: "pass" };
        },
      },
      () => {},
      () => {
        throw Error("replacement");
      },
    ),
    /replacement/,
  );
  assert.equal(calls, 1);
});
for (const status of ["skip", "compiled", "compile_timeout", "unknown"])
  test(`invalid result ${status} cannot admit history`, async () => {
    await assert.rejects(sequence("alone", [{ status }]));
  });

function trace(mode = "seeded", targetStatus = "pass") {
  const streams = [[], []],
    results = [];
  let previous = null;
  const add = (i, event, data = {}, request = null) => {
    const r = {
      schema: "issue-5807-observation-v1",
      boot: i ? "worker" : "parent",
      pid: i ? 12 : 11,
      seq: streams[i].length + 1,
      lost: 0,
      event,
      data,
      request,
      precedingLinked: previous,
    };
    streams[i].push(r);
    return r;
  };
  add(0, "observer-boot");
  add(1, "observer-boot");
  add(0, "pool-worker", { generation: "parent:1", workerPid: 12, initial: true });
  add(1, "worker-ready");
  for (const fixture of requestPlan(mode, fixtures))
    for (const [i, variant] of fixture.variants.entries()) {
      const id = results.length,
        status = fixture.role === "seed" ? "pass" : targetStatus;
      const request = { id, generation: "parent:1", poolPid: 11, path: variant.label };
      add(0, "dispatch", { generation: "parent:1", workerPid: 12, id, path: variant.label });
      add(1, "request-begin", { metadataAvailable: true, temporalRequested: fixture.role === "seed" }, request);
      add(1, "instantiate", { linkedModules: fixture.role === "seed" ? 1 : 0 }, request);
      if (fixture.role === "seed") previous = request;
      else
        for (const event of [
          "construct-enter",
          "decoder-registry",
          "decoder-selected",
          "construct-mirror",
          ...(status === "fail" ? ["construct-refusal"] : []),
        ])
          add(1, event, {}, request);
      add(1, "request-end", { status, recycle: false }, request);
      results.push({ role: fixture.role, variant: i ? "strict" : "primary", label: variant.label, raw: { status } });
      if (status !== "pass") break;
    }
  return { streams, results };
}
function remove(streams, event) {
  for (const s of streams) {
    const i = s.findIndex((r) => r.event === event);
    if (i >= 0) {
      s.splice(i, 1);
      s.forEach((r, n) => {
        r.seq = n + 1;
      });
      return;
    }
  }
  assert.fail("mutation did not reach intended event");
}
for (const mode of ["alone", "seeded"])
  for (const status of ["pass", "fail"])
    test(`controlled audit positive ${mode}/${status}`, () => {
      const { streams, results } = trace(mode, status);
      const r = auditControlledHistoryTrace(streams, mode, results);
      assert.equal(r.requests, results.length);
      assert.equal(r.regressionCleared, false);
    });
test("separate controlled audit accepts two-request trial, not a 939 assertion", () => {
  const { streams, results } = trace("alone");
  assert.equal(auditControlledHistoryTrace(streams, "alone", results).requests, 2);
});
for (const [name, mutate, pattern] of [
  [
    "empty streams",
    (x) => {
      x.streams.length = 0;
    },
    /missing worker/,
  ],
  [
    "empty results",
    (x) => {
      x.results.length = 0;
    },
    /silent-empty/,
  ],
  [
    "lost record",
    (x) => {
      x.streams[1][2].lost = 1;
    },
    /trace loss/,
  ],
  [
    "sequence gap",
    (x) => {
      x.streams[1][2].seq++;
    },
    /trace gap/,
  ],
  ["missing ready", (x) => remove(x.streams, "worker-ready"), /missing\/replaced/],
  ["missing begin", (x) => remove(x.streams, "request-begin"), /request begin/],
  ["missing end", (x) => remove(x.streams, "request-end"), /request end/],
  ["missing linked", (x) => remove(x.streams, "instantiate"), /instantiation/],
  [
    "seed not linked",
    (x) => {
      x.streams[1].find((r) => r.event === "instantiate").data.linkedModules = 0;
    },
    /actual linkage/,
  ],
  [
    "wrong worker PID",
    (x) => {
      x.streams[0].find((r) => r.event === "dispatch").data.workerPid = 13;
    },
    /worker PID mismatch/,
  ],
  [
    "wrong raw status",
    (x) => {
      x.results.at(-1).raw.status = "fail";
    },
    /status mismatch/,
  ],
  [
    "wrong previous linked",
    (x) => {
      x.streams[1].find((r) => r.event === "request-begin" && r.request.path === TARGET).precedingLinked = null;
    },
    /preceding linked seed/,
  ],
  ["missing registry", (x) => remove(x.streams, "decoder-registry"), /registry observation/],
  ["missing decoder", (x) => remove(x.streams, "decoder-selected"), /decoder observation/],
  ["missing mirror", (x) => remove(x.streams, "construct-mirror"), /mirror observation/],
])
  test(`controlled negative ${name}`, () => {
    const x = trace();
    mutate(x);
    assert.throws(() => auditControlledHistoryTrace(x.streams, "seeded", x.results), pattern);
  });
test("replacement and original-pool retry cannot masquerade as same history", () => {
  const x = trace();
  const s = x.streams[0];
  s.push({ ...s[1], seq: s.length + 1, data: { ...s[1].data, workerPid: 13, generation: "parent:2", initial: false } });
  assert.throws(() => auditControlledHistoryTrace(x.streams, "seeded", x.results), /worker replacement/);
});
test("pool interruption rejects even if result payload says pass", () => {
  const x = trace();
  const s = x.streams[0];
  s.push({ ...s[1], seq: s.length + 1, event: "pool-timeout" });
  assert.throws(() => auditControlledHistoryTrace(x.streams, "seeded", x.results), /interruption/);
});
test("partial seed prefix allowed only explicitly; final missing target fails", () => {
  const x = trace();
  x.results.length = 2;
  x.streams[0] = x.streams[0].filter((r) => r.event !== "dispatch" || r.data.id < 2);
  x.streams[1] = x.streams[1].filter((r) => !r.request || r.request.id < 2);
  for (const s of x.streams)
    s.forEach((r, i) => {
      r.seq = i + 1;
    });
  assert.equal(
    auditControlledHistoryTrace(x.streams, "seeded", x.results, { partial: true }).status,
    "EXACT_COMPLETED_PREFIX",
  );
  assert.throws(() => auditControlledHistoryTrace(x.streams, "seeded", x.results), /missing required fixture/);
});
test("dependency snapshot preserves internal links and detects content drift", () => {
  const root = mkdtempSync(join(tmpdir(), "js2-5807-history-synthetic-"));
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "index.js"), "synthetic");
  symlinkSync("pkg/index.js", join(root, "alias.js"));
  const a = treeSnapshot(root);
  assert.equal(a.entries.find((e) => e.type === "link").target, "pkg/index.js");
  writeFileSync(join(root, "pkg", "index.js"), "synthetic changed");
  assert.notEqual(treeSnapshot(root).sha256, a.sha256);
  // Tiny synthetic receipts remain in this unique scratch directory; no cleanup
  // touches an existing root, dependency tree, or protected historical evidence.
});
test("dependency snapshot rejects escaping links", () => {
  const root = mkdtempSync(join(tmpdir(), "js2-5807-history-synthetic-"));
  writeFileSync(join(root, "file"), "synthetic");
  symlinkSync("../", join(root, "escape"));
  assert.throws(() => treeSnapshot(root), /escaping tree link/);
});
test("dependency snapshot rejects silent empty", () => {
  const root = mkdtempSync(join(tmpdir(), "js2-5807-history-synthetic-"));
  assert.throws(() => treeSnapshot(root), /empty snapshot/);
});
test("second trial excludes exact preserved traces without deleting them", () => {
  const old = [{ path: "11-aaa.jsonl", sha256: "old" }],
    fresh = { path: "12-bbb.jsonl", sha256: "new" };
  assert.deepEqual(selectTrialTraces([...old, fresh], old), [fresh]);
  assert.equal(old.length, 1);
});
test("prior trace drift invalidates subsequent trial", () => {
  assert.throws(
    () => selectTrialTraces([{ path: "old", sha256: "changed" }], [{ path: "old", sha256: "original" }]),
    /preserved trace missing\/drifted/,
  );
});
test("missing prior trace invalidates subsequent trial", () => {
  assert.throws(() => selectTrialTraces([], [{ path: "old", sha256: "original" }]), /preserved trace missing\/drifted/);
});
