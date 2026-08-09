// The `assert` surface lit's own tests use, implemented in plain JS so the
// SAME SOURCE is compiled into the Wasm module and evaluated for the native
// oracle. Two hand-written shims would let a difference between the shims
// masquerade as a compiler bug; one source cannot.
//
// The member list is not guessed — it is every `assert.*` that appears across
// the 58 pinned upstream test files. A member outside it throws a named error,
// which fails identically on both sides and therefore lands in
// `harness-incompatible` rather than being scored against an approximation.

export const LIT_ASSERT_SHIM = `
var __lastError = "";
function __recordError(e) {
  __lastError = e && e.message ? String(e.message) : String(e);
  return 0;
}
function __objectIs(a, b) {
  if (a === b) return a !== 0 || 1 / a === 1 / b;
  return a !== a && b !== b;
}
function __deepEqual(a, b) {
  if (__objectIs(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!__deepEqual(a[i], b[i])) return false;
    return true;
  }
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var j = 0; j < ka.length; j++) {
    if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false;
    if (!__deepEqual(a[ka[j]], b[ka[j]])) return false;
  }
  return true;
}
function __show(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch (e) { return "[object]"; } }
  return String(v);
}
function __fail(message) { throw new Error(message); }
function __check(ok, message) { if (!ok) __fail(message); }
function __length(v) {
  if (v === null || v === undefined) return -1;
  if (typeof v.length === "number") return v.length;
  if (typeof v.size === "number") return v.size;
  return -1;
}

var assert = {
  // chai's \`equal\` is ==, \`strictEqual\` is ===. lit relies on the difference
  // in a handful of places, so they are NOT aliases here.
  equal: function (a, b, m) { __check(a == b, m || ("expected " + __show(a) + " to equal " + __show(b))); },
  notEqual: function (a, b, m) { __check(a != b, m || ("expected " + __show(a) + " to not equal " + __show(b))); },
  strictEqual: function (a, b, m) { __check(__objectIs(a, b), m || ("expected " + __show(a) + " to strictly equal " + __show(b))); },
  notStrictEqual: function (a, b, m) { __check(!__objectIs(a, b), m || ("expected " + __show(a) + " to not strictly equal " + __show(b))); },
  deepEqual: function (a, b, m) { __check(__deepEqual(a, b), m || ("expected " + __show(a) + " to deep equal " + __show(b))); },
  isTrue: function (v, m) { __check(v === true, m || ("expected " + __show(v) + " to be true")); },
  isFalse: function (v, m) { __check(v === false, m || ("expected " + __show(v) + " to be false")); },
  isOk: function (v, m) { __check(!!v, m || ("expected " + __show(v) + " to be truthy")); },
  ok: function (v, m) { __check(!!v, m || ("expected " + __show(v) + " to be truthy")); },
  notOk: function (v, m) { __check(!v, m || ("expected " + __show(v) + " to be falsy")); },
  isNull: function (v, m) { __check(v === null, m || ("expected " + __show(v) + " to be null")); },
  isNotNull: function (v, m) { __check(v !== null, m || ("expected " + __show(v) + " to not be null")); },
  isUndefined: function (v, m) { __check(v === undefined, m || ("expected " + __show(v) + " to be undefined")); },
  isDefined: function (v, m) { __check(v !== undefined, m || ("expected " + __show(v) + " to be defined")); },
  isNaN: function (v, m) { __check(v !== v, m || ("expected " + __show(v) + " to be NaN")); },
  isArray: function (v, m) { __check(Array.isArray(v), m || ("expected " + __show(v) + " to be an array")); },
  isEmpty: function (v, m) {
    var n = v && typeof v === "object" && !Array.isArray(v) && typeof v.length !== "number"
      ? Object.keys(v).length : __length(v);
    __check(n === 0, m || ("expected " + __show(v) + " to be empty"));
  },
  lengthOf: function (v, n, m) { __check(__length(v) === n, m || ("expected length " + __length(v) + " to be " + n)); },
  instanceOf: function (v, c, m) { __check(v instanceof c, m || ("expected " + __show(v) + " to be an instance of " + (c && c.name))); },
  isAtMost: function (a, b, m) { __check(a <= b, m || ("expected " + __show(a) + " to be at most " + __show(b))); },
  oneOf: function (v, list, m) {
    var found = false;
    for (var i = 0; i < list.length; i++) if (__objectIs(v, list[i])) found = true;
    __check(found, m || ("expected " + __show(v) + " to be one of " + __show(list)));
  },
  sameMembers: function (a, b, m) {
    var ok = Array.isArray(a) && Array.isArray(b) && a.length === b.length;
    if (ok) for (var i = 0; i < a.length; i++) {
      var found = false;
      for (var j = 0; j < b.length; j++) if (__objectIs(a[i], b[j])) found = true;
      if (!found) ok = false;
    }
    __check(ok, m || ("expected " + __show(a) + " to have the same members as " + __show(b)));
  },
  include: function (haystack, needle, m) {
    var ok;
    if (typeof haystack === "string") ok = haystack.indexOf(needle) !== -1;
    else if (Array.isArray(haystack)) {
      ok = false;
      for (var i = 0; i < haystack.length; i++) if (__objectIs(haystack[i], needle)) ok = true;
    } else if (haystack && typeof haystack.has === "function") ok = haystack.has(needle);
    else if (haystack && typeof haystack === "object" && needle && typeof needle === "object") {
      ok = true;
      var keys = Object.keys(needle);
      for (var k = 0; k < keys.length; k++) if (!__deepEqual(haystack[keys[k]], needle[keys[k]])) ok = false;
    } else ok = false;
    __check(ok, m || ("expected " + __show(haystack) + " to include " + __show(needle)));
  },
  throws: function (fn, expected, m) {
    var threw = false, error = null;
    try { fn(); } catch (e) { threw = true; error = e; }
    __check(threw, m || "expected function to throw");
    if (typeof expected === "string") {
      var text = error && error.message ? String(error.message) : String(error);
      __check(text.indexOf(expected) !== -1, m || ("expected error " + __show(text) + " to include " + __show(expected)));
    } else if (typeof expected === "function") {
      __check(error instanceof expected, m || "expected error to be an instance of the given constructor");
    }
  },
  doesNotThrow: function (fn, m) {
    try { fn(); } catch (e) { __fail(m || ("expected function not to throw, got " + __show(e && e.message))); }
  },
  fail: function (m) { __fail(m || "assert.fail()"); },
};
`;

export const LAST_ERROR_EXPORT = `export function __lit_last_error() {\n  return __lastError;\n}`;

/**
 * Wraps one upstream test body in a callable function returning 1 on pass and
 * 0 on failure. The prelude is upstream's own `setup` hook; the body is
 * upstream's own, verbatim.
 */
export function buildTestFunction(test, { exported = true } = {}) {
  const asyncKeyword = test.isAsync ? "async " : "";
  const keyword = exported ? `export ${asyncKeyword}function` : `${asyncKeyword}function`;
  return `${keyword} ${test.id}() {\n  try {\n${test.prelude}\n${test.body}\n    return 1;\n  } catch (__error) {\n    return __recordError(__error);\n  }\n}`;
}
