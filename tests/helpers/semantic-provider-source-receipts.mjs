// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Test instrument, not a compiler or an alternative PreparedProgram constructor.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { isDeepStrictEqual, types as utilTypes } from "node:util";

export const BASELINE = "b4c116639a7e146e83611a988a8da28d77de9368";
export const SCHEMA = "semantic-provider-source-v1";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const here = dirname(fileURLToPath(import.meta.url));
// Node 22 stores lazy native stacks as accessors. Admit the actual runtime
// functions by identity, never accessor names or a spoofable toString receipt.
const nativeErrorStackDescriptor = Object.getOwnPropertyDescriptor(new Error(), "stack");
export const CANONICAL_ROOTS = Object.freeze([
  "src/ir/core/intrinsic-contracts.ts",
  "src/ir/core/intrinsics.ts",
  "src/ir/core/callable-bindings.ts",
  "src/ir/analysis/effects.ts",
  "src/ir/analysis/intrinsics.ts",
  "src/ir/analysis/async-plan.ts",
  "src/ir/runtime/host-capabilities.ts",
  "src/ir/runtime/async-providers.ts",
  "src/ir/runtime/callable-declarations.ts",
  "src/ir/runtime/manifest.ts",
  "src/ir/runtime/async-attachment.ts",
  "src/ir/runtime/intrinsic-verification.ts",
]);
const common = {
  bootstrap: "src/index.ts",
  checker: "src/checker/index.ts",
  source: "src/ir/program-source.ts",
  whole: "src/ir/program-preparation.ts",
  typed: "src/ir/program-prepare-ir.ts",
  controls: "src/ir/program-middleend.ts",
  codec: "src/ir/program-codec.ts",
  consumer: "src/ir/program-consumer.ts",
  binary: "src/emit/binary.ts",
  wat: "src/emit/wat.ts",
  runtime: "src/runtime.ts",
  transport: "tests/helpers/typed-program-transport.mjs",
  asyncPrepare: "src/ir/async-prepare-ir.ts",
  batch: "src/ir/passes/batch-string-concat.ts",
  demands: "src/ir/program-runtime-demands.ts",
  support: "src/ir/intrinsic-support.ts",
  nodes: "src/ir/core/nodes.ts",
  program: "src/ir/program.ts",
};
// Explicit historical interfaces. Missing modules never select another arm.
export const ARM_PATHS = Object.freeze({
  baseline: Object.freeze({
    ...common,
    manifest: "src/ir/runtime-manifest.ts",
    async: "src/ir/async-plan.ts",
    attachment: "src/ir/async-plan.ts",
  }),
  candidate: Object.freeze({
    ...common,
    manifest: "src/ir/runtime/manifest.ts",
    async: "src/ir/analysis/async-plan.ts",
    attachment: "src/ir/runtime/async-attachment.ts",
  }),
});

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}
function exactlyOne(text, pattern, label) {
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, `fixture source must contain exactly one ${label}`);
  return matches[0][1];
}
function template(root, path, name, substitutions = {}) {
  let text = exactlyOne(read(root, path), new RegExp(`const ${name} = \x60([\\s\\S]*?)\x60;`, "g"), `${path}:${name}`);
  for (const [key, value] of Object.entries(substitutions)) {
    assert.equal(text.split(`\${${key}}`).length, 2, `one documented substitution ${key}`);
    text = text.replace(`\${${key}}`, value);
  }
  assert(!text.includes("${"), `unresolved fixture interpolation ${name}`);
  return text;
}
const standalone = { target: "standalone", backend: "wasmgc" };
const host = { target: "host", backend: "wasmgc" };
export const controlsFor = (mode) => ({
  gvnMode: mode,
  ownership: false,
  escape: false,
  verifyIntermediateAllocations: false,
  verifyDominanceNaive: false,
});

/** Read existing source literals, never evaluate a test module or fabricate IR. */
export function fixtureMatrix(root) {
  const numberPath = "tests/issue-3526-number-boundary-intrinsics.test.ts";
  const booleanPath = "tests/issue-3526-boolean-boundary-intrinsic.test.ts";
  const externPath = "tests/issue-3526-boundary-residuals.test.ts";
  const mathPath = "tests/issue-3526-ir-math-intrinsic-integration.test.ts";
  const math = template(root, mathPath, "source");
  const boolean = template(root, booleanPath, "RUNNABLE", {
    BOOL_STORE_SOURCE: template(root, booleanPath, "BOOL_STORE_SOURCE"),
  });
  const extern = template(root, externPath, "RUNNABLE", { PROBE_SOURCE: template(root, externPath, "PROBE_SOURCE") });
  let native = read(root, "website/playground/examples/js/async.ts");
  for (const name of ["fetchUser", "fetchAllSequential", "fetchAllParallel"]) {
    assert.equal(native.split(`async function ${name}`).length, 2);
    native = native.replace(`async function ${name}`, `export async function ${name}`);
  }
  // These are the unchanged replay8 / lexical-TDZ source literals.
  const alias = {
    "./math.ts": "export function double(x: number): number { return x * 2; }",
    "./entry.ts": 'import { double as twice } from "./math"; export function main(): number { return twice(20) + 2; }',
  };
  const startup = (kind) => ({
    "./base.ts": `export ${kind} digit: number = 1; digit = digit * 10 + 3;`,
    "./entry.ts": `import { digit } from "./base"; ${kind} answer: number = digit * 10 + 2; export function read(): number { return answer; }`,
  });
  const single = (id, source, policy, calls, extra = {}) => ({
    id,
    files: { "./entry.ts": source },
    policy,
    calls,
    reverse: false,
    ...extra,
  });
  const cases = [
    single(
      "math-trig",
      math,
      standalone,
      ["sin", "cos", "tan"].map((name) => ({ name, args: [], expected: Math[name](0.75), tolerance: 1e-12 })),
      {
        requiredFeatures: ["math.sin", "math.reduce-trig"],
      },
    ),
    ...[
      ["host", { ...host, numberBoundary: { box: "host", unbox: "host" } }],
      [
        "native",
        { ...standalone, stringConst: { storage: "native" }, numberBoundary: { box: "unsupported", unbox: "native" } },
      ],
    ].map(([label, policy]) =>
      single(
        `number-${label}`,
        template(root, numberPath, "MEMO"),
        policy,
        [{ name: "test", args: [], expected: 15181 }],
        { requiredFeatures: ["js.number.unbox"] },
      ),
    ),
    ...[
      ["host", { ...host, booleanBoundary: { box: "host" } }],
      ["standalone-refusal", { ...standalone, booleanBoundary: { box: "unsupported" } }],
    ].map(([label, policy]) =>
      single(
        `boolean-${label}`,
        boolean,
        policy,
        [
          { name: "probe", args: [3], expected: 1 },
          { name: "probe", args: [1], expected: 0 },
        ],
        { requiredFeatures: ["js.boolean.box"] },
      ),
    ),
    ...[
      ["host", { ...host, externIsUndefined: { probe: "host" } }],
      ["native", { ...standalone, externIsUndefined: { probe: "native" } }],
    ].map(([label, policy]) =>
      single(
        `extern-${label}`,
        extern,
        policy,
        [
          { name: "present", args: [], expected: 1 },
          { name: "absent", args: [], expected: 0 },
        ],
        { requiredFeatures: ["js.extern.is_undefined"] },
      ),
    ),
    single("native-async", native, standalone, [], { native: true }),
    single(
      "native-async-post-pass",
      native,
      { ...standalone, stringConcatMany: { batch: "native" }, stringConst: { storage: "native" } },
      [],
      { native: true, postPass: true },
    ),
    ...[false, true].flatMap((reverse) => [
      {
        id: `alias-${reverse}`,
        files: alias,
        policy: standalone,
        reverse,
        calls: [{ name: "main", args: [], expected: 42 }],
      },
      {
        id: `startup-${reverse}`,
        files: startup("var"),
        policy: standalone,
        reverse,
        calls: [{ name: "read", args: [], expected: 132 }],
      },
      {
        id: `tdz-${reverse}`,
        files: startup("let"),
        policy: standalone,
        reverse,
        calls: [{ name: "read", args: [], expected: 132 }],
      },
    ]),
  ];
  const rows = cases.flatMap((fixture) =>
    ["off", "on"].map((mode) => ({ ...fixture, mode, id: `${fixture.id}:gvn-${mode}`, controls: controlsFor(mode) })),
  );
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((row) => row.id)).size, 30);
  return rows;
}

/** Lossless diagnostic/value graph receipt, including undefined, NaN, -0 and sharing. */
export function evidenceValue(value) {
  const seen = new Map();
  const visit = (entry) => {
    if (entry === undefined) return { $undefined: true };
    if (typeof entry === "number" && (!Number.isFinite(entry) || Object.is(entry, -0)))
      return { $number: String(Object.is(entry, -0) ? "-0" : entry) };
    if (typeof entry === "bigint") return { $bigint: String(entry) };
    if (entry === null || typeof entry !== "object") {
      assert.notEqual(typeof entry, "function", "receipt cannot erase a function");
      assert.notEqual(typeof entry, "symbol", "receipt cannot erase a symbol");
      return entry;
    }
    if (seen.has(entry)) return { $ref: seen.get(entry) };
    seen.set(entry, seen.size);
    if (entry instanceof Map) return { $map: [...entry].map(([key, item]) => [visit(key), visit(item)]) };
    if (entry instanceof Set) return { $set: [...entry].map(visit) };
    if (Array.isArray(entry)) return entry.map(visit);
    const output = {};
    const nativeError = utilTypes.isNativeError(entry);
    const descriptors = Reflect.ownKeys(entry).map((key) => [key, Object.getOwnPropertyDescriptor(entry, key)]);
    // Preflight every own property before the native formatter can run. In
    // particular a custom cause/detail/stack getter must remain unobserved.
    for (const [key, desc] of descriptors) {
      assert(
        "value" in desc ||
          (nativeError &&
            key === "stack" &&
            typeof nativeErrorStackDescriptor?.get === "function" &&
            desc.get === nativeErrorStackDescriptor.get &&
            desc.set === nativeErrorStackDescriptor.set),
        "receipt encountered an accessor",
      );
    }
    if (nativeError || entry instanceof Error) {
      // Stack formatting reads these through the prototype chain; do not let
      // custom inherited getters or object coercion run through that path.
      for (const key of ["name", "message"]) {
        let owner = entry,
          desc;
        while (owner !== null && !(desc = Object.getOwnPropertyDescriptor(owner, key)))
          owner = Object.getPrototypeOf(owner);
        assert(!desc || "value" in desc, "receipt encountered an accessor");
        const text = desc?.value;
        assert(text === undefined || typeof text === "string", "receipt error text requires primitive strings");
        output[key] = visit(text);
      }
    }
    for (const [key, desc] of descriptors) {
      const name = typeof key === "symbol" ? `$symbol:${String(key.description)}` : key;
      output[name] = visit("value" in desc ? desc.value : Reflect.apply(nativeErrorStackDescriptor.get, entry, []));
    }
    return output;
  };
  return visit(value);
}

function filesUnder(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) entries.push([relative(root, path), sha256(readFileSync(path))]);
      else throw new Error(`non-file source entry ${path}`);
    }
  };
  walk(root);
  return entries;
}
export function sourceSnapshot(root) {
  root = realpathSync(root);
  const census = filesUnder(join(root, "src"));
  assert(census.length > 1000, "compiler source census is empty/incomplete");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  return {
    root,
    head: git("rev-parse", "HEAD"),
    diff: git("diff", "--binary", "HEAD", "--", "src"),
    census,
    sha256: sha256(JSON.stringify(census)),
    scope: "all src files, including README; untracked canonical modules included",
  };
}
export function implementationIdentity() {
  return [join(here, "semantic-provider-source-receipts.mjs"), join(here, "semantic-provider-source-free.mjs")].map(
    (path) => ({ path, sha256: sha256(readFileSync(path)) }),
  );
}
export function runtimeIdentity(root) {
  const require = createRequire(join(root, "package.json"));
  const esbuildRequire = createRequire(require.resolve("esbuild/package.json"));
  const packages = ["tsx", "esbuild", `@esbuild/${process.platform}-${process.arch}`].map((name) => {
    const path = realpathSync(
      (name.startsWith("@esbuild/") ? esbuildRequire : require).resolve(`${name}/package.json`),
    );
    return { name, files: filesUnder(dirname(path)) };
  });
  return {
    node: process.version,
    versions: process.versions,
    executable: sha256(readFileSync(process.execPath)),
    packages,
    config: ["tsconfig.json", "pnpm-lock.yaml"].map((path) => [path, sha256(readFileSync(join(root, path)))]),
  };
}
export function childEnvironment(root, mode) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(name)) delete env[name];
  return {
    ...env,
    NODE_OPTIONS: "--max-old-space-size=2048",
    TSX_TSCONFIG_PATH: resolve(root, "tsconfig.json"),
    TSX_DISABLE_CACHE: "1",
    JS2WASM_IR_GVN: mode === "on" ? "1" : "0",
    JS2WASM_IR_OWNERSHIP: "0",
    JS2WASM_IR_ESCAPE: "0",
    IR_VERIFY_ALLOC: "0",
    JS2WASM_IR_VERIFY_DOMINANCE_NAIVE: "0",
    JS2WASM_IR_INLINE: "0",
  };
}
function launchIdentity() {
  return {
    execArgv: process.execArgv,
    env: Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => /^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key))
        .sort(),
    ),
  };
}
async function loadArm(root, arm) {
  assert(Object.hasOwn(ARM_PATHS, arm), "unknown compiler arm");
  const urls = Object.fromEntries(
    Object.entries(ARM_PATHS[arm]).map(([name, path]) => [name, pathToFileURL(join(root, path)).href]),
  );
  const api = {};
  // Normal bootstrap is explicit and precedes all phase imports.
  for (const [name, url] of Object.entries(urls)) api[name] = await import(url);
  return { api, urls };
}
function caught(phase, error) {
  return { phase, kind: "threw", error: evidenceValue(error) };
}
function assertValue(call, value) {
  if (!Object.hasOwn(call, "expected")) return;
  if (Object.hasOwn(call, "tolerance")) {
    assert(Number.isFinite(value), `non-finite result for ${call.name}`);
    assert(Math.abs(value - call.expected) <= call.tolerance, `wrong result for ${call.name}: ${value}`);
  } else assert.equal(value, call.expected);
}
function featuresOf(program) {
  return program.runtime.flatMap((projection) => projection.prepared.manifest.features);
}
function joins(runtime, api) {
  return runtime.functions
    .filter((fn) => fn.asyncPlan || fn.asyncRuntime)
    .map((fn) => {
      const current = api.attachment.assertPreparedIrAsyncRuntimeCurrent(
        fn.unitId,
        fn.name,
        fn.asyncPlan,
        fn.asyncRuntime,
      );
      return {
        owner: fn.unitId,
        plan: current.plan === fn.asyncPlan,
        manifest: current.manifest === runtime.manifest,
        providers: current.providers.map((provider) => runtime.manifest.providers.indexOf(provider)),
        statesFrozen: current.states.every((state) => Object.isFrozen(state) && Object.isFrozen(state.body)),
        stateCount: current.states.length,
        instructionCount: current.states.reduce((count, state) => count + state.body.length, 0),
        numberBridge: api.async.irAsyncPlanNeedsNumberBridge(fn.asyncPlan),
      };
    });
}
async function preparedEmission(program, fixture, api) {
  let phase = "backend-acceptance";
  const receipt = {};
  try {
    const options = {
      backend: "wasmgc",
      target: fixture.policy.target,
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
      moduleName: "ir-whole-program-replay",
    };
    const accepted = api.consumer.acceptPreparedIrProgram(program, options);
    if (accepted.kind !== "accepted") return { phase, kind: "refused", refusal: evidenceValue(accepted) };
    phase = "backend-emission";
    const emitted = api.consumer.emitAcceptedIrProgram(accepted);
    const binary = api.binary.emitBinary(emitted.module);
    receipt.artifact = {
      binary: Buffer.from(binary).toString("base64"),
      wat: api.wat.emitWat(emitted.module),
      imports: evidenceValue(emitted.module.imports),
      emittedUnits: evidenceValue(emitted.emittedUnitIds),
      module: evidenceValue(emitted.module),
    };
    phase = "instantiate";
    const imports = {};
    for (const entry of emitted.module.imports)
      if (entry.desc.kind === "tag")
        (imports[entry.module] ??= {})[entry.name] = new WebAssembly.Tag({ parameters: ["externref"] });
    // The historical prepared replay contract supplies tags only. Other imports
    // retain an actual instantiation failure; never synthesize a runtime resolver.
    receipt.instantiatedBinary = Buffer.from(binary).toString("base64");
    const { instance } = await WebAssembly.instantiate(binary, imports);
    receipt.exports = WebAssembly.Module.exports(new WebAssembly.Module(binary));
    phase = "execute";
    receipt.values = [];
    for (const call of fixture.calls) {
      assert.equal(typeof instance.exports[call.name], "function", `missing export ${call.name}`);
      const values = [instance.exports[call.name](...call.args), instance.exports[call.name](...call.args)];
      receipt.values.push({ call, values: evidenceValue(values) });
      for (const value of values) assertValue(call, value);
    }
    return { ...receipt, phase, kind: fixture.native ? "unmeasured-async-execution" : "executed" };
  } catch (error) {
    return { ...receipt, ...caught(phase, error) };
  }
}

async function nativeValues(result, api) {
  const values = [];
  for (const action of ["suspension", "non-i31", "undefined"]) {
    const jobs = [],
      events = [];
    const imports = api.runtime.buildCompiledImports(result, {
      setTimeout(callback, delay, ...args) {
        const ordinal = jobs.length;
        events.push(["start", ordinal, delay]);
        jobs.push(() => {
          events.push(["fire", ordinal]);
          callback(...args);
        });
        return ordinal + 1;
      },
    });
    const bytes = result.binary;
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    imports.setInstance?.(instance);
    const ex = instance.exports;
    for (const name of ["__promise_boundary_state", "__promise_boundary_value", "__drain_microtasks"])
      assert.equal(typeof ex[name], "function", `missing mandatory native export ${name}`);
    const promise = action === "undefined" ? ex.main() : ex.fetchUser(action === "non-i31" ? 300_000_000 : 7);
    const before = ex.__promise_boundary_state(promise);
    assert.equal(before, 0);
    assert.equal(jobs.length, 1);
    if (action === "undefined") {
      for (let i = 0; i < 5; i++) {
        assert(jobs[i], "missing sequential timer");
        jobs[i]();
      }
      assert.equal(jobs.length, 10);
      for (let i = 9; i >= 5; i--) jobs[i]();
    } else jobs[0]();
    const after = ex.__promise_boundary_state(promise);
    assert.equal(after, 1);
    const value = ex.__promise_boundary_value(promise);
    if (action === "undefined") {
      assert.equal(typeof ex.__dynamic_boundary_tag, "function");
      assert.equal(ex.__dynamic_boundary_tag(value), 2);
      values.push({
        action,
        before,
        after,
        value: { $undefined: true },
        events,
        instantiatedBinary: Buffer.from(bytes).toString("base64"),
      });
    } else if (action === "non-i31") {
      // Use the existing real Promise boundary for the boxed-number readout.
      const wrapped = api.runtime.wrapCompiledExports(result, instance);
      const second = wrapped.fetchUser(300_000_000);
      assert.equal(jobs.length, 2);
      jobs[1]();
      const unboxed = await second;
      assert.equal(unboxed, 3_000_000_000);
      values.push({
        action,
        before,
        after,
        value: unboxed,
        events,
        instantiatedBinary: Buffer.from(bytes).toString("base64"),
      });
    } else {
      assert.equal(value, 70);
      values.push({ action, before, after, value, events, instantiatedBinary: Buffer.from(bytes).toString("base64") });
    }
  }
  return values;
}
async function publicReceipt(fixture, api) {
  // Public async execution is an independent control, not prepared replay.
  // Multi-source programs stay exclusively in the actual preparation recorder.
  if (Object.keys(fixture.files).length !== 1)
    return { assessed: false, reason: "multisource covered by prepared replay" };
  let phase = "public-compile";
  const receipt = { assessed: true };
  try {
    const result = await api.bootstrap.compile(fixture.files["./entry.ts"], {
      fileName: "semantic-provider-source.ts",
      target: fixture.policy.target,
      experimentalIR: true,
      trackFallbacks: true,
      trackIrOutcomes: true,
      skipSemanticDiagnostics: true,
      emitWat: true,
      ...(fixture.native ? { hostBridge: "always" } : {}),
    });
    receipt.result = evidenceValue({
      success: result.success,
      errors: result.errors,
      imports: result.imports,
      stringPool: result.stringPool,
      irCompiledFuncs: result.irCompiledFuncs,
      irOutcomes: result.irOutcomes,
      irPostClaimErrors: result.irPostClaimErrors,
    });
    if (!result.success) return { ...receipt, phase, kind: "refused" };
    receipt.binary = Buffer.from(result.binary).toString("base64");
    receipt.wat = result.wat;
    const module = new WebAssembly.Module(result.binary);
    receipt.imports = WebAssembly.Module.imports(module);
    receipt.exports = WebAssembly.Module.exports(module);
    phase = "public-execute";
    if (fixture.native) {
      assert.deepEqual(
        receipt.imports.map(({ module, name }) => `${module}.${name}`),
        ["env.__timer_set_timeout"],
      );
      for (const name of ["fetchUser", "fetchAllSequential", "fetchAllParallel", "main"]) {
        const rows = result.irOutcomes.filter((row) => row.unitKind === "function" && row.displayName === name);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, "emitted");
        assert.equal(rows[0].irBodyEmitted, true);
        assert.equal(rows[0].legacyBodyEmitted, false);
      }
      receipt.values = [await nativeValues(result, api), await nativeValues(result, api)];
    } else {
      const imports = api.runtime.buildImports(result.imports, undefined, result.stringPool);
      receipt.instantiatedBinary = Buffer.from(result.binary).toString("base64");
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setExports?.(instance.exports);
      receipt.values = fixture.calls.map((call) => {
        assert.equal(typeof instance.exports[call.name], "function");
        const values = [instance.exports[call.name](...call.args), instance.exports[call.name](...call.args)];
        for (const value of values) assertValue(call, value);
        return { call, values: evidenceValue(values) };
      });
      if (fixture.id.startsWith("boolean-host:")) {
        // Keep the independently reproduced __host_eq failure visible.
        assert.deepEqual(
          receipt.imports.map((entry) => entry.name),
          ["__typeof_boolean", "__unbox_number", "__box_number", "__box_boolean", "__get_undefined"],
        );
      }
    }
    return { ...receipt, phase, kind: "executed" };
  } catch (error) {
    return { ...receipt, ...caught(phase, error) };
  }
}

async function rowReceipt(fixture, api) {
  const row = {
    id: fixture.id,
    fixture,
    preparation: null,
    public: null,
    postPass: { assessed: false, satisfied: false },
  };
  let phase = "analyze";
  let admission = null;
  let activeOwner = null;
  try {
    const ast = api.checker.analyzeMultiSource(fixture.files, "./entry.ts");
    const input = {
      sourceFiles: fixture.reverse ? [...ast.sourceFiles].reverse() : ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: fixture.policy,
      runtimePolicies: [fixture.policy],
      deferTopLevelInit: false,
    };
    phase = "source-preparation";
    const source = api.source.prepareIrProgramSources(input);
    row.source =
      source.kind === "prepared"
        ? { kind: source.kind, packet: api.transport.encodeTypedPacket(api.source.captureTypedIrProgramInput(source)) }
        : { kind: "refused", refusal: evidenceValue(source) };
    phase = "whole-preparation";
    const result = api.whole.prepareWholeIrProgram(input);
    if (result.kind !== "prepared") row.preparation = { phase, kind: "refused", refusal: evidenceValue(result) };
    else {
      const program = result.program;
      phase = "canonical-codec";
      const canonical = api.codec.encodePreparedIrProgram(program);
      const decoded = api.codec.decodePreparedIrProgram(canonical);
      assert.equal(api.codec.encodePreparedIrProgram(decoded), canonical);
      const runtime = program.runtime.map((projection) => ({
        backend: projection.backend,
        target: projection.target,
        data: evidenceValue(projection.prepared),
        joins: joins(projection.prepared, api),
      }));
      const replayJoins = decoded.runtime.map((projection) => joins(projection.prepared, api));
      const original = await preparedEmission(program, fixture, api);
      const replayed = await preparedEmission(decoded, fixture, api);
      row.preparation = {
        phase: "complete",
        kind: "prepared",
        canonical,
        runtime,
        replayJoins,
        features: featuresOf(program),
        original,
        replayed,
        replayEqual: isDeepStrictEqual(original, replayed),
      };
      const fn = program.ir.functions.find((fn) => fn.asyncPlan?.states.some((state) => state.body.length > 0));
      if (fn)
        admission = {
          wire: api.transport.encodeTypedPacket({ fn, policy: fixture.policy }),
          owner: fn.unitId,
          fixtureId: fixture.id,
          canonicalSha256: sha256(canonical),
        };
    }
    if (fixture.postPass && source.kind === "prepared") {
      phase = "post-pass-source-async";
      const observations = [];
      for (const sourceFn of source.ir.functions.filter((fn) => fn.funcKind === "async")) {
        activeOwner = api.program.preparedIrProgramOwner(source, sourceFn.unitId);
        assert(activeOwner, "source-produced async owner has no inventory location");
        const prepared = api.asyncPrepare.prepareSuspendingIrFunction(sourceFn, fixture.policy.numberBoundary);
        if (!prepared) {
          observations.push({ owner: sourceFn.unitId, kind: "producer-declined" });
          continue;
        }
        const before = prepared.main;
        const transformed = api.batch.batchStringConcat(
          before,
          source.allocations,
          api.manifest.stringConcatManyArityCap("native"),
        );
        const changed = !isDeepStrictEqual(before.asyncPlan?.states, transformed.asyncPlan?.states);
        const runtime = api.support.prepareIrRuntimeManifest({
          functions: [transformed],
          sourceFile: input.entrySource.fileName,
          sourceLocationsByUnit: new Map([
            [
              sourceFn.unitId,
              { file: activeOwner.sourceFile, line: activeOwner.location.line, column: activeOwner.location.column },
            ],
          ]),
          policy: fixture.policy,
          ...api.demands.irProgramRuntimeDemands(transformed),
          includeEmpty: true,
        });
        observations.push({
          owner: sourceFn.unitId,
          kind: "authenticated",
          changed,
          before: evidenceValue(before),
          after: evidenceValue(transformed),
          beforePlan: evidenceValue(before.asyncPlan),
          afterPlan: evidenceValue(transformed.asyncPlan),
          // Serialize the returned owners' SEMANTIC plans independently. Their
          // asyncRuntime.states are provider projections, not semantic bodies.
          runtimeSemanticPlans: runtime.functions
            .filter((fn) => fn.asyncPlan)
            .map((fn) => ({
              owner: fn.unitId,
              plan: evidenceValue(fn.asyncPlan),
            })),
          joins: joins(runtime, api),
          // Standalone encoding avoids graph-reference aliases inside runtime.
          manifest: evidenceValue(runtime.manifest),
          runtime: evidenceValue(runtime),
          ordering: "semantic state pass then real runtime preparation/authentication; not post-attachment mutation",
        });
      }
      row.postPass = {
        assessed: true,
        satisfied: false,
        observations,
      };
      row.postPass.satisfied = postPassSatisfied(row.postPass);
    }
  } catch (error) {
    if (phase === "post-pass-source-async")
      row.postPass = {
        ...row.postPass,
        assessed: true,
        satisfied: false,
        owner: evidenceValue(activeOwner),
        ...caught(phase, error),
      };
    else row.preparation = caught(phase, error);
  }
  row.public = await publicReceipt(fixture, api);
  return { row, admission };
}

export async function runArm({ root, arm, mode }) {
  root = realpathSync(root);
  assert(["off", "on"].includes(mode));
  const before = sourceSnapshot(root),
    runtime = runtimeIdentity(root),
    implementation = implementationIdentity();
  if (arm === "baseline") {
    assert.equal(before.head, BASELINE);
    assert.equal(before.diff, "");
  }
  const matrix = fixtureMatrix(root).filter((row) => row.mode === mode);
  const launch = launchIdentity();
  assert.equal(process.env.ESBUILD_BINARY_PATH, undefined, "alternate loader binary is not admitted");
  assert.equal(process.env.TSX_TSCONFIG_PATH, join(root, "tsconfig.json"));
  assert.equal(process.env.TSX_DISABLE_CACHE, "1");
  assert.equal(process.env.NODE_OPTIONS, "--max-old-space-size=2048");
  const { api, urls } = await loadArm(root, arm);
  assert.deepEqual(api.controls.resolveIrPreparationControlsFromEnv(), controlsFor(mode));
  const rows = [],
    admissions = [];
  for (const fixture of matrix) {
    const result = await rowReceipt(fixture, api);
    rows.push(result.row);
    if (result.admission) admissions.push(result.admission);
  }
  const after = sourceSnapshot(root);
  assert.deepEqual(after, before, "compiler source changed during recorder");
  assert.deepEqual(runtimeIdentity(root), runtime, "runtime/loader/config changed");
  assert.deepEqual(implementationIdentity(), implementation, "instrument changed");
  return {
    schema: SCHEMA,
    provenance: {
      arm,
      mode,
      before,
      after,
      runtime,
      implementation,
      urls,
      launch,
      fixtureSha256: sha256(JSON.stringify(matrix)),
    },
    rows,
    admissions,
  };
}

/** Separate, source-produced admission fixture. Never a whole-program replay substitute. */
export async function produceAdmission({ root, arm, captureReceipt }) {
  assert.equal(typeof captureReceipt, "function", "independent producer receipt sink is required");
  root = realpathSync(root);
  const snapshot = sourceSnapshot(root);
  const { api, urls } = await loadArm(root, arm);
  const path = "tests/issue-2865-standalone-async-await-unwrap.test.ts";
  const sourceFile = read(root, path);
  // Fixed exact declaration extraction, not a fallback after a refusal. The
  // existing Promise-parameter predicate is unsuitable: typeNodeToIr admits
  // primitive annotations only. This source already exercises native await.
  const source = exactlyOne(
    sourceFile,
    /runWasi\(`(async function f\(\): Promise<number> \{ return await 99; \})\n/g,
    "existing numeric-await declaration",
  );
  const ast = api.checker.analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const input = {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: standalone,
    deferTopLevelInit: false,
  };
  const result = api.source.prepareIrProgramSources(input);
  if (result.kind !== "prepared")
    return { kind: "refused", phase: "admission-source-preparation", refusal: evidenceValue(result), source, urls };
  const functions = result.ir.functions.filter((fn) => fn.name === "f");
  assert.equal(functions.length, 1, "exact source-produced async owner");
  const prepared = api.asyncPrepare.prepareSuspendingIrFunction(functions[0]);
  if (!prepared)
    return {
      kind: "refused",
      phase: "admission-async-preparation",
      owner: functions[0].unitId,
      source,
      urls,
      detail: "actual async producer declined the source function",
    };
  const plan = prepared.main.asyncPlan;
  assert(plan && plan.states.some((state) => state.body.length > 0), "nonempty source-derived async body required");
  const ownerRecords = result.inventory.terminalUnits.filter((unit) => unit.id === functions[0].unitId);
  assert.equal(ownerRecords.length, 1, "exact inventoried producer owner");
  const wire = api.transport.encodeTypedPacket({ fn: prepared.main, policy: standalone, inventory: result.inventory });
  assert.deepEqual(sourceSnapshot(root), snapshot, "producer source changed");
  assert.equal(read(root, path), sourceFile, "producer fixture changed");
  // Capture independently of the transport payload. The caller pins this
  // receipt/digest before handing an untrusted serialized payload to admission.
  captureReceipt(
    structuredClone({
      schema: "semantic-provider-admission-producer-v1",
      root,
      arm,
      snapshot,
      urls,
      sourcePath: path,
      sourceFileSha256: sha256(sourceFile),
      source,
      sourceSha256: sha256(source),
      ownerRecord: evidenceValue(ownerRecords[0]),
      inventory: evidenceValue(result.inventory),
      wireSha256: sha256(wire),
    }),
  );
  return {
    kind: "produced",
    root,
    source,
    sourcePath: path,
    extraction: "exact numeric-await function declaration, excluding existing readout driver",
    sourceSha256: sha256(source),
    urls,
    owner: functions[0].unitId,
    inventory: evidenceValue(result.inventory),
    wire,
    wireSha256: sha256(wire),
  };
}

function executionBinary(binary) {
  assert.equal(typeof binary, "string");
  const bytes = Buffer.from(binary, "base64");
  assert(bytes.length > 8, "empty executable binary");
  assert.equal(bytes.toString("base64"), binary, "noncanonical binary receipt");
  assert.deepEqual([...bytes.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]);
}

function validateExecutedCalls(binary, instantiatedBinary, values, fixture) {
  executionBinary(binary);
  assert.equal(binary, instantiatedBinary, "emitted binary was not the instantiated binary");
  assert(Array.isArray(values) && values.length > 0, "missing executed values");
  assert.equal(values.length, fixture.calls.length);
  for (const [index, record] of values.entries()) {
    assert.deepEqual(record.call, fixture.calls[index], "substituted executed call");
    assert(Array.isArray(record.values) && record.values.length === 2, "two executed values per call required");
    for (const value of record.values) assertValue(fixture.calls[index], value);
  }
}

/** Validate each arm, not merely equality of two possibly-corrupt reports. */
export function validatePublicExecution(receipt, fixture) {
  assert.equal(receipt.assessed, Object.keys(fixture.files).length === 1);
  if (!receipt.assessed) return;
  assert(["executed", "refused", "threw"].includes(receipt.kind));
  if (receipt.kind !== "executed") return; // Preserve complete partial failure evidence.
  executionBinary(receipt.binary);
  assert.equal(receipt.result.success, true);
  assert.equal(typeof receipt.wat, "string");
  assert(receipt.wat.length > 0);
  assert(Array.isArray(receipt.imports) && Array.isArray(receipt.exports) && receipt.exports.length > 0);
  assert(Array.isArray(receipt.values) && receipt.values.length > 0, "missing executed values");
  if (!fixture.native) {
    validateExecutedCalls(receipt.binary, receipt.instantiatedBinary, receipt.values, fixture);
    return;
  }
  assert.deepEqual(
    receipt.imports.map(({ module, name }) => `${module}.${name}`),
    ["env.__timer_set_timeout"],
  );
  for (const name of ["fetchUser", "fetchAllSequential", "fetchAllParallel", "main"]) {
    const owners = receipt.result.irOutcomes.filter((row) => row.unitKind === "function" && row.displayName === name);
    assert.equal(owners.length, 1);
    assert.equal(owners[0].kind, "emitted");
    assert.equal(owners[0].irBodyEmitted, true);
    assert.equal(owners[0].legacyBodyEmitted, false);
  }
  assert.equal(receipt.values.length, 2, "two independent native action runs required");
  for (const run of receipt.values) {
    assert(Array.isArray(run));
    assert.deepEqual(
      run.map((record) => record.action),
      ["suspension", "non-i31", "undefined"],
    );
    for (const record of run) {
      assert.equal(record.instantiatedBinary, receipt.binary, "native action binary mismatch");
      assert.equal(record.before, 0);
      assert.equal(record.after, 1);
      assert.deepEqual(
        record.value,
        record.action === "undefined" ? { $undefined: true } : record.action === "non-i31" ? 3_000_000_000 : 70,
      );
      assert(Array.isArray(record.events));
      const count = record.action === "undefined" ? 10 : record.action === "non-i31" ? 2 : 1;
      const starts = record.events.filter((event) => event[0] === "start");
      const fires = record.events.filter((event) => event[0] === "fire");
      assert.equal(record.events.length, count * 2);
      assert.deepEqual(
        starts.map((event) => event[1]),
        Array.from({ length: count }, (_, i) => i),
      );
      assert.deepEqual(
        fires.map((event) => event[1]),
        record.action === "undefined" ? [0, 1, 2, 3, 4, 9, 8, 7, 6, 5] : starts.map((event) => event[1]),
      );
      for (const event of starts) {
        assert.equal(event.length, 3);
        assert(Number.isFinite(event[2]) && event[2] >= 0);
        const fire = fires.find((item) => item[1] === event[1]);
        assert.equal(fire.length, 2);
        assert(record.events.indexOf(event) < record.events.indexOf(fire));
      }
    }
  }
}

/** A changed body is necessary but is not an attachment authentication receipt. */
export function postPassSatisfied(postPass) {
  assert.equal(typeof postPass.assessed, "boolean");
  if (!postPass.assessed || postPass.kind === "threw") return false;
  assert(Array.isArray(postPass.observations));
  let satisfied = false;
  for (const entry of postPass.observations) {
    assert(["authenticated", "producer-declined"].includes(entry.kind));
    assert.equal(typeof entry.owner, "string");
    assert(entry.owner.length > 0);
    if (entry.kind !== "authenticated") continue;
    for (const fn of [entry.before, entry.after]) {
      assert.equal(fn.unitId, entry.owner);
      assert.equal(fn.asyncPlan.ownerUnitId, entry.owner);
    }
    for (const plan of [entry.beforePlan, entry.afterPlan]) {
      assert.equal(plan.ownerUnitId, entry.owner);
      assert(Array.isArray(plan.states) && plan.states.length > 1);
    }
    assert.equal(entry.changed, !isDeepStrictEqual(entry.beforePlan.states, entry.afterPlan.states));
    assert(Array.isArray(entry.joins) && entry.joins.length > 0, "missing transformed owner joins");
    const owners = entry.joins.filter((item) => item.owner === entry.owner);
    assert.equal(owners.length, 1, "transformed owner must have exactly one join");
    assert(Array.isArray(entry.runtime.functions));
    const runtimeOwners = entry.runtime.functions.filter((fn) => fn.unitId === entry.owner);
    assert.equal(runtimeOwners.length, 1, "transformed owner missing from actual runtime projection");
    assert.equal(runtimeOwners[0].asyncPlan.ownerUnitId, entry.owner);
    assert(["standalone-native-wasmgc", "host-wasmgc"].includes(runtimeOwners[0].asyncRuntime.kind));
    assert(Array.isArray(entry.runtimeSemanticPlans));
    const semanticOwners = entry.runtimeSemanticPlans.filter((item) => item.owner === entry.owner);
    assert.equal(semanticOwners.length, 1, "missing returned semantic owner plan");
    assert.deepEqual(semanticOwners[0].plan, entry.afterPlan, "returned semantic async plan is stale after the pass");
    const joined = owners[0];
    assert.equal(joined.plan, true);
    assert.equal(joined.manifest, true);
    assert.equal(joined.statesFrozen, true);
    assert.equal(joined.stateCount, entry.afterPlan.states.length);
    assert(Number.isInteger(joined.instructionCount) && joined.instructionCount > 0);
    const providers = entry.manifest.providers;
    assert(Array.isArray(providers) && providers.length > 0);
    assert.equal(new Set(providers.map((provider) => provider.id)).size, providers.length);
    assert(Array.isArray(joined.providers) && joined.providers.length > 0);
    assert.equal(new Set(joined.providers).size, joined.providers.length);
    assert.deepEqual(
      joined.providers,
      [...joined.providers].sort((a, b) => a - b),
      "noncanonical provider order",
    );
    for (const index of joined.providers) {
      assert(Number.isInteger(index) && index >= 0 && index < providers.length, "invalid provider index");
      assert.equal(typeof providers[index].id, "string");
      assert.equal(typeof providers[index].feature, "string");
    }
    assert.deepEqual(
      joined.providers.map((index) => providers[index].feature).sort(),
      [...entry.afterPlan.runtimeIntents].sort(),
    );
    satisfied ||= entry.changed;
  }
  return satisfied;
}

export function validateArm(report, expected, terminal) {
  assert.equal(report.schema, SCHEMA);
  assert(terminal, "missing bound terminal receipt");
  assert.equal(terminal.code, 0);
  assert.equal(terminal.signal, null);
  assert.equal(terminal.error, null);
  assert.equal(terminal.root, expected.snapshot.root);
  assert.equal(terminal.arm, expected.arm);
  assert.equal(terminal.mode, expected.mode);
  assert.equal(terminal.reportSha256, sha256(JSON.stringify(report)), "terminal/report binding");
  const p = report.provenance;
  assert.equal(p.arm, expected.arm);
  assert.equal(p.mode, expected.mode);
  assert.deepEqual(p.before, expected.snapshot);
  assert.deepEqual(p.after, expected.snapshot);
  assert.deepEqual(p.runtime, expected.runtime);
  assert.deepEqual(p.implementation, expected.implementation);
  assert.deepEqual(p.launch, expected.launch);
  assert.deepEqual(
    p.urls,
    Object.fromEntries(
      Object.entries(ARM_PATHS[expected.arm]).map(([name, path]) => [
        name,
        pathToFileURL(join(expected.snapshot.root, path)).href,
      ]),
    ),
  );
  assert.equal(p.fixtureSha256, sha256(JSON.stringify(expected.fixtures)));
  assert.deepEqual(
    report.rows.map((row) => row.id),
    expected.fixtures.map((row) => row.id),
  );
  assert.equal(report.rows.length, 15);
  for (const [index, row] of report.rows.entries()) {
    assert.deepEqual(row.fixture, expected.fixtures[index]);
    assert(row.preparation && row.public && row.postPass);
    validatePublicExecution(row.public, row.fixture);
    assert.equal(row.postPass.satisfied, postPassSatisfied(row.postPass));
    assert(["prepared", "refused", "threw"].includes(row.preparation.kind));
    if (row.preparation.kind === "prepared") {
      assert.equal(typeof row.preparation.canonical, "string");
      JSON.parse(row.preparation.canonical);
      assert(Array.isArray(row.preparation.runtime) && row.preparation.runtime.length > 0);
      assert.equal(row.preparation.replayEqual, isDeepStrictEqual(row.preparation.original, row.preparation.replayed));
      for (const emission of [row.preparation.original, row.preparation.replayed]) {
        assert(emission && typeof emission.kind === "string");
        if (emission.kind === "executed") {
          validateExecutedCalls(emission.artifact.binary, emission.instantiatedBinary, emission.values, row.fixture);
        }
      }
    }
  }
  return true;
}
export function compareArms(
  baseline,
  candidate,
  expectedBaseline,
  expectedCandidate,
  baselineTerminal,
  candidateTerminal,
) {
  validateArm(baseline, expectedBaseline, baselineTerminal);
  validateArm(candidate, expectedCandidate, candidateTerminal);
  assert.notEqual(expectedBaseline.snapshot.root, expectedCandidate.snapshot.root, "baseline-as-candidate");
  assert.equal(expectedBaseline.arm, "baseline");
  assert.equal(expectedCandidate.arm, "candidate");
  assert.equal(expectedBaseline.mode, expectedCandidate.mode);
  assert.deepEqual(expectedBaseline.runtime, expectedCandidate.runtime);
  assert.deepEqual(expectedBaseline.implementation, expectedCandidate.implementation);
  assert.deepEqual(expectedBaseline.fixtures, expectedCandidate.fixtures);
  const differences = [];
  for (let index = 0; index < baseline.rows.length; index++)
    if (!isDeepStrictEqual(baseline.rows[index], candidate.rows[index]))
      differences.push({
        id: baseline.rows[index].id,
        baseline: baseline.rows[index],
        candidate: candidate.rows[index],
      });
  const pending = candidate.rows.flatMap((row) => {
    const gaps = [];
    if (row.public.assessed && row.public.kind !== "executed") gaps.push("public execution/control failure");
    if (row.preparation.kind !== "prepared") gaps.push("whole preparation");
    else {
      if (!row.preparation.replayEqual) gaps.push("original/decoded replay mismatch");
      if (row.preparation.original.kind !== "executed") gaps.push("prepared physical execution");
      for (const feature of row.fixture.requiredFeatures ?? [])
        if (!row.preparation.features.includes(feature)) gaps.push(`provider ${feature}`);
    }
    if (row.fixture.postPass && !row.postPass.satisfied) gaps.push("source-produced transformed async authentication");
    return gaps.length ? [{ id: row.id, gaps }] : [];
  });
  // Raw differences are never normalized into acceptance; checkout-path stack
  // differences remain visible and require a separately reviewed attribution.
  return {
    preservationOK: differences.length === 0,
    acceptanceOK: differences.length === 0 && pending.length === 0,
    pairs: baseline.rows.length,
    differences,
    pending,
  };
}

async function child(root, arm, mode, directory) {
  const path = join(directory, `${arm}-${mode}.json`);
  const env = childEnvironment(root, mode);
  const args = ["--import", "tsx", fileURLToPath(import.meta.url), "--child", arm, root, mode, path];
  const expected = {
    arm,
    mode,
    snapshot: sourceSnapshot(root),
    runtime: runtimeIdentity(root),
    implementation: implementationIdentity(),
    fixtures: fixtureMatrix(root).filter((row) => row.mode === mode),
    launch: {
      execArgv: ["--import", "tsx"],
      env: Object.fromEntries(
        Object.entries(env)
          .filter(([key]) =>
            /^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key),
          )
          .sort(),
      ),
    },
  };
  const terminal = await new Promise((done) => {
    const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      error = null;
    proc.stdout.on("data", (data) => {
      stdout += data;
    });
    proc.stderr.on("data", (data) => {
      stderr += data;
    });
    proc.on("error", (value) => {
      error = evidenceValue(value);
    });
    // No timeout kills. Parent owns cancellation and the serialized heavy slot.
    proc.on("close", (code, signal) =>
      done({ root, arm, mode, code, signal, error, stdout, stderr, pid: proc.pid, args, env: expected.launch.env }),
    );
  });
  const terminalPath = join(directory, `${arm}-${mode}.terminal.json`);
  writeFileSync(terminalPath, JSON.stringify(terminal, null, 2));
  assert.equal(terminal.code, 0, terminal.stderr);
  assert.equal(terminal.signal, null);
  assert.equal(terminal.error, null);
  const report = JSON.parse(readFileSync(path, "utf8"));
  terminal.reportSha256 = sha256(JSON.stringify(report));
  writeFileSync(terminalPath, JSON.stringify(terminal, null, 2));
  writeFileSync(join(directory, `${arm}-${mode}.expected.json`), JSON.stringify(expected, null, 2));
  return { report, expected, terminal };
}
export async function runPair({ baselineRoot, candidateRoot, directory }) {
  baselineRoot = realpathSync(baselineRoot);
  candidateRoot = realpathSync(candidateRoot);
  assert.notEqual(baselineRoot, candidateRoot);
  mkdirSync(directory, { recursive: true });
  const comparisons = [];
  for (const mode of ["off", "on"]) {
    const before = await child(baselineRoot, "baseline", mode, directory);
    const after = await child(candidateRoot, "candidate", mode, directory);
    comparisons.push(
      compareArms(before.report, after.report, before.expected, after.expected, before.terminal, after.terminal),
    );
  }
  const report = {
    schema: SCHEMA,
    comparisons,
    preservationOK: comparisons.every((item) => item.preservationOK),
    acceptanceOK: comparisons.every((item) => item.acceptanceOK),
  };
  writeFileSync(join(directory, "comparison.json"), JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--child") {
    assert.equal(args.length, 4);
    const [arm, root, gvn, output] = args;
    const report = await runArm({ root, arm, mode: gvn });
    writeFileSync(output, JSON.stringify(report, null, 2));
  } else if (mode === "--admission-payload") {
    assert.equal(args.length, 4, "--admission-payload ROOT ARM OUTPUT_JSON PRODUCER_JSON");
    const report = await produceAdmission({
      root: args[0],
      arm: args[1],
      captureReceipt(receipt) {
        writeFileSync(args[3], JSON.stringify(receipt, null, 2));
        process.stdout.write(`producerSha256=${sha256(JSON.stringify(receipt))}\n`);
      },
    });
    writeFileSync(args[2], JSON.stringify(report, null, 2));
    process.exitCode = report.kind === "produced" ? 0 : 1;
  } else if (mode === "--pair") {
    assert.equal(args.length, 3, "--pair BASELINE_ROOT CANDIDATE_ROOT OUTPUT_DIRECTORY");
    const report = await runPair({ baselineRoot: args[0], candidateRoot: args[1], directory: args[2] });
    console.log(JSON.stringify({ preservationOK: report.preservationOK, acceptanceOK: report.acceptanceOK }));
    process.exitCode = report.preservationOK ? 0 : 1;
  } else throw new Error("expected --child, --pair or --admission-payload; no implicit compiler-root fallback");
}
