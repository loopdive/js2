// The `expect` shim compiled INTO the module under test.
//
// React's upstream assertions are Jest's. Jest cannot run inside a Wasm
// module, so the admitted tests get a minimal, deliberately literal
// reimplementation of exactly the matchers they use — nothing more. Any test
// reaching for a matcher not in `SUPPORTED_MATCHERS` (react-upstream-extract.mjs)
// is rejected rather than scored against an approximation of Jest.
//
// The SAME source string is used for the native oracle run and for the
// compiled-Wasm run, so a divergence is always the compiler and never a
// difference between two hand-written shims.

export const REACT_EXPECT_SHIM = `
var __lastError = "";

function __objectIs(a, b) {
  if (a === b) {
    return a !== 0 || 1 / a === 1 / b;
  }
  return a !== a && b !== b;
}

function __isObject(value) {
  return value !== null && typeof value === "object";
}

function __deepEqual(a, b) {
  if (__objectIs(a, b)) return true;
  if (!__isObject(a) || !__isObject(b)) return false;
  var aIsArray = Array.isArray(a);
  var bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!__deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  var aKeys = Object.keys(a);
  var bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (var j = 0; j < aKeys.length; j++) {
    var key = aKeys[j];
    if (!__deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function __assert(ok, message) {
  if (!ok) {
    throw new Error(message);
  }
}

function __captureThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

function __messageOf(error) {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error.message === undefined || error.message === null) return "";
  return "" + error.message;
}

function __matchesExpected(error, expected) {
  if (expected === undefined) return true;
  var message = __messageOf(error);
  if (typeof expected === "string") return message.indexOf(expected) >= 0;
  if (__isObject(expected) && typeof expected.test === "function") return expected.test(message);
  if (typeof expected === "function") return error instanceof expected;
  return true;
}

function __contains(actual, expected) {
  if (typeof actual === "string") return actual.indexOf(expected) >= 0;
  if (Array.isArray(actual)) {
    for (var i = 0; i < actual.length; i++) {
      if (__objectIs(actual[i], expected)) return true;
    }
    return false;
  }
  return false;
}

function expect(actual) {
  return {
    toBe: function (expected) {
      __assert(__objectIs(actual, expected), "expected toBe to match");
    },
    toEqual: function (expected) {
      __assert(__deepEqual(actual, expected), "expected toEqual to match");
    },
    toThrow: function (expected) {
      var error = __captureThrow(actual);
      __assert(error !== null, "expected function to throw");
      __assert(__matchesExpected(error, expected), "thrown error did not match: " + __messageOf(error));
    },
    toThrowError: function (expected) {
      var error = __captureThrow(actual);
      __assert(error !== null, "expected function to throw");
      __assert(__matchesExpected(error, expected), "thrown error did not match: " + __messageOf(error));
    },
    toContain: function (expected) {
      __assert(__contains(actual, expected), "expected value to be contained");
    },
    toBeNull: function () {
      __assert(actual === null, "expected null");
    },
    toBeUndefined: function () {
      __assert(actual === undefined, "expected undefined");
    },
    toBeDefined: function () {
      __assert(actual !== undefined, "expected defined");
    },
    toBeTruthy: function () {
      __assert(!!actual, "expected truthy");
    },
    toBeFalsy: function () {
      __assert(!actual, "expected falsy");
    },
    toBeInstanceOf: function (expected) {
      __assert(actual instanceof expected, "expected instance");
    },
    toHaveLength: function (expected) {
      __assert(actual !== null && actual !== undefined && actual.length === expected, "expected length");
    },
    not: {
      toBe: function (expected) {
        __assert(!__objectIs(actual, expected), "expected not.toBe to differ");
      },
      toEqual: function (expected) {
        __assert(!__deepEqual(actual, expected), "expected not.toEqual to differ");
      },
      toThrow: function () {
        __assert(__captureThrow(actual) === null, "expected function not to throw");
      },
      toContain: function (expected) {
        __assert(!__contains(actual, expected), "expected value not to be contained");
      },
      toBeNull: function () {
        __assert(actual !== null, "expected not null");
      },
      toBeUndefined: function () {
        __assert(actual !== undefined, "expected not undefined");
      },
      toBeDefined: function () {
        __assert(actual === undefined, "expected not defined");
      },
      toBeTruthy: function () {
        __assert(!actual, "expected not truthy");
      },
      toBeFalsy: function () {
        __assert(!!actual, "expected not falsy");
      },
      toBeInstanceOf: function (expected) {
        __assert(!(actual instanceof expected), "expected not instance");
      },
      toHaveLength: function (expected) {
        __assert(!(actual !== null && actual !== undefined && actual.length === expected), "expected other length");
      }
    }
  };
}

function __recordError(error) {
  __lastError = __messageOf(error);
  return 0;
}
`;

/**
 * Body of one admitted upstream test, as an exported Wasm function.
 *
 * An `async` upstream body stays async — its `await`s are upstream's and
 * rewriting them away would silently change what the test checks. The caller
 * awaits the result on both the native and the compiled side.
 */
export function buildTestFunction(test, { exported = true } = {}) {
  const asyncKeyword = test.isAsync ? "async " : "";
  const keyword = exported ? `export ${asyncKeyword}function` : `${asyncKeyword}function`;
  return `${keyword} ${test.id}() {
  try {
${test.prelude}
${test.body}
    return 1;
  } catch (__error) {
    return __recordError(__error);
  }
}`;
}

/** Reads back the message recorded by the most recent failing test. */
export const LAST_ERROR_EXPORT = `export function __react_last_error() { return __lastError; }`;
