/**
 * Performance workloads for the npm compatibility report.
 *
 * Every package uses the same shape of workload: a synchronous operation that
 * consumes a string and produces a number.  Keeping the operation numeric
 * makes the host and standalone lanes directly comparable and avoids timing
 * result marshalling as part of the package workload.
 */

const valueOf = (namespace) => namespace?.default ?? namespace;

const dynamicComment = (staticInput, seed, index) =>
  `${staticInput}\n/* npm-compat-runtime:${seed % 7}:${index % 11} */`;

const DEFAULT_DYNAMIC_SOURCE =
  '__npmCompatStaticInput + "\\n/* npm-compat-runtime:" + (seed % 7) + ":" + (index % 11) + " */"';

const SPEC = (spec) => Object.freeze(spec);

export const NPM_COMPAT_PERF_SPECS = Object.freeze({
  acorn: SPEC({
    sampleOp: "parse(source).body.length",
    importPath: "package/dist/acorn.mjs",
    staticInput: "const answer = 42;",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "{ parse }",
    bindingPrelude: "const __pkgNs = { parse }; const __pkg = __pkgNs;",
    operation: '__pkg.parse(input, { ecmaVersion: 2022, sourceType: "module" }).body.length',
    nativeOperation: (namespace, input) =>
      namespace.parse(input, { ecmaVersion: 2022, sourceType: "module" }).body.length,
  }),
  marked: SPEC({
    sampleOp: "marked(markdown).length",
    importPath: "package/lib/marked.esm.js",
    staticInput: "# npm-compat\n\nA short paragraph.",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "{ marked }",
    bindingPrelude: "const __pkgNs = { marked }; const __pkg = __pkgNs;",
    operation: "(__pkg.marked ?? __pkg)(input).length",
    nativeOperation: (namespace, input) => (namespace.marked ?? valueOf(namespace))(input).length,
  }),
  clsx: SPEC({
    sampleOp: "clsx(className, 'npm')",
    importPath: "package/dist/clsx.mjs",
    staticInput: "button",
    dynamicInput: (staticInput, seed) => `${staticInput}-${seed % 7}`,
    dynamicSource: '__npmCompatStaticInput + "-" + (seed % 7)',
    importClause: "{ clsx }",
    bindingPrelude: "const __pkgNs = { clsx };",
    operation: '__pkgNs.clsx(input, "npm").length',
    nativeOperation: (namespace, input) => namespace.clsx(input, "npm").length,
  }),
  cookie: SPEC({
    sampleOp: "parse(cookieHeader)",
    importPath: "package/dist/index.js",
    staticInput: "sid=abc123; theme=dark",
    dynamicInput: (_staticInput, seed) => `sid=abc${seed % 7}; theme=dark`,
    dynamicSource: '"sid=abc" + (seed % 7) + "; theme=dark"',
    importClause: "{ parse }",
    bindingPrelude: "const __pkgNs = { parse }; const __pkg = __pkgNs;",
    operation: "Object.keys(__pkg.parse(input)).length",
    nativeOperation: (namespace, input) => Object.keys(namespace.parse(input)).length,
  }),
  eslint: SPEC({
    sampleOp: "Linter.verify(source).length",
    importPath: "package/lib/api.js",
    staticInput: "var answer = 42",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "{ Linter }",
    bindingPrelude: "const __pkgNs = { Linter }; const __pkg = __pkgNs;",
    operation: '__pkg.Linter ? new __pkg.Linter().verify(input, { rules: { semi: ["error", "always"] } }).length : 0',
    nativeOperation: (namespace, input) =>
      namespace.Linter ? new namespace.Linter().verify(input, { rules: { semi: ["error", "always"] } }).length : 0,
  }),
  prettier: SPEC({
    sampleOp: "prettier.version.length + source.length",
    importPath: "package/index.js",
    staticInput: "const answer=42",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "{ version }",
    bindingPrelude: "const __pkgNs = { version }; const __pkg = __pkgNs;",
    operation: '(String(__pkg.version ?? "").length + input.length)',
    nativeOperation: (namespace, input) => String(namespace.version ?? "").length + input.length,
  }),
  react: SPEC({
    sampleOp: "react package import + text.length",
    importPath: "package/index.js",
    staticInput: "hello",
    dynamicInput: (staticInput, seed) => `${staticInput}-${seed % 7}`,
    dynamicSource: '__npmCompatStaticInput + "-" + (seed % 7)',
    importClause: "{ version }",
    bindingPrelude: "const __pkgNs = { version }; const __pkg = __pkgNs;",
    operation: "(__pkg ? input.length + 1 : input.length)",
    nativeOperation: (_namespace, input) => input.length + 1,
  }),
  hono: SPEC({
    sampleOp: "register route + path.length",
    importPath: "package/dist/index.js",
    staticInput: "/users/1",
    dynamicInput: (_staticInput, seed) => `/users/${seed % 7}`,
    dynamicSource: '"/users/" + (seed % 7)',
    importClause: "{ Hono }",
    bindingPrelude: "const __pkgNs = { Hono }; const __pkg = __pkgNs;",
    helperSource: `
function __npmCompatPackageOperation(input) {
  const app = new __pkgNs.Hono();
  app.get("/users/:id", () => "ok");
  return app.routes.length + input.length;
}
`,
    operation: "__npmCompatPackageOperation(input)",
    nativeOperation: (namespace, input) => {
      const app = new namespace.Hono();
      app.get("/users/:id", () => "ok");
      return app.routes.length + input.length;
    },
  }),
  lodash: SPEC({
    sampleOp: "words(text).length + kebabCase(text).length",
    importPath: "package/lodash.js",
    staticInput: "Hello npm compatibility",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "__pkgDefault",
    bindingPrelude: "const __pkgNs = __pkgDefault; const __pkg = __pkgNs;",
    operation: "__pkg.words(input).length + __pkg.kebabCase(input).length",
    nativeOperation: (namespace, input) => {
      const lodash = valueOf(namespace);
      return lodash.words(input).length + lodash.kebabCase(input).length;
    },
  }),
  "lodash-es": SPEC({
    sampleOp: "words(text).length + kebabCase(text).length",
    importPath: "package/lodash.js",
    staticInput: "Hello npm compatibility",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "{ words, kebabCase }",
    bindingPrelude: "const __pkgNs = { words, kebabCase };",
    operation: "__pkgNs.words(input).length + __pkgNs.kebabCase(input).length",
    nativeOperation: (namespace, input) => namespace.words(input).length + namespace.kebabCase(input).length,
  }),
  axios: SPEC({
    sampleOp: "isAxiosError(config)",
    importPath: "package/index.js",
    staticInput: "https://example.com/npm",
    dynamicInput: (staticInput, seed) => `${staticInput}/${seed % 7}`,
    dynamicSource: '__npmCompatStaticInput + "/" + (seed % 7)',
    importClause: "{ isAxiosError }",
    bindingPrelude: "const __pkgNs = { isAxiosError }; const __pkg = __pkgNs;",
    operation: "__pkg.isAxiosError({ config: { url: input } }) ? 1 : 0",
    nativeOperation: (namespace, input) => (namespace.isAxiosError({ config: { url: input } }) ? 1 : 0),
  }),
  "react-dom": SPEC({
    sampleOp: "react-dom package import + text.length",
    importPath: "package/index.js",
    staticInput: "hello",
    dynamicInput: (staticInput, seed) => `${staticInput}-${seed % 7}`,
    dynamicSource: '__npmCompatStaticInput + "-" + (seed % 7)',
    importClause: "{ version }",
    bindingPrelude: "const __pkgNs = { version }; const __pkg = __pkgNs;",
    operation: "(__pkg ? input.length + 1 : input.length)",
    nativeOperation: (_namespace, input) => input.length + 1,
  }),
  jsdom: SPEC({
    sampleOp: "JSDOM(html).querySelectorAll('p').length",
    importPath: "package/lib/api.js",
    staticInput: "<!doctype html><body><p>hello</p></body>",
    dynamicInput: (_staticInput, seed) => `<!doctype html><body><p>hello-${seed % 7}</p></body>`,
    dynamicSource: '"<!doctype html><body><p>hello-" + (seed % 7) + "</p></body>"',
    importClause: "{ JSDOM }",
    bindingPrelude: "const __pkgNs = { JSDOM }; const __pkg = __pkgNs;",
    helperSource: `
function __npmCompatPackageOperation(input) {
  return new __pkgNs.JSDOM(input).window.document.querySelectorAll("p").length;
}
`,
    operation: "__npmCompatPackageOperation(input)",
    nativeOperation: (namespace, input) => new namespace.JSDOM(input).window.document.querySelectorAll("p").length,
  }),
  webpack: SPEC({
    sampleOp: "typeof webpack === 'function'",
    importPath: "package/lib/index.js",
    staticInput: "webpack",
    dynamicInput: (staticInput, seed) => `${staticInput}-${seed % 7}`,
    dynamicSource: '__npmCompatStaticInput + "-" + (seed % 7)',
    importClause: "__pkgDefault",
    bindingPrelude: "const __pkgNs = __pkgDefault; const __pkg = __pkgNs;",
    operation: 'typeof __pkg === "function" ? input.length + 1 : input.length',
    nativeOperation: (namespace, input) => (typeof valueOf(namespace) === "function" ? input.length + 1 : input.length),
  }),
  uuid: SPEC({
    sampleOp: "validate(uuid) + version(uuid)",
    importPath: "package/dist/index.js",
    staticInput: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    dynamicInput: (_staticInput, seed) =>
      seed % 2 ? "6ba7b811-9dad-11d1-80b4-00c04fd430c8" : "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    dynamicSource: '(seed % 2) ? "6ba7b811-9dad-11d1-80b4-00c04fd430c8" : "6ba7b810-9dad-11d1-80b4-00c04fd430c8"',
    importClause: "{ validate, version }",
    bindingPrelude: "const __pkgNs = { validate, version };",
    operation: "(__pkgNs.validate(input) ? 1 : 0) + __pkgNs.version(input)",
    nativeOperation: (namespace, input) => (namespace.validate(input) ? 1 : 0) + namespace.version(input),
  }),
  typescript: SPEC({
    sampleOp: "transpileModule(source).outputText.length",
    importPath: "package/lib/typescript.js",
    staticInput: "const answer: number = 42;",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "{ transpileModule, ModuleKind }",
    bindingPrelude: "const __pkgNs = { transpileModule, ModuleKind }; const __pkg = __pkgNs;",
    operation:
      "__pkg.transpileModule(input, { compilerOptions: { module: __pkg.ModuleKind.ESNext } }).outputText.length",
    nativeOperation: (namespace, input) =>
      namespace.transpileModule(input, { compilerOptions: { module: namespace.ModuleKind.ESNext } }).outputText.length,
  }),
  redux: SPEC({
    sampleOp: "dispatch(action) + getState().count",
    importPath: "package/dist/redux.mjs",
    staticInput: "1",
    dynamicInput: (_staticInput, seed) => String((seed % 7) + 1),
    dynamicSource: "String((seed % 7) + 1)",
    importClause: "{ createStore }",
    bindingPrelude: "const __pkgNs = { createStore }; const __pkg = __pkgNs;",
    helperSource: `
function __npmCompatPackageOperation(input) {
  const reducer = (state = 0, action) => action.type === "add" ? state + action.amount : state;
  const store = __pkgNs.createStore(reducer);
  store.dispatch({ type: "add", amount: Number(input) });
  return store.getState();
}
`,
    operation: "__npmCompatPackageOperation(input)",
    nativeOperation: (namespace, input) => {
      const reducer = (state = 0, action) => (action.type === "add" ? state + action.amount : state);
      const store = namespace.createStore(reducer);
      store.dispatch({ type: "add", amount: Number(input) });
      return store.getState();
    },
  }),
  jest: SPEC({
    sampleOp: "typeof jest.run + source.length",
    importPath: "package/build/index.mjs",
    staticInput: "test",
    dynamicInput: (staticInput, seed) => `${staticInput}-${seed % 7}`,
    dynamicSource: '__npmCompatStaticInput + "-" + (seed % 7)',
    importClause: "* as __pkgNs",
    bindingPrelude: "const __pkg = __pkgNs;",
    operation: '((typeof __pkgNs.run === "function" ? 1 : 0) + input.length)',
    nativeOperation: (namespace, input) => (typeof namespace.run === "function" ? 1 : 0) + input.length,
  }),
  "styled-components": SPEC({
    sampleOp: "typeof css + text.length",
    importPath: "package/dist/styled-components.esm.js",
    staticInput: "color: red;",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "{ css }",
    bindingPrelude: "const __pkgNs = { css }; const __pkg = __pkgNs;",
    operation: '((typeof __pkgNs.css === "function" ? 1 : 0) + input.length)',
    nativeOperation: (namespace, input) => (typeof namespace.css === "function" ? 1 : 0) + input.length,
  }),
  moment: SPEC({
    sampleOp: "moment(date).format('YYYY-MM-DD').length",
    importPath: "package/moment.js",
    staticInput: "2020-01-02",
    dynamicInput: (_staticInput, seed) => (seed % 2 ? "2021-02-03" : "2020-01-02"),
    dynamicSource: '(seed % 2) ? "2021-02-03" : "2020-01-02"',
    importClause: "__pkgDefault",
    bindingPrelude: "const __pkgNs = __pkgDefault; const __pkg = __pkgNs;",
    operation: '__pkg(input).format("YYYY-MM-DD").length',
    nativeOperation: (namespace, input) => valueOf(namespace)(input).format("YYYY-MM-DD").length,
  }),
  stylelint: SPEC({
    sampleOp: "typeof stylelint.lint + source.length",
    importPath: "package/lib/index.mjs",
    staticInput: "a { color: red; }",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "* as __pkgNs",
    bindingPrelude: "const __pkg = __pkgNs;",
    operation: '((typeof __pkg.lint === "function" ? 1 : 0) + input.length)',
    nativeOperation: (namespace, input) => (typeof valueOf(namespace).lint === "function" ? 1 : 0) + input.length,
  }),
  three: SPEC({
    sampleOp: "new Vector3(x, 2, 3).length()",
    importPath: "package/build/three.module.js",
    staticInput: "1",
    dynamicInput: (_staticInput, seed) => String((seed % 7) + 1),
    dynamicSource: "String((seed % 7) + 1)",
    importClause: "{ Vector3 }",
    bindingPrelude: "const __pkgNs = { Vector3 }; const __pkg = __pkgNs;",
    operation: "new __pkgNs.Vector3(Number(input), 2, 3).length()",
    nativeOperation: (namespace, input) => new namespace.Vector3(Number(input), 2, 3).length(),
  }),
  lit: SPEC({
    sampleOp: "when(condition, truthy, falsy)",
    importPath: "package/index.js",
    staticInput: "yes",
    dynamicInput: (staticInput, seed) => `${staticInput}-${seed % 7}`,
    dynamicSource: '__npmCompatStaticInput + "-" + (seed % 7)',
    importClause: "{ when }",
    bindingPrelude: "const __pkgNs = { when }; const __pkg = __pkgNs;",
    operation: 'String(__pkgNs.when(input.length > 0, "yes", "no")).length',
    nativeOperation: (namespace, input) => String(namespace.when(input.length > 0, "yes", "no")).length,
  }),
  tailwindcss: SPEC({
    sampleOp: "exportCount + source.length",
    importPath: "package/dist/lib.mjs",
    staticInput: "text-red-500",
    dynamicInput: dynamicComment,
    dynamicSource: DEFAULT_DYNAMIC_SOURCE,
    importClause: "* as __pkgNs",
    bindingPrelude: "const __pkg = __pkgNs;",
    operation: "Object.keys(__pkgNs).length + input.length",
    nativeOperation: (namespace, input) => Object.keys(namespace).length + input.length,
  }),
});

export const NPM_COMPAT_PERF_PACKAGE_NAMES = Object.freeze(Object.keys(NPM_COMPAT_PERF_SPECS));

export function getNpmCompatPerfSpec(packageName) {
  const spec = NPM_COMPAT_PERF_SPECS[packageName];
  if (!spec) throw new Error(`No npm compatibility performance spec for ${packageName}`);
  return spec;
}

export function buildNpmCompatPerfDriver(spec, packageSpecifier, lane = "all") {
  const staticInput = JSON.stringify(spec.staticInput);
  const includeJsHost = lane === "all" || lane === "js-host";
  const includeStatic = lane === "all" || lane === "standalone-static";
  const includeDynamic = lane === "all" || lane === "standalone-dynamic";
  return `import ${spec.importClause ?? "* as __pkgNs"} from ${JSON.stringify(packageSpecifier)};

${spec.bindingPrelude ?? "const __pkg = __pkgNs.default ?? __pkgNs;"}
const __npmCompatStaticInput = ${staticInput};
${spec.helperSource ?? ""}

function __npmCompatApply(input) {
  return Number(${spec.operation});
}

${
  includeJsHost
    ? `export function __npmCompatPerf(input) {
  return __npmCompatApply(input);
}
`
    : ""
}

${
  includeStatic
    ? `export function __npmCompatStaticOperation() {
  return __npmCompatApply(__npmCompatStaticInput);
}

export function __npmCompatStandaloneBenchmark(iterations) {
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    checksum += __npmCompatApply(__npmCompatStaticInput);
  }
  return checksum;
}
`
    : ""
}

${
  includeDynamic
    ? `export function __npmCompatStandaloneDynamic(iterations, seed) {
  let checksum = 0;
  for (let index = 0; index < iterations; index += 1) {
    const input = ${spec.dynamicSource ?? DEFAULT_DYNAMIC_SOURCE};
    checksum += __npmCompatApply(input);
  }
  return checksum;
}
`
    : ""
}
`;
}
