// (#7013) Test-only `node:assert` for the standalone upstream lane.
//
// Several upstream suites (prettier, axios) assert through Node's `assert`
// module. In the JS-host lane the worker hands Node's real module across the
// import boundary; a standalone module has no host, so the standalone lane
// rewrites `assert` / `node:assert` / `node:assert/strict` imports in the
// generated TEST module to this file, which is compiled into the binary like
// every other assertion shim. Package code is never rewritten. The native
// oracle keeps running against Node's real `assert`.

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
  }
}

function fail(message) {
  if (message instanceof Error) throw message;
  throw new AssertionError(message === undefined ? "Failed" : String(message));
}

function describe(value) {
  const kind = typeof value;
  if (value === null || kind === "undefined" || kind === "number" || kind === "boolean") return String(value);
  if (kind === "string") return JSON.stringify(value);
  return kind;
}

function isDeepEqual(actual, expected, strict) {
  if (strict ? Object.is(actual, expected) : actual == expected) return true;
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") return false;
  if (strict && Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  if (actual instanceof Date || expected instanceof Date) {
    return actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime();
  }
  if (actual instanceof RegExp || expected instanceof RegExp) {
    return actual instanceof RegExp && expected instanceof RegExp && String(actual) === String(expected);
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (actual instanceof Map || expected instanceof Map) {
    if (!(actual instanceof Map && expected instanceof Map) || actual.size !== expected.size) return false;
    for (const [key, value] of actual) {
      if (!expected.has(key) || !isDeepEqual(value, expected.get(key), strict)) return false;
    }
    return true;
  }
  if (actual instanceof Set || expected instanceof Set) {
    if (!(actual instanceof Set && expected instanceof Set) || actual.size !== expected.size) return false;
    for (const value of actual) if (!expected.has(value)) return false;
    return true;
  }
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  for (const key of actualKeys) {
    if (!Object.prototype.hasOwnProperty.call(expected, key)) return false;
    if (!isDeepEqual(actual[key], expected[key], strict)) return false;
  }
  return true;
}

function matchesExpected(error, expected) {
  if (expected === undefined) return true;
  if (expected instanceof RegExp)
    return expected.test(String(error && error.message !== undefined ? error.message : error));
  if (typeof expected === "function") {
    if (expected.prototype !== undefined && error instanceof expected) return true;
    if (Error.isPrototypeOf(expected) || expected === Error) return false;
    return expected(error) === true;
  }
  if (expected !== null && typeof expected === "object") {
    for (const key of Object.keys(expected)) {
      const want = expected[key];
      const got = error == null ? undefined : error[key];
      if (want instanceof RegExp ? !want.test(String(got)) : !isDeepEqual(got, want, true)) return false;
    }
    return true;
  }
  return true;
}

function assert(value, message) {
  if (!value) fail(message === undefined ? `The expression evaluated to a falsy value: ${describe(value)}` : message);
}
assert.ok = assert;
assert.fail = fail;
assert.AssertionError = AssertionError;
assert.equal = function (actual, expected, message) {
  if (!(actual == expected)) fail(message ?? `${describe(actual)} == ${describe(expected)}`);
};
assert.notEqual = function (actual, expected, message) {
  if (actual == expected) fail(message ?? `${describe(actual)} != ${describe(expected)}`);
};
assert.strictEqual = function (actual, expected, message) {
  if (!Object.is(actual, expected))
    fail(message ?? `Expected values to be strictly equal: ${describe(actual)} !== ${describe(expected)}`);
};
assert.notStrictEqual = function (actual, expected, message) {
  if (Object.is(actual, expected))
    fail(message ?? `Expected "actual" to be strictly unequal to: ${describe(expected)}`);
};
assert.deepEqual = function (actual, expected, message) {
  if (!isDeepEqual(actual, expected, false)) fail(message ?? "Expected values to be loosely deep-equal");
};
assert.deepStrictEqual = function (actual, expected, message) {
  if (!isDeepEqual(actual, expected, true)) fail(message ?? "Expected values to be strictly deep-equal");
};
assert.notDeepStrictEqual = function (actual, expected, message) {
  if (isDeepEqual(actual, expected, true)) fail(message ?? "Expected values not to be strictly deep-equal");
};
assert.match = function (actual, pattern, message) {
  if (typeof actual !== "string" || !pattern.test(actual))
    fail(message ?? `The input did not match ${String(pattern)}`);
};
assert.throws = function (fn, expected, message) {
  let thrown = null;
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  if (!threw) fail(typeof expected === "string" ? expected : (message ?? "Missing expected exception."));
  if (typeof expected !== "string" && !matchesExpected(thrown, expected)) {
    throw thrown;
  }
};
assert.doesNotThrow = function (fn, message) {
  try {
    fn();
  } catch (error) {
    fail(message ?? `Got unwanted exception: ${error && error.message !== undefined ? error.message : String(error)}`);
  }
};
assert.rejects = async function (promiseOrFn, expected, message) {
  let threw = false;
  let thrown = null;
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    threw = true;
    thrown = error;
  }
  if (!threw) fail(message ?? "Missing expected rejection.");
  if (!matchesExpected(thrown, expected)) throw thrown;
};
assert.strict = assert;

export default assert;
export const ok = assert.ok;
export const equal = assert.equal;
export const notEqual = assert.notEqual;
export const strictEqual = assert.strictEqual;
export const notStrictEqual = assert.notStrictEqual;
export const deepEqual = assert.deepEqual;
export const deepStrictEqual = assert.deepStrictEqual;
export const notDeepStrictEqual = assert.notDeepStrictEqual;
export const match = assert.match;
export const throws = assert.throws;
export const doesNotThrow = assert.doesNotThrow;
export const rejects = assert.rejects;
export const strict = assert;
export { AssertionError, fail };
