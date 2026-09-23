// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Synthetic observation/admission tests only; never install into historical roots.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  HEADS,
  ORIGINALS,
  RUNTIME_PATH,
  TARGET,
  sha,
  instrumentSources,
  runtimeSource,
  createObservationRecorder,
  validateObservationArtifacts,
  auditTraceRecords,
  verifyObservationTrace,
} from "./issue-5807-observation-trace.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const originals = Object.fromEntries(
  Object.keys(ORIGINALS).map((path) => [
    path,
    execFileSync("git", ["show", HEADS[0] + ":" + path], { cwd: root, encoding: "utf8", maxBuffer: 3e6 }),
  ]),
);
const outputs = instrumentSources(HEADS[0], originals);
const clone = (value) => structuredClone(value);
const receipt = {
  files: Object.keys(outputs)
    .sort()
    .map((path) => ({ path, postSha256: sha(outputs[path]) })),
  head: HEADS[0],
};

for (const head of HEADS)
  test(`exact pinned transformations and syntax only: ${head}`, () => {
    const source = Object.fromEntries(
      Object.keys(ORIGINALS).map((path) => [
        path,
        execFileSync("git", ["show", head + ":" + path], { cwd: root, encoding: "utf8", maxBuffer: 3e6 }),
      ]),
    );
    assert.deepEqual(source, originals);
    const patched = instrumentSources(head, source);
    assert.equal(Object.keys(patched).length, 6);
    for (const [path, text] of Object.entries(patched)) {
      const javascript = path.endsWith(".ts") ? stripTypeScriptTypes(text, { mode: "transform" }) : text;
      execFileSync(process.execPath, ["--input-type=module", "--check"], { input: javascript });
    }
    assert.deepEqual(source, originals, "pure planner mutated original inputs");
  });
test("unknown HEAD fails before transforms", () =>
  assert.throws(() => instrumentSources("0".repeat(40), originals), /unknown historical HEAD/));
for (const path of Object.keys(ORIGINALS))
  test(`unexpected original bytes rejected: ${path}`, () => {
    assert.throws(
      () => instrumentSources(HEADS[0], { ...originals, [path]: originals[path] + "\n" }),
      /unexpected source:/,
    );
  });
test("missing original rejected", () => {
  const x = { ...originals };
  delete x[Object.keys(x)[0]];
  assert.throws(() => instrumentSources(HEADS[0], x), /source population/);
});
test("extra original rejected", () =>
  assert.throws(() => instrumentSources(HEADS[0], { ...originals, "src/extra.ts": "" }), /source population/));
test("instrumentation artifact positive control", () => validateObservationArtifacts(receipt, receipt, outputs));
test("receipt drift rejected", () =>
  assert.throws(
    () => validateObservationArtifacts(receipt, { ...receipt, head: HEADS[1] }, outputs),
    /modified trace admission receipt/,
  ));
test("missing observer rejected", () => {
  const x = { ...outputs };
  delete x[RUNTIME_PATH];
  assert.throws(() => validateObservationArtifacts(receipt, receipt, x), /population mismatch/);
});
test("extra artifact rejected", () =>
  assert.throws(
    () => validateObservationArtifacts(receipt, receipt, { ...outputs, "src/extra.ts": "" }),
    /population mismatch/,
  ));
for (const path of Object.keys(outputs))
  test(`patched bytes drift rejected: ${path}`, () => {
    assert.throws(
      () => validateObservationArtifacts(receipt, receipt, { ...outputs, [path]: outputs[path] + "\n" }),
      /patched bytes drift/,
    );
  });
test("real verifier refuses integration HEAD without writes", () =>
  assert.throws(() => verifyObservationTrace(root), /unknown historical HEAD/));

function recorder() {
  const records = [];
  const observation = createObservationRecorder((r) => records.push(clone(r)), 101, "synthetic-worker", TARGET);
  observation.begin(7, { generation: "synthetic-parent:1", poolPid: 100, path: TARGET }, false);
  return { observation, records };
}
test("opaque values and factory names are not read", () => {
  const { observation, records } = recorder();
  let gets = 0;
  const opaque = new Proxy(
    {},
    {
      get() {
        gets++;
        throw Error("unexpected getter");
      },
      ownKeys() {
        throw Error("unexpected ownKeys");
      },
    },
  );
  const frame = observation.enter(opaque, opaque);
  observation.registry(opaque, opaque, true, new Set([opaque]));
  observation.probe(opaque, opaque, "synthetic", opaque);
  observation.decoder(opaque, opaque, opaque);
  observation.mirror(frame, true, opaque);
  observation.failure(frame, "BigInt64Array");
  observation.leave(frame);
  assert.equal(gets, 0);
  assert.equal(records.find((r) => r.event === "construct-enter").data.factory.availability, "unavailable");
});

// Execute only the isolated marshalling function with synthetic JS stubs.
// No runtime module, compiler, Wasm, historical test, or provider executes.
function marshal(source, observation, mirror) {
  const begin = source.indexOf("function _marshalHostConstructArg(");
  const end = source.indexOf("\n/**\n * (#5381)", begin);
  assert.ok(begin > 0 && end > begin);
  const code = stripTypeScriptTypes(source.slice(begin, end), { mode: "transform" });
  return vm.runInNewContext(code + "\n_marshalHostConstructArg", {
    observation,
    marshalExports: (_, e) => e,
    _compiledAbToHostBuffer: () => undefined,
    _isWasmStruct: () => true,
    _materializeIterable: (a) => a,
    _isHostTypedArrayCtor: () => true,
    _wrapForHost: () => mirror,
    _structArgIdentityCtors: new Set(),
    TypeError,
  });
}
for (const value of [3, undefined, {}, "3"])
  test(`existing mirror length getter read once: ${typeof value}`, () => {
    for (const patched of [false, true]) {
      let reads = 0;
      const mirror = {
        get length() {
          reads++;
          return value;
        },
      };
      const { observation } = recorder();
      const fn = marshal((patched ? outputs : originals)["src/runtime.ts"], observation, mirror);
      if (typeof value === "number") assert.equal(fn({}, {}, undefined, { name: "BigInt64Array" }), mirror);
      else
        assert.throws(() => fn({}, {}, undefined, { name: "BigInt64Array" }), /cannot marshal opaque compiled value/);
      assert.equal(reads, 1);
    }
  });
test("same-object mirror does not read length", () => {
  const { observation } = recorder();
  const value = {
    get length() {
      throw Error("extra read");
    },
  };
  assert.throws(
    () => marshal(outputs["src/runtime.ts"], observation, value)(value, {}, undefined, { name: "BigInt64Array" }),
    /cannot marshal opaque/,
  );
});
test("throwing length preserves original error identity", () => {
  const error = new Error("getter sentinel"),
    mirror = {
      get length() {
        throw error;
      },
    };
  const { observation } = recorder();
  assert.throws(
    () => marshal(outputs["src/runtime.ts"], observation, mirror)({}, {}, undefined, {}),
    (e) => e === error,
  );
});
test("registry instrumentation neither adds decoder calls nor resets", () => {
  for (const patched of [false, true]) {
    const { observation } = recorder();
    let calls = 0;
    const source = (patched ? outputs : originals)["src/runtime/cross-module-struct-owners.ts"]
      .replace(/^import .*\n/gm, "")
      .replace("export function", "function");
    const create = vm.runInNewContext(
      stripTypeScriptTypes(source, { mode: "transform" }) + "\ncreateCrossModuleStructOwners",
      { observation },
    );
    const registry = create((x) => x !== null && typeof x === "object");
    const foreign = {
        __struct_field_names() {
          calls++;
          return "length";
        },
      },
      second = {};
    registry.registerModule(foreign);
    registry.registerModule(second);
    const obj = {},
      local = {};
    const frame = observation.enter(obj, local);
    assert.equal(registry.decoderFor(obj, local), foreign);
    assert.equal(calls, 1);
    assert.equal(registry.decoderFor(obj, local), foreign);
    assert.equal(calls, 1, "cached read added a call");
    observation.leave(frame);
    registry.reset();
    assert.equal(registry.decoderFor(obj, local), undefined);
    assert.equal(calls, 1);
  }
});
test("sink failure is recorded on next event, not thrown into subject", () => {
  const records = [];
  let fail = true;
  const o = createObservationRecorder(
    (r) => {
      if (fail) {
        fail = false;
        throw Error("disk");
      }
      records.push(r);
    },
    1,
    "boot",
    TARGET,
  );
  assert.doesNotThrow(() => o.emit("observer-boot"));
  o.emit("next");
  assert.equal(records[0].lost, 1);
  assert.equal(records[0].seq, 2);
});
test("generated writer makes real newline-delimited JSON and exclusive output", () => {
  const writes = [],
    opens = [],
    events = {};
  const process = {
    env: { REPLAY_OBSERVATION_TRACE: "1" },
    pid: 101,
    on: (name, fn) => {
      events[name] = fn;
    },
  };
  const code = runtimeSource()
    .replace(/^import .*;\n/gm, "")
    .replace("export const observation", "const observation");
  vm.runInNewContext(code + '\nobservation.emit("synthetic");', {
    process,
    openSync: (...args) => {
      opens.push(args);
      return 7;
    },
    writeSync: (_, bytes, offset, length) => {
      writes.push(bytes.subarray(offset, offset + length).toString());
      return length;
    },
    randomUUID: () => "fixed",
    resolve: (...x) => x.join("/"),
    Buffer,
  });
  assert.equal(opens[0][1], "wx");
  const text = writes.join("");
  assert.ok(text.endsWith("\n"));
  const rows = text.trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(
    rows.map((r) => r.event),
    ["observer-boot", "synthetic"],
  );
});

function population() {
  const streams = Array.from({ length: 5 }, () => []);
  const add = (index, event, data = {}, request = null) =>
    streams[index].push({
      schema: "issue-5807-observation-v1",
      boot: "boot-" + index,
      pid: 100 + index,
      seq: streams[index].length + 1,
      lost: 0,
      event,
      request,
      precedingLinked: null,
      data,
    });
  for (let i = 0; i < 5; i++) add(i, "observer-boot");
  for (let i = 1; i < 5; i++) {
    add(i, "worker-ready");
    add(0, "pool-ready", { workerPid: 100 + i, generation: "gen-" + i });
  }
  for (let id = 0; id < 939; id++) {
    const index = 1 + (id % 4),
      path = id === 0 ? TARGET : "test/synthetic/" + id + ".js";
    const request = { id, generation: "gen-" + index, poolPid: 100, path };
    add(0, "dispatch", { ...request, workerPid: 100 + index });
    add(index, "request-begin", { metadataAvailable: true }, request);
    if (id === 0)
      for (const event of [
        "instantiate",
        "construct-enter",
        "decoder-registry",
        "decoder-selected",
        "construct-mirror",
        "construct-refusal",
      ])
        add(index, event, {}, request);
    add(index, "request-end", { status: id === 0 ? "fail" : "pass" }, request);
  }
  return streams;
}
function dropEvent(streams, event, predicate = () => true) {
  for (const s of streams) {
    const i = s.findIndex((r) => r.event === event && predicate(r));
    if (i >= 0) {
      s.splice(i, 1);
      s.forEach((r, j) => {
        r.seq = j + 1;
      });
      return;
    }
  }
  assert.fail("negative test did not mutate an event");
}
test("full synthetic population passes floors, not causal proof", () => {
  const r = auditTraceRecords(population());
  assert.equal(r.dispatches, 939);
  assert.equal(r.targetRequests, 1);
  assert.equal(r.status, "OBSERVATIONS_AVAILABLE_NOT_CAUSAL_PROOF");
});
test("silent empty rejected", () => assert.throws(() => auditTraceRecords([]), /silent-empty/));
test("empty worker file rejected", () => assert.throws(() => auditTraceRecords([[]]), /empty worker/));
test("worker trace missing rejected", () => {
  const s = population();
  s.pop();
  assert.throws(() => auditTraceRecords(s), /four worker/);
});
test("sequence gap rejected", () => {
  const s = population();
  s[0][2].seq++;
  assert.throws(() => auditTraceRecords(s), /sequence gap/);
});
test("lost record rejected", () => {
  const s = population();
  s[0][2].lost = 1;
  assert.throws(() => auditTraceRecords(s), /lost records/);
});
test("dispatch floor enforced", () => {
  const s = population();
  dropEvent(s, "dispatch");
  assert.throws(() => auditTraceRecords(s), /below 939/);
});
test("missing dispatched request rejected", () => {
  const s = population();
  dropEvent(s, "request-begin", (r) => r.request.id === 1);
  assert.throws(() => auditTraceRecords(s), /missing dispatched worker/);
});
test("unterminated request rejected", () => {
  const s = population();
  dropEvent(s, "request-end", (r) => r.request.id === 1);
  assert.throws(() => auditTraceRecords(s), /unterminated request/);
});
test("missing target rejected despite full counts", () => {
  const s = population();
  for (const stream of s)
    for (const r of stream) {
      if (r.request?.path === TARGET) r.request.path = "test/other.js";
      if (r.data.path === TARGET) r.data.path = "test/other.js";
    }
  assert.throws(() => auditTraceRecords(s), /silent-empty target/);
});
for (const [event, message] of [
  ["instantiate", /instantiate observation/],
  ["construct-enter", /constructor observation/],
  ["decoder-selected", /decoder observation/],
  ["construct-refusal", /refusal observation/],
  ["decoder-registry", /retained registry observation/],
  ["construct-mirror", /existing mirror length observation/],
])
  test(`missing target ${event} rejected`, () => {
    const s = population();
    dropEvent(s, event);
    assert.throws(() => auditTraceRecords(s), message);
  });

test("observer bypasses mutable Set iterator and target String method", () => {
  const records = [];
  vm.runInNewContext(
    `
    const o = (${createObservationRecorder.toString()})(sink, 101, "safe", target);
    const modules = new Set([{}]);
    Set.prototype[Symbol.iterator] = () => { throw Error("extra Set iterator"); };
    Set.prototype.values = () => { throw Error("late Set values"); };
    String.prototype.startsWith = () => { throw Error("late startsWith"); };
    Object.defineProperty(Array.prototype, "0", { set() { throw Error("extra array setter"); } });
    o.begin(1, {path: target + " [strict rerun]", generation: "p:1", poolPid: 1}, false);
    const arg = {}, local = {}; const frame = o.enter(arg, local);
    o.registry(arg, local, true, modules); o.reset(modules); o.leave(frame);
  `,
    { sink: (r) => records.push(clone(r)), target: TARGET },
  );
  assert.ok(records.some((r) => r.event === "construct-enter"));
  assert.equal(Object.keys(records.find((r) => r.event === "decoder-registry").data.retained).length, 1);
});
for (const suffix of ["", " [strict rerun]", " [retry]"])
  test(`target label retained verbatim: ${suffix || "original"}`, () => {
    const records = [],
      path = TARGET + suffix;
    const o = createObservationRecorder((r) => records.push(clone(r)), 101, "labels", TARGET);
    o.begin(1, { generation: "p:1", poolPid: 1, path }, false);
    assert.ok(o.enter({}, {}));
    assert.equal(records.at(-1).request.path, path);
    const s = population();
    for (const stream of s)
      for (const r of stream) {
        if (r.request?.path === TARGET) r.request.path = path;
        if (r.data.path === TARGET) r.data.path = path;
      }
    assert.equal(auditTraceRecords(s).targetRequests, 1);
  });
test("nearby path is not silently treated as target", () => {
  const { observation } = recorder();
  observation.begin(2, { path: TARGET + ".other", generation: "p:1", poolPid: 1 }, false);
  assert.equal(observation.enter({}, {}), null);
});
test("worker sendResult compile_error keeps payload and cleanup calls unchanged", () => {
  const source = outputs["scripts/test262-worker.mjs"];
  const begin = source.indexOf("function sendResult(payload, forceRecycleReason) {");
  const end = source.indexOf('\nobservation.emit("worker-ready")', begin);
  assert.ok(begin > 0 && end > begin);
  assert.match(source, /process\.on\("message", async \(msg\) => \{\n  observation\.begin/);
  // Only the extracted result-delivery function executes, with inert stubs.
  const { observation, records } = recorder();
  let cleanups = 0,
    drifts = 0;
  const sent = [];
  const send = vm.runInNewContext(source.slice(begin, end) + "\nsendResult", {
    observation,
    postCompileCleanup: () => {
      cleanups++;
      return { recycle: false };
    },
    realmDriftRecycleReason: () => {
      drifts++;
      return undefined;
    },
    process: { send: (v) => sent.push(v) },
  });
  const payload = { id: 7, status: "compile_error", error: "synthetic compile error" };
  send(payload);
  assert.equal(sent[0], payload);
  assert.equal(cleanups, 1);
  assert.equal(drifts, 1);
  assert.deepEqual(
    records.map((r) => r.event),
    ["request-begin", "request-end"],
  );
  assert.equal(records[1].data.status, "compile_error");
  const s = population();
  s.flat().find((r) => r.event === "request-end" && r.request.id === 1).data.status = "compile_error";
  assert.equal(auditTraceRecords(s).dispatches, 939);
});
test("target compile_error without execution remains explicitly unavailable", () => {
  const s = population();
  for (const event of [
    "instantiate",
    "construct-enter",
    "decoder-registry",
    "decoder-selected",
    "construct-mirror",
    "construct-refusal",
  ])
    dropEvent(s, event);
  s.flat().find((r) => r.event === "request-end" && r.request.id === 0).data.status = "compile_error";
  assert.throws(() => auditTraceRecords(s), /target instantiate observation missing/);
});
test("wrong pool PID metadata rejected", () => {
  const s = population();
  s[1].find((r) => r.event === "request-begin").request.poolPid = -1;
  assert.throws(() => auditTraceRecords(s), /unmatched worker request/);
});
test("missing target terminal rejected even with parent interruption", () => {
  const s = population();
  dropEvent(s, "request-end", (r) => r.request.id === 0);
  s[0].push({
    ...clone(s[0].at(-1)),
    seq: s[0].length + 1,
    event: "pool-timeout",
    data: { generation: "gen-1", id: 0 },
  });
  assert.throws(() => auditTraceRecords(s), /target terminal observation missing/);
});
test("final sink failure cannot self-report; audit exposes tail limit", () => {
  const records = [];
  let fail = false;
  const o = createObservationRecorder(
    (r) => {
      if (fail) throw Error("final write failed");
      records.push(r);
    },
    1,
    "boot",
    TARGET,
  );
  o.emit("observer-boot");
  fail = true;
  o.emit("observer-exit");
  assert.equal(records.length, 1);
  assert.equal(records[0].lost, 0);
  const report = auditTraceRecords(population());
  assert.ok(report.streamTails.every((s) => s.availability === "unavailable-abrupt-or-unwritten-tail"));
  assert.match(report.sinkTailLimit, /cannot report its lost counter/);
});
test("observer-exit tail is distinguished from missing tail", () => {
  const s = population();
  s[0].push({ ...clone(s[0].at(-1)), seq: s[0].length + 1, event: "observer-exit", request: null, data: { code: 0 } });
  assert.equal(auditTraceRecords(s).streamTails[0].availability, "exit-record-observed");
});
test("generated helper is shared on process, does not inspect harness objects", () => {
  const writes = [],
    process = { env: { REPLAY_OBSERVATION_TRACE: "1" }, pid: 101, on() {} };
  let opens = 0;
  const context = vm.createContext({
    process,
    Buffer,
    openSync: () => {
      opens++;
      return 7;
    },
    writeSync: (_, b, o, n) => {
      writes.push(b.subarray(o, o + n).toString());
      return n;
    },
    randomUUID: () => "fixed",
    resolve: (...x) => x.join("/"),
  });
  const code = runtimeSource()
    .replace(/^import .*;\n/gm, "")
    .replace("export const observation", "const observation");
  vm.runInContext("{\n" + code + "\n}", context);
  vm.runInContext("{\n" + code + "\n}", context);
  assert.equal(opens, 1);
  assert.equal(writes.length, 1);
  const descriptor = Object.getOwnPropertyDescriptor(process, Symbol.for("js2.issue5807.observation.v1"));
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, false);
  vm.runInContext(
    `
    Array.prototype[Symbol.iterator] = () => { throw Error("extra array iterator"); };
    Object.prototype.toJSON = () => { throw Error("extra toJSON"); };
    process[Symbol.for("js2.issue5807.observation.v1")].emit("after-poison");
  `,
    context,
  );
  assert.equal(JSON.parse(writes.at(-1)).event, "after-poison");
});
