import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  startNativeEvalBoundaryObservation,
  NATIVE_EVAL_OBSERVATION_ENV,
  NATIVE_EVAL_OBSERVATION_FIELD,
  NATIVE_EVAL_OBSERVATION_SOURCES,
} from "./native-eval-boundary-observation.mjs";
import { safeStringifyThrown } from "./wasm-exn-render.mjs";

// Source-only assembly for observer admission; never compile or execute this
// original body. A missing/wrong pinned harness must fail, never skip controls.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const body =
  "var cdAssigned = 0;\neval('cdAssigned = 1;');\nif (cdAssigned !== 1) throw new Error('assignment-only eval should still work, got ' + cdAssigned);\n";
const admittedSource =
  read("../test262-fyi-runtime.js") +
  read("../../test262/harness/assert.js") +
  read("../../test262/harness/sta.js") +
  "/*---\ndescription: cd/assign-only\nflags: [noStrict]\n---*/\n" +
  body;
const enabled = { [NATIVE_EVAL_OBSERVATION_ENV]: "1" };
const newObserver = () => {
  const observer = startNativeEvalBoundaryObservation(admittedSource, enabled);
  assert(observer, "frozen source digest must actually admit the controls");
  return observer;
};
const worker = read("../test262-worker.mjs");
const readerStart = worker.indexOf("function extractWasmExceptionMessage(");
const readerEnd = worker.indexOf("/**\n * (#3469)", readerStart);
assert(readerStart > 0 && readerEnd > readerStart);
const readerSource = worker.slice(readerStart, readerEnd);
const makeReader = (render = () => null, peers = [], boundaryObservation = null) =>
  runInNewContext(
    "let currentNativeEvalBoundaryObservation = boundaryObservation;\n" +
      readerSource +
      "\nextractWasmExceptionMessage;",
    {
      WebAssembly,
      Error,
      safeStringifyThrown,
      tryNativeExnRender: render,
      currentLinkedPeers: peers,
      boundaryObservation,
    },
  );
const eventValues = (snapshot, event) => snapshot.events.filter((e) => e.event === event).map((e) => e.value);

function wasmCase(payload, mode = "matching") {
  const tag = new WebAssembly.Tag({ parameters: ["externref"] });
  const otherTag = new WebAssembly.Tag({ parameters: ["externref"] });
  const error = new WebAssembly.Exception(tag, [payload]);
  const calls = [];
  const getArg = error.getArg;
  Object.defineProperty(error, "getArg", {
    value(t, i) {
      calls.push("getArg");
      return getArg.call(this, t, i);
    },
  });
  const instance =
    mode === "no-instance"
      ? null
      : {
          exports: {
            get __exn_tag() {
              calls.push("__exn_tag");
              return mode === "fallback-tag" ? undefined : mode === "mismatched" ? otherTag : tag;
            },
            get __tag() {
              calls.push("__tag");
              return tag;
            },
          },
        };
  return { error, instance, calls };
}

for (const [name, payload, mode, category, expected] of [
  ["actual undefined payload", undefined, "matching", "undefined", "TypeError (null/undefined access)"],
  ["actual null payload", null, "matching", "null", "TypeError (null/undefined access)"],
  ["known string payload", "known native text", "matching", "string", "known native text"],
  ["mismatched consumer tag", "hidden", "mismatched", undefined, "TypeError (null/undefined access)"],
  ["missing consumer instance", "hidden", "no-instance", undefined, "wasm exception during module init"],
  ["non-Wasm thrown undefined", undefined, "non-wasm", undefined, "undefined"],
]) {
  test(name, () => {
    const observer = newObserver();
    const off = mode === "non-wasm" ? { error: undefined, instance: null, calls: [] } : wasmCase(payload, mode);
    const on = mode === "non-wasm" ? { error: undefined, instance: null, calls: [] } : wasmCase(payload, mode);
    const reader = makeReader();
    assert.equal(reader(off.error, off.instance), expected);
    assert.equal(reader(on.error, on.instance, observer.reader("synthetic")), expected);
    assert.deepEqual(on.calls, off.calls);
    const snapshot = observer.snapshot();
    assert.equal(snapshot.observationComplete, true);
    assert.equal(snapshot.invocations, 1);
    assert.deepEqual(eventValues(snapshot, "payload-category"), category === undefined ? [] : [category]);
    assert.deepEqual(eventValues(snapshot, "reader-text"), [expected]);
    if (mode === "mismatched") assert.deepEqual(eventValues(snapshot, "extraction"), ["failed"]);
    if (mode === "no-instance") assert.deepEqual(eventValues(snapshot, "consumer-tag"), ["no-instance"]);
    if (mode === "non-wasm") assert.deepEqual(eventValues(snapshot, "exception-kind"), ["non-wasm"]);
  });
}

test("generic consumer yields to the existing successful peer and stops", () => {
  const peer1 = {},
    peer2 = {};
  function arm(observer) {
    const row = wasmCase({});
    const reader = makeReader(
      (instance) => {
        const which = instance.exports === peer1 ? "peer-1" : instance.exports === peer2 ? "peer-2" : "consumer";
        row.calls.push(which);
        return which === "consumer" ? "[object Object]" : "peer assertion text";
      },
      [peer1, peer2],
    );
    const text = reader(row.error, row.instance, observer?.reader("synthetic-peers"));
    return { text, calls: row.calls };
  }
  const observer = newObserver();
  const off = arm(null),
    on = arm(observer);
  assert.deepEqual(on, off);
  assert.deepEqual(on, { text: "peer assertion text", calls: ["__exn_tag", "getArg", "consumer", "peer-1"] });
  const snapshot = observer.snapshot();
  assert.equal(snapshot.observationComplete, true);
  assert.deepEqual(eventValues(snapshot, "linked-peer-ordinal"), [1]);
  assert.deepEqual(eventValues(snapshot, "text-route"), ["linked-peer-native"]);
});

test("existing native, generic and safe fallbacks keep identical call order", () => {
  for (const [native, peer, expected, route] of [
    ["consumer text", "unused", "consumer text", "consumer-native"],
    [null, "peer text", "peer text", "linked-peer-native"],
    ["[object Object]", null, "[object Object]", "generic-native"],
    [null, null, "[object Object]", "payload-safe-stringification"],
  ]) {
    const linked = {};
    const observer = newObserver();
    function arm(record) {
      const row = wasmCase({});
      const text = makeReader(
        (instance) => {
          const viaPeer = instance.exports === linked;
          row.calls.push(viaPeer ? "peer" : "consumer");
          return viaPeer ? peer : native;
        },
        [linked],
      )(row.error, row.instance, record);
      return { text, calls: row.calls };
    }
    assert.deepEqual(arm(observer.reader("synthetic-fallback")), arm(undefined));
    const snapshot = observer.snapshot();
    assert.deepEqual(eventValues(snapshot, "reader-text"), [expected]);
    assert.deepEqual(eventValues(snapshot, "text-route"), [route]);
    assert.equal(snapshot.observationComplete, true);
  }
});

test("fallback tag is read once and repeated readers keep separate ordinals", () => {
  const observer = newObserver(),
    row = wasmCase("TypeError known", "fallback-tag");
  const reader = makeReader(undefined, [], observer);
  assert.equal(reader(row.error, row.instance), "TypeError known");
  assert.equal(reader(row.error, row.instance, observer.reader("deferred-module-init")), "TypeError known");
  const matcherStart = worker.indexOf("function originalHarnessExceptionMatches(");
  const matcherEnd = worker.indexOf("function extractWasmFuncName(", matcherStart);
  assert(matcherStart > 0 && matcherEnd > matcherStart);
  assert(
    worker
      .slice(matcherStart, matcherEnd)
      .includes("  return extractWasmExceptionMessage(err, instance).includes(expectedErrorType);\n"),
  );
  assert.deepEqual(row.calls, ["__exn_tag", "__tag", "getArg", "__exn_tag", "__tag", "getArg"]);
  const snapshot = observer.snapshot();
  assert.equal(snapshot.invocations, 2);
  assert.deepEqual(eventValues(snapshot, "reader-context"), ["negative-match", "deferred-module-init"]);
  assert.deepEqual(eventValues(snapshot, "consumer-tag"), ["__tag", "__tag"]);
  assert.deepEqual(
    snapshot.events.filter((e) => e.event === "reader-context").map((e) => e.invocation),
    [1, 2],
  );
});

test("default off and unlisted sources are not admitted; overflow is explicit", () => {
  assert.equal(Object.keys(NATIVE_EVAL_OBSERVATION_SOURCES).length, 11);
  assert.equal(startNativeEvalBoundaryObservation(admittedSource, {}), null);
  assert.equal(startNativeEvalBoundaryObservation(admittedSource, { [NATIVE_EVAL_OBSERVATION_ENV]: "true" }), null);
  assert.equal(startNativeEvalBoundaryObservation("cd/direct-var-new", enabled), null);
  assert.equal(startNativeEvalBoundaryObservation(admittedSource + "\n", enabled), null);
  const observer = newObserver(),
    record = observer.reader("synthetic-overflow");
  for (let i = 0; i < 130; i++) record("bounded", i);
  const snapshot = observer.snapshot();
  assert.equal(snapshot.observationComplete, false);
  assert.equal(snapshot.captureError, "event-overflow");
  assert.equal(snapshot.events.length, 128);
  const stringOverflow = newObserver();
  stringOverflow.reader("synthetic-string")("reader-text", "x".repeat(1025));
  assert.equal(stringOverflow.snapshot().captureError, "string-overflow");
  const invalid = newObserver();
  invalid.reader("synthetic-invalid")("reader-text", Object.create(null));
  assert.equal(invalid.snapshot().captureError, "non-primitive-record");
});

test("sendResult snapshots before cleanup and default off has no extra own key", () => {
  const start = worker.indexOf("function sendResult(");
  const end = worker.indexOf('process.send({ type: "ready"', start);
  assert(start > 0 && end > start);
  function arm(observer) {
    const order = [],
      sent = [];
    const send = runInNewContext(worker.slice(start, end) + "\nsendResult;", {
      currentNativeEvalBoundaryObservation: observer,
      NATIVE_EVAL_OBSERVATION_FIELD,
      currentLinkedFallback: false,
      postCompileCleanup() {
        order.push("cleanup");
        return { recycle: false };
      },
      realmDriftRecycleReason() {
        return undefined;
      },
      process: {
        send(value) {
          order.push("send");
          sent.push(value);
        },
      },
    });
    send({ id: 1, status: "fail", error: "undefined", isException: true });
    send({ id: 2, status: "pass", ret: 1 });
    return { order, sent: JSON.parse(JSON.stringify(sent)) };
  }
  const observer = newObserver();
  const record = observer.reader("synthetic-send");
  record("reader-text", "undefined");
  const on = arm(observer),
    off = arm(null);
  assert.deepEqual(on.order, ["cleanup", "send", "cleanup", "send"]);
  assert.deepEqual(on.order, off.order);
  assert.equal(Object.hasOwn(off.sent[0], NATIVE_EVAL_OBSERVATION_FIELD), false);
  assert.equal(Object.hasOwn(on.sent[1], NATIVE_EVAL_OBSERVATION_FIELD), false);
  assert.equal(on.sent[0][NATIVE_EVAL_OBSERVATION_FIELD].observationComplete, true);
  delete on.sent[0][NATIVE_EVAL_OBSERVATION_FIELD];
  assert.deepEqual(on.sent, off.sent);
});
