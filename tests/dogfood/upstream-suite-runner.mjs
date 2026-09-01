import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as ts from "typescript";
import { readWorkerCompileDuration, stripWorkerProtocol } from "./upstream-suite-worker-protocol.mjs";

// The assertions are intentionally small, deterministic JavaScript. They are
// runner infrastructure; the registered callback bodies remain the exact
// upstream source. Both Node and Wasm execute this same shim.
export const UPSTREAM_TEST_SHIM = String.raw`
// Node exposes the process-wide host as the global binding; browser-oriented upstream
// suites (including Redux's warning tests) use that spelling directly. Keep
// the alias explicit in both the native and Wasm lanes instead of treating a
// missing Node compatibility global as a package failure.
var global = globalThis;
// Some original Jest units pass the timer globals as bare identifiers. Keep
// those names live through globalThis so fake-timer installation and spy
// replacement update the same host function in both Node and Wasm lanes.
function setTimeout(callback, delay) {
  if (__upstreamFakeTimers !== null) {
    __upstreamRecordTimerSpy("setTimeout", [callback, delay]);
    return __upstreamFakeTimers.fakeSetTimeout(callback, delay);
  }
  return globalThis.setTimeout(callback, delay);
}
function clearTimeout(timer) {
  if (__upstreamFakeTimers !== null) {
    __upstreamRecordTimerSpy("clearTimeout", [timer]);
    return __upstreamFakeTimers.fakeClearTimeout(timer);
  }
  return globalThis.clearTimeout(timer);
}
const __upstreamBareTimerAliases = { setTimeout, clearTimeout };
const __upstreamTests = [];
const __upstreamErrors = [];
let __upstreamSnapshotMatcher = null;
let __upstreamSnapshotEntries = null;
let __upstreamSnapshotUsed = null;
let __upstreamCurrentTestName = "";
let __upstreamAssertion = 0;
function __upstreamFail(message) { throw new Error(String(message || "Assertion failed")); }
function __upstreamValue(value) {
  const kind = typeof value;
  if (value === null || kind === "undefined" || kind === "string" || kind === "number" || kind === "boolean") {
    return kind + ":" + String(value);
  }
  return kind;
}
function __upstreamSame(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && +a === +b;
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!aIsArray || !bIsArray || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!__upstreamSame(a[i], b[i])) return false;
    return true;
  }
  const aIsSet = a instanceof Set;
  const bIsSet = b instanceof Set;
  if (aIsSet || bIsSet) {
    if (!aIsSet || !bIsSet || a.size !== b.size) return false;
    const unmatched = Array.from(b);
    for (const value of a) {
      const index = unmatched.findIndex((candidate) => __upstreamSame(value, candidate));
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }
  const aIsMap = a instanceof Map;
  const bIsMap = b instanceof Map;
  if (aIsMap || bIsMap) {
    if (!aIsMap || !bIsMap || a.size !== b.size) return false;
    const unmatched = Array.from(b);
    for (const [key, value] of a) {
      const index = unmatched.findIndex(
        (candidate) => __upstreamSame(key, candidate[0]) && __upstreamSame(value, candidate[1]),
      );
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }
  if (typeof a.length === "number" || typeof b.length === "number") {
    if (typeof a.length !== "number" || typeof b.length !== "number" || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!__upstreamSame(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const key = ak[i];
    if (!Object.prototype.hasOwnProperty.call(b, key) || !__upstreamSame(a[key], b[key])) return false;
  }
  return true;
}
function __upstreamSubset(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (actual == null || expected == null || typeof expected !== "object") return false;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index++) {
      if (!__upstreamSubset(actual[index], expected[index])) return false;
    }
    return true;
  }
  const keys = Object.keys(expected);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!(key in Object(actual)) || !__upstreamSubset(actual[key], expected[key])) return false;
  }
  return true;
}
function __upstreamThrown(value) {
  try { value(); } catch (error) { return error; }
  return null;
}
function __upstreamThrownMatches(error, expected) {
  if (error === null) return false;
  if (expected === undefined) return true;
  const message = error && error.message !== undefined ? String(error.message) : String(error);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "string") return message.includes(expected);
  if (typeof expected === "function") return error instanceof expected || error.name === expected.name;
  return true;
}
function __upstreamNormalizeAnsi(value) {
  return String(value)
    .replace(/\u001b\[2m/g, "<dim>")
    .replace(/\u001b\[22m/g, "</intensity>")
    .replace(/\u001b\[0m/g, "</>");
}
function __upstreamInstallSnapshotMatcher(entries) {
  __upstreamSnapshotEntries = entries;
  __upstreamSnapshotUsed = [];
}
function __upstreamSnapshotMatches(actual) {
  if (__upstreamSnapshotEntries === null || __upstreamSnapshotUsed === null) return false;
  const current = String(__upstreamCurrentTestName);
  const serialized = __upstreamNormalizeAnsi(
    typeof __upstreamPrettyFormat === "function"
      ? __upstreamPrettyFormat(actual, {escapeString: false})
      : String(actual),
  );
  const candidates = [];
  for (let index = 0; index < __upstreamSnapshotEntries.length; index++) {
    const name = String(__upstreamSnapshotEntries[index][0]);
    if (__upstreamSnapshotUsed[index] || (name !== current && !name.endsWith(" " + current))) continue;
    const expected = String(__upstreamSnapshotEntries[index][1]);
    candidates.push(expected);
    const stringSnapshotMatches = typeof actual === "string" && serialized === '"' + expected + '"';
    if (serialized === expected || stringSnapshotMatches) {
      __upstreamSnapshotUsed[index] = true;
      return true;
    }
  }
  if (candidates.length > 0) __upstreamFail("snapshot mismatch: " + serialized + " != " + candidates.join(" || "));
  return false;
}
function __upstreamAsyncReject(actual, expected, label) {
  return Promise.resolve(actual).then(
    function() { __upstreamFail(label + " expected a rejected promise"); },
    function(error) {
      if (!__upstreamThrownMatches(error, expected)) {
        __upstreamFail(label + " received an unexpected error: " + (error && error.message !== undefined ? error.message : String(error)));
      }
    },
  );
}
function __upstreamAsyncResolve(actual, matcher, expected, hasExpected, label) {
  return Promise.resolve(actual).then(
    function(value) {
      const assertion = __upstreamExpect(value);
      return hasExpected ? assertion[matcher](expected) : assertion[matcher]();
    },
    function(error) {
      __upstreamFail(label + " received an unexpected rejection: " + (error && error.message !== undefined ? error.message : String(error)));
    },
  );
}
function __upstreamNormalizeInlineSnapshot(value) {
  return String(value)
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/,\n([}\]])/g, "\n$1");
}
function __upstreamInlineSnapshotValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
function __upstreamExpect(actual) {
  const positive = {
    toBe(expected) { const n = ++__upstreamAssertion; if (!Object.is(actual, expected)) __upstreamFail("assertion " + n + " toBe: " + __upstreamValue(actual) + " != " + __upstreamValue(expected)); },
    toEqual(expected) { const n = ++__upstreamAssertion; if (!__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + " toEqual mismatch"); },
    toStrictEqual(expected) { const n = ++__upstreamAssertion; if (!__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + " toStrictEqual mismatch"); },
    toBeUndefined() { const n = ++__upstreamAssertion; if (actual !== undefined) __upstreamFail("assertion " + n + " expected undefined, got " + __upstreamValue(actual)); },
    toBeDefined() { const n = ++__upstreamAssertion; if (actual === undefined) __upstreamFail("assertion " + n + " expected defined value"); },
    toBeNull() { const n = ++__upstreamAssertion; if (actual !== null) __upstreamFail("assertion " + n + " expected null, got " + __upstreamValue(actual)); },
    toBeTruthy() { const n = ++__upstreamAssertion; if (!actual) __upstreamFail("assertion " + n + " expected truthy value"); },
    toBeFalsy() { const n = ++__upstreamAssertion; if (actual) __upstreamFail("assertion " + n + " expected falsey value"); },
    toHaveLength(expected) { const n = ++__upstreamAssertion; if (actual == null || actual.length !== expected) __upstreamFail("assertion " + n + " length mismatch"); },
    toContain(expected) { const n = ++__upstreamAssertion; if (actual == null || typeof actual.includes !== "function" || !actual.includes(expected)) __upstreamFail("assertion " + n + " expected contained value"); },
    toHaveProperty(expected) { const n = ++__upstreamAssertion; if (actual == null || !(expected in Object(actual))) __upstreamFail("assertion " + n + " missing property " + String(expected)); },
    toMatchObject(expected) { const n = ++__upstreamAssertion; if (!__upstreamSubset(actual, expected)) __upstreamFail("assertion " + n + " object subset mismatch"); },
    toMatch(expected) { const n = ++__upstreamAssertion; const value = String(actual); if (expected instanceof RegExp ? !expected.test(value) : !value.includes(String(expected))) __upstreamFail("assertion " + n + " pattern mismatch"); },
    toMatchInlineSnapshot(expected) { const n = ++__upstreamAssertion; const value = __upstreamNormalizeInlineSnapshot(__upstreamInlineSnapshotValue(actual)); const snapshot = __upstreamNormalizeInlineSnapshot(expected); if (value !== snapshot) __upstreamFail("assertion " + n + " inline snapshot mismatch: " + value + " != " + snapshot); },
    toBeGreaterThan(expected) { const n = ++__upstreamAssertion; if (!(actual > expected)) __upstreamFail("assertion " + n + " expected greater value"); },
    toBeCalled() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (!calls || calls.length === 0) __upstreamFail("assertion " + n + " expected spy to be called"); },
    toHaveBeenCalled() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (!calls || calls.length === 0) __upstreamFail("assertion " + n + " expected spy to be called"); },
    toBeCalledWith() { const n = ++__upstreamAssertion; const expected = Array.prototype.slice.call(arguments); const calls = __upstreamMockCalls(actual); let matched = false; if (calls) for (let i = 0; i < calls.length; i++) if (__upstreamSame(calls[i], expected)) matched = true; if (!matched) __upstreamFail("assertion " + n + " expected matching spy call"); },
    toHaveBeenCalledWith() { const n = ++__upstreamAssertion; const expected = Array.prototype.slice.call(arguments); const calls = __upstreamMockCalls(actual); let matched = false; if (calls) for (let i = 0; i < calls.length; i++) if (__upstreamSame(calls[i], expected)) matched = true; if (!matched) __upstreamFail("assertion " + n + " expected matching spy call"); },
    toHaveBeenLastCalledWith() { const n = ++__upstreamAssertion; const expected = Array.prototype.slice.call(arguments); const calls = __upstreamMockCalls(actual); const last = calls && calls.length > 0 ? calls[calls.length - 1] : undefined; if (!__upstreamSame(last, expected)) __upstreamFail("assertion " + n + " expected matching last spy call"); },
    toHaveBeenCalledTimes(expected) { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (!calls || calls.length !== expected) __upstreamFail("assertion " + n + " spy call count mismatch"); },
    toHaveBeenCalledOnce() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (!calls || calls.length !== 1) __upstreamFail("assertion " + n + " spy call count mismatch"); },
    toBeCalledOnce() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (!calls || calls.length !== 1) __upstreamFail("assertion " + n + " spy call count mismatch"); },
    toBeInstanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected !== "function" || !(actual instanceof expected)) __upstreamFail("assertion " + n + " instance mismatch"); },
    instanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected !== "function" || !(actual instanceof expected)) __upstreamFail("assertion " + n + " instance mismatch"); },
    toMatchSnapshot() {
      if (__upstreamSnapshotEntries === null && typeof __upstreamSnapshotMatcher !== "function") {
        __upstreamFail("snapshot assertion requires a package-specific snapshot adapter");
      }
      const n = ++__upstreamAssertion;
      const matched =
        __upstreamSnapshotEntries !== null ? __upstreamSnapshotMatches(actual) : __upstreamSnapshotMatcher(actual);
      if (!matched) __upstreamFail("snapshot mismatch at assertion " + n);
    },
    toThrow(expected) { const n = ++__upstreamAssertion; if (typeof actual !== "function" || !__upstreamThrownMatches(__upstreamThrown(actual), expected)) __upstreamFail("assertion " + n + " expected matching throw"); },
    toThrowError(expected) { const n = ++__upstreamAssertion; if (typeof actual !== "function" || !__upstreamThrownMatches(__upstreamThrown(actual), expected)) __upstreamFail("assertion " + n + " expected matching throw"); },
  };
  positive.not = {
    toBe(expected) { const n = ++__upstreamAssertion; if (Object.is(actual, expected)) __upstreamFail("assertion " + n + " unexpected equal value"); },
    toEqual(expected) { const n = ++__upstreamAssertion; if (__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + " unexpected deep equality"); },
    toBeUndefined() { const n = ++__upstreamAssertion; if (actual === undefined) __upstreamFail("assertion " + n + " unexpectedly undefined"); },
    toBeDefined() { const n = ++__upstreamAssertion; if (actual !== undefined) __upstreamFail("assertion " + n + " unexpectedly defined"); },
    toBeNull() { const n = ++__upstreamAssertion; if (actual === null) __upstreamFail("assertion " + n + " unexpectedly null"); },
    toBeTruthy() { const n = ++__upstreamAssertion; if (actual) __upstreamFail("assertion " + n + " unexpectedly truthy"); },
    toBeFalsy() { const n = ++__upstreamAssertion; if (!actual) __upstreamFail("assertion " + n + " unexpectedly falsey"); },
    toMatchInlineSnapshot(expected) { const n = ++__upstreamAssertion; const value = __upstreamNormalizeInlineSnapshot(__upstreamInlineSnapshotValue(actual)); const snapshot = __upstreamNormalizeInlineSnapshot(expected); if (value === snapshot) __upstreamFail("assertion " + n + " unexpectedly matched inline snapshot"); },
    toBeInstanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected === "function" && actual instanceof expected) __upstreamFail("assertion " + n + " unexpected instance"); },
    instanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected === "function" && actual instanceof expected) __upstreamFail("assertion " + n + " unexpected instance"); },
    toBeCalled() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (calls && calls.length > 0) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toHaveBeenCalled() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (calls && calls.length > 0) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toHaveBeenCalledOnce() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (calls && calls.length === 1) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toBeCalled() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (calls && calls.length > 0) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toHaveBeenCalled() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (calls && calls.length > 0) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toHaveBeenCalledOnce() { const n = ++__upstreamAssertion; const calls = __upstreamMockCalls(actual); if (calls && calls.length === 1) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toThrow(expected) { const n = ++__upstreamAssertion; const error = typeof actual === "function" ? __upstreamThrown(actual) : new Error("not callable"); if (error !== null && (expected === undefined || __upstreamThrownMatches(error, expected))) __upstreamFail("assertion " + n + " unexpected throw"); },
    toThrowError(expected) { const n = ++__upstreamAssertion; const error = typeof actual === "function" ? __upstreamThrown(actual) : new Error("not callable"); if (error !== null && (expected === undefined || __upstreamThrownMatches(error, expected))) __upstreamFail("assertion " + n + " unexpected throw"); },
  };
  // Vitest/Jest promise assertions are part of the upstream test contract,
  // not optional syntax. Attach rejection handlers immediately so a rejected
  // Request/Response promise cannot become an unhandled host error before the
  // lifted async test awaits it.
  positive.rejects = {
    toThrow(expected) { return __upstreamAsyncReject(actual, expected, "rejects.toThrow"); },
    toThrowError(expected) { return __upstreamAsyncReject(actual, expected, "rejects.toThrowError"); },
    toThrowErrorMatchingInlineSnapshot(expected) { return __upstreamAsyncReject(actual, expected, "rejects.toThrowErrorMatchingInlineSnapshot"); },
  };
  positive.resolves = {
    toBe(expected) { return __upstreamAsyncResolve(actual, "toBe", expected, true, "resolves"); },
    toEqual(expected) { return __upstreamAsyncResolve(actual, "toEqual", expected, true, "resolves"); },
    toStrictEqual(expected) { return __upstreamAsyncResolve(actual, "toStrictEqual", expected, true, "resolves"); },
    toBeDefined() { return __upstreamAsyncResolve(actual, "toBeDefined", undefined, false, "resolves"); },
    toBeNull() { return __upstreamAsyncResolve(actual, "toBeNull", undefined, false, "resolves"); },
    toBeTruthy() { return __upstreamAsyncResolve(actual, "toBeTruthy", undefined, false, "resolves"); },
    toBeFalsy() { return __upstreamAsyncResolve(actual, "toBeFalsy", undefined, false, "resolves"); },
    toHaveLength(expected) { return __upstreamAsyncResolve(actual, "toHaveLength", expected, true, "resolves"); },
    toContain(expected) { return __upstreamAsyncResolve(actual, "toContain", expected, true, "resolves"); },
  };
  return positive;
}
const expect = __upstreamExpect;
const __upstreamGlobalStubs = [];
const __upstreamEnvStubs = [];
const __upstreamSpies = [];
const __upstreamSpyFunctions = [];
// Keep scalar call counts in a flat host vector. Nested WasmGC vectors are
// copied when stored in another host-like vector and do not receive later
// writes from the callback closure.
const __upstreamSpyCallCounts = [];
const __upstreamSpyCallBases = [];
const __upstreamSpyCallOwners = [];
const __upstreamSpyCallStarts = [];
const __upstreamSpyCallLengths = [];
const __upstreamSpyCallValues = [];
const __upstreamTimerSpies = { setTimeout: null, clearTimeout: null };
let __upstreamSetTimeoutCallCount = 0;
let __upstreamClearTimeoutCallCount = 0;
function __upstreamMockCallsByIndex(index) {
  const calls = [];
  const base = __upstreamSpyCallBases[index] || 0;
  for (let record = base; record < __upstreamSpyCallOwners.length; record++) {
    if (__upstreamSpyCallOwners[record] !== index) continue;
    const args = [];
    const start = __upstreamSpyCallStarts[record] || 0;
    const length = __upstreamSpyCallLengths[record] || 0;
    for (let arg = 0; arg < length; arg++) args.push(__upstreamSpyCallValues[start + arg]);
    calls.push(args);
  }
  return calls;
}
function __upstreamMockCalls(actual) {
  if (actual === __upstreamBareTimerAliases.setTimeout) {
    return { length: __upstreamSetTimeoutCallCount };
  }
  if (actual === __upstreamBareTimerAliases.clearTimeout) {
    return { length: __upstreamClearTimeoutCallCount };
  }
  for (let index = 0; index < __upstreamSpyFunctions.length; index++) {
    if (__upstreamSpyFunctions[index] === actual) return __upstreamMockCallsByIndex(index);
  }
  // Keep the live mock.calls vector on the spy itself. A WasmGC vector stored
  // inside another host-like vector is copied at the boundary and then stops
  // reflecting later callback invocations.
  const directMock = actual && actual.mock;
  if (directMock && directMock.calls) return directMock.calls;
  return undefined;
}
function __upstreamRecordTimerSpy(key, args) {
  if (key === "setTimeout") __upstreamSetTimeoutCallCount++;
  else if (key === "clearTimeout") __upstreamClearTimeoutCallCount++;
}
const vi = {
  fn(implementation) {
    const spyIndex = __upstreamSpyFunctions.length;
    __upstreamSpyCallCounts.push(0);
    __upstreamSpyCallBases.push(__upstreamSpyCallOwners.length);
    function spy(...args) {
      __upstreamSpyCallCounts[spyIndex] = (__upstreamSpyCallCounts[spyIndex] || 0) + 1;
      __upstreamSpyCallOwners.push(spyIndex);
      __upstreamSpyCallStarts.push(__upstreamSpyCallValues.length);
      __upstreamSpyCallLengths.push(args.length);
      for (let index = 0; index < args.length; index++) __upstreamSpyCallValues.push(args[index]);
      if (typeof implementation === "function") return implementation.apply(this, args);
    }
    __upstreamSpyFunctions.push(spy);
    const mock = {};
    Object.defineProperty(mock, "calls", {
      get() { return __upstreamMockCallsByIndex(spyIndex); },
      enumerable: true,
      configurable: true,
    });
    spy.mock = mock;
    spy.mockClear = function() {
      __upstreamSpyCallCounts[spyIndex] = 0;
      __upstreamSpyCallBases[spyIndex] = __upstreamSpyCallOwners.length;
      return spy;
    };
    spy.mockReturnValue = function(value) { implementation = function() { return value; }; return spy; };
    spy.mockImplementation = function(next) { implementation = next; return spy; };
    spy.mockRestore = function() {};
    return spy;
  },
  spyOn(object, key) {
    const original = object[key];
    const spy = vi.fn(function() { return original.apply(this, arguments); });
    spy.mockRestore = function() {
      object[key] = original;
      if (__upstreamTimerSpies[key] === spy) __upstreamTimerSpies[key] = null;
    };
    const bareAlias = __upstreamBareTimerAliases[key];
    if (bareAlias !== undefined) {
      bareAlias.mock = spy.mock;
      bareAlias.mockClear = spy.mockClear;
      bareAlias.mockRestore = spy.mockRestore;
      __upstreamTimerSpies[key] = spy;
      if (key === "setTimeout") __upstreamSetTimeoutCallCount = 0;
      else if (key === "clearTimeout") __upstreamClearTimeoutCallCount = 0;
    }
    __upstreamSpies.push({ object, key, original, spy });
    object[key] = spy;
    return spy;
  },
  stubGlobal(key, value) {
    const name = String(key);
    const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, name);
    __upstreamGlobalStubs.push({ name, hadOwn, previous: globalThis[name] });
    globalThis[name] = value;
  },
  unstubAllGlobals() {
    for (let index = __upstreamGlobalStubs.length - 1; index >= 0; index--) {
      const stub = __upstreamGlobalStubs[index];
      if (stub.hadOwn) globalThis[stub.name] = stub.previous;
      else delete globalThis[stub.name];
    }
    __upstreamGlobalStubs.length = 0;
  },
  stubEnv(key, value) {
    if (globalThis.process && globalThis.process.env) {
      const env = globalThis.process.env;
      const name = String(key);
      __upstreamEnvStubs.push({ env, name, hadOwn: Object.prototype.hasOwnProperty.call(env, name), previous: env[name] });
      env[name] = String(value);
    }
  },
  unstubAllEnvs() {
    for (let index = __upstreamEnvStubs.length - 1; index >= 0; index--) {
      const stub = __upstreamEnvStubs[index];
      if (stub.hadOwn) stub.env[stub.name] = stub.previous;
      else delete stub.env[stub.name];
    }
    __upstreamEnvStubs.length = 0;
  },
};
function __upstreamRestoreAllMocks() {
  for (let index = __upstreamSpies.length - 1; index >= 0; index--) {
    const spy = __upstreamSpies[index];
    spy.spy.mockRestore();
  }
  __upstreamSpies.length = 0;
  __upstreamTimerSpies.setTimeout = null;
  __upstreamTimerSpies.clearTimeout = null;
  __upstreamSetTimeoutCallCount = 0;
  __upstreamClearTimeoutCallCount = 0;
}
let __upstreamFakeTimers = null;
function __upstreamUseFakeTimers() {
  if (__upstreamFakeTimers !== null) return jest;
  const timers = new Map();
  let nextTimerId = 1;
  let now = 0;
  const fakeSetTimeout = function(callback, delay) {
    const id = nextTimerId++;
    const normalizedDelay = Math.max(0, Number(delay) || 0);
    timers.set(id, { callback, at: now + normalizedDelay });
    return id;
  };
  const fakeClearTimeout = function(id) {
    timers.delete(id);
  };
  __upstreamFakeTimers = { timers, fakeSetTimeout, fakeClearTimeout, get now() { return now; }, set now(value) { now = value; } };
  return jest;
}
function __upstreamNextTimer() {
  if (__upstreamFakeTimers === null || __upstreamFakeTimers.timers.size === 0) return null;
  let next = null;
  for (const [id, entry] of __upstreamFakeTimers.timers) {
    if (next === null || entry.at < next.entry.at || (entry.at === next.entry.at && id < next.id)) {
      next = { id, entry };
    }
  }
  return next;
}
function __upstreamRunTimer(next) {
  if (__upstreamFakeTimers === null || next === null) return;
  if (!__upstreamFakeTimers.timers.has(next.id)) return;
  __upstreamFakeTimers.timers.delete(next.id);
  __upstreamFakeTimers.now = Math.max(__upstreamFakeTimers.now, next.entry.at);
  next.entry.callback();
}
function __upstreamRunAllTimers() {
  if (__upstreamFakeTimers === null) return;
  let guard = 10000;
  while (__upstreamFakeTimers.timers.size > 0) {
    if (--guard < 0) throw new Error("fake timer queue exceeded 10000 callbacks");
    __upstreamRunTimer(__upstreamNextTimer());
  }
}
function __upstreamAdvanceTimersByTime(milliseconds) {
  if (__upstreamFakeTimers === null) return;
  const target = __upstreamFakeTimers.now + Math.max(0, Number(milliseconds) || 0);
  let guard = 10000;
  while (__upstreamFakeTimers.timers.size > 0) {
    if (--guard < 0) throw new Error("fake timer queue exceeded 10000 callbacks");
    const next = __upstreamNextTimer();
    if (next === null || next.entry.at > target) break;
    __upstreamRunTimer(next);
  }
  __upstreamFakeTimers.now = target;
}
function __upstreamRunOnlyPendingTimers() {
  if (__upstreamFakeTimers === null) return;
  const pending = Array.from(__upstreamFakeTimers.timers.keys());
  for (const id of pending) {
    const entry = __upstreamFakeTimers.timers.get(id);
    if (entry !== undefined) __upstreamRunTimer({ id, entry });
  }
}
function __upstreamClearAllTimers() {
  if (__upstreamFakeTimers !== null) __upstreamFakeTimers.timers.clear();
}
function __upstreamGetTimerCount() {
  return __upstreamFakeTimers === null ? 0 : __upstreamFakeTimers.timers.size;
}
function __upstreamRunAllTimersAsync() {
  __upstreamRunAllTimers();
  return Promise.resolve();
}
function __upstreamAdvanceTimersByTimeAsync(milliseconds) {
  __upstreamAdvanceTimersByTime(milliseconds);
  return Promise.resolve();
}
function __upstreamRunOnlyPendingTimersAsync() {
  __upstreamRunOnlyPendingTimers();
  return Promise.resolve();
}
function __upstreamUseRealTimers() {
  __upstreamRestoreAllMocks();
  if (__upstreamFakeTimers === null) return jest;
  __upstreamFakeTimers = null;
  return jest;
}
function __upstreamSetSystemTime(value) {
  if (__upstreamFakeTimers !== null) {
    const timestamp = value instanceof Date ? value.getTime() : Number(value);
    if (Number.isFinite(timestamp)) __upstreamFakeTimers.now = timestamp;
  }
}
function __upstreamNow() {
  return __upstreamFakeTimers === null ? Date.now() : __upstreamFakeTimers.now;
}
function __upstreamGetRealSystemTime() {
  return Date.now();
}
// A number of Jest-owned packages publish their original tests with the Jest
// global even when the selected unit only needs spies. Keep this small facade
// backed by the same deterministic implementation as vi; package adapters can
// add a package-specific module/mock registry when a test needs more than
// function spies.
const jest = {
  fn: vi.fn,
  spyOn: vi.spyOn,
  resetModules() {},
  doMock() {},
  // The selected original units use isolateModules to make a fresh require
  // boundary. Each compiled test file already runs in its own worker/module,
  // so invoke the callback directly while preserving the public Jest seam.
  isolateModules(callback) {
    return callback();
  },
  useFakeTimers: __upstreamUseFakeTimers,
  useRealTimers: __upstreamUseRealTimers,
  runAllTimers: __upstreamRunAllTimers,
  runAllTimersAsync: __upstreamRunAllTimersAsync,
  advanceTimersByTime: __upstreamAdvanceTimersByTime,
  advanceTimersByTimeAsync: __upstreamAdvanceTimersByTimeAsync,
  runOnlyPendingTimers: __upstreamRunOnlyPendingTimers,
  runOnlyPendingTimersAsync: __upstreamRunOnlyPendingTimersAsync,
  clearAllTimers: __upstreamClearAllTimers,
  getTimerCount: __upstreamGetTimerCount,
  setSystemTime: __upstreamSetSystemTime,
  now: __upstreamNow,
  getRealSystemTime: __upstreamGetRealSystemTime,
  restoreAllMocks: __upstreamRestoreAllMocks,
};
const __upstreamBeforeEach = [];
const __upstreamAfterEach = [];
const __upstreamBeforeAll = [];
const __upstreamAfterAll = [];
function describe(_name, body) {
  const hookCount = __upstreamBeforeEach.length;
  const afterHookCount = __upstreamAfterEach.length;
  const beforeAllCount = __upstreamBeforeAll.length;
  const afterAllCount = __upstreamAfterAll.length;
  body();
  __upstreamBeforeEach.length = hookCount;
  __upstreamAfterEach.length = afterHookCount;
  __upstreamBeforeAll.length = beforeAllCount;
  __upstreamAfterAll.length = afterAllCount;
}
function __upstreamRegister(name, body) {
  const hooks = __upstreamBeforeEach.slice();
  const afterHooks = __upstreamAfterEach.slice();
  const beforeAllHooks = __upstreamBeforeAll.slice();
  const afterAllHooks = __upstreamAfterAll.slice();
  __upstreamTests.push({
    name: String(name),
    beforeAllHooks,
    afterAllHooks,
    body: function(assertion) {
      for (let index = 0; index < hooks.length; index++) hooks[index]();
      let result;
      try {
        result = body(assertion);
      } catch (error) {
        for (let index = afterHooks.length - 1; index >= 0; index--) afterHooks[index]();
        throw error;
      }
      if (result && typeof result.then === "function") {
        return result.then(
          function(value) {
            for (let index = afterHooks.length - 1; index >= 0; index--) afterHooks[index]();
            return value;
          },
          function(error) {
            for (let index = afterHooks.length - 1; index >= 0; index--) afterHooks[index]();
            throw error;
          },
        );
      }
      for (let index = afterHooks.length - 1; index >= 0; index--) afterHooks[index]();
      return result;
    },
  });
}
function __upstreamRegisterTest(name, body) {
  const validName = typeof name === "string" || typeof name === "number" || (typeof name === "function" && name.name);
  if (!validName) {
    const renderedName = typeof name === "function" && !name.name ? "() => {}" : String(name);
    throw new Error("Invalid first argument, " + renderedName + ". It must be a named class, named function, number, or string.");
  }
  if (typeof body === "undefined") {
    throw new Error(
      "Missing second argument. It must be a callback function. Perhaps you want to use " +
        String.fromCharCode(96) +
        "test.todo" +
        String.fromCharCode(96) +
        " for a test placeholder.",
    );
  }
  if (typeof body !== "function") {
    throw new Error("Invalid second argument, " + String(body) + ". It must be a callback function.");
  }
  __upstreamRegister(name, body);
}
function it(name, body) { __upstreamRegisterTest(name, body); }
function test(name, body) { __upstreamRegisterTest(name, body); }
function __upstreamSkip() {}
function __upstreamTodo(description) {
  if (arguments.length !== 1 || typeof description !== "string") {
    throw new Error("Todo must be called with only a description.");
  }
}
it.skip = __upstreamSkip;
it.todo = __upstreamTodo;
test.skip = __upstreamSkip;
test.todo = __upstreamTodo;
describe.skip = __upstreamSkip;
describe.todo = __upstreamSkip;
function __upstreamRegisterHook(body) {
  if (typeof body !== "function") throw new Error("Invalid first argument. It must be a callback function.");
}
function afterEach(body) { __upstreamRegisterHook(body); __upstreamAfterEach.push(body); }
function beforeEach(body) { __upstreamRegisterHook(body); __upstreamBeforeEach.push(body); }
function beforeAll(body) { __upstreamRegisterHook(body); __upstreamBeforeAll.push(body); }
function afterAll(body) { __upstreamRegisterHook(body); __upstreamAfterAll.push(body); }
Object.defineProperty(globalThis, "beforeEach", { configurable: true, writable: true, value: function(body) { __upstreamRegisterHook(body); __upstreamBeforeEach.push(body); } });
Object.defineProperty(globalThis, "beforeAll", { configurable: true, writable: true, value: function(body) { __upstreamRegisterHook(body); __upstreamBeforeAll.push(body); } });
Object.defineProperty(globalThis, "afterEach", { configurable: true, writable: true, value: function(body) { __upstreamRegisterHook(body); __upstreamAfterEach.push(body); } });
Object.defineProperty(globalThis, "afterAll", { configurable: true, writable: true, value: function(body) { __upstreamRegisterHook(body); __upstreamAfterAll.push(body); } });
function __upstreamCallNamedHook(name, body) {
  if (name === "beforeEach") return beforeEach(body);
  if (name === "beforeAll") return beforeAll(body);
  if (name === "afterEach") return afterEach(body);
  if (name === "afterAll") return afterAll(body);
  throw new Error("Unknown hook: " + String(name));
}
function __upstreamTableRows(strings, values) {
  const markers = [];
  let source = "";
  for (let index = 0; index < strings.length; index++) {
    source += strings[index];
    if (index < values.length) {
      const marker = "__UPSTREAM_TABLE_VALUE_" + index + "__";
      markers.push(marker);
      source += marker;
    }
  }
  const lines = source.split(/\r?\n/).map(function(line) { return line.trim(); }).filter(Boolean);
  if (lines.length === 0) return [];
  const columns = lines.shift().split("|").map(function(column) { return column.trim(); });
  const rows = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^[|\- ]+$/.test(lines[index])) continue;
    const cells = lines[index].split("|").map(function(cell) { return cell.trim(); });
    const row = {};
    for (let column = 0; column < columns.length; column++) {
      let value = cells[column] || "";
      for (let marker = 0; marker < markers.length; marker++) {
        if (value === markers[marker]) value = values[marker];
      }
      row[columns[column]] = value;
    }
    rows.push(row);
  }
  return rows;
}
function __upstreamEach(cases) {
  const values = Array.prototype.slice.call(arguments, 1);
  const tableRows = Array.isArray(cases) && cases.raw && values.length > 0 ? __upstreamTableRows(cases, values) : null;
  return function(name, body) {
    const sourceCases = tableRows || cases;
    let expandRows = sourceCases.length > 0;
    for (let caseIndex = 0; caseIndex < sourceCases.length; caseIndex++) {
      if (!Array.isArray(sourceCases[caseIndex])) { expandRows = false; break; }
    }
    for (let index = 0; index < sourceCases.length; index++) {
      const sourceRow = sourceCases[index];
      const row = expandRows ? sourceRow : [sourceRow];
      const displayName = String(name)
        .replace(/%s/g, function() { return String(row[0]); })
        .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, function(_match, key) {
          return sourceRow && typeof sourceRow === "object" && !Array.isArray(sourceRow) && key in sourceRow ? String(sourceRow[key]) : _match;
        });
      it(displayName, function() {
        if (tableRows) return body(sourceRow);
        if (row.length === 0) return body();
        if (row.length === 1) return body(row[0]);
        if (row.length === 2) return body(row[0], row[1]);
        if (row.length === 3) return body(row[0], row[1], row[2]);
        return body(row[0], row[1], row[2], row[3]);
      });
    }
  };
}
function __upstreamEachDirect(cases, name, body) {
  let expandRows = cases.length > 0;
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    if (!Array.isArray(cases[caseIndex])) { expandRows = false; break; }
  }
  for (let index = 0; index < cases.length; index++) {
    const sourceRow = cases[index];
    const row = expandRows ? sourceRow : [sourceRow];
    const displayName = String(name).replace(/%s/g, function() { return String(row[0]); });
    it(displayName, function() {
      if (row.length === 0) return body();
      if (row.length === 1) return body(row[0]);
      if (row.length === 2) return body(row[0], row[1]);
      if (row.length === 3) return body(row[0], row[1], row[2]);
      return body(row[0], row[1], row[2], row[3]);
    });
  }
}
function __upstreamDescribeEachDirect(cases, name, body) {
  let expandRows = cases.length > 0;
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    if (!Array.isArray(cases[caseIndex])) { expandRows = false; break; }
  }
  for (let index = 0; index < cases.length; index++) {
    const sourceRow = cases[index];
    const row = expandRows ? sourceRow : [sourceRow];
    if (row.length === 0) body();
    else if (row.length === 1) body(row[0]);
    else if (row.length === 2) body(row[0], row[1]);
    else if (row.length === 3) body(row[0], row[1], row[2]);
    else body(row[0], row[1], row[2], row[3]);
  }
}
it.each = __upstreamEach;
test.each = __upstreamEach;
function __upstreamDescribeEach(cases) {
  return (name, body) => {
    let expandRows = cases.length > 0;
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      if (!Array.isArray(cases[caseIndex])) { expandRows = false; break; }
    }
    for (let index = 0; index < cases.length; index++) {
      const row = expandRows ? cases[index] : [cases[index]];
      const displayName = String(name).replace(/%s/g, function() { return String(row[0]); });
      if (row.length === 0) body();
      else if (row.length === 1) body(row[0]);
      else if (row.length === 2) body(row[0], row[1]);
      else if (row.length === 3) body(row[0], row[1], row[2]);
      else body(row[0], row[1], row[2], row[3]);
    }
  };
}
describe.each = __upstreamDescribeEach;
// Vitest's expectTypeOf is erased by TypeScript and only performs compile-time
// checks. Keep the original calls executable without turning type assertions
// into fake runtime coverage in either the Node or Wasm lane.
function __upstreamTypeExpectation() {
  const chain = {
    toEqualTypeOf() { return chain; },
    toMatchTypeOf() { return chain; },
    toBeString() { return chain; },
    toBeNumber() { return chain; },
    toBeBoolean() { return chain; },
    toBeArray() { return chain; },
    toBeObject() { return chain; },
    toBeFunction() { return chain; },
    toBeUndefined() { return chain; },
    toBeDefined() { return chain; },
  };
  return chain;
}
function expectTypeOf() { return __upstreamTypeExpectation(); }
const __qunitAssert = {
  expect(_count) {},
  ok(value, message) { const n = ++__upstreamAssertion; if (!value) __upstreamFail("assertion " + n + ": " + (message || "expected truthy value") + "; got " + __upstreamValue(value)); },
  notOk(value, message) { const n = ++__upstreamAssertion; if (value) __upstreamFail("assertion " + n + ": " + (message || "expected falsey value") + "; got " + __upstreamValue(value)); },
  isDefined(value, message) { const n = ++__upstreamAssertion; if (value === undefined) __upstreamFail("assertion " + n + ": " + (message || "expected defined value")); },
  equal(actual, expected, message) { const n = ++__upstreamAssertion; if (actual != expected) __upstreamFail("assertion " + n + ": " + (message || "equal mismatch") + "; " + __upstreamValue(actual) + " != " + __upstreamValue(expected)); },
  notEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (actual == expected) __upstreamFail("assertion " + n + ": " + (message || "notEqual mismatch") + "; unexpected " + __upstreamValue(actual)); },
  strictEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (actual !== expected) __upstreamFail("assertion " + n + ": " + (message || "strictEqual mismatch") + "; " + __upstreamValue(actual) + " !== " + __upstreamValue(expected)); },
  notStrictEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (actual === expected) __upstreamFail("assertion " + n + ": " + (message || "notStrictEqual mismatch") + "; unexpected " + __upstreamValue(actual)); },
  deepEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (!__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + ": " + (message || "deepEqual mismatch") + "; " + __upstreamValue(actual) + " != " + __upstreamValue(expected)); },
  throws(fn, expected, message) { if (!__upstreamThrownMatches(__upstreamThrown(fn), expected)) __upstreamFail(message || "expected matching throw"); },
};
function suiteModule(_name, body) { if (typeof body === "function") body(); }
const QUnit = {
  module: suiteModule,
  test(name, body) { __upstreamTests.push({ name: String(name), body }); },
};
`;

// CommonJS package graphs can execute imported modules before the generated
// entry module initializes a top-level `var global` alias. The Node platform
// already provides the binding through codegen, so Node-oriented adapters must
// omit this browser compatibility declaration rather than observing it as
// undefined during module initialization.
export const UPSTREAM_TEST_SHIM_NODE = UPSTREAM_TEST_SHIM.replace("var global = globalThis;\n", "");

export const UPSTREAM_TEST_EXPORTS = String.raw`
export function upstreamTestCount(): number { return __upstreamTests.length; }
export function upstreamTestNames(): string[] {
  const names: string[] = [];
  for (let i = 0; i < __upstreamTests.length; i++) names.push(__upstreamTests[i].name);
  return names;
}
export async function runUpstreamTest(index: number): Promise<number> {
  __upstreamAssertion = 0;
  __upstreamCurrentTestName = __upstreamTests[index].name;
  let result;
  try {
    const beforeAllHooks = __upstreamTests[index].beforeAllHooks || [];
    for (let hookIndex = 0; hookIndex < beforeAllHooks.length; hookIndex++) {
      const hook = beforeAllHooks[hookIndex];
      if (!hook.__upstreamRan) { hook(); hook.__upstreamRan = true; }
    }
    result = __upstreamTests[index].body(__qunitAssert);
  } catch (error) {
    __upstreamErrors[index] = error && error.message !== undefined ? String(error.message) : String(error);
    return 0;
  }
  if (result && typeof result.then === "function") {
    // Await the test promise directly. Returning an anonymous object from the
    // Promise.then callbacks makes the harness result depend on that object's
    // inferred Wasm struct identity. In a large package graph (Hono's
    // trailing-slash tests), an unrelated same-shape carrier can then make
    // outcome.passed read as false even though the original callback and all
    // assertions completed successfully.
    let outcomePassed = true;
    let outcomeError = "";
    try {
      await result;
    } catch (error) {
      outcomePassed = false;
      outcomeError = error && error.message !== undefined ? String(error.message) : String(error);
    }
    __upstreamErrors[index] = outcomeError;
    if (index === __upstreamTests.length - 1) {
      const afterAllHooks = __upstreamTests[index].afterAllHooks || [];
      for (let hookIndex = afterAllHooks.length - 1; hookIndex >= 0; hookIndex--) {
        const hook = afterAllHooks[hookIndex];
        if (!hook.__upstreamRan) { hook(); hook.__upstreamRan = true; }
      }
    }
    return outcomePassed ? 1 : 0;
  }
  __upstreamErrors[index] = "";
  if (index === __upstreamTests.length - 1) {
    const afterAllHooks = __upstreamTests[index].afterAllHooks || [];
    for (let hookIndex = afterAllHooks.length - 1; hookIndex >= 0; hookIndex--) {
      const hook = afterAllHooks[hookIndex];
      if (!hook.__upstreamRan) { hook(); hook.__upstreamRan = true; }
    }
  }
  return 1;
}
export function runUpstreamTests(): number[] {
  const statuses: number[] = [];
  __upstreamErrors.length = 0;
  for (let i = 0; i < __upstreamTests.length; i++) {
    __upstreamAssertion = 0;
    __upstreamCurrentTestName = __upstreamTests[i].name;
    let result;
    try {
      const beforeAllHooks = __upstreamTests[i].beforeAllHooks || [];
      for (let hookIndex = 0; hookIndex < beforeAllHooks.length; hookIndex++) {
        const hook = beforeAllHooks[hookIndex];
        if (!hook.__upstreamRan) { hook(); hook.__upstreamRan = true; }
      }
      result = __upstreamTests[i].body(__qunitAssert);
    } catch (error) {
      statuses.push(0);
      __upstreamErrors.push(error && error.message !== undefined ? String(error.message) : String(error));
      continue;
    }
    if (result && typeof result.then === "function") {
      // The per-test async entry point above is used by the native oracle and
      // Wasm worker. Keep this legacy aggregate entry point synchronous for
      // callers that only admit synchronous callbacks.
      if (typeof result.catch === "function") result.catch(function() {});
      statuses.push(0);
      __upstreamErrors.push("async callback requires the per-test runner");
    } else {
      statuses.push(1);
      __upstreamErrors.push("");
    }
    if (i === __upstreamTests.length - 1) {
      const afterAllHooks = __upstreamTests[i].afterAllHooks || [];
      for (let hookIndex = afterAllHooks.length - 1; hookIndex >= 0; hookIndex--) {
        const hook = afterAllHooks[hookIndex];
        if (!hook.__upstreamRan) { hook(); hook.__upstreamRan = true; }
      }
    }
  }
  return statuses;
}
export function upstreamTestErrors(): string[] { return __upstreamErrors; }
export function cleanupUpstreamTestEnvironment(): void {
  if (typeof jest.useRealTimers === "function") jest.useRealTimers();
  if (typeof jest.restoreAllMocks === "function") jest.restoreAllMocks();
}
`;

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function nativePathFor(generatedPath) {
  const extension = extname(generatedPath);
  return `${generatedPath.slice(0, -extension.length)}.native.mjs`;
}

// (#4604 S7, generalized) Late host errors from NATIVE upstream test runs must
// cost a report entry, never the process. `runNative` imports the generated
// module IN-PROCESS and try/catches only the awaited test body — but upstream
// code schedules host-timer work that can throw AFTER its test resolved.
// npm-compat refresh run 32623956233 died exactly this way: hono's
// `concurrent.js` threw "interval violated" from a `setTimeout` callback ~2
// minutes into the measurement, the uncaughtException killed node, and ALL SIX
// packages of the `libraries` matrix row lost their measurement (the partial
// report is deliberately discarded on non-zero exit). Same policy as
// react-dom's `installNativeHostErrorBoundary`: record and keep going. Every
// capture is echoed to stderr so genuine harness bugs stay visible in CI logs,
// and drained into the next run's `native.lateHostErrors`.
const nativeLateHostErrors = [];
let nativeLateBoundaryInstalled = false;
let nativeLateCurrentFile = null;
function installNativeLateErrorBoundary() {
  if (nativeLateBoundaryInstalled) return;
  nativeLateBoundaryInstalled = true;
  const record = (kind) => (error) => {
    const entry = {
      kind,
      file: nativeLateCurrentFile,
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
    };
    nativeLateHostErrors.push(entry);
    process.stderr.write(`[dogfood] late native host error (${kind}) in ${entry.file ?? "?"}: ${entry.message}\n`);
  };
  process.on("uncaughtException", record("uncaughtException"));
  process.on("unhandledRejection", record("unhandledRejection"));
}

async function runNative(generatedPath, source) {
  installNativeLateErrorBoundary();
  nativeLateCurrentFile = generatedPath;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      allowJs: true,
    },
    fileName: generatedPath,
    reportDiagnostics: true,
  });
  const nativePath = nativePathFor(generatedPath);
  writeFileSync(nativePath, transpiled.outputText);
  const module = await import(`${pathToFileURL(nativePath).href}?run=${Date.now()}-${Math.random()}`);
  const count = Number(module.upstreamTestCount());
  const statuses = [];
  const errors = [];
  if (typeof module.runUpstreamTest === "function") {
    for (let index = 0; index < count; index++) {
      let value;
      try {
        value = await module.runUpstreamTest(index);
      } catch (error) {
        value = 0;
        errors.push(errorText(error));
      }
      statuses.push(Number(value) === 1);
      if (errors.length < index + 1) errors.push(String(module.upstreamTestErrors()[index] ?? ""));
    }
  } else {
    statuses.push(...Array.from(module.runUpstreamTests(), (value) => Number(value) === 1));
    errors.push(...Array.from(module.upstreamTestErrors(), String));
  }
  module.cleanupUpstreamTestEnvironment?.();
  return {
    count,
    names: Array.from(module.upstreamTestNames(), String),
    statuses,
    errors,
    // Late async throws recorded (not fatal) since this file's native run
    // started — see installNativeLateErrorBoundary above. Drained per run so
    // one file's stray timers are not attributed to the next.
    lateHostErrors: nativeLateHostErrors.splice(0, nativeLateHostErrors.length),
  };
}

/**
 * Compile and execute one upstream module in a child process.
 *
 * `compileProject` is intentionally synchronous from the event loop's point
 * of view.  A Promise.race timeout therefore cannot interrupt a pathological
 * module: the timer never gets a chance to fire while code generation is
 * running.  Keeping the compiler and Wasm instance in a short-lived child
 * gives the suite a real hard deadline and prevents one package from wedging
 * the npm-compat workflow.
 */
function runIsolatedCompile(generatedPath, timeoutMs, mode = "project", workerEnv = {}) {
  return new Promise((resolve) => {
    const workerPath = new URL("./upstream-suite-compile-worker.mjs", import.meta.url);
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(workerPath), generatedPath, mode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...workerEnv },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stage = "compile";
    let compileDurationMs = null;
    let timer;
    const started = performance.now();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        const detail = stripWorkerProtocol(stderr);
        const timeoutLabel = stage === "compile" ? "compile" : "worker execution";
        finish({
          compile: {
            success: false,
            validates: false,
            durationMs: stage === "execution" && compileDurationMs !== null ? compileDurationMs : timeoutMs,
            workerDurationMs: Math.round(performance.now() - started),
            binaryBytes: 0,
            timedOut: true,
            timeoutStage: stage,
            errors: [{ message: `${timeoutLabel} timeout after ${timeoutMs}ms${detail ? `; worker: ${detail}` : ""}` }],
          },
          wasm: null,
        });
      }, timeoutMs);
      timer.unref?.();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stage === "compile") {
        const duration = readWorkerCompileDuration(stderr);
        if (duration !== null) {
          compileDurationMs = duration;
          stage = "execution";
          armTimeout();
        }
      }
    });
    child.on("error", (error) => {
      finish({
        compile: {
          success: false,
          validates: false,
          durationMs: Math.round(performance.now() - started),
          binaryBytes: 0,
          errors: [{ message: errorText(error) }],
        },
        wasm: null,
      });
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      try {
        const result = JSON.parse(stdout.trim());
        finish(result);
      } catch {
        const detail = stderr.trim() || stdout.trim() || `worker exited with ${signal ?? `code ${code}`}`;
        finish({
          compile: {
            success: false,
            validates: false,
            durationMs: Math.round(performance.now() - started),
            binaryBytes: 0,
            errors: [{ message: detail }],
          },
          wasm: null,
        });
      }
    });
    armTimeout();
  });
}

export async function compileAndRunUpstreamModule({
  generatedPath,
  source,
  nativeSource = source,
  timeoutMs = 180_000,
  workerEnv,
}) {
  mkdirSync(dirname(generatedPath), { recursive: true });
  writeFileSync(generatedPath, source);

  let native;
  try {
    native = await runNative(generatedPath, nativeSource);
  } catch (error) {
    return { native: { fatal: errorText(error), count: 0, names: [], statuses: [] }, compile: null, wasm: null };
  }

  const isolated = await runIsolatedCompile(generatedPath, timeoutMs, "project", workerEnv);
  return { native, ...isolated };
}

/**
 * Compile a generated source file in an isolated worker without executing its
 * exports. Large package implementations (notably ReactDOM) must pass this
 * gate before per-test batches are attempted; the child gives the caller a
 * real deadline even while synchronous code generation is running.
 */
export async function compileSourceInWorker({ generatedPath, source, timeoutMs = 300_000, workerEnv }) {
  mkdirSync(dirname(generatedPath), { recursive: true });
  writeFileSync(generatedPath, source);
  return runIsolatedCompile(generatedPath, timeoutMs, "source", workerEnv);
}

/**
 * Compile a generated multi-file upstream project in an isolated worker.
 * Keeping the package implementation in imported files means a test entry
 * does not have to concatenate/recompile the same large CJS body once per
 * batch, while the worker still supplies a hard deadline for pathological
 * code generation.
 */
export async function compileProjectInWorker({
  generatedRoot,
  entryFile = "entry.ts",
  files,
  timeoutMs = 300_000,
  workerEnv,
}) {
  mkdirSync(generatedRoot, { recursive: true });
  for (const [relativePath, source] of Object.entries(files)) {
    const target = join(generatedRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return runIsolatedCompile(join(generatedRoot, entryFile), timeoutMs, "project", workerEnv);
}

export function summarizeUpstreamRuns({ name, pin, testFiles, selectedFiles, runs }) {
  const report = {
    generatedAt: new Date().toISOString(),
    package: name,
    upstreamSuite: {
      repo: pin.repo,
      tag: pin.tag,
      commit: pin.commit,
      testFiles: testFiles.length,
      testFilePaths: testFiles,
      registrationSites: pin.registrationSites,
      selectedRegistrationSites: pin.selectedRegistrationSites ?? null,
      selectedFiles,
    },
    extraction: {
      filesSeen: testFiles.length,
      filesSelected: selectedFiles.length,
      filesDeferred: testFiles.length - selectedFiles.length,
      testsRegistered: 0,
      deferredRegistrations: 0,
      // A deferred upstream registration is not a compiler failure: the
      // adapter deliberately did not execute it because its host/package
      // dependency surface is not wired yet. Keep that inventory explicit so
      // npm-compat can show unavailable infrastructure instead of making the
      // denominator look like a silent omission.
      unavailableInfra: 0,
      nativePassed: 0,
      nativeFailed: 0,
    },
    compile: { modules: runs.length, succeeded: 0, validated: 0, durationMs: 0, binaryBytes: 0 },
    results: { scored: 0, passed: 0, failed: 0, runtimeFailed: 0, tests: [] },
  };

  for (const run of runs) {
    const native = run.result.native;
    report.extraction.testsRegistered += native.count;
    report.extraction.nativePassed += native.statuses.filter(Boolean).length;
    report.extraction.nativeFailed += native.statuses.filter((status) => !status).length;
    if (run.result.compile?.success) report.compile.succeeded++;
    if (run.result.compile?.validates) report.compile.validated++;
    report.compile.durationMs += run.result.compile?.durationMs ?? 0;
    report.compile.binaryBytes += run.result.compile?.binaryBytes ?? 0;

    for (let index = 0; index < native.count; index++) {
      const nativePassed = native.statuses[index] === true;
      const wasmPassed = run.result.wasm?.statuses[index] === true;
      const status = !nativePassed
        ? "harness-incompatible"
        : run.result.wasm?.fatal
          ? "runtime-failed"
          : wasmPassed
            ? "passed"
            : "failed";
      if (nativePassed) {
        report.results.scored++;
        if (status === "passed") report.results.passed++;
        else if (status === "runtime-failed") report.results.runtimeFailed++;
        else report.results.failed++;
      }
      report.results.tests.push({
        file: run.file,
        name: native.names[index],
        status,
        nativeError: native.errors?.[index] || null,
        wasmError: run.result.wasm?.errors?.[index] || run.result.wasm?.fatal || null,
      });
    }
  }
  const registrationSites = Number(pin.registrationSites);
  if (Number.isFinite(registrationSites)) {
    // `testsRegistered` may include expanded `test.each`/`it.each` cases and
    // therefore cannot be compared directly with the static call-site count.
    // An adapter can provide the number of static sites it selected so the
    // report keeps deferred host infrastructure visible without inventing a
    // negative or zero deferred count after table expansion.
    const selectedRegistrationSites = Number(pin.selectedRegistrationSites);
    const registeredForInventory = Number.isFinite(selectedRegistrationSites)
      ? selectedRegistrationSites
      : report.extraction.testsRegistered;
    report.extraction.deferredRegistrations = Math.max(0, registrationSites - registeredForInventory);
    report.extraction.unavailableInfra = report.extraction.deferredRegistrations;
  }
  report.compile.details = runs.map((run) => ({
    file: run.file,
    ...run.result.compile,
    nativeError: run.result.native.fatal ?? null,
    runtimeError: run.result.wasm?.fatal ?? null,
  }));
  report.summary = {
    headline: `${report.results.passed}/${report.results.scored} admitted original tests pass in Wasm`,
    exactDenominator: report.results.scored,
    upstreamFiles: report.extraction.filesSeen,
    deferredFiles: report.extraction.filesDeferred,
    nativePassed: report.extraction.nativePassed,
    nativeFailed: report.extraction.nativeFailed,
    unavailableInfra: report.extraction.unavailableInfra,
    wasmPassed: report.results.passed,
    wasmFailed: report.results.failed,
    runtimeFailed: report.results.runtimeFailed,
  };
  return report;
}

export function writeUpstreamReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export function cliUpstreamHarness(runHarness, { reportSucceeded } = {}) {
  const jsonOnly = process.argv.includes("--json");
  return runHarness({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
      if (reportSucceeded && !reportSucceeded(report)) process.exitCode = 1;
      return report;
    })
    .catch((error) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify({ fatal: errorText(error) })}\n`);
      else console.error("[dogfood] upstream suite crashed:", error);
      process.exitCode = 2;
    });
}
