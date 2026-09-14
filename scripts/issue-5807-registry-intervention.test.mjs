// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Synthetic trace audit only. No compiler, provider, or historical fixture runs.
import assert from "node:assert/strict";
import test from "node:test";
import { auditRegistryInterventionTrace, EXPECTED_ERROR } from "./issue-5807-registry-intervention.mjs";
import { TARGET } from "./issue-5807-observation-trace.mjs";
import { SEED } from "./issue-5807-controlled-history.mjs";

function sample(arm = "reset", targetStatus = "pass") {
  const streams = [[], []],
    results = [];
  let precedingLinked = null;
  function add(i, event, data = {}, request = null) {
    const r = {
      schema: "issue-5807-observation-v1",
      pid: i ? 12 : 11,
      boot: i ? "worker" : "controller",
      seq: streams[i].length + 1,
      lost: 0,
      event,
      data,
      request,
      precedingLinked,
    };
    streams[i].push(r);
    return r;
  }
  add(0, "observer-boot");
  add(1, "observer-boot");
  add(0, "pool-worker", { generation: "controller:1", workerPid: 12, initial: true });
  add(1, "worker-ready");
  for (const role of ["seed", "target"])
    for (const variant of ["primary", "strict"]) {
      const path = role === "seed" ? SEED : TARGET;
      const label = path + (variant === "strict" ? " [strict rerun]" : "");
      const request = { id: results.length, generation: "controller:1", poolPid: 11, path: label };
      const status = role === "seed" ? "pass" : targetStatus;
      add(0, "dispatch", { generation: request.generation, workerPid: 12, id: request.id, path: label });
      add(1, "request-begin", { metadataAvailable: true, temporalRequested: role === "seed" }, request);
      if (role === "target" && arm !== "original") {
        add(1, "intervention-before", { arm, linkedModules: 0 }, request);
        if (arm === "reset")
          add(
            1,
            "registry-reset",
            { retained: variant === "primary" ? { 0: "worker:3", 1: "worker:4" } : {} },
            request,
          );
        add(1, "intervention-after", { arm, linkedModules: 0 }, request);
      }
      add(1, "instantiate", { linkedModules: role === "seed" ? 1 : 0 }, request);
      if (role === "seed") {
        precedingLinked = request;
        add(1, "registry-reset", { retained: {} }, request);
        const ids = variant === "primary" ? ["worker:1", "worker:2"] : ["worker:3", "worker:4"];
        for (const exports of ids) add(1, "registry-register", { exports }, request);
      } else {
        add(1, "construct-enter", { arg: "worker:5", local: "worker:6" }, request);
        add(
          1,
          "decoder-registry",
          {
            arg: "worker:5",
            local: "worker:6",
            enabled: arm !== "reset",
            retained: arm === "reset" ? {} : { 0: "worker:3", 1: "worker:4" },
          },
          request,
        );
        add(
          1,
          "decoder-selected",
          { arg: "worker:5", local: "worker:6", selected: arm === "reset" ? null : "worker:3" },
          request,
        );
        add(
          1,
          "construct-mirror",
          {
            arg: "worker:5",
            distinct: true,
            length: {
              availability: "existing-read",
              type: status === "pass" ? "number" : "undefined",
              value: status === "pass" ? 3 : null,
            },
          },
          request,
        );
        if (status === "fail") add(1, "construct-refusal", { name: "BigInt64Array" }, request);
      }
      add(1, "request-end", { status, recycle: false }, request);
      results.push({ role, variant, label, raw: { status, ...(status === "fail" ? { error: EXPECTED_ERROR } : {}) } });
      if (status !== "pass") break;
    }
  add(0, "observer-exit", { code: 0 });
  return { streams, results, workerTerminals: [{ pid: 12, code: null, signal: "SIGTERM" }] };
}
function audit(x, arm = "reset", options = {}) {
  return auditRegistryInterventionTrace(x.streams, arm, x.results, {
    requireExit: true,
    workerTerminals: x.workerTerminals,
    ...options,
  });
}
const target = (r) => r.request?.path === TARGET;
const event = (x, name, predicate = () => true) => {
  const r = x.streams.flat().find((r) => r.event === name && predicate(r));
  assert.ok(r, "negative mutation failed to find intended event: " + name);
  return r;
};
function renumber(x) {
  for (const s of x.streams)
    s.forEach((r, i) => {
      r.seq = i + 1;
    });
}
function remove(x, name, predicate = () => true) {
  const r = event(x, name, predicate),
    s = x.streams.find((s) => s.includes(r));
  s.splice(s.indexOf(r), 1);
  renumber(x);
}
function insert(x, anchorName, name, data, predicate = target) {
  const r = event(x, anchorName, predicate),
    s = x.streams.find((s) => s.includes(r));
  s.splice(s.indexOf(r), 0, { ...r, event: name, data });
  renumber(x);
}

for (const arm of ["original", "sham"])
  test(`${arm}: exact primary opaque failure, three requests, no target reset`, () => {
    const x = sample(arm, "fail"),
      result = audit(x, arm);
    assert.equal(result.requests, 3);
    assert.equal(result.regressionCleared, false);
    assert.equal(x.streams[1].filter((r) => target(r) && r.event === "registry-reset").length, 0);
  });
for (const status of ["pass", "fail"])
  test(`reset admits observed ${status} without forcing improvement`, () => {
    const result = audit(sample("reset", status));
    assert.equal(result.requests, status === "pass" ? 4 : 3);
    assert.equal(result.regressionCleared, false);
  });
test("original has no intervention events at all", () => {
  const x = sample("original", "fail");
  assert.ok(!x.streams.flat().some((r) => r.event.startsWith("intervention-")));
  audit(x, "original");
});
test("worker terminal uses actual original SIGTERM, without invented exit event", () => {
  const x = sample();
  assert.equal(x.streams[1].at(-1).event, "request-end");
  assert.match(audit(x).tailLimit, /SIGTERM/);
});

for (const [name, mutate, pattern] of [
  [
    "no streams",
    (x) => {
      x.streams.length = 0;
    },
    /worker trace/,
  ],
  [
    "empty results",
    (x) => {
      x.results.length = 0;
    },
    /silent-empty/,
  ],
  [
    "too many results",
    (x) => {
      x.results.push(x.results[0]);
    },
    /too many/,
  ],
  [
    "extra trace stream",
    (x) => {
      x.streams.push([]);
    },
    /extra worker trace/,
  ],
  [
    "empty stream",
    (x) => {
      x.streams[1].length = 0;
    },
    /empty trace/,
  ],
  [
    "missing boot",
    (x) => {
      x.streams[1][0].event = "other";
    },
    /observer boot/,
  ],
  [
    "trace loss",
    (x) => {
      event(x, "construct-mirror").lost = 1;
    },
    /trace loss/,
  ],
  [
    "sequence gap",
    (x) => {
      event(x, "construct-mirror").seq++;
    },
    /trace gap/,
  ],
  ["missing ready", (x) => remove(x, "worker-ready"), /missing\/replaced/],
  ["missing dispatch", (x) => remove(x, "dispatch", (r) => r.data.path === TARGET), /dispatch population/],
  ["missing begin", (x) => remove(x, "request-begin", target), /request begin/],
  ["missing end", (x) => remove(x, "request-end", target), /request end/],
  ["missing instantiate", (x) => remove(x, "instantiate", target), /instantiation/],
  [
    "seed not linked",
    (x) => {
      event(x, "instantiate").data.linkedModules = 0;
    },
    /actual linkage/,
  ],
  [
    "target linked",
    (x) => {
      event(x, "instantiate", target).data.linkedModules = 1;
    },
    /actual linkage/,
  ],
  [
    "seed missing natural reset",
    (x) => remove(x, "registry-reset", (r) => r.request.path === SEED),
    /seed natural reset/,
  ],
  [
    "seed intervention",
    (x) =>
      insert(
        x,
        "instantiate",
        "intervention-before",
        { arm: "reset", linkedModules: 1 },
        (r) => r.request.path === SEED,
      ),
    /seed intervention/,
  ],
  ["missing hook before", (x) => remove(x, "intervention-before", target), /intervention before/],
  ["missing hook after", (x) => remove(x, "intervention-after", target), /intervention after/],
  [
    "wrong hook arm",
    (x) => {
      event(x, "intervention-before", target).data.arm = "sham";
    },
    /arm\/linkage/,
  ],
  [
    "wrong hook linkage",
    (x) => {
      event(x, "intervention-before", target).data.linkedModules = 1;
    },
    /arm\/linkage/,
  ],
  ["missing reset", (x) => remove(x, "registry-reset", target), /target reset count/],
  ["extra reset", (x) => insert(x, "intervention-after", "registry-reset", {}, target), /target reset count/],
  [
    "reset before hook",
    (x) => {
      const a = event(x, "registry-reset", target),
        b = event(x, "intervention-before", target);
      const s = x.streams[1],
        i = s.indexOf(a),
        j = s.indexOf(b);
      [s[i], s[j]] = [s[j], s[i]];
      renumber(x);
    },
    /reset outside/,
  ],
  [
    "wrong predecessor",
    (x) => {
      event(x, "request-begin", target).precedingLinked = null;
    },
    /preceding linked seed/,
  ],
  [
    "wrong request metadata",
    (x) => {
      const r = event(x, "construct-enter", target);
      r.request = { ...r.request, path: SEED };
    },
    /request metadata/,
  ],
  ["missing constructor", (x) => remove(x, "construct-enter", target), /constructor observation/],
  ["missing registry", (x) => remove(x, "decoder-registry", target), /registry observation/],
  ["missing decoder", (x) => remove(x, "decoder-selected", target), /decoder observation/],
  ["missing mirror", (x) => remove(x, "construct-mirror", target), /mirror observation/],
  [
    "wrong raw status",
    (x) => {
      x.results.at(-1).raw.status = "fail";
    },
    /status mismatch/,
  ],
  [
    "raw recycle",
    (x) => {
      x.results[0].raw.recycle = true;
    },
    /result recycle/,
  ],
  [
    "trace recycle",
    (x) => {
      event(x, "request-end").data.recycle = true;
    },
    /trace recycle/,
  ],
  [
    "worker replacement",
    (x) => {
      const r = event(x, "pool-worker");
      x.streams[0].splice(2, 0, { ...r });
      renumber(x);
    },
    /worker replacement/,
  ],
  ["pool timeout", (x) => insert(x, "request-begin", "pool-timeout", {}, target), /interruption/],
  [
    "unknown intervention event",
    (x) => insert(x, "intervention-after", "intervention-unknown", {}, target),
    /unknown intervention event/,
  ],
  [
    "missing worker terminal",
    (x) => {
      x.workerTerminals.length = 0;
    },
    /worker terminal/,
  ],
  [
    "unexpected worker kill",
    (x) => {
      x.workerTerminals[0].signal = "SIGKILL";
    },
    /worker terminal/,
  ],
  [
    "wrong terminal pid",
    (x) => {
      x.workerTerminals[0].pid = 99;
    },
    /worker terminal/,
  ],
  ["missing controller exit", (x) => remove(x, "observer-exit"), /controller exit tail/],
  [
    "nonzero controller exit",
    (x) => {
      event(x, "observer-exit").data.code = 2;
    },
    /nonzero controller/,
  ],
])
  test(`reject ${name}`, () => {
    const x = sample();
    mutate(x);
    assert.throws(() => audit(x), pattern);
  });
for (const arm of ["original", "sham"]) {
  test(`${arm} unexpected PASS is not a reproduced control`, () => {
    assert.throws(() => audit(sample(arm, "pass"), arm), /control did not reproduce/);
  });
  test(`${arm} different error is not a reproduced control`, () => {
    const x = sample(arm, "fail");
    x.results.at(-1).raw.error = "other";
    assert.throws(() => audit(x, arm), /control error differs/);
  });
  test(`${arm} target reset rejected`, () => {
    const x = sample(arm, "fail");
    insert(x, "instantiate", "registry-reset", {});
    assert.throws(() => audit(x, arm), /target reset count/);
  });
}
test("original hook events rejected", () => {
  const x = sample("original", "fail");
  insert(x, "instantiate", "intervention-before", { arm: "original", linkedModules: 0 });
  assert.throws(() => audit(x, "original"), /intervention before/);
});
test("failed target must retain constructor refusal evidence", () => {
  const x = sample("reset", "fail");
  remove(x, "construct-refusal");
  assert.throws(() => audit(x), /failure not attributed/);
});
test("partial seed prefix admits only the exact prefix; final missing target rejects", () => {
  const x = sample();
  x.results.length = 2;
  x.streams[0] = x.streams[0].filter((r) => r.event !== "dispatch" || r.data.id < 2);
  x.streams[1] = x.streams[1].filter((r) => !r.request || r.request.id < 2);
  renumber(x);
  assert.equal(audit(x, "reset", { partial: true, requireExit: false }).requests, 2);
  assert.throws(() => audit(x), /missing required fixture/);
});
test("unknown arm rejects before trace admission", () =>
  assert.throws(() => audit(sample(), "other"), /unknown intervention arm/));

test("reset must retire the exact preceding seed identities", () => {
  const x = sample();
  event(x, "registry-reset", target).data.retained = { 0: "unrelated:1", 1: "unrelated:2" };
  assert.throws(() => audit(x), /exact preceding registrations/);
});
test("reset cannot leave the target registry enabled", () => {
  const x = sample();
  event(x, "decoder-registry", target).data.enabled = true;
  assert.throws(() => audit(x), /remains enabled/);
});
test("reset cannot leave retained entries", () => {
  const x = sample();
  event(x, "decoder-registry", target).data.retained = { 0: "worker:3" };
  assert.throws(() => audit(x), /retains entries/);
});
test("reset cannot leave peer decoder selection", () => {
  const x = sample();
  event(x, "decoder-selected", target).data.selected = "worker:3";
  assert.throws(() => audit(x), /selected peer after reset/);
});
test("seed registration evidence cannot be missing", () => {
  const x = sample();
  remove(x, "registry-register");
  assert.throws(() => audit(x), /seed registration population/);
});
test("control must select a decoder actually registered by the seed", () => {
  const x = sample("sham", "fail");
  event(x, "decoder-selected", target).data.selected = "unrelated";
  assert.throws(() => audit(x, "sham"), /did not select retained seed/);
});
