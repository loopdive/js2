// Host globals supplied to the unmodified test262 harness by the js2wasm lane.
// Keep this file plain JavaScript: test262-fyi/data prepends it verbatim before
// harness/assert.js, harness/sta.js, optional includes, and the raw test body.
var print = function (value) {
  console.log(value);
};

var $262 = {
  global: globalThis,
  // Host-provided identity sentinel used by IsHTMLDDA feature tests. This
  // object preserves the non-undefined identity required by destructuring and
  // nullish tests; compiler support for the full falsy/typeof/equality
  // [[IsHTMLDDA]] semantics remains a separate language-feature concern.
  IsHTMLDDA: function () {},
  createRealm: function () {
    // (#4634) A realm must expose error constructors with DISTINCT function
    // identity so the same-realm harness tests (assert-throws-same-realm,
    // asyncHelpers-throwsAsync-same-realm) can observe that a foreign
    // instance does not satisfy `assert.throws(TypeError, ...)`. The ctors
    // are minted via an anonymous factory ON PURPOSE: a function expression
    // literally named `TypeError` in this prelude shadows the builtin in the
    // compiler's name-keyed fnctor machinery for EVERY test module (the
    // 2026-08-23 merge_group park, 367 js-host regressions) — never name
    // these after builtins.
    var mkerr = function () {
      return function (msg) {
        this.message = msg;
      };
    };
    // The realm's global forwards the builtins the cross-realm corpus reads
    // (`.global.Array` / `.global.Proxy` / `.global.eval`) from the real
    // global, and overrides ONLY the error constructors with distinct
    // identities. Copied via `globalThis.<name>` member reads — the same
    // read path `global: globalThis` used to serve — never bare-identifier
    // value reads, whose standalone lowering differs per builtin.
    var realmGlobal = {
      Array: globalThis.Array,
      ArrayBuffer: globalThis.ArrayBuffer,
      Boolean: globalThis.Boolean,
      DataView: globalThis.DataView,
      Date: globalThis.Date,
      Function: globalThis.Function,
      Iterator: globalThis.Iterator,
      Map: globalThis.Map,
      Math: globalThis.Math,
      Number: globalThis.Number,
      // (#6651 U1) The `Object` forward was held back after the 2026-08-23
      // PR #4794 merge_group park (js-host `dynamic-import/assignment-
      // expression/import-meta.js` lost its TypeError). Lane S1 re-measured
      // 2026-09-26: that row passes WITH the forward on current main, and the
      // 196-row cross-realm bucket changed 0 host statuses. U1 re-checked the
      // row on both lanes before re-adding it.
      Object: globalThis.Object,
      Promise: globalThis.Promise,
      Proxy: globalThis.Proxy,
      RegExp: globalThis.RegExp,
      Set: globalThis.Set,
      String: globalThis.String,
      Symbol: globalThis.Symbol,
      WeakMap: globalThis.WeakMap,
      WeakSet: globalThis.WeakSet,
      eval: globalThis.eval,
      parseInt: globalThis.parseInt,
      Error: mkerr(),
      TypeError: mkerr(),
      RangeError: mkerr(),
      SyntaxError: mkerr(),
      ReferenceError: mkerr(),
      EvalError: mkerr(),
      URIError: mkerr(),
    };
    var realm = {
      global: realmGlobal,
      IsHTMLDDA: $262.IsHTMLDDA,
      createRealm: $262.createRealm,
      evalScript: $262.evalScript,
      gc: $262.gc,
      detachArrayBuffer: $262.detachArrayBuffer,
    };
    return realm;
  },
  evalScript: function (sourceText) {
    try {
      return __js2wasm_global_script_eval(sourceText);
    } catch (error) {
      // The standalone compiler recognizes the private host entry above. The
      // ordinary host lane has no such import, so preserve its native-eval
      // fallback without swallowing a ReferenceError thrown by the script.
      if (
        error instanceof ReferenceError &&
        typeof error.message === "string" &&
        error.message.indexOf("__js2wasm_global_script_eval") !== -1
      ) {
        return eval(sourceText);
      }
      throw error;
    }
  },
  gc: function () {},
  detachArrayBuffer: function (buffer) {
    if (typeof structuredClone !== "function") {
      // Standalone/WASI have no host `structuredClone`. Their native
      // ArrayBuffer representation observes this marker as a detached backing
      // store (`tryCompileStandaloneDetachedWrite`), so the literal Test262
      // harness can exercise detached-buffer semantics without a JS host.
      buffer.__detached__ = true;
      return;
    }
    structuredClone(buffer, { transfer: [buffer] });
  },
};
// Copyright (C) 2017 Ecma International.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: |
    Collection of assertion functions used throughout test262
defines:
  - assert
  - compareArray
  - formatIdentityFreeValue
  - formatSimpleValue
  - isNegativeZero
  - isPrimitive
---*/

function isNegativeZero(value) {
  return value === 0 && 1 / value === -Infinity;
}

function isPrimitive(value) {
  return !value || (typeof value !== "object" && typeof value !== "function");
}

function formatIdentityFreeValue(value) {
  switch (value === null ? "null" : typeof value) {
    case "string":
      return typeof JSON !== "undefined" ? JSON.stringify(value) : '"' + value + '"';
    case "bigint":
      return String(value) + "n";
    case "number":
      if (isNegativeZero(value)) return "-0";
    // falls through
    case "boolean":
    case "undefined":
    case "null":
      return String(value);
  }
}

function formatSimpleValue(value) {
  var basic = formatIdentityFreeValue(value);
  if (basic) return basic;
  try {
    return String(value);
  } catch (err) {
    if (err.name === "TypeError") {
      return Object.prototype.toString.call(value);
    }
    throw err;
  }
}

function assert(mustBeTrue, message) {
  if (mustBeTrue === true) {
    return;
  }

  if (message === undefined) {
    message = "Expected true but got " + assert._toString(mustBeTrue);
  }
  throw new Test262Error(message);
}

assert._isSameValue = function (a, b) {
  if (a === b) {
    // Handle +/-0 vs. -/+0
    return a !== 0 || 1 / a === 1 / b;
  }

  // Handle NaN vs. NaN
  return a !== a && b !== b;
};

assert.sameValue = function (actual, expected, message) {
  try {
    if (assert._isSameValue(actual, expected)) {
      return;
    }
  } catch (error) {
    throw new Test262Error(message + " (_isSameValue operation threw) " + error);
    return;
  }

  if (message === undefined) {
    message = "";
  } else {
    message += " ";
  }

  message += "Expected SameValue(«" + assert._toString(actual) + "», «" + assert._toString(expected) + "») to be true";

  throw new Test262Error(message);
};

assert.notSameValue = function (actual, unexpected, message) {
  if (!assert._isSameValue(actual, unexpected)) {
    return;
  }

  if (message === undefined) {
    message = "";
  } else {
    message += " ";
  }

  message +=
    "Expected SameValue(«" + assert._toString(actual) + "», «" + assert._toString(unexpected) + "») to be false";

  throw new Test262Error(message);
};

assert.throws = function (expectedErrorConstructor, func, message) {
  var expectedName, actualName;
  if (typeof func !== "function") {
    throw new Test262Error("assert.throws requires two arguments: the error constructor " + "and a function to run");
    return;
  }
  if (message === undefined) {
    message = "";
  } else {
    message += " ";
  }

  try {
    func();
  } catch (thrown) {
    if (typeof thrown !== "object" || thrown === null) {
      message += "Thrown value was not an object!";
      throw new Test262Error(message);
    } else if (thrown.constructor !== expectedErrorConstructor) {
      expectedName = expectedErrorConstructor.name;
      actualName = thrown.constructor.name;
      if (expectedName === actualName) {
        message += "Expected a " + expectedName + " but got a different error constructor with the same name";
      } else {
        message += "Expected a " + expectedName + " but got a " + actualName;
      }
      throw new Test262Error(message);
    }
    return;
  }

  message += "Expected a " + expectedErrorConstructor.name + " to be thrown but no exception was thrown at all";
  throw new Test262Error(message);
};

assert.compareArray = function (actual, expected, message) {
  message = message === undefined ? "" : message;

  if (typeof message === "symbol") {
    message = message.toString();
  }

  if (isPrimitive(actual)) {
    assert(false, "Actual argument [" + actual + "] shouldn't be primitive. " + String(message));
  } else if (isPrimitive(expected)) {
    assert(false, "Expected argument [" + expected + "] shouldn't be primitive. " + String(message));
  }
  var result = compareArray(actual, expected);
  if (result) return;

  var format = compareArray.format;
  assert(
    false,
    "Actual " +
      format(actual) +
      " and expected " +
      format(expected) +
      " should have the same contents. " +
      String(message),
  );
};

function compareArray(a, b) {
  if (b.length !== a.length) {
    return false;
  }
  for (var i = 0; i < a.length; i++) {
    if (!assert._isSameValue(b[i], a[i])) {
      return false;
    }
  }
  return true;
}

compareArray.format = function (arrayLike) {
  return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]";
};

assert._formatIdentityFreeValue = formatIdentityFreeValue;

assert._toString = formatSimpleValue;
// Copyright (c) 2012 Ecma International.  All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: |
    Provides both:

    - An error class to avoid false positives when testing for thrown exceptions
    - A function to explicitly throw an exception using the Test262Error class
defines: [Test262Error, $DONOTEVALUATE]
---*/

function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}

Test262Error.prototype.toString = function () {
  return "Test262Error: " + this.message;
};

Test262Error.thrower = function (message) {
  throw new Test262Error(message);
};

function $DONOTEVALUATE() {
  throw "Test262: This statement should not be evaluated.";
}

assert.sameValue(1, 1);
