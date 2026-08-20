import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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
    return null;
  }
}

function loadCrossPackageReactModules(nativeReact) {
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

  let modules;
  try {
    modules = {
      reactDom: readModule("react-dom"),
      reactDomClient: readModule("react-dom/client"),
      reactDomServer: readModule("react-dom/server"),
      reactTestRenderer: readModule("react-test-renderer"),
    };
  } finally {
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
export function installReactUpstreamInfrastructure({ react } = {}) {
  const nativeReact = react ?? readModule("react");
  const { reactDom, reactDomClient, reactDomServer, reactTestRenderer } = loadCrossPackageReactModules(nativeReact);
  const propTypes = readModule("prop-types");
  const webStreams = readModule("web-streams-polyfill/ponyfill") ?? readModule("web-streams-polyfill");
  const createReactClass = createReactClassFactory(nativeReact);

  const previous = globalThis.__js2ReactUpstreamInfrastructure;
  const previousError = console.error;
  const previousWarn = console.warn;
  const errors = [];
  const warnings = [];

  // React's internal assertion helpers consume console output after a render.
  // Capture it without printing hundreds of expected development warnings.
  console.error = (...args) => errors.push(args.map(String).join(" "));
  console.warn = (...args) => warnings.push(args.map(String).join(" "));

  const infrastructure = {
    react: nativeReact,
    reactDom,
    reactDomClient,
    reactDomServer,
    reactTestRenderer,
    propTypes,
    createReactClass,
    webStreams,
    patchMessageChannel() {},
    errors,
    warnings,
    consumeConsole(kind) {
      const target = kind === "warn" ? warnings : errors;
      const out = target.slice();
      target.length = 0;
      return out;
    },
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
