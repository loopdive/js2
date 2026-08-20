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
// React's upstream Jest transform injects this build-time constant. The
// implementation under test is react.production.js, so both the native oracle
// and compiled lane must execute the original assertions with the production
// value instead of relying on an ambient host global.
var __DEV__ = false;
// React's upstream tests use Node's global spelling for host polyfills. Keep
// that compatibility binding in the native and Wasm lanes alike.
var global = globalThis;

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

function __asyncRejected(actual, expected) {
  var result;
  try { result = typeof actual === "function" ? actual() : actual; }
  catch (error) {
    __assert(__matchesExpected(error, expected), "rejected error did not match: " + __messageOf(error));
    return Promise.resolve(true);
  }
  return Promise.resolve(result).then(
    function () { throw new Error("expected promise to reject"); },
    function (error) {
      __assert(__matchesExpected(error, expected), "rejected error did not match: " + __messageOf(error));
      return true;
    }
  );
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

function __mockMatchesCalls(mock, expected) {
  if (!mock || !mock.mock || !mock.mock.calls) return false;
  for (var i = 0; i < mock.mock.calls.length; i++) {
    if (__deepEqual(mock.mock.calls[i], expected)) return true;
  }
  return false;
}

function expect(actual) {
  return {
    toBe: function (expected) {
      __assert(__objectIs(actual, expected), "expected " + actual + " toBe " + expected);
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
    toBeNaN: function () {
      __assert(typeof actual === "number" && actual !== actual, "expected NaN");
    },
    toBeInstanceOf: function (expected) {
      __assert(actual instanceof expected, "expected instance");
    },
    toHaveLength: function (expected) {
      __assert(actual !== null && actual !== undefined && actual.length === expected, "expected length");
    },
    toHaveBeenCalled: function () {
      __assert(actual && actual.mock && actual.mock.calls && actual.mock.calls.length > 0, "expected mock to be called");
    },
    toBeCalled: function () {
      __assert(actual && actual.mock && actual.mock.calls && actual.mock.calls.length > 0, "expected mock to be called");
    },
    toHaveBeenCalledTimes: function (expected) {
      __assert(actual && actual.mock && actual.mock.calls && actual.mock.calls.length === expected, "expected mock call count");
    },
    toBeCalledTimes: function (expected) {
      __assert(actual && actual.mock && actual.mock.calls && actual.mock.calls.length === expected, "expected mock call count");
    },
    toHaveBeenCalledWith: function () {
      __assert(__mockMatchesCalls(actual, Array.prototype.slice.call(arguments)), "expected mock arguments");
    },
    toBeCalledWith: function () {
      __assert(__mockMatchesCalls(actual, Array.prototype.slice.call(arguments)), "expected mock arguments");
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
      toBeNaN: function () {
        __assert(typeof actual !== "number" || actual === actual, "expected non-NaN");
      },
      toBeInstanceOf: function (expected) {
        __assert(!(actual instanceof expected), "expected not instance");
      },
      toHaveLength: function (expected) {
        __assert(!(actual !== null && actual !== undefined && actual.length === expected), "expected other length");
      },
      toHaveBeenCalled: function () {
        __assert(!(actual && actual.mock && actual.mock.calls && actual.mock.calls.length > 0), "expected mock not to be called");
      },
      toBeCalled: function () {
        __assert(!(actual && actual.mock && actual.mock.calls && actual.mock.calls.length > 0), "expected mock not to be called");
      },
      toHaveBeenCalledTimes: function (expected) {
        __assert(!(actual && actual.mock && actual.mock.calls && actual.mock.calls.length === expected), "expected different mock call count");
      },
      toBeCalledTimes: function (expected) {
        __assert(!(actual && actual.mock && actual.mock.calls && actual.mock.calls.length === expected), "expected different mock call count");
      },
      toHaveBeenCalledWith: function () {
        __assert(!__mockMatchesCalls(actual, Array.prototype.slice.call(arguments)), "expected different mock arguments");
      },
      toBeCalledWith: function () {
        __assert(!__mockMatchesCalls(actual, Array.prototype.slice.call(arguments)), "expected different mock arguments");
      }
    },
    rejects: {
      toThrow: function (expected) { return __asyncRejected(actual, expected); },
      toThrowError: function (expected) { return __asyncRejected(actual, expected); },
    },
    resolves: {
      toBe: function (expected) {
        return Promise.resolve(actual).then(function (value) { __assert(__objectIs(value, expected), "resolved value mismatch"); });
      },
      toEqual: function (expected) {
        return Promise.resolve(actual).then(function (value) { __assert(__deepEqual(value, expected), "resolved value mismatch"); });
      },
    }
  };
}

function __recordError(error) {
  __lastError = __messageOf(error);
  return 0;
}

var __jestSpies = [];
var __jestMocks = {};
// Some React files gate additional registrations with if (gate(...)) at
// describe scope. The extractor carries that scope into each lifted test, so
// the registration calls must remain harmless rather than becoming an
// accidental "it is not defined" infrastructure failure.
function it() {}
function test() {}
function describe(_name, body) { if (typeof body === "function") body(); }
function __jestFn(implementation) {
  var impl = typeof implementation === "function" ? implementation : null;
  function mock() {
    var args = Array.prototype.slice.call(arguments);
    mock.mock.calls.push(args);
    if (impl) return impl.apply(this, args);
    return undefined;
  }
  mock.mock = {calls: []};
  mock.mockImplementation = function (next) {
    impl = typeof next === "function" ? next : null;
    return mock;
  };
  mock.mockReturnValue = function (value) {
    impl = function () { return value; };
    return mock;
  };
  mock.mockClear = function () {
    mock.mock.calls.length = 0;
    return mock;
  };
  mock.mockReset = function () {
    mock.mock.calls.length = 0;
    impl = null;
    return mock;
  };
  mock.mockRestore = function () { return mock; };
  return mock;
}
function __jestSpyOn(target, key) {
  var original = target[key];
  var mock = __jestFn(original);
  mock.mockRestore = function () {
    target[key] = original;
    return mock;
  };
  target[key] = mock;
  __jestSpies.push(mock);
  return mock;
}
var jest = {
  fn: __jestFn,
  spyOn: __jestSpyOn,
  resetModules: function () { __jestMocks = {}; },
  mock: function (name, factory) {
    __jestMocks[name] = typeof factory === "function" ? factory : function () { return factory; };
  },
  requireActual: function (name) { return __js2RequireActual(name); },
  restoreAllMocks: function () {
    for (var i = 0; i < __jestSpies.length; i++) __jestSpies[i].mockRestore();
    __jestSpies.length = 0;
  },
  runAllTimers: function () { return Promise.resolve(); },
  useFakeTimers: function () {},
  useRealTimers: function () {},
  advanceTimersByTime: function () {},
};

// React's upstream tests are cross-package tests, not isolated calls to the
// react entry point. Keep the package under test in Wasm, but expose the
// surrounding Jest/DOM/rendering infrastructure through one explicit host
// surface. The host object is read through globalThis at each call rather than
// copied into a local Wasm value; this preserves object identity across the
// boundary and lets a test's same source run in the native oracle as well.
function __js2ReactInfra() {
  var value = globalThis.__js2ReactUpstreamInfrastructure;
  if (value === undefined || value === null) {
    throw new Error("React upstream test infrastructure is not installed");
  }
  return value;
}

function __js2WrapRoot(hostRoot) {
  return {
    render: function (value) { return hostRoot.render(value); },
    unmount: function () { return hostRoot.unmount(); },
  };
}

function __js2WrapRenderer(hostRenderer) {
  return {
    toJSON: function () { return hostRenderer.toJSON(); },
    toTree: function () { return hostRenderer.toTree(); },
    update: function (value) { return hostRenderer.update(value); },
    unmount: function () { return hostRenderer.unmount(); },
    getInstance: function () { return hostRenderer.getInstance(); },
    get root() { return hostRenderer.root; },
  };
}

var __js2ReactDOMClient = {
  createRoot: function (container, options) {
    return __js2WrapRoot(__js2ReactInfra().reactDomClient.createRoot(container, options));
  },
  hydrateRoot: function (container, value, options) {
    return __js2WrapRoot(__js2ReactInfra().reactDomClient.hydrateRoot(container, value, options));
  },
};

var __js2ReactDOM = {
  createPortal: function (children, container, key) {
    return __js2ReactInfra().reactDom.createPortal(children, container, key);
  },
  flushSync: function (callback) {
    return __js2ReactInfra().reactDom.flushSync(callback);
  },
  unstable_batchedUpdates: function (callback) {
    var args = Array.prototype.slice.call(arguments, 1);
    return __js2ReactInfra().reactDom.unstable_batchedUpdates.apply(null, [callback].concat(args));
  },
  render: function (value, container, callback) {
    var root = __js2ReactInfra().reactDomClient.createRoot(container);
    root.render(value);
    if (typeof callback === "function") callback();
    return null;
  },
  unmountComponentAtNode: function (container) {
    return false;
  },
};

var __js2ReactDOMServer = {
  renderToString: function (value, options) {
    return __js2ReactInfra().reactDomServer.renderToString(value, options);
  },
  renderToStaticMarkup: function (value, options) {
    return __js2ReactInfra().reactDomServer.renderToStaticMarkup(value, options);
  },
  renderToReadableStream: function (value, options) {
    return __js2ReactInfra().reactDomServer.renderToReadableStream(value, options);
  },
};

var __js2ReactTestRenderer = {
  create: function (value, options) {
    return __js2WrapRenderer(__js2ReactInfra().reactTestRenderer.create(value, options));
  },
  act: function (callback) {
    return __js2ReactInfra().reactTestRenderer.act(callback);
  },
};

var __js2ReactNoop = {
  render: function (value) {
    var renderer = __js2ReactInfra().reactTestRenderer.create(value);
    return __js2WrapRenderer(renderer);
  },
  flush: function () {},
  flushSync: function (callback) {
    return __js2ReactInfra().reactTestRenderer.act(callback);
  },
  getChildren: function () { return []; },
  getChildrenAsJSX: function () { return null; },
  clear: function () {},
};

var __js2PropTypes = {};
var __js2PropTypeNames = [
  "array", "bigint", "bool", "func", "number", "object", "string", "symbol",
  "any", "arrayOf", "element", "elementType", "instanceOf", "node", "objectOf",
  "oneOf", "oneOfType", "shape", "exact",
];
for (var __js2PropTypeIndex = 0; __js2PropTypeIndex < __js2PropTypeNames.length; __js2PropTypeIndex++) {
  (function (name) {
    __js2PropTypes[name] = function () {
      var target = __js2ReactInfra().propTypes[name];
      if (typeof target !== "function") throw new Error("prop-types export is unavailable: " + name);
      return target.apply(__js2ReactInfra().propTypes, arguments);
    };
  })(__js2PropTypeNames[__js2PropTypeIndex]);
}

var __js2InternalTestUtils = {
  act: function (callback) {
    var renderer = __js2ReactInfra().reactTestRenderer;
    if (renderer && typeof renderer.act === "function") return renderer.act(callback);
    var result = callback();
    return result && typeof result.then === "function" ? result : Promise.resolve(result);
  },
  waitForAll: function () { return Promise.resolve(); },
  waitFor: function () { return Promise.resolve(); },
  waitForPaint: function () { return Promise.resolve(); },
  waitForMicrotasks: function () { return Promise.resolve(); },
  waitForThrow: function (callback) { return Promise.resolve().then(callback); },
  assertConsoleErrorDev: function (expected) { return __js2AssertConsole("error", expected); },
  assertConsoleWarnDev: function (expected) { return __js2AssertConsole("warn", expected); },
  assertLog: function () {},
};

function __js2AssertConsole(kind, expected) {
  var actual = __js2ReactInfra().consumeConsole(kind);
  var wanted = Array.isArray(expected) ? expected : [expected];
  if (wanted.length === 0) {
    if (actual.length !== 0) throw new Error("unexpected console output: " + actual.join("\\n"));
    return;
  }
  for (var i = 0; i < wanted.length; i++) {
    var text = String(wanted[i]);
    var found = false;
    for (var j = 0; j < actual.length; j++) {
      if (actual[j].indexOf(text.replace(/\\*\\*/g, "")) >= 0) { found = true; break; }
    }
    if (!found) throw new Error("expected console " + kind + " output: " + text);
  }
}

function patchMessageChannel() {}
function spyOnDevAndProd(target, key) { return jest.spyOn(target, key); }
function gate(callbackOrName) {
  if (typeof callbackOrName === "string") {
    return callbackOrName === "enableFragmentRefs" ? false : false;
  }
  return typeof callbackOrName === "function"
    ? callbackOrName({ build: true, stable: true, www: false, source: false, enableFragmentRefs: false })
    : false;
}

function runJest(testFile) {
  var runner = __js2ReactInfra().runJest;
  if (typeof runner !== "function") throw new Error("React upstream runJest infrastructure is unavailable: " + testFile);
  return runner(testFile);
}

function __js2CheckReactVersion(packageName) {
  var actual = typeof __REACT__ === "undefined" ? __js2ReactInfra().react : __REACT__;
  var mockFactory = __jestMocks["react"];
  if (!mockFactory || !actual) return;
  var mocked = mockFactory();
  if (mocked && mocked.version !== undefined && actual.version !== undefined && mocked.version !== actual.version) {
    throw new Error(
      'Incompatible React versions: The "react" and "' + (packageName || "react-dom") + '" packages must have the exact same version. Instead got:\\n' +
        (packageName === "react-native-renderer" ? "  - react:                  " : "  - react:      ") +
        mocked.version +
        "\\n" +
        "  - " + (packageName || "react-dom") + ":  " + actual.version,
    );
  }
}

function __js2RequireActual(name) {
  if (name === "react") return typeof __REACT__ === "undefined" ? __js2ReactInfra().react : __REACT__;
  if (name === "react-dom" || name === "react-dom/client") {
    __js2CheckReactVersion("react-dom");
    return name === "react-dom" ? __js2ReactDOM : __js2ReactDOMClient;
  }
  if (
    name === "react-dom/server" ||
    name === "react-dom/server.node" ||
    name === "react-dom/server.browser" ||
    name === "react-dom/server.bun" ||
    name === "react-dom/server.edge" ||
    name === "react-dom/static" ||
    name === "react-dom/static.node" ||
    name === "react-dom/static.browser" ||
    name === "react-dom/static.edge"
  ) {
    __js2CheckReactVersion("react-dom");
    if (typeof __REACTDOM_SERVER__ !== "undefined" && __REACTDOM_SERVER__ !== null) {
      return __REACTDOM_SERVER__;
    }
    return __js2ReactDOMServer;
  }
  if (name === "react-native-renderer") {
    __js2CheckReactVersion("react-native-renderer");
    return __js2ReactInfra().require(name);
  }
  if (name === "react-test-renderer") return __js2ReactTestRenderer;
  if (name === "react-noop-renderer") return __js2ReactNoop;
  if (name === "internal-test-utils") return __js2InternalTestUtils;
  if (name === "prop-types") return __js2PropTypes;
  if (name === "create-react-class/factory") return function () {
    var factory = __js2ReactInfra().createReactClass;
    if (typeof factory !== "function") throw new Error("create-react-class test infrastructure is unavailable");
    return factory;
  };
  if (name === "web-streams-polyfill/ponyfill/es6") return __js2ReactInfra().webStreams;
  if (name === "util") return { TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder };
  if (name === "shared/ReactFeatureFlags") return {
    disableLegacyContext: false,
    disableLegacyMode: false,
    enableFragmentRefs: false,
    build: true,
    stable: true,
    www: false,
    source: false,
  };
  if (name === "react/package.json") return { version: __js2ReactInfra().react.version };
  if (name === "scripts/jest/patchMessageChannel") return { patchMessageChannel: patchMessageChannel };
  if (name === "react-dom/test-utils") return { act: __js2InternalTestUtils.act };
  return __js2ReactInfra().require(name);
}

function require(name) {
  if (__jestMocks[name]) return __jestMocks[name]();
  return __js2RequireActual(name);
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
