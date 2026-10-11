#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Observation only. Does not compile, dispatch, reset registries, or score rows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HEADS = Object.freeze([
  "129e3efd4530ae1be56dbf5fdea54ddbbd87443e",
  "efa0908e09998c73da592fba32708c7ecca8d6e5",
]);
export const TARGET = "test/built-ins/TypedArrayConstructors/ctors-bigint/object-arg/new-instance-extensibility.js";
export const ORIGINALS = Object.freeze({
  "scripts/compiler-pool.ts": "f3a2c4568025adec4f75de147632286f51193a594c75e5447bf87a760606b60e",
  "scripts/test262-worker.mjs": "d22e2a50f2351bf6bab986dfd577704eb35e31d01b07d55481ddc23772c5cd4e",
  "scripts/test262-import-object.mjs": "95c1fdd5f5b9982b87951db68f6569ec2aab9b3fba9d32fcfc6a0975114a2ddb",
  "src/runtime.ts": "ea32ee061a8cb7097768e5e8762ffe41417854b3db7926ab9417474162f7f64c",
  "src/runtime/cross-module-struct-owners.ts": "d787b63679001c35963918a3efaa7dfba6acddc50e388ae2f6d194359d1ec1cd",
});
export const RUNTIME_PATH = "scripts/issue-5807-observation-runtime.mjs";
export const RECEIPT_PATH = "replay5807-trace-admission.json";
const INPUTS = [
  "src",
  "tests",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  ".github",
];
const SELF = fileURLToPath(import.meta.url);
export const sha = (value) => createHash("sha256").update(value).digest("hex");

/** Pure recorder, also exercised with synthetic objects and a memory sink.
 * No property enumeration, getters, String(object), or Wasm calls on observed
 * values. Object identities are weak; recording never retains the objects.
 */
export function createObservationRecorder(sink, pid, boot, target) {
  const ids = new WeakMap();
  const weakGet = Function.call.bind(WeakMap.prototype.get);
  const weakSet = Function.call.bind(WeakMap.prototype.set);
  const startsWith = Function.call.bind(String.prototype.startsWith);
  const setValues = Function.call.bind(Set.prototype.values);
  const setNext = Function.call.bind(Object.getPrototypeOf(new Set().values()).next);
  let nextId = 0,
    sequence = 0,
    lost = 0,
    request = null,
    precedingLinked = null;
  let frame = null;
  function identity(value) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
    let result = weakGet(ids, value);
    if (!result) {
      result = boot + ":" + ++nextId;
      weakSet(ids, value, result);
    }
    return result;
  }
  function scalar(value) {
    const type = typeof value;
    return {
      type,
      value:
        value === null || type === "string" || type === "boolean"
          ? value
          : type === "number" && value === value && value !== Infinity && value !== -Infinity
            ? value
            : null,
      identity: identity(value),
    };
  }
  function emit(event, data = {}) {
    const record = {
      schema: "issue-5807-observation-v1",
      pid,
      boot,
      seq: ++sequence,
      lost,
      event,
      request,
      precedingLinked,
      data,
    };
    try {
      sink(record);
    } catch {
      lost++;
    }
  }
  function retainedIds(modules) {
    const retained = { __proto__: null };
    const iterator = setValues(modules);
    let index = 0;
    for (let step = setNext(iterator); !step.done; step = setNext(iterator)) retained[index++] = identity(step.value);
    return retained;
  }
  return {
    identity,
    scalar,
    emit,
    dispatch(proc, id, path) {
      const metadata = { generation: identity(proc), poolPid: pid, path: path ?? null };
      emit("dispatch", { ...metadata, workerPid: proc.pid, id });
      return metadata;
    },
    begin(id, metadata, temporal) {
      request = {
        id,
        generation: metadata?.generation ?? null,
        poolPid: metadata?.poolPid ?? null,
        path: metadata?.path ?? null,
      };
      emit("request-begin", { temporalRequested: temporal, metadataAvailable: metadata !== undefined });
    },
    finish(status, recycle, reason) {
      emit("request-end", { status, recycle, reason: reason ?? null });
      request = null;
    },
    linked(count) {
      emit("instantiate", { linkedModules: count });
      if (count > 0) precedingLinked = request;
    },
    enter(arg, local) {
      const current =
        request?.path === target || (typeof request?.path === "string" && startsWith(request.path, target + " ["));
      if (!current) return null;
      const next = { parent: frame, arg: identity(arg), local: identity(local), length: { availability: "not-read" } };
      frame = next;
      emit("construct-enter", {
        arg: next.arg,
        local: next.local,
        factory: {
          availability: "unavailable",
          reason: "compiled callback ignores factory; observing identity/name here would require extra compiled reads",
        },
      });
      return next;
    },
    leave(current) {
      if (current) frame = current.parent;
    },
    mirror(current, distinct, length) {
      if (!current) return;
      current.length = distinct
        ? { availability: "existing-read", ...scalar(length) }
        : { availability: "not-read-same-object" };
      emit("construct-mirror", { arg: current.arg, distinct, length: current.length });
    },
    failure(current, name) {
      if (current) emit("construct-refusal", { arg: current.arg, local: current.local, name, length: current.length });
    },
    decoder(obj, local, selected) {
      if (frame && identity(obj) === frame.arg)
        emit("decoder-selected", {
          arg: frame.arg,
          local: identity(local),
          selected: identity(selected),
          effective: identity(selected ?? local),
        });
    },
    registry(obj, local, enabled, modules) {
      if (!frame || identity(obj) !== frame.arg) return;
      const retained = retainedIds(modules);
      emit("decoder-registry", { arg: frame.arg, local: identity(local), enabled, retained });
    },
    probe(obj, exports, stage, result) {
      if (frame && identity(obj) === frame.arg)
        emit("decoder-probe", {
          arg: frame.arg,
          exports: identity(exports),
          stage,
          result: scalar(result),
        });
    },
    registration(exports) {
      emit("registry-register", { exports: identity(exports) });
    },
    reset(modules) {
      const retained = retainedIds(modules);
      emit("registry-reset", { retained });
    },
  };
}

/** Standalone observer shared across the two bundled runtime copies through
 * process (not the harness global). Only trace-owned primitive records reach
 * the serializer. Completed synchronous writes avoid user-space buffering;
 * an unwritten final tail at abrupt process death remains explicitly unknown.
 */
export function runtimeSource() {
  return `// Generated observation artifact; no compiler or harness changes.\n
import process from "node:process";
import { openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
const key = Symbol.for("js2.issue5807.observation.v1");
if (process.env.REPLAY_OBSERVATION_TRACE !== "1") throw new Error("observation trace requires explicit environment admission");
${createObservationRecorder.toString()}
if (!process[key]) {
  const boot = process.pid + "-" + randomUUID();
  const fd = openSync(resolve("replay5807-traces", boot + ".jsonl"), "wx", 0o600);
  const quote = JSON.stringify.bind(JSON), keys = Object.keys.bind(Object), bytesFrom = Buffer.from.bind(Buffer);
  const serialize = (v) => {
    if (v === null) return "null";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return quote(v);
    if (v === undefined) return "null";
    let out = "{", first = true;
    const names = keys(v);
    for (let i = 0; i < names.length; i++) { const k = names[i]; if (!first) out += ","; first = false; out += quote(k) + ":" + serialize(v[k]); }
    return out + "}";
  };
  // Arrays are encoded as numeric-key objects; audit never guesses their shape.
  const recorder = createObservationRecorder((record) => {
    const line = serialize(record) + "\\n";
    const bytes = bytesFrom(line); let offset = 0;
    while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error("trace short write"); offset += n; }
  }, process.pid, boot, ${JSON.stringify(TARGET)});
  Object.defineProperty(process, key, { value: recorder });
  recorder.emit("observer-boot", { factoryIdentity: "unavailable-without-extra-compiled-reads" });
  process.on("exit", (code) => recorder.emit("observer-exit", { code }));
}
export const observation = process[key];
`;
}

function replaceOnce(source, before, after, path) {
  assert.equal(source.split(before).length - 1, 1, `unexpected anchor count: ${path}: ${before.slice(0, 65)}`);
  return source.replace(before, () => after);
}

/** Exact-original admission precedes every transformation. Pure, no writes. */
export function instrumentSources(head, originals) {
  assert.ok(HEADS.includes(head), "unknown historical HEAD");
  assert.deepEqual(Object.keys(originals).sort(), Object.keys(ORIGINALS).sort(), "unexpected source population");
  for (const [path, digest] of Object.entries(ORIGINALS))
    assert.equal(sha(originals[path]), digest, `unexpected source: ${path}`);
  const result = { ...originals };
  const change = (path, before, after) => {
    result[path] = replaceOnce(result[path], before, after, path);
  };
  const pool = "scripts/compiler-pool.ts",
    worker = "scripts/test262-worker.mjs",
    seam = "scripts/test262-import-object.mjs";
  const runtime = "src/runtime.ts",
    registry = "src/runtime/cross-module-struct-owners.ts";
  for (const path of [pool, worker, seam])
    result[path] = 'import { observation } from "./issue-5807-observation-runtime.mjs";\n' + result[path];
  result[runtime] = 'import { observation } from "../scripts/issue-5807-observation-runtime.mjs";\n' + result[runtime];
  result[registry] =
    'import { observation } from "../../scripts/issue-5807-observation-runtime.mjs";\n' + result[registry];
  change(
    pool,
    '    const proc = state.proc;\n    proc.on("message",',
    '    const proc = state.proc;\n    observation.emit("pool-worker", { generation: observation.identity(proc), workerPid: proc.pid, initial: countInitialReady });\n    proc.on("message",',
  );
  change(
    pool,
    '      if (msg.type === "ready") {',
    '      if (msg.type === "ready") {\n        observation.emit("pool-ready", { generation: observation.identity(proc), workerPid: proc.pid });',
  );
  change(
    pool,
    "      const timer = setTimeout(() => {",
    '      const timer = setTimeout(() => {\n        observation.emit("pool-timeout", { generation: observation.identity(free.proc), workerPid: free.proc.pid, id: job.id, path: job.label, timeoutMs: job.timeoutMs });',
  );
  change(
    pool,
    "      free.proc.send({ id: job.id, ...job.msg });",
    "      const __observation5807 = observation.dispatch(free.proc, job.id, job.label);\n      free.proc.send({ id: job.id, ...job.msg, __observation5807 });",
  );
  change(
    pool,
    "    const active = state.active;\n    const wasReady",
    '    const active = state.active;\n    observation.emit("pool-failure", { generation: observation.identity(proc), workerPid: proc.pid, id: active?.job.id, path: active?.job.label, reason });\n    const wasReady',
  );
  change(
    pool,
    "    const oldProc = state.proc;\n    oldProc.removeAllListeners();",
    '    const oldProc = state.proc;\n    observation.emit("pool-recycle", { generation: observation.identity(oldProc), workerPid: oldProc.pid, reason: reason ?? null });\n    oldProc.removeAllListeners();',
  );
  change(
    worker,
    'process.on("message", async (msg) => {',
    'process.on("message", async (msg) => {\n  observation.begin(msg.id, msg.__observation5807, msg.temporal === true);',
  );
  change(
    worker,
    "  const recycle = Boolean(forceRecycleReason || driftReason || cleanup.recycle);",
    '  const recycle = Boolean(forceRecycleReason || driftReason || cleanup.recycle);\n  observation.finish(payload.status ?? (payload.ok ? "compiled" : "unknown"), recycle, forceRecycleReason || driftReason || cleanup.reason);',
  );
  change(
    worker,
    'process.send({ type: "ready", pid: process.pid });',
    'observation.emit("worker-ready");\nprocess.send({ type: "ready", pid: process.pid });',
  );
  change(
    seam,
    "  const linkedModules = options.linkedModules ?? [];",
    "  const linkedModules = options.linkedModules ?? [];\n  observation.linked(linkedModules.length);",
  );
  change(
    registry,
    "    const fn = exports.__struct_field_names;",
    '    const fn = exports.__struct_field_names;\n    observation.probe(obj, exports, "helper-type", typeof fn);',
  );
  change(
    registry,
    "      const csv = fn(obj);",
    '      const csv = fn(obj);\n      observation.probe(obj, exports, "existing-decoder-result", csv);',
  );
  change(
    registry,
    "      modules.add(exports);",
    "      modules.add(exports);\n      observation.registration(exports);",
  );
  change(
    registry,
    "      if (!enabled || !canBeWeakKey(obj)) return undefined;",
    "      observation.registry(obj, local, enabled, modules);\n      if (!enabled || !canBeWeakKey(obj)) return undefined;",
  );
  change(
    registry,
    "    reset(): void {\n      modules.clear();",
    "    reset(): void {\n      observation.reset(modules);\n      modules.clear();",
  );
  change(
    runtime,
    "  return _crossModuleStructs.decoderFor(obj, exports) ?? exports;",
    "  const selected = _crossModuleStructs.decoderFor(obj, exports);\n  observation.decoder(obj, exports, selected);\n  return selected ?? exports;",
  );
  change(
    runtime,
    "  const eff = marshalExports(callbackState, exports);\n  const buf = _compiledAbToHostBuffer(a, eff);",
    "  const eff = marshalExports(callbackState, exports);\n  const __observationFrame = observation.enter(a, eff);\n  try {\n  const buf = _compiledAbToHostBuffer(a, eff);",
  );
  change(
    runtime,
    '      if (mirror !== a && typeof mirror.length === "number") return mirror;',
    '      const __observedLength = mirror !== a ? mirror.length : undefined;\n      observation.mirror(__observationFrame, mirror !== a, __observedLength);\n      if (mirror !== a && typeof __observedLength === "number") return mirror;',
  );
  change(
    runtime,
    "      throw new TypeError(`cannot marshal opaque compiled value to host ${nm} constructor`);",
    "      observation.failure(__observationFrame, nm);\n      throw new TypeError(`cannot marshal opaque compiled value to host ${nm} constructor`);",
  );
  change(
    runtime,
    "  return a;\n}\n\n/**\n * (#5381)",
    "  return a;\n  } finally { observation.leave(__observationFrame); }\n}\n\n/**\n * (#5381)",
  );
  result[RUNTIME_PATH] = runtimeSource();
  return result;
}

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const names = (text) => text.split("\0").filter(Boolean).sort();
function regular(root, path) {
  const full = join(root, path);
  assert.ok(lstatSync(full).isFile() && !lstatSync(full).isSymbolicLink(), `nonregular: ${path}`);
  assert.equal(realpathSync(full), full, `aliased path: ${path}`);
  return readFileSync(full, "utf8");
}
function prepared(root) {
  root = realpathSync(resolve(root));
  assert.equal(realpathSync(git(root, "rev-parse", "--show-toplevel").trim()), root, "not an exact repository root");
  const head = git(root, "rev-parse", "HEAD").trim();
  assert.ok(HEADS.includes(head), "unknown historical HEAD");
  const originals = Object.fromEntries(
    Object.keys(ORIGINALS).map((path) => [path, git(root, "show", `${head}:${path}`)]),
  );
  const outputs = instrumentSources(head, originals);
  const modifiedPaths = Object.keys(ORIGINALS).sort(),
    untrackedPaths = [RUNTIME_PATH];
  const files = Object.keys(outputs)
    .sort()
    .map((path) => ({ path, preSha256: ORIGINALS[path] ?? null, postSha256: sha(outputs[path]) }));
  const receipt = {
    schema: "issue-5807-observation-install-v1",
    head,
    installerSha256: sha(readFileSync(SELF)),
    modifiedPaths,
    untrackedPaths,
    files,
    patchSha256: sha(JSON.stringify(files)),
    traceDirectory: "replay5807-traces",
    factoryObservation: "unavailable-without-extra-compiled-reads",
    harnessAndTestCompilerInputChanged: false,
    resetAdded: false,
    comparisonOrGateChanged: false,
    precedingLinkedMeaning: "most recent linked instantiation entry, not proof that instantiation completed",
  };
  return { root, originals, outputs, receipt };
}
function assertScope(root, modified, untracked) {
  assert.deepEqual(
    names(git(root, "diff", "--name-only", "-z", "HEAD", "--", ...INPUTS)),
    modified,
    "unexpected tracked input mutation",
  );
  assert.deepEqual(
    names(git(root, "ls-files", "--others", "--exclude-standard", "-z", "--", ...INPUTS)),
    untracked,
    "unexpected untracked input mutation",
  );
}
export function verifyObservationTrace(root = process.cwd()) {
  const plan = prepared(root);
  validateObservationArtifacts(
    plan.receipt,
    JSON.parse(regular(plan.root, RECEIPT_PATH)),
    Object.fromEntries(Object.keys(plan.outputs).map((path) => [path, regular(plan.root, path)])),
  );
  assertScope(plan.root, plan.receipt.modifiedPaths, plan.receipt.untrackedPaths);
  return plan.receipt;
}
export function validateObservationArtifacts(expected, receipt, contents) {
  assert.deepEqual(receipt, expected, "modified trace admission receipt");
  assert.deepEqual(
    Object.keys(contents).sort(),
    expected.files.map((f) => f.path).sort(),
    "instrumentation artifact population mismatch",
  );
  for (const file of expected.files)
    assert.equal(sha(contents[file.path]), file.postSha256, `patched bytes drift: ${file.path}`);
}
export function installObservationTrace(root = process.cwd()) {
  assert.equal(process.env.REPLAY_OBSERVATION_TRACE, "1", "explicit REPLAY_OBSERVATION_TRACE=1 required");
  const plan = prepared(root);
  assertScope(plan.root, [], []);
  for (const [path, text] of Object.entries(plan.originals))
    assert.equal(regular(plan.root, path), text, `original drift: ${path}`);
  for (const path of [RUNTIME_PATH, RECEIPT_PATH, "replay5807-traces"]) {
    try {
      lstatSync(join(plan.root, path));
      assert.fail(`refuse existing ${path}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  // Reserve the admission receipt before changing anything. An interrupted
  // install leaves an explicitly invalid receipt and is never silently reused.
  writeFileSync(join(plan.root, RECEIPT_PATH), '{"status":"INSTALL_INCOMPLETE"}\n', { flag: "wx" });
  mkdirSync(join(plan.root, "replay5807-traces"), { mode: 0o700 });
  for (const [path, text] of Object.entries(plan.outputs))
    writeFileSync(join(plan.root, path), text, { flag: path === RUNTIME_PATH ? "wx" : "w" });
  writeFileSync(join(plan.root, RECEIPT_PATH), JSON.stringify(plan.receipt, null, 2) + "\n");
  return verifyObservationTrace(plan.root);
}

/** Trace completeness is a separate diagnostic admission, NOT a verdict gate.
 * It establishes per-worker observations and target coverage, not causality.
 */
export function auditTraceRecords(streams) {
  assert.ok(streams.length > 0, "silent-empty trace directory");
  const records = [],
    boots = new Set();
  for (const stream of streams) {
    assert.ok(stream.length > 0, "empty worker trace");
    assert.equal(stream[0].event, "observer-boot", "missing observer boot");
    assert.ok(!boots.has(stream[0].boot), "duplicate worker generation");
    boots.add(stream[0].boot);
    for (let i = 0; i < stream.length; i++) {
      const r = stream[i];
      assert.equal(r.schema, "issue-5807-observation-v1");
      assert.equal(r.boot, stream[0].boot);
      assert.equal(r.pid, stream[0].pid);
      assert.equal(r.seq, i + 1, "trace sequence gap");
      assert.equal(r.lost, 0, "trace sink lost records");
      records.push(r);
    }
  }
  const dispatches = records.filter((r) => r.event === "dispatch");
  const ready = records.filter((r) => r.event === "worker-ready");
  assert.ok(new Set(ready.map((r) => r.boot)).size >= 4, "missing initial four worker observations");
  assert.ok(dispatches.length >= 939, "dispatch population below 939 (not canonical row proof)");
  for (const r of records.filter((r) => r.event === "pool-ready"))
    assert.ok(
      ready.some((w) => w.pid === r.data.workerPid),
      "missing ready worker trace",
    );
  const starts = records.filter((r) => r.event === "request-begin");
  for (const r of starts) {
    assert.ok(r.data.metadataAvailable, "missing dispatch metadata");
    assert.ok(
      dispatches.some(
        (d) =>
          d.pid === r.request.poolPid &&
          d.data.generation === r.request.generation &&
          d.data.id === r.request.id &&
          d.data.workerPid === r.pid &&
          d.data.path === r.request.path,
      ),
      "unmatched worker request",
    );
  }
  for (const d of dispatches) {
    const start = starts.find(
      (r) => r.request.generation === d.data.generation && r.request.id === d.data.id && r.pid === d.data.workerPid,
    );
    assert.ok(start, "missing dispatched worker/request trace");
    const terminal = records.some(
      (r) => r.event === "request-end" && r.boot === start.boot && r.request?.id === start.request.id,
    );
    const interrupted = records.some(
      (r) =>
        ["pool-timeout", "pool-failure"].includes(r.event) &&
        r.data.generation === d.data.generation &&
        r.data.id === d.data.id,
    );
    assert.ok(terminal || interrupted, "unterminated request without observed parent interruption");
  }
  const target = records.filter((r) => r.request?.path === TARGET || r.request?.path?.startsWith(TARGET + " ["));
  const beginnings = target.filter((r) => r.event === "request-begin");
  assert.ok(beginnings.length > 0, "silent-empty target trace");
  for (const start of beginnings) {
    const own = target.filter((r) => r.boot === start.boot && r.request.id === start.request.id);
    assert.ok(
      own.some((r) => r.event === "instantiate"),
      "target instantiate observation missing",
    );
    assert.ok(
      own.some((r) => r.event === "construct-enter"),
      "target constructor observation missing",
    );
    const end = own.find((r) => r.event === "request-end");
    assert.ok(end, "target terminal observation missing");
    if (end.data.status === "fail") {
      assert.ok(
        own.some((r) => r.event === "construct-refusal"),
        "failed target lacks refusal observation; attribution unavailable",
      );
      assert.ok(
        own.some((r) => r.event === "decoder-selected"),
        "failed target lacks decoder observation",
      );
      assert.ok(
        own.some((r) => r.event === "decoder-registry"),
        "failed target lacks retained registry observation",
      );
      assert.ok(
        own.some((r) => r.event === "construct-mirror"),
        "failed target lacks existing mirror length observation",
      );
    }
  }
  return {
    status: "OBSERVATIONS_AVAILABLE_NOT_CAUSAL_PROOF",
    streams: streams.length,
    workerReady: ready.length,
    dispatches: dispatches.length,
    targetRequests: beginnings.length,
    resets: records.filter((r) => r.event === "registry-reset").length,
    streamTails: streams.map((s) => ({
      boot: s[0].boot,
      pid: s[0].pid,
      availability:
        s.at(-1).event === "observer-exit" ? "exit-record-observed" : "unavailable-abrupt-or-unwritten-tail",
    })),
    sinkTailLimit:
      "a final failed write followed by abrupt death cannot report its lost counter; parent interruptions do not prove tail completeness",
    factoryIdentitiesAndNames: "unavailable-without-extra-compiled-reads",
    canonical939Proof: "separate original completeness gate required",
  };
}
export function auditObservationTrace(root = process.cwd()) {
  verifyObservationTrace(root);
  const dir = join(realpathSync(root), "replay5807-traces");
  assert.equal(realpathSync(dir), dir, "aliased trace directory");
  const paths = readdirSync(dir).sort();
  assert.ok(
    paths.every((p) => /^\d+-[0-9a-f-]+\.jsonl$/.test(p)),
    "unexpected trace artifact",
  );
  return auditTraceRecords(
    paths.map((path) => {
      const text = regular(dir, path);
      assert.ok(text.endsWith("\n"), "partial trace line");
      return text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  assert.equal(process.argv.length, 3, "usage: issue-5807-observation-trace.mjs install|verify|audit (cwd subject)");
  const mode = process.argv[2];
  assert.ok(["install", "verify", "audit"].includes(mode), "unknown trace mode");
  console.log(
    JSON.stringify(
      mode === "install"
        ? installObservationTrace()
        : mode === "verify"
          ? verifyObservationTrace()
          : auditObservationTrace(),
      null,
      2,
    ),
  );
}
