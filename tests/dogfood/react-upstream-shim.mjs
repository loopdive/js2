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
// React's Jest transform injects these build selectors as lexical constants.
// The published stable package is neither an www variant nor an experimental
// build, so expose the same values instead of letting original tests fail at
// the build constants are not defined.
var __VARIANT__ = false;
var __EXPERIMENTAL__ = false;
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
  if (b !== null && b !== undefined && typeof b === "object") {
    if (b.__js2ObjectContaining !== undefined) {
      var objectExpected = b.__js2ObjectContaining;
      if (!__isObject(a)) return false;
      var objectKeys = Object.keys(objectExpected);
      for (var objectIndex = 0; objectIndex < objectKeys.length; objectIndex++) {
        var objectKey = objectKeys[objectIndex];
        if (!__deepEqual(a[objectKey], objectExpected[objectKey])) return false;
      }
      return true;
    }
    if (b.__js2ArrayContaining !== undefined) {
      if (!Array.isArray(a)) return false;
      var arrayExpected = b.__js2ArrayContaining;
      for (var arrayIndex = 0; arrayIndex < arrayExpected.length; arrayIndex++) {
        var found = false;
        for (var actualIndex = 0; actualIndex < a.length; actualIndex++) {
          if (__deepEqual(a[actualIndex], arrayExpected[arrayIndex])) {
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      return true;
    }
  }
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

function __containsEqual(actual, expected) {
  if (!Array.isArray(actual)) return false;
  for (var i = 0; i < actual.length; i++) {
    if (__deepEqual(actual[i], expected)) return true;
  }
  return false;
}

function __match(actual, expected) {
  var value = "" + actual;
  if (expected !== null && expected !== undefined && typeof expected.test === "function") {
    expected.lastIndex = 0;
    return expected.test(value);
  }
  return value.indexOf("" + expected) >= 0;
}

function __snapshotValue(value) {
  if (value !== null && value !== undefined && typeof value.outerHTML === "string") return value.outerHTML;
  if (value !== null && value !== undefined && typeof value.toJSON === "function") return value.toJSON();
  return value;
}

function __normalizeSnapshot(value) {
  return ("" + value).replace(/\\r\\n/g, "\\n").trim().replace(/\\n[ \\t]+/g, "\\n");
}

function __snapshotMatches(actual, expected) {
  var value = __snapshotValue(actual);
  var serialized = typeof value === "string" ? JSON.stringify(value) : value;
  var wanted = __normalizeSnapshot(expected);
  return __normalizeSnapshot(serialized) === wanted || __normalizeSnapshot(value) === wanted;
}

function __renderedOutput(value) {
  if (value !== null && value !== undefined && typeof value.getChildrenAsJSX === "function") {
    return value.getChildrenAsJSX();
  }
  if (value !== null && value !== undefined && typeof value.toJSON === "function") return value.toJSON();
  return value;
}

function __mockMatchesCalls(mock, expected) {
  if (!mock || !mock.mock || !mock.mock.calls) return false;
  for (var i = 0; i < mock.mock.calls.length; i++) {
    if (__deepEqual(mock.mock.calls[i], expected)) return true;
  }
  return false;
}

function __mockMatchesNthCall(mock, index, expected) {
  if (!mock || !mock.mock || !mock.mock.calls || index < 1 || index > mock.mock.calls.length) return false;
  return __deepEqual(mock.mock.calls[index - 1], expected);
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
    toContainEqual: function (expected) {
      __assert(__containsEqual(actual, expected), "expected value to contain an equal item");
    },
    toMatch: function (expected) {
      __assert(__match(actual, expected), "expected value to match");
    },
    toMatchInlineSnapshot: function (expected) {
      __assert(__snapshotMatches(actual, expected), "expected value to match inline snapshot");
    },
    toMatchRenderedOutput: function (expected) {
      __assert(__deepEqual(__renderedOutput(actual), expected), "expected rendered output to match");
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
    toBeGreaterThan: function (expected) {
      __assert(actual > expected, "expected " + actual + " toBeGreaterThan " + expected);
    },
    toBeCalledWith: function () {
      __assert(__mockMatchesCalls(actual, Array.prototype.slice.call(arguments)), "expected mock arguments");
    },
    toHaveBeenNthCalledWith: function (index) {
      __assert(
        __mockMatchesNthCall(actual, index, Array.prototype.slice.call(arguments, 1)),
        "expected nth mock arguments"
      );
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
      toContainEqual: function (expected) {
        __assert(!__containsEqual(actual, expected), "expected value not to contain an equal item");
      },
      toMatch: function (expected) {
        __assert(!__match(actual, expected), "expected value not to match");
      },
      toMatchInlineSnapshot: function (expected) {
        __assert(!__snapshotMatches(actual, expected), "expected value not to match inline snapshot");
      },
      toMatchRenderedOutput: function (expected) {
        __assert(!__deepEqual(__renderedOutput(actual), expected), "expected rendered output not to match");
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
      toBeGreaterThan: function (expected) {
        __assert(!(actual > expected), "expected not.toBeGreaterThan " + expected);
      },
      toBeCalledWith: function () {
        __assert(!__mockMatchesCalls(actual, Array.prototype.slice.call(arguments)), "expected different mock arguments");
      },
      toHaveBeenNthCalledWith: function (index) {
        __assert(
          !__mockMatchesNthCall(actual, index, Array.prototype.slice.call(arguments, 1)),
          "expected different nth mock arguments"
        );
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
      not: {
        toThrow: function () {
          return Promise.resolve(actual).then(function (value) {
            if (typeof value !== "function") return;
            __assert(__captureThrow(value) === null, "expected resolved function not to throw");
          });
        },
        toThrowError: function () {
          return Promise.resolve(actual).then(function (value) {
            if (typeof value !== "function") return;
            __assert(__captureThrow(value) === null, "expected resolved function not to throw");
          });
        },
      },
    }
  };
}

// Jest exposes asymmetric matchers as static helpers on expect. Keep their
// marker objects inside the same literal matcher implementation so
// toEqual(expect.objectContaining(...)) and
// toEqual(expect.arrayContaining(...)) behave identically in the native
// oracle and compiled Wasm lanes.
expect.objectContaining = function (value) {
  return { __js2ObjectContaining: value };
};
expect.arrayContaining = function (value) {
  return { __js2ArrayContaining: value };
};

function __recordError(error) {
  __lastError = __messageOf(error);
  return 0;
}

var __jestSpies = [];
var __jestMocks = {};
var __jestIsolationDepth = 0;
var __jestIsolationModules = null;
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
function __js2CloneModuleNamespace(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object" && typeof value !== "function") return value;
  var clone;
  if (typeof value === "function") {
    clone = function () { return value.apply(this, arguments); };
  } else if (Array.isArray(value)) {
    clone = value.slice();
  } else {
    clone = {};
  }
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) clone[keys[i]] = value[keys[i]];
  return clone;
}
function __js2IsolatedModule(name, value) {
  if (__jestIsolationDepth === 0) return value;
  if (__jestIsolationModules === null) __jestIsolationModules = {};
  if (Object.prototype.hasOwnProperty.call(__jestIsolationModules, name)) return __jestIsolationModules[name];
  var isolated = __js2CloneModuleNamespace(value);
  __jestIsolationModules[name] = isolated;
  return isolated;
}
function __jestIsolateModules(callback) {
  var previousDepth = __jestIsolationDepth;
  var previousModules = __jestIsolationModules;
  __jestIsolationDepth = previousDepth + 1;
  __jestIsolationModules = {};
  try {
    return typeof callback === "function" ? callback() : undefined;
  } finally {
    __jestIsolationDepth = previousDepth;
    __jestIsolationModules = previousModules;
  }
}
var jest = {
  fn: __jestFn,
  spyOn: __jestSpyOn,
  resetModules: function () { __jestMocks = {}; },
  // Jest gives each isolateModules callback a fresh module registry. The
  // package graphs themselves stay host-owned here, so the faithful boundary
  // is a fresh namespace object per required module, scoped to the callback.
  // This preserves the identity contract tested by ReactDOM without mutating
  // Node's process-wide require cache or leaking state into later callbacks.
  isolateModules: __jestIsolateModules,
  mock: function (name, factory) {
    __jestMocks[name] = typeof factory === "function" ? factory : function () { return factory; };
  },
  unmock: function (name) {
    delete __jestMocks[name];
  },
  requireActual: function (name) { return __js2IsolatedModule(name, __js2RequireActual(name)); },
  restoreAllMocks: function () {
    for (var i = 0; i < __jestSpies.length; i++) __jestSpies[i].mockRestore();
    __jestSpies.length = 0;
  },
  runAllTimers: function () { return Promise.resolve(); },
  useFakeTimers: function () {},
  useRealTimers: function () {},
  setTimeout: function () {},
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

function __js2PrepareReactValue(value) {
  var infra = __js2ReactInfra();
  return infra.prepareReactValues && typeof infra.prepareReactValue === "function"
    ? infra.prepareReactValue(value)
    : value;
}

function __js2NodeStreamFacade() {
  return {
    PassThrough: function () {
      return __js2ReactInfra().createPassThrough();
    },
  };
}

// ReactDOM's Fizz tests import this private monorepo helper. It is test
// infrastructure, not part of the published package graph, so keep the
// browser/DOM behavior on the host while exposing the same named functions to
// the native oracle and the compiled test lane.
async function __js2FizzExecuteScript(script) {
  var ownerDocument = script.ownerDocument;
  if (script.parentNode === null) {
    throw new Error("executeScript expects to be called on script nodes that are currently in a document");
  }
  var parent = script.parentNode;
  var scriptSrc = script.getAttribute("src");
  if (scriptSrc) {
    if (document !== ownerDocument) {
      throw new Error("You must set the current document to the global document to use script src in tests");
    }
    try {
      require(scriptSrc);
    } catch (error) {
      var event = new window.ErrorEvent("error", { error: error });
      window.dispatchEvent(event);
    }
    return;
  }
  var newScript = ownerDocument.createElement("script");
  newScript.textContent = script.textContent;
  for (var index = 0; index < script.attributes.length; index++) {
    var attribute = script.attributes[index];
    newScript.setAttribute(attribute.name, attribute.value);
  }
  parent.insertBefore(newScript, script);
  parent.removeChild(script);
}

async function __js2FizzInsertNodesAndExecuteScripts(source, target, CSPnonce) {
  var ownerDocument = target.ownerDocument || target;
  var badNonceScriptNodes = new Map();
  if (CSPnonce) {
    var scripts = source.querySelectorAll("script");
    for (var index = 0; index < scripts.length; index++) {
      var script = scripts[index];
      if (!script.hasAttribute("src") && script.getAttribute("nonce") !== CSPnonce) {
        badNonceScriptNodes.set(script, script.textContent);
        script.textContent = "";
      }
    }
  }
  var lastChild = null;
  while (source.firstChild) {
    var node = source.firstChild;
    if (lastChild === node) throw new Error("Infinite loop.");
    lastChild = node;
    if (node.nodeType === 1) {
      var element = node;
      if (
        element.dataset != null &&
        (element.dataset.rxi != null ||
          element.dataset.rri != null ||
          element.dataset.rci != null ||
          element.dataset.rsi != null)
      ) {
        ownerDocument.body.appendChild(element);
      } else {
        target.appendChild(element);
        if (element.nodeName === "SCRIPT") {
          await __js2FizzExecuteScript(element);
        } else {
          var nestedScripts = element.querySelectorAll("script");
          for (var nestedIndex = 0; nestedIndex < nestedScripts.length; nestedIndex++) {
            await __js2FizzExecuteScript(nestedScripts[nestedIndex]);
          }
        }
      }
    } else {
      target.appendChild(node);
    }
  }
  badNonceScriptNodes.forEach(function (scriptContent, script) {
    script.textContent = scriptContent;
  });
}

function __js2FizzMergeOptions(options, defaultOptions) {
  return Object.assign({}, defaultOptions, options);
}

function __js2FizzStripExternalRuntimeInNodes(nodes, externalRuntimeSrc) {
  if (!Array.isArray(nodes)) nodes = Array.from(nodes);
  if (externalRuntimeSrc == null) return nodes;
  return nodes.filter(function (node) {
    return (
      (node.tagName !== "SCRIPT" && node.tagName !== "script") ||
      node.getAttribute("src") !== externalRuntimeSrc
    );
  });
}

function __js2FizzGetVisibleChildren(element) {
  var children = [];
  var node = element.firstChild;
  while (node) {
    if (node.nodeType === 1) {
      if (
        ((node.tagName !== "SCRIPT" && node.tagName !== "script") || node.hasAttribute("data-meaningful")) &&
        node.tagName !== "TEMPLATE" &&
        node.tagName !== "template" &&
        !node.hasAttribute("hidden") &&
        !node.hasAttribute("aria-hidden") &&
        (node.getAttribute("rel") !== "expect" || node.getAttribute("blocking") !== "render")
      ) {
        var props = {};
        var attributes = node.attributes;
        for (var index = 0; index < attributes.length; index++) {
          if (attributes[index].name === "id" && attributes[index].value.indexOf(":") >= 0) continue;
          props[attributes[index].name] = attributes[index].value;
        }
        var nestedChildren = __js2FizzGetVisibleChildren(node);
        if (nestedChildren !== undefined) props.children = nestedChildren;
        children.push(__js2RequireActual("react").createElement(node.tagName.toLowerCase(), props));
      }
    } else if (node.nodeType === 3) {
      children.push(node.data);
    }
    node = node.nextSibling;
  }
  return children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
}

var __js2FizzTestUtils = {
  insertNodesAndExecuteScripts: __js2FizzInsertNodesAndExecuteScripts,
  mergeOptions: __js2FizzMergeOptions,
  stripExternalRuntimeInNodes: __js2FizzStripExternalRuntimeInNodes,
  getVisibleChildren: __js2FizzGetVisibleChildren,
};

function __js2WrapRoot(hostRoot) {
  return {
    render: function (value) { return hostRoot.render(__js2PrepareReactValue(value)); },
    unmount: function () { return hostRoot.unmount(); },
  };
}

function __js2WrapNoopRoot(hostRoot) {
  return {
    render: function (value) { return hostRoot.render(__js2PrepareReactValue(value)); },
    unmount: function () { return hostRoot.unmount(); },
    getChildren: function () { return hostRoot.getChildren(); },
    getChildrenAsJSX: function () { return hostRoot.getChildrenAsJSX(); },
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

// create-react-class is a CommonJS host dependency. Returning its host
// function directly from require() makes the subsequent indirect call
// depend on a callable host closure surviving the Wasm boundary. Keep the
// call itself in this shim and cross the boundary only for the spec/result;
// this is the same explicit-capability pattern used by the DOM and noop
// adapters above.
function __js2CreateReactClass(spec) {
  var creator = __js2ReactInfra().createReactClass;
  if (typeof creator !== "function") throw new Error("create-react-class test infrastructure is unavailable");
  try {
    return creator(__js2PrepareReactValue(spec));
  } catch (error) {
    throw new Error("create-react-class host call failed: " + (error && error.message ? error.message : String(error)));
  }
}

function __js2CreateReactClassFactory() {
  return __js2CreateReactClass;
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
    return __js2ReactInfra().reactDom.createPortal(__js2PrepareReactValue(children), container, key);
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
    root.render(__js2PrepareReactValue(value));
    if (typeof callback === "function") callback();
    return null;
  },
  unmountComponentAtNode: function (container) {
    return false;
  },
  // ReactDOM's resource-hint APIs are used by the Node/Edge Fizz upstream
  // tests. Keep them as explicit host facades for the native oracle; the Wasm
  // lanes call the corresponding functions in the compiled production graph.
  preconnect: function (url, options) {
    return __js2ReactInfra().reactDom.preconnect(url, options);
  },
  prefetchDNS: function (url) {
    return __js2ReactInfra().reactDom.prefetchDNS(url);
  },
  preinit: function (url, options) {
    return __js2ReactInfra().reactDom.preinit(url, options);
  },
  preinitModule: function (url, options) {
    return __js2ReactInfra().reactDom.preinitModule(url, options);
  },
  preload: function (url, options) {
    return __js2ReactInfra().reactDom.preload(url, options);
  },
  preloadModule: function (url, options) {
    return __js2ReactInfra().reactDom.preloadModule(url, options);
  },
  requestFormReset: function (fiber) {
    return __js2ReactInfra().reactDom.requestFormReset(fiber);
  },
  useFormState: function () {
    return __js2ReactInfra().reactDom.useFormState.apply(__js2ReactInfra().reactDom, arguments);
  },
  useFormStatus: function () {
    return __js2ReactInfra().reactDom.useFormStatus.apply(__js2ReactInfra().reactDom, arguments);
  },
  get version() {
    return __js2ReactInfra().reactDom.version;
  },
};

var __js2ReactDOMServer = {
  renderToString: function (value, options) {
    return __js2ReactInfra().reactDomServer.renderToString(__js2PrepareReactValue(value), options);
  },
  renderToStaticMarkup: function (value, options) {
    return __js2ReactInfra().reactDomServer.renderToStaticMarkup(__js2PrepareReactValue(value), options);
  },
  renderToReadableStream: function (value, options) {
    return __js2ReactInfra().reactDomServer.renderToReadableStream(__js2PrepareReactValue(value), options);
  },
};

var __js2ReactTestRenderer = {
  create: function (value, options) {
    var renderer;
    var prepared = __js2PrepareReactValue(value);
    var create = function () { renderer = __js2ReactInfra().reactTestRenderer.create(prepared, options); };
    if (typeof __js2ReactInfra().reactTestRenderer.act === "function") __js2ReactInfra().reactTestRenderer.act(create);
    else create();
    return __js2WrapRenderer(renderer);
  },
  act: function (callback) {
    return __js2ReactInfra().reactTestRenderer.act(callback);
  },
};

var __js2ReactNoop = {
  render: function (value) {
    var noop = __js2ReactInfra().reactNoop;
    if (!noop || typeof noop.render !== "function") throw new Error("React upstream noop renderer infrastructure is unavailable");
    return __js2WrapRenderer(noop.render(__js2PrepareReactValue(value)));
  },
  createRoot: function () {
    var noop = __js2ReactInfra().reactNoop;
    if (!noop || typeof noop.createRoot !== "function") throw new Error("React upstream noop renderer infrastructure is unavailable");
    return __js2WrapNoopRoot(noop.createRoot());
  },
  flush: function () {
    var noop = __js2ReactInfra().reactNoop;
    return typeof noop.flush === "function" ? noop.flush() : undefined;
  },
  flushSync: function (callback) {
    var noop = __js2ReactInfra().reactNoop;
    return typeof noop.flushSync === "function" ? noop.flushSync(callback) : callback();
  },
  getChildren: function () {
    var noop = __js2ReactInfra().reactNoop;
    return typeof noop.getChildren === "function" ? noop.getChildren() : [];
  },
  getChildrenAsJSX: function () {
    var noop = __js2ReactInfra().reactNoop;
    return typeof noop.getChildrenAsJSX === "function" ? noop.getChildrenAsJSX() : null;
  },
  clear: function () {
    var noop = __js2ReactInfra().reactNoop;
    if (typeof noop.clear === "function") noop.clear();
  },
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
    var utils = __js2ReactInfra().internalTestUtils;
    if (utils && typeof utils.act === "function") return utils.act(callback);
    var result = callback();
    return result && typeof result.then === "function" ? result : Promise.resolve(result);
  },
  // ReactDOM's browser Fizz tests use serverAct rather than the client
  // renderer's act helper. The upstream helper only needs to invoke the
  // server callback and await its promise; routing it through
  // react-test-renderer.act would add an unrelated renderer dependency.
  serverAct: function (callback) {
    var utils = __js2ReactInfra().internalTestUtils;
    if (utils && typeof utils.serverAct === "function") return utils.serverAct(callback);
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

var __js2IntersectionMocks = {
  mockIntersectionObserver: function () {
    return __js2ReactInfra().intersectionMocks.mockIntersectionObserver();
  },
  simulateIntersection: function () {
    return __js2ReactInfra().intersectionMocks.simulateIntersection.apply(
      __js2ReactInfra().intersectionMocks,
      arguments,
    );
  },
  setBoundingClientRect: function (target, rect) {
    return __js2ReactInfra().intersectionMocks.setBoundingClientRect(target, rect);
  },
  setClientRects: function (target, rects) {
    return __js2ReactInfra().intersectionMocks.setClientRects(target, rects);
  },
};

var __js2HTMLNodeType = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
  DOCUMENT_TYPE_NODE: 10,
  DOCUMENT_FRAGMENT_NODE: 11,
};

function __js2AssertConsole(kind, expected) {
  var actual = __js2ReactInfra().consumeConsole(kind);
  var wanted = Array.isArray(expected) ? expected : [expected];
  if (wanted.length === 0) {
    if (actual.length !== 0) throw new Error("unexpected console output: " + actual.join("\\n"));
    return;
  }
  function matches(entry, wanted) {
    var parts = String(wanted).split("**");
    var cursor = entry.indexOf(parts[0]);
    if (cursor < 0) return false;
    cursor += parts[0].length;
    for (var index = 1; index < parts.length; index++) {
      var next = entry.indexOf(parts[index], cursor);
      if (next < 0) return false;
      cursor = next + parts[index].length;
    }
    return true;
  }
  for (var i = 0; i < wanted.length; i++) {
    var text = String(wanted[i]);
    var found = false;
    for (var j = 0; j < actual.length; j++) {
      if (matches(actual[j], text)) { found = true; break; }
    }
    if (!found) throw new Error("expected console " + kind + " output: " + text);
  }
}

function patchMessageChannel() {}
function spyOnDevAndProd(target, key) { return jest.spyOn(target, key); }
function spyOnDev(target, key) { return jest.spyOn(target, key); }
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

// The ReactDOM repository keeps this helper next to its tests rather than in
// the published package. Keep its original rendering scenarios in the test
// shim, but resolve every React/ReactDOM module through initModules so the
// compiled lane still exercises its own Wasm renderer. Only JSDOM and the
// Node stream sink remain explicit host capabilities.
function __js2ReactDOMServerIntegrationTestUtils(initModules) {
  var ReactDOM;
  var ReactDOMClient;
  var ReactDOMServer;
  var act;

  function resetModules() {
    var modules = initModules();
    ReactDOM = modules.ReactDOM;
    ReactDOMClient = modules.ReactDOMClient;
    ReactDOMServer = modules.ReactDOMServer;
    act = __js2RequireActual("internal-test-utils").act;
  }

  function shouldUseDocument(reactElement) {
    return reactElement && reactElement.type === "html";
  }

  function getContainerFromMarkup(reactElement, markup) {
    if (shouldUseDocument(reactElement)) {
      var doc = document.implementation.createHTMLDocument("");
      doc.open();
      doc.write(markup || "<!doctype html><html><meta charset=utf-8><title>test doc</title>");
      doc.close();
      return doc;
    }
    var container = document.createElement("div");
    container.innerHTML = markup;
    return container;
  }

  async function asyncReactDOMRender(reactElement, domElement, forceHydrate) {
    if (forceHydrate) {
      await act(function () {
        ReactDOMClient.hydrateRoot(domElement, reactElement, {
          onRecoverableError: function (error) {
            var message = error && error.message ? error.message : "";
            if (message.indexOf("There was an error while hydrating.") < 0) console.error(error);
          },
        });
      });
      return;
    }
    await act(function () {
      if (ReactDOMClient) {
        var root = ReactDOMClient.createRoot(domElement);
        root.render(reactElement);
      } else {
        ReactDOM.render(reactElement, domElement);
      }
    });
  }

  async function expectErrors(fn, count) {
    if (console.error && typeof console.error.mockClear === "function") console.error.mockClear();
    else if (console.error) spyOnDev(console, "error").mockImplementation(function () {});
    var result = await fn();
    if (console.error && console.error.mock && console.error.mock.calls) {
      var filteredWarnings = [];
      var shouldIgnore = __js2ReactInfra().shouldIgnoreConsoleError;
      for (var index = 0; index < console.error.mock.calls.length; index++) {
        var args = console.error.mock.calls[index];
        var format = args[0];
        var rest = Array.prototype.slice.call(args, 1);
        if (typeof shouldIgnore !== "function" || !shouldIgnore(format, rest)) filteredWarnings.push(args);
      }
      if (filteredWarnings.length !== count && __DEV__) {
        expect(console.error).toHaveBeenCalledTimes(count);
      }
    }
    return result;
  }

  function renderIntoDom(reactElement, domElement, forceHydrate, errorCount) {
    return expectErrors(async function () {
      await asyncReactDOMRender(reactElement, domElement, forceHydrate);
      return domElement.firstChild;
    }, errorCount === undefined ? 0 : errorCount);
  }

  async function renderIntoString(reactElement, errorCount) {
    return expectErrors(function () {
      return new Promise(function (resolve) {
        resolve(ReactDOMServer.renderToString(reactElement));
      });
    }, errorCount === undefined ? 0 : errorCount);
  }

  async function serverRender(reactElement, errorCount) {
    var markup = await renderIntoString(reactElement, errorCount);
    return getContainerFromMarkup(reactElement, markup).firstChild;
  }

  async function renderIntoStream(reactElement, errorCount) {
    return expectErrors(function () {
      return new Promise(function (resolve, reject) {
        var writable = __js2NodeStreamFacade().PassThrough();
        var buffer = "";
        writable.setEncoding("utf8");
        writable.on("data", function (chunk) { buffer += chunk; });
        writable.on("error", reject);
        writable.on("finish", function () { resolve(buffer); });
        var stream = ReactDOMServer.renderToPipeableStream(reactElement, {
          onShellError: reject,
        });
        stream.pipe(writable);
      });
    }, errorCount === undefined ? 0 : errorCount);
  }

  async function streamRender(reactElement, errorCount) {
    var markup = await renderIntoStream(reactElement, errorCount);
    var firstNode = getContainerFromMarkup(reactElement, markup).firstChild;
    if (firstNode && firstNode.nodeType === 10) firstNode = firstNode.nextSibling;
    return firstNode;
  }

  function clientCleanRender(element, errorCount) {
    if (shouldUseDocument(element)) return clientRenderOnServerString(element, errorCount);
    return renderIntoDom(element, document.createElement("div"), false, errorCount);
  }

  async function clientRenderOnServerString(element, errorCount) {
    var markup = await renderIntoString(element, errorCount);
    resetModules();
    var container = getContainerFromMarkup(element, markup);
    var serverNode = container.firstChild;
    var firstClientNode = await renderIntoDom(element, container, true, errorCount);
    var clientNode = firstClientNode;
    while (serverNode || clientNode) {
      expect(serverNode !== null && serverNode !== undefined).toBe(true);
      expect(clientNode !== null && clientNode !== undefined).toBe(true);
      expect(clientNode.nodeType).toBe(serverNode.nodeType);
      expect(serverNode === clientNode).toBe(true);
      serverNode = serverNode.nextSibling;
      clientNode = clientNode.nextSibling;
    }
    return firstClientNode;
  }

  function BadMarkupExpected() {}

  async function clientRenderOnBadMarkup(element, errorCount) {
    var container = getContainerFromMarkup(
      element,
      shouldUseDocument(element)
        ? "<html><body><div id=badIdWhichWillCauseMismatch /></body></html>"
        : "<div id=badIdWhichWillCauseMismatch></div>",
    );
    await renderIntoDom(element, container, true, (errorCount === undefined ? 0 : errorCount) + 1);
    var hydratedTextContent = container.lastChild && container.lastChild.textContent;
    var cleanContainer;
    if (shouldUseDocument(element)) {
      cleanContainer = getContainerFromMarkup(element, "<html></html>").documentElement;
      element = element.props.children;
    } else {
      cleanContainer = document.createElement("div");
    }
    await asyncReactDOMRender(element, cleanContainer, true);
    var cleanTextContent = (cleanContainer.lastChild && cleanContainer.lastChild.textContent) || "";
    expect(hydratedTextContent).toBe(cleanTextContent);
    throw new BadMarkupExpected();
  }

  function itRenders(desc, testFn) {
    it("renders " + desc + " with server string render", function () { return testFn(serverRender); });
    it("renders " + desc + " with server stream render", function () { return testFn(streamRender); });
    itClientRenders(desc, testFn);
  }

  function itClientRenders(desc, testFn) {
    it("renders " + desc + " with clean client render", function () { return testFn(clientCleanRender); });
    it("renders " + desc + " with client render on top of good server markup", function () {
      return testFn(clientRenderOnServerString);
    });
    it("renders " + desc + " with client render on top of bad server markup", async function () {
      try {
        await testFn(clientRenderOnBadMarkup);
      } catch (error) {
        if (!(error instanceof BadMarkupExpected)) throw error;
      }
    });
  }

  function itThrows(desc, testFn, partialMessage) {
    it("throws " + desc, function () {
      return testFn().then(
        function () { expect(false).toBe("The promise resolved and should not have."); },
        function (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toContain(partialMessage);
        },
      );
    });
  }

  function itThrowsWhenRendering(desc, testFn, partialMessage) {
    itThrows("when rendering " + desc + " with server string render", function () {
      return testFn(serverRender);
    }, partialMessage);
    itThrows("when rendering " + desc + " with clean client render", function () {
      return testFn(clientCleanRender);
    }, partialMessage);
    itThrows("when rendering " + desc + " with client render on top of bad server markup", function () {
      return testFn(function (element, warningCount) {
        return clientRenderOnBadMarkup(element, (warningCount || 0) - 1);
      });
    }, partialMessage);
  }

  function expectMarkupMatch(serverElement, clientElement) {
    return testMarkupMatch(serverElement, clientElement, true);
  }

  function expectMarkupMismatch(serverElement, clientElement) {
    return testMarkupMatch(serverElement, clientElement, false);
  }

  async function testMarkupMatch(serverElement, clientElement, shouldMatch) {
    var domElement = await serverRender(serverElement);
    resetModules();
    return renderIntoDom(clientElement, domElement.parentNode, true, shouldMatch ? 0 : 1);
  }

  return {
    resetModules: resetModules,
    expectMarkupMismatch: expectMarkupMismatch,
    expectMarkupMatch: expectMarkupMatch,
    itRenders: itRenders,
    itClientRenders: itClientRenders,
    itThrowsWhenRendering: itThrowsWhenRendering,
    asyncReactDOMRender: asyncReactDOMRender,
    serverRender: serverRender,
    clientCleanRender: clientCleanRender,
    clientRenderOnBadMarkup: clientRenderOnBadMarkup,
    clientRenderOnServerString: clientRenderOnServerString,
    renderIntoDom: renderIntoDom,
    streamRender: streamRender,
  };
}

function __js2RequireActual(name) {
  if (name === "react") return typeof __REACT__ === "undefined" ? __js2ReactInfra().react : __REACT__;
  if (name === "react-dom" || name === "react-dom/client") {
    __js2CheckReactVersion("react-dom");
    if (typeof __js2NativeHost !== "undefined" && __js2NativeHost) {
      return name === "react-dom" ? __js2ReactInfra().reactDom : __js2ReactInfra().reactDomClient;
    }
    // When the harness has compiled ReactDOM's published graphs, keep the
    // package import inside that graph. The host facades remain the fallback
    // for the standalone React suite, where no compiled ReactDOM carrier is
    // present. This matters for Fizz Node/Edge tests that call ReactDOM's
    // resource-hint APIs: routing them to the host facade would make the test
    // pass without exercising the package under test.
    if (name === "react-dom" && typeof __REACTDOM_SHARED__ !== "undefined" && __REACTDOM_SHARED__ !== null)
      return __REACTDOM_SHARED__;
    if (name === "react-dom/client" && typeof __REACTDOM__ !== "undefined" && __REACTDOM__ !== null)
      return __REACTDOM__;
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
    if (typeof __js2NativeHost !== "undefined" && __js2NativeHost) return __js2ReactInfra().reactDomServer;
    // Each Fizz lane compiles exactly one published server graph (browser,
    // node, or edge). Route every server/static entrypoint to that graph while
    // the lane is active; the graph's own test file determines which API is
    // exercised. The legacy lane leaves this carrier undefined and continues
    // to use its separately published legacy renderer.
    if (typeof __REACTDOM_FIZZ__ !== "undefined" && __REACTDOM_FIZZ__ !== null) {
      return __REACTDOM_FIZZ__;
    }
    if (typeof __REACTDOM_SERVER__ !== "undefined" && __REACTDOM_SERVER__ !== null) {
      return __REACTDOM_SERVER__;
    }
    return __js2ReactDOMServer;
  }
  if (name === "react-native-renderer") {
    __js2CheckReactVersion("react-native-renderer");
    var nativeRenderer = __js2ReactInfra().reactNativeRenderer;
    if (nativeRenderer === null || nativeRenderer === undefined)
      throw new Error("React upstream native renderer infrastructure is unavailable");
    return nativeRenderer;
  }
  if (name === "react-test-renderer")
    return typeof __js2NativeHost !== "undefined" && __js2NativeHost
      ? __js2ReactInfra().reactTestRenderer
      : __js2ReactTestRenderer;
  if (name === "react-noop-renderer")
    return typeof __js2NativeHost !== "undefined" && __js2NativeHost
      ? __js2ReactInfra().reactNoop
      : __js2ReactNoop;
  // These entries are internal React-monorepo test dependencies rather than
  // published package graphs. Keep their host carriers explicit so an
  // upstream test reaches its assertion instead of failing at module lookup.
  if (name === "react/jsx-runtime") return __js2ReactInfra().reactJsxRuntime;
  if (name === "react/jsx-dev-runtime") return __js2ReactInfra().reactJsxDevRuntime;
  if (name === "scheduler" || name === "scheduler/unstable_mock") return __js2ReactInfra().schedulerMock;
  if (name === "internal-test-utils") return __js2InternalTestUtils;
  if (name === "./utils/ReactDOMServerIntegrationTestUtils") return __js2ReactDOMServerIntegrationTestUtils;
  if (name === "./utils/IntersectionMocks") return __js2IntersectionMocks;
  if (name === "react-dom-bindings/src/client/HTMLNodeType") return __js2HTMLNodeType;
  if (name === "prop-types") return __js2PropTypes;
  if (name === "create-react-class") return __js2CreateReactClass;
  if (name === "create-react-class/factory") {
    var factory = __js2ReactInfra().createReactClassFactory;
    if (typeof factory !== "function") throw new Error("create-react-class factory infrastructure is unavailable");
    return __js2CreateReactClassFactory;
  }
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
  // Published implementation modules are evaluated before the entry module
  // initializes the Jest mock table. Their top-level Node require calls
  // must still reach the explicit host dependency resolver; an early access
  // to __jestMocks[name] would otherwise trap during module initialization.
  if (__jestMocks !== undefined && __jestMocks !== null && __jestMocks[name])
    return __js2IsolatedModule(name, __jestMocks[name]());
  return __js2IsolatedModule(name, __js2RequireActual(name));
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
  // The upstream files are strict-mode CommonJS modules. Preserve that
  // semantic boundary inside each lifted function: in sloppy mode a callback
  // invoked with a primitive context receives a boxed String object, while
  // Jest's strict wrapper observes the original primitive.
  "use strict";
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

/**
 * Watchdog for one awaited test execution, shared by the React-family suites.
 *
 * An upstream body can await a promise the harness can never settle (a Fizz
 * stream that never completes, an `act` whose scheduler work never drains).
 * Without this bound a single such test parks the whole npm-compat generator
 * forever — the process prints nothing and never exits, which is
 * indistinguishable from a crashed runner from CI's point of view. The
 * timeout is a watchdog, not a selection filter: a timed-out test stays in
 * the report as a failure or harness-incompatible result.
 */
export function withTimeout(value, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(value), timeout]).finally(() => clearTimeout(timer));
}
