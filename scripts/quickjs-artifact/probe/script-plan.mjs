// Finite native acceptance fixture. No compiler/provider cache or consumer route.
// Shipped 42 and identified test-build 7 are separate receipts/denominators.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readQuickjsArtifact, assertQuickjsScriptPlanCapability } from "../../quickjs-eval-provider.mjs";
import { instantiateArtifact } from "../wasi-stub.mjs";
import { SCRIPT_PLAN_CASES, SCRIPT_PLAN_ALLOCATION_CASES } from "./script-plan-contract.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const RESOURCE_NAMES = ["nodes", "buffers", "plans", "atoms", "arrays", "compiled", "cells"];
const SNAPSHOT_SOURCE =
  "JSON.stringify(Object.getOwnPropertyNames(globalThis).map(function(n) { var d = Object.getOwnPropertyDescriptor(globalThis,n); return [n,d.configurable,d.enumerable,d.writable,typeof d.value,typeof d.value === 'object' || typeof d.value === 'function' ? null : String(d.value),typeof d.get,typeof d.set]; }));";
// Retain real native references for every descriptor value/getter/setter.
// The owned comparison closure is released BEFORE destroying its context.
const DESCRIPTOR_IDENTITY_SOURCE = `(function() {
  var global = globalThis, same = Object.is, names = Object.getOwnPropertyNames(global);
  var descriptors = names.map(function(name) { return Object.getOwnPropertyDescriptor(global, name); });
  return function() {
    var current = Object.getOwnPropertyNames(global);
    if (current.length !== names.length) return 0;
    for (var i = 0; i < names.length; i++) {
      if (current[i] !== names[i]) return 0;
      var before = descriptors[i], after = Object.getOwnPropertyDescriptor(global, names[i]);
      if (!after || before.configurable !== after.configurable || before.enumerable !== after.enumerable ||
          before.writable !== after.writable || !same(before.value, after.value) || !same(before.get, after.get) || !same(before.set, after.set)) return 0;
    }
    return 1;
  };
})()`;

function harness(Q, testBuild) {
  const bytes = (source) => {
    const data = new TextEncoder().encode(source);
    const pointer = Q.qjs_malloc_raw(data.length + 1);
    assert.notEqual(pointer, 0, "source/reader fixture allocation failed");
    new Uint8Array(Q.memory.buffer).set(data, pointer);
    new Uint8Array(Q.memory.buffer)[pointer + data.length] = 0;
    return { pointer, length: data.length };
  };
  const free = (ctx, value) => {
    if (testBuild) Q.qjs_script_plan_test_free_value(ctx, value);
    else Q.qjs_free_value(ctx, value);
  };
  const string = (ctx, value) => {
    const lengthPointer = Q.qjs_malloc_raw(4);
    assert.notEqual(lengthPointer, 0);
    const pointer = Q.qjs_to_cstring_len(ctx, value, lengthPointer);
    assert.notEqual(pointer, 0, "owned string conversion failed");
    const length = new DataView(Q.memory.buffer).getUint32(lengthPointer, true);
    const result = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(Q.memory.buffer, pointer, length));
    Q.qjs_free_raw(pointer);
    Q.qjs_free_raw(lengthPointer);
    return result;
  };
  const evalValue = (ctx, source) => {
    const input = bytes(source);
    const value = Q.qjs_eval(ctx, input.pointer, input.length);
    Q.qjs_free_raw(input.pointer);
    assert.notEqual(value, 0, "fixture eval lost completion cell");
    assert.equal(Q.qjs_is_exception(value), 0, `fixture setup/read failed: ${source}`);
    return value;
  };
  const number = (ctx, source) => {
    const value = evalValue(ctx, source);
    const result = Q.qjs_to_f64(ctx, value);
    free(ctx, value);
    return result;
  };
  const evalString = (ctx, source) => {
    const value = evalValue(ctx, source);
    const result = string(ctx, value);
    free(ctx, value);
    return result;
  };
  const property = (ctx, object, name) => {
    const input = bytes(name),
      value = Q.qjs_get_prop_str(ctx, object, input.pointer);
    Q.qjs_free_raw(input.pointer);
    assert.notEqual(value, 0);
    return value;
  };
  const pending = (ctx, expectedBrand = null) => {
    const exception = Q.qjs_take_exception(ctx);
    assert.notEqual(exception, 0, "fixture cannot read pending exception");
    const name = property(ctx, exception, "name"),
      brand = string(ctx, name);
    free(ctx, name);
    if (expectedBrand) assert.equal(brand, expectedBrand);
    return { exception, brand };
  };
  const rejectScalar = (ctx, operation, brand = "TypeError") => {
    assert.equal(operation(), -1);
    const error = pending(ctx, brand);
    free(ctx, error.exception);
  };
  const rejectValue = (ctx, operation, brand = "TypeError") => {
    const result = operation();
    assert.notEqual(result, 0);
    assert.equal(Q.qjs_is_exception(result), 1);
    free(ctx, result);
    const error = pending(ctx, brand);
    free(ctx, error.exception);
  };
  const compile = (ctx, source, replacement = null) => {
    const input = bytes(source);
    const id = Q.qjs_script_plan_compile(ctx, input.pointer, input.length) >>> 0;
    if (replacement !== null) {
      const data = new TextEncoder().encode(replacement);
      assert.ok(data.length <= input.length);
      new Uint8Array(Q.memory.buffer, input.pointer, input.length).fill(32);
      new Uint8Array(Q.memory.buffer).set(data, input.pointer);
    }
    Q.qjs_free_raw(input.pointer);
    return id;
  };
  const raw = (ctx, id) => {
    const count = Q.qjs_script_plan_count(ctx, id);
    assert.ok(count >= 0, "unreadable plan is not an empty list");
    return Array.from({ length: count }, (_, ordinal) => {
      const value = Q.qjs_script_plan_name(ctx, id, ordinal);
      assert.notEqual(value, 0);
      assert.equal(Q.qjs_is_exception(value), 0);
      const name = string(ctx, value);
      free(ctx, value);
      return {
        name,
        ordinal,
        kind: Q.qjs_script_plan_kind(ctx, id, ordinal),
        origin: Q.qjs_script_plan_origin(ctx, id, ordinal),
      };
    });
  };
  const resources = () =>
    testBuild ? Object.fromEntries(RESOURCE_NAMES.map((name) => [name, Q[`qjs_script_plan_test_${name}`]()])) : null;
  const seed = (ctx) => {
    const value = evalValue(
      ctx,
      "globalThis.__probe_body_effect__ = 0; globalThis.__probe_loop_effect__ = 0; globalThis.__probe_throw_marker__ = new Error('frozen marker');",
    );
    free(ctx, value);
  };
  const project = (rows) =>
    Array.from(
      new Map(
        rows
          .filter((row) => row.kind < 2)
          .map((row) => [
            row.name,
            [row.name, rows.some((other) => other.name === row.name && other.kind === 1) ? "function" : "var"],
          ]),
      ).values(),
    );
  const consume = (ctx, id, expected, name) => {
    const result = Q.qjs_script_plan_eval(ctx, id);
    assert.notEqual(result, 0);
    if (expected.exception) {
      assert.equal(Q.qjs_is_exception(result), 1);
      free(ctx, result);
      const exception = Q.qjs_take_exception(ctx),
        marker = evalValue(ctx, "globalThis.__probe_throw_marker__");
      assert.notEqual(exception, 0);
      assert.equal(Q.qjs_is_equal(ctx, exception, marker, 1), 1);
      free(ctx, exception);
      free(ctx, marker);
      assert.equal(number(ctx, "Object.prototype.hasOwnProperty.call(globalThis, 'retained') ? 1 : 0"), 1);
      assert.equal(number(ctx, "retainedFn()"), expected.selectedFunctionResult);
    } else {
      assert.equal(Q.qjs_is_exception(result), 0);
      if (expected.completion === "same-as-global-function") {
        const globalFunction = evalValue(ctx, name);
        assert.equal(Q.qjs_is_function(ctx, result), 1);
        assert.equal(Q.qjs_is_equal(ctx, result, globalFunction, 1), 1);
        const called = Q.qjs_call(ctx, result, 0, 0, 0);
        assert.notEqual(called, 0);
        assert.equal(Q.qjs_is_exception(called), 0);
        assert.equal(Q.qjs_to_f64(ctx, called), expected.selectedFunctionResult);
        free(ctx, called);
        free(ctx, globalFunction);
      } else if (typeof expected.completion === "number") assert.equal(Q.qjs_to_f64(ctx, result), expected.completion);
      free(ctx, result);
    }
    assert.equal(number(ctx, "globalThis.__probe_body_effect__"), expected.afterEvalBodyEffect);
  };
  const descriptorIdentity = (ctx, retained) => {
    const result = Q.qjs_call(ctx, retained, 0, 0, 0);
    assert.notEqual(result, 0);
    assert.equal(Q.qjs_is_exception(result), 0);
    const same = Q.qjs_to_f64(ctx, result);
    free(ctx, result);
    assert.equal(same, 1, "compile changed an own descriptor's exact value/getter/setter identity");
  };
  return {
    bytes,
    free,
    string,
    evalValue,
    number,
    evalString,
    pending,
    rejectScalar,
    rejectValue,
    compile,
    raw,
    resources,
    seed,
    project,
    consume,
    descriptorIdentity,
  };
}

async function runShipped(Q) {
  const H = harness(Q, false),
    results = [];
  for (const entry of SCRIPT_PLAN_CASES) {
    const receipt = {
      id: entry.id,
      source: entry.source,
      sourceSha256: entry.sourceSha256,
      expected: entry.expected,
      phase: "compile/read",
      status: "FAIL",
      actual: {},
    };
    let rt = 0,
      ctx = 0,
      id = 0,
      identity = 0;
    const extras = [],
      extraRuntimes = [],
      extraRuntimeContexts = [];
    try {
      rt = Q.qjs_new_runtime();
      assert.notEqual(rt, 0);
      ctx = Q.qjs_new_context(rt);
      assert.notEqual(ctx, 0);
      H.seed(ctx);
      const descriptors = H.evalString(ctx, SNAPSHOT_SOURCE);
      identity = H.evalValue(ctx, DESCRIPTOR_IDENTITY_SOURCE);
      H.descriptorIdentity(ctx, identity);
      const before = Q.qjs_malloc_count(rt);
      id = H.compile(ctx, entry.source, entry.expected.replacement ?? null);
      if (entry.expected.error) {
        assert.equal(id, 0);
        const error = H.pending(ctx, entry.expected.error);
        receipt.actual.errorBrand = error.brand;
        H.free(ctx, error.exception);
        receipt.actual.strict = null;
        receipt.actual.raw = [];
      } else {
        assert.notEqual(id, 0, "failed compile cannot publish an empty plan");
        const raw = H.raw(ctx, id),
          strictScalar = Q.qjs_script_plan_strict(ctx, id);
        assert.ok(strictScalar === 0 || strictScalar === 1, "strictness must be a successful 0/1 scalar");
        const strict = strictScalar === 1;
        receipt.actual.raw = raw;
        receipt.actual.strict = strict;
        receipt.actual.projection = H.project(raw);
        assert.deepEqual(raw, entry.expected.raw);
        assert.equal(strict, entry.expected.strict);
        assert.deepEqual(receipt.actual.projection, entry.expected.projection);
      }
      receipt.actual.bodyEffect = H.number(ctx, "globalThis.__probe_body_effect__");
      assert.equal(receipt.actual.bodyEffect, 0);
      assert.equal(H.number(ctx, "globalThis.__probe_loop_effect__"), 0);
      assert.equal(
        H.evalString(ctx, SNAPSHOT_SOURCE),
        descriptors,
        "compile published or changed a global own descriptor",
      );
      H.descriptorIdentity(ctx, identity);
      H.free(ctx, identity);
      identity = 0;
      receipt.actual.compileDescriptorIdentity = true;
      receipt.actual.engineAllocationCountBefore = before;
      receipt.actual.engineAllocationCountAfterCompile = Q.qjs_malloc_count(rt);
      const protocol = entry.expected.protocol;
      if (protocol === "invalid-index") {
        for (const index of entry.expected.invalidIndices) {
          H.rejectScalar(ctx, () => Q.qjs_script_plan_kind(ctx, id, index), "RangeError");
          H.rejectScalar(ctx, () => Q.qjs_script_plan_origin(ctx, id, index), "RangeError");
          H.rejectValue(ctx, () => Q.qjs_script_plan_name(ctx, id, index), "RangeError");
        }
        assert.equal(Q.qjs_script_plan_count(ctx, id), 1);
      } else if (protocol === "foreign-context") {
        const foreign = Q.qjs_new_context(rt);
        assert.notEqual(foreign, 0);
        extras.push(foreign);
        const other = H.compile(foreign, "var unrelated;");
        assert.notEqual(other, 0);
        for (const operation of [
          () => Q.qjs_script_plan_count(foreign, id),
          () => Q.qjs_script_plan_strict(foreign, id),
          () => Q.qjs_script_plan_kind(foreign, id, 0),
          () => Q.qjs_script_plan_origin(foreign, id, 0),
          () => Q.qjs_script_plan_free(foreign, id),
        ])
          H.rejectScalar(foreign, operation);
        H.rejectValue(foreign, () => Q.qjs_script_plan_name(foreign, id, 0));
        H.rejectValue(foreign, () => Q.qjs_script_plan_eval(foreign, id));
        assert.equal(Q.qjs_script_plan_count(ctx, id), 1);
        assert.equal(Q.qjs_script_plan_count(foreign, other), 1);
        assert.equal(Q.qjs_script_plan_free(foreign, other), 0);
      } else if (protocol === "stale-id-after-free" || protocol === "stale-id-after-context-free") {
        const stale = id;
        const foreign = Q.qjs_new_context(rt);
        assert.notEqual(foreign, 0);
        extras.push(foreign);
        const other = H.compile(foreign, "var unrelated;");
        assert.notEqual(other, 0);
        if (protocol === "stale-id-after-free") assert.equal(Q.qjs_script_plan_free(ctx, id), 0);
        else {
          Q.qjs_free_context(ctx);
          ctx = Q.qjs_new_context(rt);
          assert.notEqual(ctx, 0);
          H.seed(ctx);
        }
        id = 0;
        const replacement = H.compile(ctx, "var replacement;");
        assert.ok(replacement > stale);
        id = replacement;
        H.rejectScalar(ctx, () => Q.qjs_script_plan_count(ctx, stale));
        H.rejectScalar(ctx, () => Q.qjs_script_plan_free(ctx, stale));
        H.rejectValue(ctx, () => Q.qjs_script_plan_eval(ctx, stale));
        assert.equal(Q.qjs_script_plan_free(ctx, 0), 0);
        assert.equal(Q.qjs_script_plan_count(foreign, other), 1);
        assert.equal(Q.qjs_script_plan_free(foreign, other), 0);
      } else if (protocol === "discard-ready") {
        assert.equal(Q.qjs_script_plan_free(ctx, id), 0);
        id = 0;
        assert.equal(H.number(ctx, "globalThis.__probe_body_effect__"), 0);
        assert.equal(H.evalString(ctx, SNAPSHOT_SOURCE), descriptors);
      } else if (["identity", "normal-consume-once", "throw-consume-once", "source-buffer-reuse"].includes(protocol)) {
        receipt.phase = "evaluate-once";
        const selected = entry.expected.raw.find((record) => record.kind === 1)?.name;
        H.consume(ctx, id, entry.expected, selected);
        assert.deepEqual(H.raw(ctx, id), entry.expected.raw);
        H.rejectValue(ctx, () => Q.qjs_script_plan_eval(ctx, id));
        assert.equal(H.number(ctx, "globalThis.__probe_body_effect__"), entry.expected.afterEvalBodyEffect);
        receipt.actual.consumedOnce = true;
      } else if (protocol === "context-plan-cleanup" || protocol === "runtime-plan-cleanup") {
        // Normal teardown respects native preconditions: all contexts go first.
        const secondCtx = protocol === "runtime-plan-cleanup" ? Q.qjs_new_context(rt) : 0;
        if (protocol === "runtime-plan-cleanup") {
          assert.notEqual(secondCtx, 0);
          extras.push(secondCtx);
        }
        const second = H.compile(secondCtx || ctx, entry.source);
        assert.notEqual(second, 0);
        const third = H.compile(ctx, "globalThis.__probe_body_effect__++;");
        assert.notEqual(third, 0);
        const consumed = Q.qjs_script_plan_eval(ctx, third);
        assert.notEqual(consumed, 0);
        assert.equal(Q.qjs_is_exception(consumed), 0);
        H.free(ctx, consumed);
        const otherRt = Q.qjs_new_runtime();
        assert.notEqual(otherRt, 0);
        extraRuntimes.push(otherRt);
        const otherCtx = Q.qjs_new_context(otherRt);
        assert.notEqual(otherCtx, 0);
        extraRuntimeContexts.push(otherCtx);
        const survivor = H.compile(otherCtx, "var survivor;");
        assert.notEqual(survivor, 0);
        const stale = id;
        Q.qjs_free_context(ctx);
        ctx = 0;
        id = 0;
        if (secondCtx) {
          Q.qjs_free_context(secondCtx);
          extras.splice(extras.indexOf(secondCtx), 1);
        }
        if (protocol === "runtime-plan-cleanup") {
          Q.qjs_free_runtime(rt);
          rt = 0;
        }
        H.rejectScalar(otherCtx, () => Q.qjs_script_plan_count(otherCtx, stale));
        assert.equal(Q.qjs_script_plan_count(otherCtx, survivor), 1);
        assert.equal(Q.qjs_script_plan_free(otherCtx, survivor), 0);
        Q.qjs_free_context(otherCtx);
        extraRuntimeContexts.pop();
        Q.qjs_free_runtime(otherRt);
        extraRuntimes.pop();
        receipt.actual.normalTeardownOrder = "contexts-before-runtime";
      }
      receipt.status = "PASS";
    } catch (error) {
      receipt.actual.failure = error.stack ?? String(error);
    } finally {
      if (ctx && identity) H.free(ctx, identity);
      if (ctx && id) Q.qjs_script_plan_free(ctx, id);
      for (const extra of extras) Q.qjs_free_context(extra);
      if (ctx) Q.qjs_free_context(ctx);
      if (rt) Q.qjs_free_runtime(rt);
      for (const extra of extraRuntimeContexts) Q.qjs_free_context(extra);
      for (const extra of extraRuntimes) Q.qjs_free_runtime(extra);
    }
    results.push(receipt);
  }
  assert.equal(results.length, 42);
  return results;
}

async function runFaults(Q) {
  const H = harness(Q, true),
    results = [];
  for (const entry of SCRIPT_PLAN_ALLOCATION_CASES) {
    const receipt = { ...entry, phase: "allocation-failure-and-recovery", status: "FAIL", actual: {} };
    const rt = Q.qjs_new_runtime(),
      ctx = Q.qjs_new_context(rt);
    H.seed(ctx);
    let id = 0,
      identity = 0,
      survivor = H.compile(ctx, "var unrelated;");
    try {
      assert.notEqual(survivor, 0);
      if (entry.operation !== "compile") {
        id = H.compile(ctx, entry.source);
        assert.notEqual(id, 0);
      }
      const before = H.resources(),
        descriptors = H.evalString(ctx, SNAPSHOT_SOURCE),
        memoryBefore = Q.qjs_malloc_count(rt);
      identity = H.evalValue(ctx, DESCRIPTOR_IDENTITY_SOURCE);
      Q.qjs_script_plan_test_fail(entry.faultSite);
      const result =
        entry.operation === "compile"
          ? H.compile(ctx, entry.source)
          : entry.operation === "name"
            ? Q.qjs_script_plan_name(ctx, id, 0)
            : Q.qjs_script_plan_eval(ctx, id);
      assert.equal(result, 0);
      const error = H.pending(ctx, entry.expected.pendingError);
      receipt.actual.pendingBrand = error.brand;
      H.free(ctx, error.exception);
      Q.qjs_script_plan_test_fail(0);
      assert.equal(H.number(ctx, "globalThis.__probe_body_effect__"), 0);
      assert.equal(H.evalString(ctx, SNAPSHOT_SOURCE), descriptors);
      H.descriptorIdentity(ctx, identity);
      H.free(ctx, identity);
      identity = 0;
      receipt.actual.compileDescriptorIdentity = true;
      receipt.actual.before = before;
      receipt.actual.afterFailure = H.resources();
      assert.deepEqual(receipt.actual.afterFailure, before);
      assert.equal(Q.qjs_script_plan_count(ctx, survivor), 1);
      if (id) assert.equal(Q.qjs_script_plan_test_state(ctx, id), 0, "result-cell OOM changed READY state");
      else {
        id = H.compile(ctx, entry.source);
        assert.notEqual(id, 0);
      }
      assert.deepEqual(H.raw(ctx, id), entry.expected.recovery.raw);
      H.consume(
        ctx,
        id,
        { completion: "same-as-global-function", selectedFunctionResult: 11, afterEvalBodyEffect: 1 },
        "allocatedFn",
      );
      assert.equal(Q.qjs_script_plan_test_state(ctx, id), 2);
      assert.equal(Q.qjs_script_plan_free(ctx, id), 0);
      id = 0;
      assert.equal(Q.qjs_script_plan_free(ctx, survivor), 0);
      survivor = 0;
      receipt.actual.released = H.resources();
      assert.deepEqual(receipt.actual.released, Object.fromEntries(RESOURCE_NAMES.map((name) => [name, 0])));
      receipt.actual.engineAllocationCountBefore = memoryBefore;
      receipt.actual.engineAllocationCountAfterRecovery = Q.qjs_malloc_count(rt);
      receipt.status = "PASS";
    } catch (error) {
      receipt.actual.failure = error.stack ?? String(error);
    } finally {
      Q.qjs_script_plan_test_fail(0);
      if (identity) H.free(ctx, identity);
      if (id) Q.qjs_script_plan_free(ctx, id);
      if (survivor) Q.qjs_script_plan_free(ctx, survivor);
      Q.qjs_free_context(ctx);
      Q.qjs_free_runtime(rt);
    }
    receipt.actual.afterTeardown = H.resources();
    results.push(receipt);
  }
  assert.equal(results.length, 7);
  // A nonempty NORMAL context hook must also release READY and CONSUMED nodes;
  // neither explicit plan free nor the private runtime hook substitutes for it.
  const contextCleanup = { id: "test-only-nonempty-normal-context-cleanup", status: "FAIL", actual: {} };
  const contextRt = Q.qjs_new_runtime(),
    ownerCtx = Q.qjs_new_context(contextRt),
    survivorCtx = Q.qjs_new_context(contextRt);
  let ownerLive = true;
  try {
    const survivor = H.compile(survivorCtx, "var survivor;");
    assert.notEqual(survivor, 0);
    const unrelated = H.resources();
    const source = SCRIPT_PLAN_CASES.find((entry) => entry.id === "context-plan-cleanup").source;
    const ready1 = H.compile(ownerCtx, source),
      ready2 = H.compile(ownerCtx, source);
    assert.notEqual(ready1, 0);
    assert.notEqual(ready2, 0);
    const consumedId = H.compile(ownerCtx, ";");
    assert.notEqual(consumedId, 0);
    const completion = Q.qjs_script_plan_eval(ownerCtx, consumedId);
    assert.notEqual(completion, 0);
    assert.equal(Q.qjs_is_exception(completion), 0);
    H.free(ownerCtx, completion);
    contextCleanup.actual.statesBefore = [ready1, ready2, consumedId].map((id) =>
      Q.qjs_script_plan_test_state(ownerCtx, id),
    );
    assert.deepEqual(contextCleanup.actual.statesBefore, [0, 0, 2]);
    contextCleanup.actual.before = H.resources();
    assert.equal(contextCleanup.actual.before.nodes - unrelated.nodes, 3);
    Q.qjs_free_context(ownerCtx);
    ownerLive = false;
    contextCleanup.actual.after = H.resources();
    assert.deepEqual(contextCleanup.actual.after, unrelated);
    H.rejectScalar(survivorCtx, () => Q.qjs_script_plan_count(survivorCtx, consumedId));
    assert.equal(Q.qjs_script_plan_count(survivorCtx, survivor), 1);
    assert.equal(Q.qjs_script_plan_free(survivorCtx, survivor), 0);
    contextCleanup.actual.released = H.resources();
    assert.deepEqual(contextCleanup.actual.released, Object.fromEntries(RESOURCE_NAMES.map((name) => [name, 0])));
    contextCleanup.status = "PASS";
  } catch (error) {
    contextCleanup.actual.failure = error.stack ?? String(error);
  } finally {
    if (ownerLive) Q.qjs_free_context(ownerCtx);
    Q.qjs_free_context(survivorCtx);
    Q.qjs_free_runtime(contextRt);
  }
  contextCleanup.actual.afterTeardown = H.resources();
  // Nonempty private runtime backstop, separate from the normal runtime API.
  const backstop = { id: "test-only-nonempty-runtime-backstop", status: "FAIL", actual: {} };
  const rt = Q.qjs_new_runtime(),
    ctx1 = Q.qjs_new_context(rt),
    ctx2 = Q.qjs_new_context(rt);
  const otherRt = Q.qjs_new_runtime(),
    otherCtx = Q.qjs_new_context(otherRt);
  try {
    const survivor = H.compile(otherCtx, "var survivor;");
    assert.notEqual(survivor, 0);
    const unrelated = H.resources();
    const source = SCRIPT_PLAN_CASES.find((entry) => entry.id === "runtime-plan-cleanup").source;
    const ready1 = H.compile(ctx1, source),
      ready2 = H.compile(ctx2, source);
    assert.notEqual(ready1, 0);
    assert.notEqual(ready2, 0);
    const consumedId = H.compile(ctx1, ";");
    assert.notEqual(consumedId, 0);
    const completion = Q.qjs_script_plan_eval(ctx1, consumedId);
    assert.notEqual(completion, 0);
    assert.equal(Q.qjs_is_exception(completion), 0);
    H.free(ctx1, completion);
    backstop.actual.statesBefore = [
      Q.qjs_script_plan_test_state(ctx1, ready1),
      Q.qjs_script_plan_test_state(ctx2, ready2),
      Q.qjs_script_plan_test_state(ctx1, consumedId),
    ];
    assert.deepEqual(backstop.actual.statesBefore, [0, 0, 2]);
    backstop.actual.before = H.resources();
    assert.equal(backstop.actual.before.nodes - unrelated.nodes, 3);
    Q.qjs_script_plan_test_release_runtime(rt);
    backstop.actual.after = H.resources();
    assert.deepEqual(backstop.actual.after, unrelated);
    assert.equal(Q.qjs_script_plan_count(otherCtx, survivor), 1);
    assert.equal(Q.qjs_script_plan_free(otherCtx, survivor), 0);
    backstop.actual.released = H.resources();
    assert.deepEqual(backstop.actual.released, Object.fromEntries(RESOURCE_NAMES.map((name) => [name, 0])));
    backstop.status = "PASS";
  } catch (error) {
    backstop.actual.failure = error.stack ?? String(error);
  } finally {
    Q.qjs_free_context(ctx1);
    Q.qjs_free_context(ctx2);
    Q.qjs_free_runtime(rt);
    Q.qjs_free_context(otherCtx);
    Q.qjs_free_runtime(otherRt);
  }
  backstop.actual.afterTeardown = H.resources();
  return { results, contextCleanup, backstop };
}

async function main(args) {
  const [mode, dir, receiptPath] = args;
  if (!["--shipped", "--faults"].includes(mode) || !dir || !receiptPath)
    throw new Error("usage: script-plan.mjs --shipped|--faults ARTIFACT_DIR RECEIPT_JSON");
  const testBuild = mode === "--faults";
  const artifact = readQuickjsArtifact(resolve(dir), { requiredScriptPlanVersion: 1, allowTestBuild: testBuild });
  if (!artifact) throw new Error("missing native artifact (no implicit build)");
  const { instance, captured } = await instantiateArtifact(artifact.binary);
  assertQuickjsScriptPlanCapability(artifact, 1, { allowTestBuild: testBuild, instance });
  const output = testBuild ? await runFaults(instance.exports) : { results: await runShipped(instance.exports) };
  const receipt = {
    kind: testBuild ? "script-plan-test-build-allocation" : "script-plan-shipped-native",
    node: process.version,
    artifactSha256: artifact.sha256,
    abiSha256: artifact.abiSha256,
    buildInfo: artifact.buildInfo,
    contractSha256: hash(readFileSync(fileURLToPath(new URL("./script-plan-contract.mjs", import.meta.url)))),
    denominator: testBuild ? 7 : 42,
    ...output,
    captured,
  };
  writeFileSync(resolve(receiptPath), JSON.stringify(receipt, null, 2) + "\n");
  const passed = output.results.filter((entry) => entry.status === "PASS").length;
  console.log(
    JSON.stringify({
      receipt: resolve(receiptPath),
      passed,
      registered: output.results.length,
      contextCleanup: output.contextCleanup?.status,
      backstop: output.backstop?.status,
      artifactSha256: artifact.sha256,
    }),
  );
  if (
    passed !== receipt.denominator ||
    (testBuild && (output.backstop.status !== "PASS" || output.contextCleanup.status !== "PASS"))
  )
    process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
