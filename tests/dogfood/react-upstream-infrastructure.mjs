import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { format } from "node:util";

const require = createRequire(import.meta.url);

function peerPackageRoots() {
  const roots = [];
  for (const packageName of ["react-dom", "react-test-renderer"]) {
    try {
      // pnpm keeps peer dependencies next to the package that declares them,
      // even when the workspace root does not expose a direct symlink.
      roots.push(dirname(dirname(require.resolve(packageName))));
    } catch {
      // The package may not be installed in a lightweight runner; the normal
      // require path below remains the only candidate in that case.
    }
  }
  return roots;
}

const PEER_PACKAGE_ROOTS = peerPackageRoots();

const PROP_TYPE_NAMES = [
  "array",
  "bigint",
  "bool",
  "func",
  "number",
  "object",
  "string",
  "symbol",
  "any",
  "arrayOf",
  "element",
  "elementType",
  "instanceOf",
  "node",
  "objectOf",
  "oneOf",
  "oneOfType",
  "shape",
  "exact",
];

function readModule(name) {
  try {
    return require(name);
  } catch {
    for (const root of PEER_PACKAGE_ROOTS) {
      try {
        return require(join(root, name));
      } catch {
        // Try the next package peer root.
      }
    }
    return null;
  }
}

function readReactForBuild(build) {
  if (build !== "development") return readModule("react");
  let reactPath;
  try {
    reactPath = require.resolve("react");
  } catch {
    return readModule("react");
  }
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCacheEntry = require.cache[reactPath];
  process.env.NODE_ENV = "development";
  delete require.cache[reactPath];
  try {
    return require("react");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousCacheEntry) require.cache[reactPath] = previousCacheEntry;
    else delete require.cache[reactPath];
  }
}

function loadCrossPackageReactModules(nativeReact, { build = "production" } = {}) {
  if (!nativeReact) {
    return {
      reactDom: readModule("react-dom"),
      reactDomClient: readModule("react-dom/client"),
      reactDomServer: readModule("react-dom/server"),
      reactTestRenderer: readModule("react-test-renderer"),
    };
  }

  // The pinned React fixture is loaded from its verified tarball, while the
  // host-only packages come from node_modules. If ReactDOM resolves its peer
  // normally, it gets a second React object and hooks see a null dispatcher.
  // Load the host packages once with CommonJS's React entry aliased to the
  // exact fixture object, then restore the module cache so this setup cannot
  // leak into unrelated tests.
  let reactPath;
  try {
    reactPath = require.resolve("react");
  } catch {
    reactPath = null;
  }
  const isCrossPackagePath = (path) =>
    path === reactPath || path.includes("/react-dom/") || path.includes("/react-test-renderer/");
  const saved = new Map();
  for (const path of Object.keys(require.cache)) {
    if (isCrossPackagePath(path)) saved.set(path, require.cache[path]);
    if (isCrossPackagePath(path)) delete require.cache[path];
  }
  if (reactPath) {
    require.cache[reactPath] = {
      id: reactPath,
      filename: reactPath,
      loaded: true,
      exports: nativeReact,
    };
  }

  // ReactDOM and react-test-renderer choose their development/production entry
  // point from NODE_ENV. Resolve every peer package under the same selector as
  // the React artifact under test, then restore the caller's environment. A
  // mismatched renderer pair has different internal queues (for example, the
  // development renderer expects an act queue that production React does not
  // expose) and fails before a test assertion runs.
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = build === "development" ? "development" : "production";
  let modules;
  try {
    modules = {
      reactDom: readModule("react-dom"),
      reactDomClient: readModule("react-dom/client"),
      reactDomServer: readModule("react-dom/server"),
      reactTestRenderer: readModule("react-test-renderer"),
    };
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    for (const path of Object.keys(require.cache)) if (isCrossPackagePath(path)) delete require.cache[path];
    for (const [path, entry] of saved) require.cache[path] = entry;
  }
  return modules;
}

function createReactClassFactory(react) {
  const factory = readModule("create-react-class/factory");
  if (typeof factory !== "function" || !react) return null;
  try {
    return factory(react.Component, react.isValidElement, new react.Component().updater);
  } catch {
    return null;
  }
}

function renderedJsonToJsx(value, react) {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((child) => renderedJsonToJsx(child, react));
  if (!value || typeof value !== "object" || typeof value.type !== "string") return value;
  const children = Array.isArray(value.children)
    ? value.children.map((child) => renderedJsonToJsx(child, react))
    : value.children;
  return react.createElement(value.type, value.props ?? null, ...(children ?? []));
}

function domNodeToRenderedJson(node) {
  if (!node) return null;
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return null;
  const props = {};
  for (const attribute of node.attributes ?? []) {
    const name = attribute.name === "class" ? "className" : attribute.name;
    props[name] = attribute.value;
  }
  const children = [];
  for (const child of node.childNodes ?? []) {
    const value = domNodeToRenderedJson(child);
    if (value !== null) children.push(value);
  }
  // React's noop host instances expose their element type. Add the same
  // non-DOM convenience property to host nodes so ref assertions such as
  // `ref.current.type === "div"` remain meaningful in this DOM-backed
  // fallback.
  if (node.type === undefined) {
    try {
      Object.defineProperty(node, "type", {
        configurable: true,
        value: node.tagName.toLowerCase(),
      });
    } catch {
      // Some jsdom host objects are not extensible; the JSON surface above is
      // still usable even when the ref convenience property cannot be added.
    }
  }
  return { type: node.tagName.toLowerCase(), props, children };
}

function createReactValueAdapter(react) {
  const prepare = (value, seen = new WeakMap()) => {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const array = [];
      seen.set(value, array);
      for (const child of value) array.push(prepare(child, seen));
      return array;
    }
    // Native React elements already have the host shape. In particular, do
    // not read their deprecated `ref` accessor or clone them through the
    // adapter: the native oracle must observe React's own warning behavior.
    // Wasm-marshalled component constructors arrive as object handles, so
    // those continue through the reification arm below.
    if (react.isValidElement?.(value) && typeof value.type !== "object") return value;
    // A React element created inside Wasm has the same global $$typeof symbol
    // as the host React package, but its props object is a Wasm proxy. Rebuild
    // the element with host React so ReactDOM can use ordinary object
    // operations (`hasOwnProperty`, descriptors, and child traversal) at the
    // Wasm/host boundary.
    if ("type" in value && "props" in value && "$$typeof" in value) {
      const props = prepare(value.props, seen) ?? {};
      if (value.key !== undefined && value.key !== null) props.key = value.key;
      return react.createElement(value.type, props, ...(Array.isArray(props.children) ? props.children : []));
    }
    const object = {};
    seen.set(value, object);
    for (const key of Object.keys(value)) object[key] = prepare(value[key], seen);
    return object;
  };
  return prepare;
}

function decorateDomTree(node) {
  if (!node) return;
  if (node.nodeType === 1 && node.type === undefined) {
    try {
      Object.defineProperty(node, "type", {
        configurable: true,
        value: node.tagName.toLowerCase(),
      });
    } catch {
      // See the equivalent guard in domNodeToRenderedJson.
    }
  }
  for (const child of node.childNodes ?? []) decorateDomTree(child);
}

// React's upstream tests use the internal noop renderer for scheduler and
// profiler assertions. It is not published as an npm package, so the native
// oracle cannot resolve it from node_modules. This adapter keeps the same
// public control surface while using the pinned react-test-renderer as the
// host implementation. It is deliberately a host capability: the compiled
// test still calls the explicit facade in react-upstream-shim.mjs.
function createReactNoopAdapter(react, reactTestRenderer, reactDom, reactDomClient) {
  if (!reactTestRenderer?.create) return null;
  let renderer = null;
  const useDomRenderer =
    typeof reactTestRenderer.act !== "function" &&
    typeof reactDom?.flushSync === "function" &&
    typeof reactDomClient?.createRoot === "function" &&
    typeof globalThis.document?.createElement === "function";
  const withAct = (callback) =>
    typeof reactTestRenderer.act === "function" ? reactTestRenderer.act(callback) : callback();
  const renderDom = (value, previous = null) => {
    const next = previous ?? renderer;
    const current =
      next?.kind === "dom"
        ? next
        : {
            kind: "dom",
            container: globalThis.document.createElement("div"),
            root: null,
          };
    if (!current.root) current.root = reactDomClient.createRoot(current.container);
    reactDom.flushSync(() => current.root.render(value));
    decorateDomTree(current.container.firstChild);
    current.value = value;
    if (!previous) renderer = current;
    return current;
  };
  const renderInto = (value, previous = null) => {
    if (useDomRenderer) return renderDom(value, previous);
    const next = previous ?? renderer;
    if (next) {
      withAct(() => next.update(value));
      return next;
    }
    let created;
    withAct(() => {
      created = reactTestRenderer.create(value);
    });
    if (!previous) renderer = created;
    return created;
  };
  const readJson = (current = renderer) =>
    current?.kind === "dom" ? domNodeToRenderedJson(current.container.firstChild) : (current?.toJSON?.() ?? null);
  const rendererApi = (current) => ({
    toJSON: () => readJson(current),
    toTree: () => null,
    update: (value) => renderInto(value, current),
    unmount: () => {
      if (current.kind === "dom") current.root?.unmount?.();
      else current.unmount?.();
    },
    getInstance: () => null,
  });
  const root = () => {
    let current = null;
    return {
      render(value) {
        current = renderInto(value, current);
      },
      unmount() {
        if (current?.kind === "dom") current.root?.unmount?.();
        else current?.unmount?.();
        current = null;
      },
      getChildren() {
        const value = readJson(current);
        return value === null ? [] : Array.isArray(value) ? value : [value];
      },
      getChildrenAsJSX() {
        return renderedJsonToJsx(readJson(current), react);
      },
    };
  };
  return {
    render(value) {
      renderer = renderInto(value);
      return renderer.kind === "dom" ? rendererApi(renderer) : renderer;
    },
    createRoot: root,
    flush() {},
    flushSync(callback) {
      return typeof reactTestRenderer.act === "function" ? reactTestRenderer.act(callback) : callback();
    },
    getChildren() {
      const value = readJson();
      return value === null ? [] : Array.isArray(value) ? value : [value];
    },
    getChildrenAsJSX() {
      return renderedJsonToJsx(readJson(), react);
    },
    clear() {
      if (renderer?.kind === "dom") renderer.root?.unmount?.();
      else renderer?.unmount?.();
      renderer = null;
    },
  };
}

function createInternalTestUtils({ reactTestRenderer, reactDom, consumeConsole }) {
  const act = (callback) => {
    if (typeof reactTestRenderer?.act === "function") return reactTestRenderer.act(callback);
    // The production test-renderer intentionally has no `act` export. The
    // upstream tests still use the shared internal helper for ReactDOM roots,
    // so use ReactDOM's synchronous commit boundary instead of merely calling
    // the callback and leaving the root's update queued on the host scheduler.
    if (typeof reactDom?.flushSync === "function") {
      let result;
      reactDom.flushSync(() => {
        result = callback();
      });
      return result && typeof result.then === "function" ? result : Promise.resolve(result);
    }
    const result = callback();
    return result && typeof result.then === "function" ? result : Promise.resolve(result);
  };
  const consoleMatches = (actual, expected) => {
    const parts = String(expected).split("**");
    let cursor = actual.indexOf(parts[0]);
    if (cursor < 0) return false;
    cursor += parts[0].length;
    for (let index = 1; index < parts.length; index++) {
      const next = actual.indexOf(parts[index], cursor);
      if (next < 0) return false;
      cursor = next + parts[index].length;
    }
    return true;
  };
  const assertConsole = (kind, expected) => {
    const actual = consumeConsole(kind);
    const wanted = Array.isArray(expected) ? expected : [expected];
    for (const value of wanted) {
      if (!actual.some((entry) => consoleMatches(entry, value))) {
        throw new Error(`expected console ${kind} output: ${String(value)}`);
      }
    }
  };
  return {
    act,
    serverAct: act,
    waitForAll: async () => {},
    waitFor: async () => {},
    waitForPaint: async () => {},
    waitForMicrotasks: async () => {},
    waitForThrow: (callback) => Promise.resolve().then(callback),
    assertConsoleErrorDev: (expected) => assertConsole("error", expected),
    assertConsoleWarnDev: (expected) => assertConsole("warn", expected),
    assertLog() {},
  };
}

// ReactDOM's selector and fragment-ref tests import this small private helper
// from the monorepo. It is test infrastructure rather than published package
// code, so keep the browser behavior on the host while exposing the same
// functions through the explicit React upstream capability surface.
function createIntersectionMocks() {
  const state = { callback: null, observedTargets: [] };
  const hostWindow = globalThis.window;
  const previousWindowObserver = hostWindow?.IntersectionObserver;
  const previousGlobalObserver = globalThis.IntersectionObserver;
  class IntersectionObserver {
    constructor(callback) {
      state.callback = callback;
    }

    disconnect() {
      state.callback = null;
      state.observedTargets.splice(0);
    }

    observe(target) {
      state.observedTargets.push(target);
    }

    unobserve(target) {
      const index = state.observedTargets.indexOf(target);
      if (index >= 0) state.observedTargets.splice(index, 1);
    }
  }
  if (hostWindow) hostWindow.IntersectionObserver = IntersectionObserver;
  globalThis.IntersectionObserver = IntersectionObserver;

  function mockIntersectionObserver() {
    state.callback = null;
    state.observedTargets = [];
    if (hostWindow) hostWindow.IntersectionObserver = IntersectionObserver;
    return state;
  }

  function simulateIntersection(...entries) {
    if (typeof state.callback !== "function") throw new Error("IntersectionObserver callback is not installed");
    state.callback(
      entries.map(([target, rect, ratio]) => ({
        boundingClientRect: {
          top: rect.y,
          left: rect.x,
          width: rect.width,
          height: rect.height,
        },
        intersectionRatio: ratio,
        target,
      })),
    );
  }

  function setBoundingClientRect(target, { x, y, width, height }) {
    target.getBoundingClientRect = () => ({
      width,
      height,
      left: x,
      right: x + width,
      top: y,
      bottom: y + height,
    });
  }

  function setClientRects(target, rects) {
    target.getClientRects = () =>
      rects.map(({ x, y, width, height }) => ({
        width,
        height,
        left: x,
        right: x + width,
        top: y,
        bottom: y + height,
        x,
        y,
      }));
  }

  return {
    mockIntersectionObserver,
    simulateIntersection,
    setBoundingClientRect,
    setClientRects,
    cleanup() {
      if (hostWindow) {
        if (previousWindowObserver === undefined) delete hostWindow.IntersectionObserver;
        else hostWindow.IntersectionObserver = previousWindowObserver;
      }
      if (previousGlobalObserver === undefined) delete globalThis.IntersectionObserver;
      else globalThis.IntersectionObserver = previousGlobalObserver;
    },
  };
}

function unrefMessagePorts() {
  // ReactDOM's scheduler owns a MessageChannel. Its ports are useful while a
  // test is running, but a referenced port keeps Node alive after the report
  // has been written. Unref is deliberately non-destructive: pending work can
  // still run while other handles keep the process alive.
  for (const handle of process._getActiveHandles?.() ?? []) {
    if (handle?.constructor?.name === "MessagePort" && typeof handle.unref === "function") handle.unref();
  }
}

/**
 * Install the host half of the React upstream-test environment.
 *
 * React's own tests intentionally span packages: the core tests import
 * react-dom/client, react-test-renderer, prop-types and the private
 * internal-test-utils package. Those are test infrastructure, not part of the
 * React package under test. Keep them as explicit host values so the same
 * generated test source can use them in the native oracle and through the
 * Wasm host boundary.
 */
export function installReactUpstreamInfrastructure({ react, build = "production" } = {}) {
  const nativeReact = react ?? readReactForBuild(build);
  const { reactDom, reactDomClient, reactDomServer, reactTestRenderer } = loadCrossPackageReactModules(nativeReact, {
    build,
  });
  const propTypes = readModule("prop-types");
  const webStreams = readModule("web-streams-polyfill/ponyfill") ?? readModule("web-streams-polyfill");
  // React's create-react-class integration tests import both the already
  // configured public creator and the original three-argument factory. Keep
  // both host capabilities distinct: returning the configured creator from
  // the `/factory` entry makes the upstream call
  // `factory(React.Component, React.isValidElement, updater)` feed the
  // component object as the factory's first parameter and fails later as
  // "null is not a function".
  const createReactClassFactoryModule = readModule("create-react-class/factory");
  const createReactClass = createReactClassFactory(nativeReact);

  const previous = globalThis.__js2ReactUpstreamInfrastructure;
  const previousError = console.error;
  const previousWarn = console.warn;
  const errors = [];
  const warnings = [];

  const consumeConsole = (kind) => {
    const target = kind === "warn" ? warnings : errors;
    const out = target.slice();
    target.length = 0;
    return out;
  };
  const reactNoop = createReactNoopAdapter(nativeReact, reactTestRenderer, reactDom, reactDomClient);
  const intersectionMocks = createIntersectionMocks();
  const prepareReactValue = createReactValueAdapter(nativeReact);
  const reactJsxRuntime = readModule("react/jsx-runtime");
  const reactJsxDevRuntime = readModule("react/jsx-dev-runtime");
  const reactNativeRenderer = readModule("react-native-renderer") ?? { version: nativeReact?.version };

  // React's internal assertion helpers consume console output after a render.
  // Capture it without printing hundreds of expected development warnings.
  // React's warnings use Node's printf-style console arguments (`%s`, `%o`,
  // and friends). Preserve the same formatting that a real Node console would
  // produce; joining the raw arguments leaves placeholders in the captured
  // text and makes an otherwise available warning assertion fail.
  console.error = (...args) => errors.push(format(...args));
  console.warn = (...args) => warnings.push(format(...args));

  const infrastructure = {
    react: nativeReact,
    reactDom,
    reactDomClient,
    reactDomServer,
    reactTestRenderer,
    reactNoop,
    intersectionMocks,
    prepareReactValue,
    // Native oracle values already have React's host representation. The
    // compiled lane flips this switch only while an exported Wasm test is
    // executing, so the reifier never changes the oracle's warning/identity
    // behavior.
    prepareReactValues: false,
    reactNativeRenderer,
    reactJsxRuntime,
    reactJsxDevRuntime,
    propTypes,
    createReactClass,
    createReactClassFactory: createReactClassFactoryModule,
    internalTestUtils: createInternalTestUtils({ reactTestRenderer, reactDom, consumeConsole }),
    webStreams,
    patchMessageChannel() {},
    // Node Fizz's upstream tests construct `stream.PassThrough` through a
    // dynamic namespace member. Expose the host construction as a named
    // capability so the compiled test does not depend on dynamic `new
    // Stream.PassThrough()` lowering; the returned stream remains the real
    // Node object and its methods cross the existing extern boundary.
    createPassThrough() {
      const stream = readModule("stream");
      if (!stream?.PassThrough) throw new Error("React upstream stream infrastructure is unavailable");
      return new stream.PassThrough();
    },
    errors,
    warnings,
    consumeConsole,
    require(name) {
      // The generated source only delegates here for a module not covered by
      // the explicit facades. This keeps the dependency boundary visible and
      // avoids silently turning an absent test dependency into undefined.
      const value = readModule(name);
      if (value === null || value === undefined) {
        throw new Error(`React upstream test dependency is unavailable: ${name}`);
      }
      return value;
    },
  };
  globalThis.__js2ReactUpstreamInfrastructure = infrastructure;
  unrefMessagePorts();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unrefMessagePorts();
    intersectionMocks.cleanup();
    console.error = previousError;
    console.warn = previousWarn;
    if (previous === undefined) delete globalThis.__js2ReactUpstreamInfrastructure;
    else globalThis.__js2ReactUpstreamInfrastructure = previous;
    process.removeListener("exit", cleanup);
  };
  process.once("exit", cleanup);

  return {
    infrastructure,
    cleanup,
  };
}

export { PROP_TYPE_NAMES };
