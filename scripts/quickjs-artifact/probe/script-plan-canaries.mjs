// Isolated matched old/new compatibility receipt; never builds native artifacts
// or publishes caches. Execution requires its own reviewed finite runtime lease.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCompilerInputsHash } from "../../compiler-inputs-hash.mjs";
import { instantiateRuntimeEvalNamespace, loadProviderCompiler } from "../../runtime-eval-provider.mjs";
import {
  assertQuickjsArtifactExports,
  assertQuickjsArtifactStandalone,
  assertQuickjsScriptPlanCapability,
  buildQuickjsAdapterSource,
  readQuickjsArtifact,
  QUICKJS_ADAPTER_COMPILE_OPTIONS,
  QUICKJS_ADAPTER_EXTERNS,
  QUICKJS_IMPORT_MODULE,
  QUICKJS_ADAPTER_CANARY_SOURCE,
  QUICKJS_ADAPTER_CANARY_EXPECTATIONS,
  QUICKJS_DIRECT_CANARY_SOURCE,
  QUICKJS_DIRECT_CANARY_EXPECTATIONS,
  QUICKJS_FUNCTION_PARITY_CANARY_SOURCE,
  QUICKJS_FUNCTION_PARITY_CANARY_EXPECTATIONS,
  QUICKJS_STATE_PARITY_CANARY_SOURCE,
  QUICKJS_STATE_PARITY_CANARY_EXPECTATIONS,
} from "../../quickjs-eval-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)),
  ROOT = resolve(HERE, "../../..");
const IMPORT_MODULE = "js2wasm:runtime-eval";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const errorText = (error) => error.stack ?? String(error);
const DEFINITIONS = Object.freeze([
  {
    id: "adapter",
    fileName: "quickjs-eval-canary.ts",
    source: QUICKJS_ADAPTER_CANARY_SOURCE,
    expectations: QUICKJS_ADAPTER_CANARY_EXPECTATIONS,
    sourceSha256: "8ce393dac801b9707f2159f8644e17c1b2115e54d7ab14cadc93763df23e1526",
    extra: {},
  },
  {
    id: "direct",
    fileName: "quickjs-eval-direct-canary.ts",
    source: QUICKJS_DIRECT_CANARY_SOURCE,
    expectations: QUICKJS_DIRECT_CANARY_EXPECTATIONS,
    sourceSha256: "383406b3c5001924d7e38c869eab307d468513d9d88bd86fbf3b79d3ee596fa6",
    extra: { inferModuleStrictArguments: false },
  },
  {
    id: "function-parity",
    fileName: "quickjs-eval-function-parity-canary.ts",
    source: QUICKJS_FUNCTION_PARITY_CANARY_SOURCE,
    expectations: QUICKJS_FUNCTION_PARITY_CANARY_EXPECTATIONS,
    sourceSha256: "6a9f4568f57e535fd26af3ffafb44492de4335191807463d687a6ca9e60bcbf4",
    extra: {},
  },
  {
    id: "state-parity",
    fileName: "quickjs-eval-state-parity-canary.ts",
    source: QUICKJS_STATE_PARITY_CANARY_SOURCE,
    expectations: QUICKJS_STATE_PARITY_CANARY_EXPECTATIONS,
    sourceSha256: "48014e044ec07a4502a1addf33d9496a004dafcdafb4dc6dd3a066a73544feec",
    extra: { inferModuleStrictArguments: false },
  },
]);
const EXPECTED_READINGS = [42, 7, 151, 42, 111, 42, 4321, 6543, 42, 11, 52];
const CAPABILITY_SOURCE = `
import { store8 } from "wasm:memory";
type i32 = number;
declare function probe_ext(a: i32): i32;
export function probe(a: i32): i32 { store8(a, 1); return probe_ext(a); }
`;
const PROVIDER_ENTRIES = [
  "__runtime_new_function",
  "__runtime_indirect_eval",
  "__runtime_direct_eval",
  "__runtime_script_eval",
  "__runtime_apply_interpreted",
];

export function productionInputs() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(ROOT, path).split(sep).join("/"));
      else throw new Error(`unexpected nonregular compiler input: ${path}`);
    }
  };
  walk(join(ROOT, "src"));
  files.push(
    "pnpm-lock.yaml",
    "scripts/compiler-inputs-hash.mjs",
    "scripts/runtime-eval-provider.mjs",
    "scripts/quickjs-eval-provider.mjs",
    "scripts/quickjs-artifact/wasi-stub.mjs",
    "scripts/quickjs-artifact/patches/script-plan-v1.mjs",
    "scripts/quickjs-artifact/patches/script-plan-v1.json",
    "scripts/quickjs-artifact/patches/script-plan-v1.patch",
    "scripts/quickjs-artifact/qjs_shim.c",
    "scripts/quickjs-artifact/build.sh",
    "scripts/quickjs-artifact/extract-abi.mjs",
    "scripts/quickjs-artifact/probe/script-plan-canaries.mjs",
  );
  const entries = files.sort().map((path) => ({ path, sha256: sha(readFileSync(join(ROOT, path))) }));
  return {
    sha256: sha(JSON.stringify(entries)),
    files: entries,
    maintainedCompilerInputsHash: computeCompilerInputsHash({
      root: ROOT,
      memoize: false,
      bundlePaths: [join(ROOT, "scripts/compiler-bundle.mjs"), join(ROOT, "scripts/index.js")],
    }),
  };
}
function toolsReceipt() {
  const require = createRequire(import.meta.url),
    packages = {};
  for (const name of ["tsx", "typescript", "binaryen"]) {
    const path = require.resolve(`${name}/package.json`),
      bytes = readFileSync(path);
    packages[name] = { path, version: JSON.parse(bytes).version, sha256: sha(bytes) };
  }
  return { node: process.version, executable: process.execPath, execArgv: process.execArgv, packages };
}
function wasmStartFunctionIndex(binary) {
  assert.deepEqual(Array.from(binary.subarray(0, 8)), [0, 97, 115, 109, 1, 0, 0, 0]);
  let position = 8,
    start = null;
  const uint32 = () => {
    let result = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      assert.ok(position < binary.length, "truncated Wasm section integer");
      const byte = binary[position++];
      if (shift === 28) assert.ok(byte < 16, "invalid Wasm u32");
      result |= (byte & 127) << shift;
      if (!(byte & 128)) return result >>> 0;
    }
    throw new Error("unterminated Wasm u32");
  };
  while (position < binary.length) {
    const id = binary[position++],
      size = uint32(),
      end = position + size;
    assert.ok(end <= binary.length, "truncated Wasm section");
    if (id === 8) {
      assert.equal(start, null, "duplicate Wasm start section");
      start = uint32();
      assert.equal(position, end, "invalid Wasm start section payload");
    }
    position = end;
  }
  return start;
}
function moduleReceipt(binary) {
  const module = new WebAssembly.Module(binary);
  return {
    module,
    sha256: sha(binary),
    bytes: binary.length,
    startFunctionIndex: wasmStartFunctionIndex(binary),
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  };
}
const serialModule = ({ module, ...receipt }) => receipt;
function ownTemporary(path) {
  const absolute = resolve(path);
  assert.ok(absolute.startsWith(join(ROOT, ".tmp") + sep), "canaries require immutable OWN staged inputs/output");
  return absolute;
}
function artifactReceipt(dir, expectedVersion, expectedBinary, expectedAbi, expectedBuildInfo) {
  assert.equal(realpathSync(dir), dir, "staged artifact directory must not resolve back to donor");
  assert.ok(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink());
  for (const name of ["libquickjs.wasm", "qjs-abi.json", "build-info.json"]) {
    const stat = lstatSync(join(dir, name));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "stage real immutable bytes, not donor symlinks");
  }
  const artifact = readQuickjsArtifact(dir, { requiredScriptPlanVersion: expectedVersion });
  assert.ok(artifact);
  assert.equal(artifact.sha256, expectedBinary);
  assert.equal(artifact.abiSha256, expectedAbi);
  const buildInfoSha256 = sha(readFileSync(join(dir, "build-info.json")));
  assert.equal(buildInfoSha256, expectedBuildInfo);
  const capability = assertQuickjsScriptPlanCapability(artifact, expectedVersion);
  assert.equal(capability.version, expectedVersion);
  const module = assertQuickjsArtifactStandalone(artifact.binary);
  assertQuickjsArtifactExports(module);
  return {
    artifact,
    module,
    receipt: {
      dir,
      sha256: artifact.sha256,
      abiSha256: artifact.abiSha256,
      buildInfoSha256,
      buildInfo: artifact.buildInfo,
      capability,
      imports: WebAssembly.Module.imports(module),
      exports: WebAssembly.Module.exports(module),
    },
  };
}

async function main(args) {
  const [oldDirArg, newDirArg, outDirArg] = args;
  if (!oldDirArg || !newDirArg || !outDirArg || args.length !== 3)
    throw new Error(
      "usage: node --import tsx script-plan-canaries.mjs OWN_OLD_ARTIFACT OWN_NEW_ARTIFACT OWN_NEW_RECEIPT_DIR",
    );
  const oldDir = ownTemporary(oldDirArg),
    newDir = ownTemporary(newDirArg),
    outDir = ownTemporary(outDirArg);
  assert.ok(!existsSync(outDir), "refuse to overwrite a prior canary receipt directory");
  assert.ok(!process.env.TEST262_BUNDLE_HASH, "a caller-asserted compiler hash is not matched source evidence");
  assert.ok(
    !existsSync(join(ROOT, "scripts/compiler-bundle.mjs")) && !existsSync(join(ROOT, "scripts/index.js")),
    "this fixture must use own source compiler, not bundle bytes",
  );
  assert.deepEqual(
    DEFINITIONS.flatMap((definition) => definition.expectations.map((row) => row.expected)),
    EXPECTED_READINGS,
  );
  for (const definition of DEFINITIONS) assert.equal(sha(definition.source), definition.sourceSha256);
  const before = productionInputs();
  mkdirSync(outDir);
  const receipt = {
    kind: "script-plan-matched-compatibility",
    status: "FAIL",
    tools: toolsReceipt(),
    productionInputsBefore: before,
    bundleBytesUsed: false,
    denominatorPerArtifact: 11,
    contract: DEFINITIONS.map(({ extra, ...definition }) => ({
      ...definition,
      options: {
        ...QUICKJS_ADAPTER_COMPILE_OPTIONS,
        fileName: definition.fileName,
        externNativeTypes: false,
        externImportModule: "undefined",
        importMemory: "undefined",
        ...extra,
      },
    })),
    adapterCompileOptions: QUICKJS_ADAPTER_COMPILE_OPTIONS,
    capability: {},
    modules: [],
    arms: [],
  };
  let adapter,
    artifacts = [],
    loadError = null;
  const compiledModules = new Map();
  try {
    artifacts = [
      artifactReceipt(
        oldDir,
        0,
        "073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45",
        "0aab187dade1dfc988d5054bc54b4b04f2ad14dae0fb897b4b660b5d8bb028a9",
        "4c50336591f72414a9798a997277641725e4dd484d6c547c6cf8c2c6093b0178",
      ),
      artifactReceipt(
        newDir,
        1,
        "95333826e7c8c8ed7398203891db713dc44368c86a24dae6fe6da7d3004fa36c",
        "4247f2ff4f03420b939692533177ddd485fbcb058a9377ecc33344ce1697f21b",
        "c970d9db70077ade6277b6f6cb44fc110951b7ebc3c240d3abd5845c3db3876e",
      ),
    ];
    receipt.artifacts = artifacts.map((entry) => entry.receipt);
    const source = buildQuickjsAdapterSource(artifacts[0].artifact.abi);
    assert.equal(buildQuickjsAdapterSource(artifacts[1].artifact.abi), source);
    receipt.adapterSourceSha256 = sha(source);
    assert.equal(receipt.adapterSourceSha256, "de224ca0ef34cda4679c1311a741fc042e50bf79e0140515a5ac1365b359b111");
    const loader = await loadProviderCompiler({
      label: "script-plan-isolated-canary",
      capability: async (compile) => {
        try {
          const result = await compile(CAPABILITY_SOURCE, {
            ...QUICKJS_ADAPTER_COMPILE_OPTIONS,
            fileName: "quickjs-capability-probe.ts",
          });
          receipt.capability.source = CAPABILITY_SOURCE;
          receipt.capability.sourceSha256 = sha(CAPABILITY_SOURCE);
          receipt.capability.errors = result.errors ?? [];
          assert.ok(result.success && result.binary, "capability compile failed");
          const proof = moduleReceipt(result.binary);
          receipt.capability.module = serialModule(proof);
          assert.ok(proof.imports.every((entry) => entry.module === QUICKJS_IMPORT_MODULE));
          assert.ok(proof.imports.some((entry) => entry.name === "probe_ext"));
          assert.ok(proof.imports.some((entry) => entry.kind === "memory"));
          writeFileSync(join(outDir, "capability.wasm"), result.binary);
          return null;
        } catch (error) {
          receipt.capability.error = errorText(error);
          return receipt.capability.error;
        }
      },
    });
    receipt.loader = { origin: loader.origin, notes: loader.notes };
    assert.equal(loader.origin, "src/index.ts (tsx)");
    assert.deepEqual(productionInputs(), before, "compiler inputs changed before matched compilation");
    const result = await loader.compile(source, { ...QUICKJS_ADAPTER_COMPILE_OPTIONS });
    receipt.adapterErrors = result.errors ?? [];
    assert.ok(result.success && result.binary, "adapter compile failed");
    adapter = moduleReceipt(result.binary);
    receipt.adapter = serialModule(adapter);
    const allowed = new Set([...QUICKJS_ADAPTER_EXTERNS, "memory"]);
    assert.ok(adapter.imports.every((entry) => entry.module === QUICKJS_IMPORT_MODULE && allowed.has(entry.name)));
    writeFileSync(join(outDir, "matched-adapter.wasm"), result.binary);
    for (const definition of DEFINITIONS) {
      const moduleRow = { id: definition.id, sourceSha256: definition.sourceSha256, status: "FAIL" };
      try {
        const result = await loader.compile(definition.source, {
          ...QUICKJS_ADAPTER_COMPILE_OPTIONS,
          fileName: definition.fileName,
          externNativeTypes: false,
          externImportModule: undefined,
          importMemory: undefined,
          ...definition.extra,
        });
        moduleRow.errors = result.errors ?? [];
        assert.ok(result.success && result.binary, "user canary compile failed");
        const compiled = moduleReceipt(result.binary);
        Object.assign(moduleRow, serialModule(compiled));
        assert.ok(
          compiled.imports.some((entry) => entry.module === IMPORT_MODULE),
          "canary does not link provider: vacuous evidence",
        );
        compiledModules.set(definition.id, compiled);
        moduleRow.status = "PASS";
        writeFileSync(join(outDir, `${definition.id}.wasm`), result.binary);
      } catch (error) {
        moduleRow.error = errorText(error);
      }
      receipt.modules.push(moduleRow);
    }
  } catch (error) {
    loadError = errorText(error);
    receipt.setupError = loadError;
  }
  for (let index = 0; index < 2; index++) {
    const arm = { id: index === 0 ? "old-version0" : "new-version1", rows: [], realms: [] };
    for (const definition of DEFINITIONS) {
      const realm = { id: definition.id, startCalled: false, status: "FAIL" };
      let instance = null,
        realmError = loadError;
      try {
        assert.ok(!loadError, loadError ?? "setup failed");
        const compiled = compiledModules.get(definition.id);
        assert.ok(compiled, "user canary compile failed");
        const userModule = compiled.module;
        const namespace = instantiateRuntimeEvalNamespace({
          engine: "quickjs",
          adapterModule: adapter.module,
          quickjsModule: artifacts[index].module,
        });
        realm.providerEntries = Object.fromEntries(PROVIDER_ENTRIES.map((name) => [name, typeof namespace[name]]));
        assert.ok(PROVIDER_ENTRIES.every((name) => typeof namespace[name] === "function"));
        instance = new WebAssembly.Instance(userModule, { [IMPORT_MODULE]: namespace });
        realm.actualExports = WebAssembly.Module.exports(userModule);
        realm.startFunctionIndex = compiled.startFunctionIndex;
        const nativeStart = compiled.startFunctionIndex !== null,
          exportedStart = typeof instance.exports._start === "function";
        assert.notEqual(nativeStart, exportedStart, "user canary must have exactly one initialization mechanism");
        realm.initializationMechanism = nativeStart ? "wasm-start-section" : "exported-_start";
        // Successful instantiation already ran native start exactly once. Calling
        // an exported _start too would double initialize this fresh realm.
        realm.nativeStartCompleted = nativeStart;
        if (!nativeStart) {
          instance.exports._start();
          realm.startCalled = true;
        }
        realm.status = "PASS";
      } catch (error) {
        realmError = errorText(error);
        realm.error = realmError;
      }
      for (const expected of definition.expectations) {
        const row = { module: definition.id, ...expected, status: "FAIL" };
        try {
          assert.ok(!realmError, realmError ?? "realm failed");
          assert.equal(typeof instance.exports[expected.probe], "function");
          row.actual = instance.exports[expected.probe]();
          assert.equal(row.actual, expected.expected);
          row.status = "PASS";
        } catch (error) {
          row.error = errorText(error);
        }
        arm.rows.push(row);
      }
      arm.realms.push(realm);
    }
    assert.equal(arm.rows.length, 11);
    receipt.arms.push(arm);
  }
  receipt.productionInputsAfter = productionInputs();
  receipt.inputsUnchanged = JSON.stringify(receipt.productionInputsAfter) === JSON.stringify(before);
  receipt.noPassLoss = receipt.arms[0].rows.every(
    (row, index) => row.status !== "PASS" || receipt.arms[1].rows[index].status === "PASS",
  );
  const allPass = receipt.arms.every((arm) => arm.rows.every((row) => row.status === "PASS"));
  receipt.status = allPass && receipt.inputsUnchanged && receipt.noPassLoss ? "PASS" : "FAIL";
  writeFileSync(join(outDir, "results.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      receipt: join(outDir, "results.json"),
      status: receipt.status,
      inputsUnchanged: receipt.inputsUnchanged,
      noPassLoss: receipt.noPassLoss,
      arms: receipt.arms.map((arm) => ({
        id: arm.id,
        passed: arm.rows.filter((row) => row.status === "PASS").length,
        registered: arm.rows.length,
      })),
    }),
  );
  if (receipt.status !== "PASS") process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
