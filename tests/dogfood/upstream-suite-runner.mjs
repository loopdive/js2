import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as ts from "typescript";

// The assertions are intentionally small, deterministic JavaScript. They are
// runner infrastructure; the registered callback bodies remain the exact
// upstream source. Both Node and Wasm execute this same shim.
export const UPSTREAM_TEST_SHIM = String.raw`
// Node exposes the process-wide host as the global binding; browser-oriented upstream
// suites (including Redux's warning tests) use that spelling directly. Keep
// the alias explicit in both the native and Wasm lanes instead of treating a
// missing Node compatibility global as a package failure.
var global = globalThis;
const __upstreamTests = [];
const __upstreamErrors = [];
let __upstreamSnapshotMatcher = null;
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
    toBeCalled() { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (!calls || calls.length === 0) __upstreamFail("assertion " + n + " expected spy to be called"); },
    toHaveBeenCalled() { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (!calls || calls.length === 0) __upstreamFail("assertion " + n + " expected spy to be called"); },
    toBeCalledWith() { const n = ++__upstreamAssertion; const expected = Array.prototype.slice.call(arguments); const calls = actual && actual.mock && actual.mock.calls; let matched = false; if (calls) for (let i = 0; i < calls.length; i++) if (__upstreamSame(calls[i], expected)) matched = true; if (!matched) __upstreamFail("assertion " + n + " expected matching spy call"); },
    toHaveBeenCalledWith() { const n = ++__upstreamAssertion; const expected = Array.prototype.slice.call(arguments); const calls = actual && actual.mock && actual.mock.calls; let matched = false; if (calls) for (let i = 0; i < calls.length; i++) if (__upstreamSame(calls[i], expected)) matched = true; if (!matched) __upstreamFail("assertion " + n + " expected matching spy call"); },
    toHaveBeenCalledTimes(expected) { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (!calls || calls.length !== expected) __upstreamFail("assertion " + n + " spy call count mismatch"); },
    toHaveBeenCalledOnce() { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (!calls || calls.length !== 1) __upstreamFail("assertion " + n + " spy call count mismatch"); },
    toBeCalledOnce() { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (!calls || calls.length !== 1) __upstreamFail("assertion " + n + " spy call count mismatch"); },
    toBeInstanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected !== "function" || !(actual instanceof expected)) __upstreamFail("assertion " + n + " instance mismatch"); },
    instanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected !== "function" || !(actual instanceof expected)) __upstreamFail("assertion " + n + " instance mismatch"); },
    toMatchSnapshot() {
      if (typeof __upstreamSnapshotMatcher !== "function") {
        __upstreamFail("snapshot assertion requires a package-specific snapshot adapter");
      }
      const n = ++__upstreamAssertion;
      if (!__upstreamSnapshotMatcher(actual)) __upstreamFail("snapshot mismatch at assertion " + n);
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
    toBeInstanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected === "function" && actual instanceof expected) __upstreamFail("assertion " + n + " unexpected instance"); },
    instanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected === "function" && actual instanceof expected) __upstreamFail("assertion " + n + " unexpected instance"); },
    toBeCalled() { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (calls && calls.length > 0) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toHaveBeenCalled() { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (calls && calls.length > 0) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toHaveBeenCalledOnce() { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (calls && calls.length === 1) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toThrow() { const n = ++__upstreamAssertion; if (typeof actual !== "function" || __upstreamThrown(actual) !== null) __upstreamFail("assertion " + n + " unexpected throw"); },
    toThrowError() { const n = ++__upstreamAssertion; if (typeof actual !== "function" || __upstreamThrown(actual) !== null) __upstreamFail("assertion " + n + " unexpected throw"); },
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
const vi = {
  fn(implementation) {
    function spy() {
      const args = Array.prototype.slice.call(arguments);
      spy.mock.calls.push(args);
      if (typeof implementation === "function") return implementation.apply(this, args);
    }
    spy.mock = { calls: [] };
    spy.mockClear = function() { spy.mock.calls.length = 0; return spy; };
    spy.mockReturnValue = function(value) { implementation = function() { return value; }; return spy; };
    spy.mockImplementation = function(next) { implementation = next; return spy; };
    spy.mockRestore = function() {};
    return spy;
  },
  spyOn(object, key) {
    const original = object[key];
    const spy = vi.fn(function() { return original.apply(this, arguments); });
    spy.mockRestore = function() { object[key] = original; };
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
function beforeEach(body) { __upstreamBeforeEach.push(body); }
function beforeAll(body) { __upstreamBeforeAll.push(body); }
function afterAll(body) { __upstreamAfterAll.push(body); }
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
function it(name, body) { __upstreamRegister(name, body); }
function test(name, body) { __upstreamRegister(name, body); }
function __upstreamSkip() {}
it.skip = __upstreamSkip;
it.todo = __upstreamSkip;
test.skip = __upstreamSkip;
test.todo = __upstreamSkip;
describe.skip = __upstreamSkip;
describe.todo = __upstreamSkip;
function afterEach(body) { __upstreamAfterEach.push(body); }
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
    const expandRows = sourceCases.length > 0 && sourceCases.every(function(value) { return Array.isArray(value); });
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
it.each = __upstreamEach;
test.each = __upstreamEach;
describe.each = function(cases) {
  return function(name, body) {
    const expandRows = cases.length > 0 && cases.every(function(value) { return Array.isArray(value); });
    for (let index = 0; index < cases.length; index++) {
      const row = expandRows ? cases[index] : [cases[index]];
      const displayName = String(name).replace(/%s/g, function() { return String(row[0]); });
      describe(displayName, function() {
        if (row.length === 0) return body();
        if (row.length === 1) return body(row[0]);
        if (row.length === 2) return body(row[0], row[1]);
        if (row.length === 3) return body(row[0], row[1], row[2]);
        return body(row[0], row[1], row[2], row[3]);
      });
    }
  };
};
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
    const outcome = await result.then(
      () => ({ passed: true, error: "" }),
      (error) => ({
        passed: false,
        error: error && error.message !== undefined ? String(error.message) : String(error),
      }),
    );
    __upstreamErrors[index] = outcome.error;
    if (index === __upstreamTests.length - 1) {
      const afterAllHooks = __upstreamTests[index].afterAllHooks || [];
      for (let hookIndex = afterAllHooks.length - 1; hookIndex >= 0; hookIndex--) {
        const hook = afterAllHooks[hookIndex];
        if (!hook.__upstreamRan) { hook(); hook.__upstreamRan = true; }
      }
    }
    return outcome.passed ? 1 : 0;
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
`;

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function nativePathFor(generatedPath) {
  const extension = extname(generatedPath);
  return `${generatedPath.slice(0, -extension.length)}.native.mjs`;
}

async function runNative(generatedPath, source) {
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
  return {
    count,
    names: Array.from(module.upstreamTestNames(), String),
    statuses,
    errors,
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
    const started = performance.now();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        compile: {
          success: false,
          validates: false,
          durationMs: timeoutMs,
          binaryBytes: 0,
          timedOut: true,
          errors: [{ message: `compile timeout after ${timeoutMs}ms${stderr ? `; worker: ${stderr.trim()}` : ""}` }],
        },
        wasm: null,
      });
    }, timeoutMs);
    timer.unref?.();
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
    report.extraction.deferredRegistrations = Math.max(0, registrationSites - report.extraction.testsRegistered);
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

export function cliUpstreamHarness(runHarness) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
    })
    .catch((error) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify({ fatal: errorText(error) })}\n`);
      else console.error("[dogfood] upstream suite crashed:", error);
      process.exitCode = 2;
    });
}
