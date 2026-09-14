// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// A runnable paired instrument as well as a focused suite. Historical arms are
// explicit roots; ordinary tests measure current source, not historical parity.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { CompileResult, CompileOptions } from "../src/index.js";

const ownRoot = resolve(import.meta.dirname, "..");
const instrument = fileURLToPath(import.meta.url);
const BASE = "e3de0f3ff7d7828c66b3fea7946f08e593bf77d8";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const parse = (source: string) => ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
const controls = {
  JS2WASM_IR_GVN: "0",
  JS2WASM_IR_OWNERSHIP: "0",
  JS2WASM_IR_ESCAPE: "0",
  IR_VERIFY_ALLOC: "0",
  JS2WASM_IR_VERIFY_DOMINANCE_NAIVE: "0",
  JS2WASM_IR_INLINE: "0",
};
function envFor(root: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key))
      Reflect.deleteProperty(env, key);
  return {
    ...env,
    ...controls,
    NODE_OPTIONS: "--max-old-space-size=2048",
    TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
    TSX_DISABLE_CACHE: "1",
  };
}
function launch() {
  return {
    argv: process.execArgv,
    env: Object.fromEntries(
      Object.entries(process.env)
        .filter(([key]) => /^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key))
        .sort(),
    ),
  };
}
function tree(root: string, directory: string): [string, string][] {
  const result: [string, string][] = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...tree(root, path));
    else if (entry.isFile()) result.push([path, sha(readFileSync(join(root, path)))]);
  }
  return result;
}
function snapshot(root: string) {
  const files = tree(root, "src");
  return {
    root,
    head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", "src"], {
      encoding: "utf8",
    }),
    files,
    sha256: sha(JSON.stringify(files)),
  };
}
function runtime(root: string) {
  const req = createRequire(join(root, "package.json"));
  const tsx = dirname(req.resolve("tsx/package.json"));
  const esbuild = dirname(req.resolve("esbuild/package.json"));
  const binaryPackage = dirname(
    createRequire(join(esbuild, "package.json")).resolve(`@esbuild/${process.platform}-${process.arch}/package.json`),
  );
  return {
    node: process.version,
    versions: process.versions,
    exec: realpathSync(process.execPath),
    execSha256: sha(readFileSync(process.execPath)),
    tsx: tree(tsx, "dist"),
    tsxPackage: sha(readFileSync(join(tsx, "package.json"))),
    esbuild: tree(esbuild, "lib"),
    esbuildPackage: sha(readFileSync(join(esbuild, "package.json"))),
    binary: tree(binaryPackage, "bin"),
    typescript: sha(readFileSync(req.resolve("typescript"))),
    config: sha(read(root, "tsconfig.json")),
    instrument: sha(readFileSync(instrument)),
  };
}
function data(value: unknown): unknown {
  const seen = new Map<object, number>();
  function visit(v: any): any {
    if (v === undefined) return { $undefined: true };
    if (typeof v === "number" && !Number.isFinite(v)) return { $number: String(v) };
    if (typeof v === "bigint") return { $bigint: String(v) };
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return { $ref: seen.get(v) };
    seen.set(v, seen.size);
    if (v instanceof Error)
      return Object.fromEntries(
        [...new Set(["name", "message", "stack", "cause", ...Object.getOwnPropertyNames(v)])].map((k) => [
          k,
          visit((v as Error & Record<string, unknown>)[k]),
        ]),
      );
    if (Array.isArray(v)) return v.map(visit);
    if (v instanceof Map) return { $map: [...v].map(([k, w]) => [visit(k), visit(w)]) };
    if (v instanceof Set) return { $set: [...v].map(visit) };
    return Object.fromEntries(Object.keys(v).map((k) => [k, visit(v[k])]));
  }
  return visit(value);
}
function templates(root: string, path: string, callee: string): string[] {
  const sf = parse(read(root, path)),
    found: string[] = [];
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === callee) {
      const first = node.arguments[0];
      if (first && ts.isNoSubstitutionTemplateLiteral(first)) found.push(first.text);
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return found;
}
function declaration(root: string, path: string, name: string) {
  const sf = parse(read(root, path));
  const matches = sf.statements.filter(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  assert.equal(matches.length, 1, "exact existing harness " + name);
  return matches[0]!.getText(sf);
}
interface Fixture {
  id: string;
  lane: "standalone" | "wasi";
  source: string;
  sourcePath: string;
  kind: "delay" | "family" | "hooks" | "adoption" | "tracking";
  expected?: number;
  harness?: string;
}
function fixtures(root: string): Fixture[] {
  const delayPath = "tests/issue-4573-standalone-native-promise-delay.test.ts";
  const delayDecl = parse(read(root, delayPath))
    .statements.filter(ts.isVariableStatement)
    .flatMap((n) => [...n.declarationList.declarations])
    .find((n) => n.name.getText() === "EXACT_DELAY");
  assert(delayDecl?.initializer && ts.isNoSubstitutionTemplateLiteral(delayDecl.initializer));
  const hooksPath = "tests/deno-promise-hooks-standalone.test.ts",
    hooks = templates(root, hooksPath, "instantiate");
  assert.equal(hooks.length, 2);
  const adoptionPath = "tests/issue-2867.test.ts",
    adoption = templates(root, adoptionPath, "runWasi");
  assert.equal(adoption.length, 5);
  const trackingPath = "tests/issue-2958.test.ts",
    tracking = templates(root, trackingPath, "runWasi");
  assert(tracking.length >= 2);
  assert.equal(tracking[0], 'Promise.reject(new Error("x"));');
  assert.equal(tracking[1], 'Promise.reject(new Error("x")).catch(() => {});');
  return [
    { id: "delay", lane: "standalone", source: delayDecl.initializer.text, sourcePath: delayPath, kind: "delay" },
    {
      id: "native-family",
      lane: "standalone",
      source: read(root, "website/playground/examples/js/async.ts")
        .replace("async function fetchUser", "export async function fetchUser")
        .replace("async function fetchAllSequential", "export async function fetchAllSequential")
        .replace("async function fetchAllParallel", "export async function fetchAllParallel"),
      sourcePath: "website/playground/examples/js/async.ts",
      kind: "family",
    },
    ...hooks.map(
      (source, index): Fixture => ({
        id: index === 0 ? "hooks-present" : "hooks-absent",
        lane: "standalone",
        source,
        sourcePath: hooksPath,
        kind: "hooks",
      }),
    ),
    ...[0, 2].map(
      (index): Fixture => ({
        id: index === 0 ? "adoption-fulfilled" : "adoption-pending",
        lane: "wasi",
        source: adoption[index]!,
        sourcePath: adoptionPath,
        kind: "adoption",
        expected: 11,
        harness: declaration(root, adoptionPath, "runWasi"),
      }),
    ),
    ...[0, 1].map(
      (index): Fixture => ({
        id: index === 0 ? "tracking-unhandled" : "tracking-handled",
        lane: "wasi",
        source: tracking[index]!,
        sourcePath: trackingPath,
        kind: "tracking",
        expected: index === 0 ? 1 : 0,
        harness: declaration(root, trackingPath, "runWasi"),
      }),
    ),
  ];
}
// Independent admission recipe, not inferred from observed compilations. The
// legacy runWasi bodies above remain untouched; adoption must compile their
// original source wrapper, not the unwrapped Promise expression fixture.
function expectedCompilations(fixture: Fixture): { source: string; options: CompileOptions }[] {
  if (fixture.kind === "adoption") {
    const recipe = {
      source:
        "\nlet result = 0;\nexport function run(): void { " +
        fixture.source +
        " }\nexport function getResult(): number { return result; }\n",
      options: { fileName: "t.ts", target: "wasi" as const, emitWat: true },
    };
    return [recipe, recipe];
  }
  if (fixture.kind === "tracking") {
    const recipe = {
      source: fixture.source,
      options: {
        fileName: "settlement-" + fixture.id + ".ts",
        target: "wasi" as const,
        skipSemanticDiagnostics: true,
        emitWat: true,
      },
    };
    return [recipe, recipe];
  }
  return [
    {
      source: fixture.source,
      options: {
        fileName: "settlement-" + fixture.id + ".ts",
        target: "standalone",
        experimentalIR: fixture.kind !== "hooks",
        skipSemanticDiagnostics: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        ...(fixture.kind === "family" ? { hostBridge: "always" as const } : {}),
        ...(fixture.kind === "hooks" ? { deferTopLevelInit: true } : {}),
        emitWat: true,
      },
    },
  ];
}
async function settle<T>(promise: Promise<T>, phase: string): Promise<T> {
  let rejectIdle!: (error: Error) => void;
  const idle = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  const onIdle = () => {
    const error = Object.assign(new Error("unsettled recorder await: " + phase), {
      code: "ERR_RECORDER_UNSETTLED_AWAIT",
      phase,
    });
    rejectIdle(error);
  };
  process.once("beforeExit", onIdle);
  try {
    return await Promise.race([promise, idle]);
  } finally {
    process.removeListener("beforeExit", onIdle);
  }
}
function artifact(result: CompileResult) {
  const bytes = result.binary;
  const module = new WebAssembly.Module(bytes);
  return {
    binary: Buffer.from(bytes).toString("base64"),
    wat: result.wat,
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
    resourceOrder: result.wat
      .split("\n")
      .filter((line) => /^ {2}\((?:type|import|global|func|export|elem|data)\b/.test(line)),
    units: data({
      compiled: result.irCompiledFuncs,
      outcomes: result.irOutcomes,
      postClaimErrors: result.irPostClaimErrors,
    }),
    stringPool: data(result.stringPool),
  };
}
type Api = { compile: typeof import("../src/index.js").compile; runtime: typeof import("../src/runtime.js") };
async function standaloneRun(
  result: CompileResult,
  fixture: Fixture,
  api: Api,
  action: string,
  executions: any[],
  setPhase: (phase: string) => void,
) {
  const bytes = result.binary,
    events: unknown[] = [],
    jobs: (() => void)[] = [];
  const values: unknown[] = [];
  const execution = {
    action,
    instantiationInputBinary: Buffer.from(bytes).toString("base64"),
    instantiatedBinary: null as string | null,
    values,
    events,
  };
  executions.push(execution);
  setPhase("imports");
  let registrations = 0;
  const imports = api.runtime.buildCompiledImports(result, {
    setTimeout: ((callback: Function, delay: number, ...args: unknown[]) => {
      const ordinal = registrations++;
      events.push(["start", ordinal, delay]);
      if (action === "rejection" && ordinal === 1) {
        events.push(["registration-reject", ordinal]);
        throw new Error("injected timer registration failure at 1");
      }
      let firings = 0;
      jobs.push(() => {
        events.push([firings++ === 0 ? "fire" : "repeat", ordinal]);
        callback(...args);
      });
      if (action === "non-i31" && registrations === 1) jobs[0]!();
      return ordinal + 1;
    }) as typeof setTimeout,
  });
  setPhase("instantiate");
  const { instance } = await settle(WebAssembly.instantiate(bytes, imports), "instantiate:" + fixture.id);
  execution.instantiatedBinary = Buffer.from(bytes).toString("base64");
  setPhase("execute");
  imports.setInstance?.(instance);
  const ex = instance.exports as Record<string, Function>;
  if (fixture.kind === "hooks") {
    assert.equal(WebAssembly.Module.imports(new WebAssembly.Module(bytes)).length, 0);
    if (ex.__module_init) ex.__module_init();
    values.push(ex.startThen!());
    ex.__drain_microtasks!();
    values.push(ex.lifecycle!(), ex.startExecutor!());
    assert.deepEqual(values, fixture.id === "hooks-present" ? [142, 1422943, 184] : [0, 42, 1]);
  } else {
    assert.deepEqual(
      WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map((n) => n.module + "." + n.name),
      ["env.__timer_set_timeout"],
    );
    assert.equal(typeof ex.__promise_boundary_state, "function");
    assert.equal(typeof ex.__promise_boundary_value, "function");
    if (action === "non-i31") {
      assert.equal(ex.__promise_boundary_observe, undefined);
      const wrapped = api.runtime.wrapCompiledExports(result, instance) as Record<string, Function>;
      const value = await settle(Promise.resolve(wrapped.fetchUser!(300_000_000)), "settled-non-i31");
      assert.equal(value, 3_000_000_000);
      assert.equal(jobs.length, 1);
      values.push(value);
    } else {
      let promise: unknown;
      if (fixture.kind === "delay") promise = ex.delay!(7, 73);
      else if (action === "undefined") promise = ex.main!();
      else if (action === "rejection") {
        const vec = ex.__new_vec_f64!(3);
        [3, 1, 2].forEach((value, index) => ex.__vec_set_byte!(vec, index, value));
        promise = ex.fetchAllSequential!(vec);
      } else promise = ex.fetchUser!(7);
      values.push(ex.__promise_boundary_state!(promise), ex.__promise_boundary_value!(promise));
      assert.deepEqual(values, [0, null]);
      assert.equal(jobs.length, 1);
      if (action === "undefined") {
        for (let i = 0; i < 5; i++) {
          assert(jobs[i]);
          jobs[i]!();
        }
        assert.equal(jobs.length, 10);
        for (let i = 9; i >= 5; i--) jobs[i]!();
        const value = ex.__promise_boundary_value!(promise);
        values.push(ex.__promise_boundary_state!(promise), ex.__dynamic_boundary_tag!(value));
        assert.deepEqual(values, [0, null, 1, 2]);
      } else {
        jobs[0]!();
        values.push(ex.__promise_boundary_state!(promise), ex.__promise_boundary_value!(promise));
        assert.deepEqual(
          values,
          action === "rejection" ? [0, null, 2, null] : [0, null, 1, fixture.kind === "delay" ? 73 : 70],
        );
        jobs[0]!();
        values.push(ex.__promise_boundary_state!(promise), ex.__promise_boundary_value!(promise));
        assert.deepEqual(values.slice(2, 4), values.slice(4));
      }
    }
  }
}
async function measure(fixture: Fixture, api: Api) {
  let phase = "compile";
  const receipt: any = { id: fixture.id, fixture, compilations: [], executions: [] };
  const compile = async (source: string, options: CompileOptions) => {
    phase = "compile";
    // These are the two existing WasmGC targets; CompileOptions has no
    // separate backend property. Do not record an ignored synthetic control.
    assert(options.target === "standalone" || options.target === "wasi");
    const resolved = { ...options, emitWat: true };
    const result = await settle(api.compile(source, resolved), "compile:" + fixture.id);
    const record: any = {
      source,
      options: resolved,
      success: result.success,
      errors: data(result.errors),
      artifact: { binary: Buffer.from(result.binary).toString("base64"), wat: result.wat },
    };
    receipt.compilations.push(record);
    phase = "artifact-validation";
    if (result.success) record.artifact = artifact(result);
    return result;
  };
  try {
    if (fixture.harness) {
      // Reuse the EXACT existing harness body, including its WASI shim. Only
      // compile and instantiate are wrapped to retain the actual artifacts.
      const expect = (value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected) });
      const wasm = {
        ...WebAssembly,
        instantiate: async (bytes: Uint8Array, imports: WebAssembly.Imports) => {
          phase = "instantiate";
          const actual = Buffer.from(bytes).toString("base64");
          assert.equal(actual, receipt.compilations.at(-1).artifact.binary);
          const execution = { instantiationInputBinary: actual, instantiatedBinary: null as string | null };
          receipt.executions.push(execution);
          const result = await settle(WebAssembly.instantiate(bytes, imports), "legacy-instantiate:" + fixture.id);
          execution.instantiatedBinary = actual;
          phase = "execute";
          return result;
        },
        validate: WebAssembly.validate,
      };
      const js = ts.transpileModule(fixture.harness, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
      }).outputText;
      const run = new Function("compile", "expect", "WebAssembly", js + "\nreturn runWasi;")(compile, expect, wasm);
      for (let count = 0; count < 2; count++) {
        const value = await settle(run(fixture.source, "settlement-" + fixture.id), "legacy-run:" + fixture.id);
        receipt.executions.at(-1).value = data(value);
        if (fixture.kind === "adoption") assert.equal(value, 11);
        else {
          assert.equal(value.exitCode, fixture.expected);
          assert.equal(value.reportLines, fixture.expected);
        }
      }
    } else {
      const result = await compile(fixture.source, {
        fileName: "settlement-" + fixture.id + ".ts",
        target: "standalone",
        experimentalIR: fixture.kind !== "hooks",
        skipSemanticDiagnostics: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        ...(fixture.kind === "family" ? { hostBridge: "always" as const } : {}),
        ...(fixture.kind === "hooks" ? { deferTopLevelInit: true } : {}),
      });
      if (!result.success) return { ...receipt, kind: "refused", phase: "compile" };
      phase = "execute";
      const actions = fixture.kind === "family" ? ["suspension", "non-i31", "rejection", "undefined"] : [fixture.kind];
      for (let count = 0; count < 2; count++)
        for (const action of actions)
          await standaloneRun(result, fixture, api, action, receipt.executions, (next) => {
            phase = next;
          });
    }
    return { ...receipt, kind: "executed" };
  } catch (error) {
    return { ...receipt, kind: "threw", phase, error: data(error) };
  }
}
async function arm(root: string, output: string) {
  root = realpathSync(root);
  assert.equal(process.env.TSX_TSCONFIG_PATH, join(root, "tsconfig.json"));
  assert.equal(process.env.TSX_DISABLE_CACHE, "1");
  assert.equal(process.env.ESBUILD_BINARY_PATH, undefined);
  for (const [key, value] of Object.entries(controls)) assert.equal(process.env[key], value);
  const before = snapshot(root),
    identity = runtime(root),
    matrix = fixtures(root),
    urls = {
      compile: pathToFileURL(join(root, "src/index.ts")).href,
      runtime: pathToFileURL(join(root, "src/runtime.ts")).href,
    };
  const { compile } = await settle(import(urls.compile), "import-public");
  const runtimeApi = await settle(import(urls.runtime), "import-runtime");
  const rows = [];
  for (const fixture of matrix) {
    appendFileSync(output + ".progress.jsonl", JSON.stringify({ kind: "start", id: fixture.id }) + "\n");
    const row = await measure(fixture, { compile, runtime: runtimeApi });
    rows.push(row);
    appendFileSync(output + ".progress.jsonl", JSON.stringify({ kind: "completed", row }) + "\n");
  }
  const after = snapshot(root);
  assert.deepEqual(after, before);
  assert.deepEqual(runtime(root), identity);
  const report = {
    schema: "promise-settlement-source-v1",
    provenance: { before, after, identity, urls, launch: launch(), matrixSha256: sha(JSON.stringify(matrix)) },
    rows,
  };
  writeFileSync(output, JSON.stringify(report, null, 2));
  return report;
}
async function child(root: string, directory: string, label: string) {
  root = realpathSync(root);
  const output = join(directory, label + ".json"),
    env = envFor(root),
    args = ["--import", "tsx", instrument, "--settlement-arm", root, output];
  const expected = {
    snapshot: snapshot(root),
    identity: runtime(root),
    matrix: fixtures(root),
    launch: {
      argv: ["--import", "tsx"],
      env: Object.fromEntries(
        Object.entries(env)
          .filter(([key]) =>
            /^(JS2WASM_|IR_VERIFY_|TSX_|ESBUILD_BINARY_PATH$|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key),
          )
          .sort(),
      ),
    },
  };
  writeFileSync(join(directory, label + ".expected.json"), JSON.stringify(expected, null, 2));
  const terminal = await new Promise<any>((done) => {
    const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      error: unknown = null;
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", (e) => {
      error = data(e);
    });
    proc.on("close", (code, signal) =>
      done({ root, output, args, code, signal, error, stdout, stderr, pid: proc.pid }),
    );
  });
  writeFileSync(join(directory, label + ".terminal.json"), JSON.stringify(terminal, null, 2));
  assert.equal(terminal.code, 0, terminal.stderr);
  assert.equal(terminal.signal, null);
  assert.equal(terminal.error, null);
  const report = JSON.parse(readFileSync(output, "utf8"));
  terminal.reportSha256 = sha(JSON.stringify(report));
  writeFileSync(join(directory, label + ".terminal.json"), JSON.stringify(terminal, null, 2));
  validate(report, expected, terminal);
  return { report, expected, terminal };
}
function validate(report: any, expected: any, terminal: any) {
  assert.equal(terminal.code, 0);
  assert.equal(terminal.signal, null);
  assert.equal(terminal.error, null);
  assert.equal(terminal.root, expected.snapshot.root);
  assert.equal(terminal.reportSha256, sha(JSON.stringify(report)));
  const p = report.provenance;
  assert.equal(report.schema, "promise-settlement-source-v1");
  assert.deepEqual(p.before, expected.snapshot);
  assert.deepEqual(p.after, expected.snapshot);
  assert.deepEqual(p.identity, expected.identity);
  assert.deepEqual(p.launch, expected.launch);
  assert.deepEqual(p.urls, {
    compile: pathToFileURL(join(expected.snapshot.root, "src/index.ts")).href,
    runtime: pathToFileURL(join(expected.snapshot.root, "src/runtime.ts")).href,
  });
  assert.equal(p.matrixSha256, sha(JSON.stringify(expected.matrix)));
  assert.equal(report.rows.length, 8);
  assert.deepEqual(
    report.rows.map((row: any) => row.fixture),
    expected.matrix,
  );
  for (const [rowIndex, row] of report.rows.entries()) {
    const fixture = expected.matrix[rowIndex] as Fixture;
    assert.equal(row.id, fixture.id, "row identity must match independently selected fixture");
    assert(["executed", "threw", "refused"].includes(row.kind));
    const recipes = expectedCompilations(fixture);
    assert(Array.isArray(row.compilations));
    assert(row.compilations.length <= recipes.length, "extra compile attempts are not the expected recipe");
    for (const [index, compilation] of row.compilations.entries()) {
      assert.deepEqual(
        { source: compilation.source, options: compilation.options },
        recipes[index],
        "independent source/options recipe: " + fixture.id + " compile " + index,
      );
    }
    if (row.kind !== "executed") continue;
    assert.equal(row.compilations.length, recipes.length, "exact compilation count: " + fixture.id);
    for (const c of row.compilations) {
      assert(c.success);
      const bytes = Buffer.from(c.artifact.binary, "base64");
      assert(bytes.length > 8);
      assert.equal(bytes.toString("base64"), c.artifact.binary);
      assert.deepEqual([...bytes.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]);
      assert(c.artifact.wat.length > 0);
      assert(c.artifact.resourceOrder.length > 0);
      assert(c.artifact.exports.length > 0);
    }
    const count = row.fixture.kind === "family" ? 8 : 2;
    assert.equal(row.executions.length, count);
    for (const [index, ex] of row.executions.entries()) {
      assert.equal(ex.instantiationInputBinary, ex.instantiatedBinary);
      assert.equal(ex.instantiatedBinary, row.compilations[0].artifact.binary);
      validateExecution(row.fixture, ex, index);
    }
    for (const c of row.compilations) assert.deepEqual(c, row.compilations[0]);
    assert.deepEqual(row.executions.slice(0, count / 2), row.executions.slice(count / 2));
  }
}
function validateExecution(fixture: Fixture, ex: any, index: number) {
  if (fixture.kind === "adoption") {
    assert.equal(ex.value, 11);
    return;
  }
  if (fixture.kind === "tracking") {
    assert.deepEqual(ex.value, {
      exitCode: fixture.expected,
      stdout: "",
      stderr: fixture.expected === 1 ? "Unhandled promise rejection\n" : "",
      reportLines: fixture.expected,
    });
    return;
  }
  if (fixture.kind === "hooks") {
    assert.equal(ex.action, "hooks");
    assert.deepEqual(ex.values, fixture.id === "hooks-present" ? [142, 1422943, 184] : [0, 42, 1]);
    assert.deepEqual(ex.events, []);
    return;
  }
  if (fixture.kind === "delay") {
    assert.equal(ex.action, "delay");
    assert.deepEqual(ex.values, [0, null, 1, 73, 1, 73]);
    assert.deepEqual(ex.events, [
      ["start", 0, 7],
      ["fire", 0],
      ["repeat", 0],
    ]);
    return;
  }
  const actions = ["suspension", "non-i31", "rejection", "undefined"];
  assert.equal(ex.action, actions[index % 4]);
  if (ex.action === "suspension") {
    assert.deepEqual(ex.values, [0, null, 1, 70, 1, 70]);
    assert.deepEqual(ex.events, [
      ["start", 0, 30],
      ["fire", 0],
      ["repeat", 0],
    ]);
  } else if (ex.action === "non-i31") {
    assert.deepEqual(ex.values, [3_000_000_000]);
    assert.deepEqual(ex.events, [
      ["start", 0, 30],
      ["fire", 0],
    ]);
  } else if (ex.action === "rejection") {
    assert.deepEqual(ex.values, [0, null, 2, null, 2, null]);
    assert.deepEqual(ex.events, [
      ["start", 0, 30],
      ["fire", 0],
      ["start", 1, 30],
      ["registration-reject", 1],
      ["repeat", 0],
    ]);
  } else {
    assert.deepEqual(ex.values, [0, null, 1, 2]);
    const events: unknown[] = [];
    for (let ordinal = 0; ordinal < 5; ordinal++) events.push(["start", ordinal, 30], ["fire", ordinal]);
    for (let ordinal = 5; ordinal < 10; ordinal++) events.push(["start", ordinal, 30]);
    for (let ordinal = 9; ordinal >= 5; ordinal--) events.push(["fire", ordinal]);
    assert.deepEqual(ex.events, events);
  }
}
function compare(before: any, after: any) {
  validate(before.report, before.expected, before.terminal);
  validate(after.report, after.expected, after.terminal);
  assert.notEqual(before.expected.snapshot.root, after.expected.snapshot.root);
  assert.equal(before.expected.snapshot.head, BASE);
  assert.equal(before.expected.snapshot.dirty, "");
  assert.deepEqual(before.expected.identity, after.expected.identity);
  assert.deepEqual(before.expected.matrix, after.expected.matrix);
  const differences = before.report.rows.flatMap((row: any, index: number) =>
    JSON.stringify(row) === JSON.stringify(after.report.rows[index])
      ? []
      : [{ id: row.id, before: row, after: after.report.rows[index] }],
  );
  return {
    pairs: 8,
    preservationOK: differences.length === 0,
    acceptanceOK: differences.length === 0 && after.report.rows.every((row: any) => row.kind === "executed"),
    differences,
    pending: after.report.rows.filter((row: any) => row.kind !== "executed"),
  };
}
const mode = process.argv[2];
if (mode === "--settlement-arm") {
  assert.equal(process.argv.length, 5);
  const root = process.argv[3]!,
    output = process.argv[4]!;
  assert.equal(output, resolve(output));
  await arm(root, output);
} else if (mode === "--settlement-pair") {
  assert.equal(process.argv.length, 6);
  const before = realpathSync(process.argv[3]!),
    after = realpathSync(process.argv[4]!),
    directory = resolve(process.argv[5]!);
  const rel = relative(before, directory);
  assert(rel === ".." || rel.startsWith("../"), "no baseline writes");
  mkdirSync(directory, { recursive: true });
  const a = await child(before, directory, "baseline"),
    b = await child(after, directory, "candidate"),
    result = compare(a, b);
  writeFileSync(join(directory, "comparison.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({ pairs: result.pairs, preservationOK: result.preservationOK, acceptanceOK: result.acceptanceOK }),
  );
  process.exitCode = result.preservationOK ? 0 : 1;
} else {
  const { describe, it, expect } = await import("vitest");
  let measurement: ReturnType<typeof child> | undefined;
  function current() {
    mkdirSync(join(ownRoot, ".tmp"), { recursive: true });
    return (measurement ??= child(ownRoot, mkdtempSync(join(ownRoot, ".tmp/promise-settlement-")), "current"));
  }
  describe("source-produced Promise settlement preservation (current execution; historical pair is explicit CLI)", () => {
    it("pins eight source fixtures with standalone and legacy WASI lanes distinct", () => {
      const matrix = fixtures(ownRoot);
      expect(matrix).toHaveLength(8);
      expect(matrix.filter((f) => f.lane === "standalone")).toHaveLength(4);
      expect(matrix.filter((f) => f.lane === "wasi")).toHaveLength(4);
    });
    it.each(fixtures(ownRoot).map((f) => f.id))(
      "executes %s twice using exactly the recorded instantiated bytes",
      async (id) => {
        const result = await current();
        const row = result.report.rows.find((r: any) => r.id === id);
        expect(row, row ? JSON.stringify(row) : "missing row").toMatchObject({ kind: "executed" });
      },
      180000,
    );
    it("rejects missing rows and dirty source provenance even with recomputed terminal hashes", async () => {
      const result = await current();
      for (const edit of [
        (r: any) => r.rows.pop(),
        (r: any) => {
          r.provenance.before.sha256 = "changed";
        },
      ]) {
        const corrupt = structuredClone(result);
        edit(corrupt.report);
        corrupt.terminal.reportSha256 = sha(JSON.stringify(corrupt.report));
        expect(() => validate(corrupt.report, corrupt.expected, corrupt.terminal)).toThrow();
      }
    });
    it("rejects identical wrong values, substituted actions and bytes in both execution runs", async () => {
      const result = await current();
      for (const edit of [
        (row: any) => {
          for (const ex of row.executions) ex.values = [0, null, 1, 74, 1, 74];
        },
        (row: any) => {
          for (const ex of row.executions) ex.action = "unrelated";
        },
        (row: any) => {
          for (const ex of row.executions) ex.instantiatedBinary += "AAAA";
        },
      ]) {
        const corrupt = structuredClone(result);
        const row = corrupt.report.rows.find((entry: any) => entry.id === "delay");
        assert.equal(row.kind, "executed");
        edit(row);
        corrupt.terminal.reportSha256 = sha(JSON.stringify(corrupt.report));
        expect(() => validate(corrupt.report, corrupt.expected, corrupt.terminal)).toThrow();
      }
    });
    it.each([
      "standalone-source",
      "standalone-options",
      "extra-standalone-compile",
      "adoption-wrapper",
      "legacy-options",
      "missing-legacy-compile",
      "row-identity",
      "extra-option",
    ])("rejects recomputed receipt with changed independent recipe: %s", async (mutation) => {
      const result = await current();
      const corrupt = structuredClone(result);
      const legacy = ["adoption-wrapper", "legacy-options", "missing-legacy-compile"].includes(mutation);
      const row = corrupt.report.rows.find((entry: any) => entry.id === (legacy ? "adoption-fulfilled" : "delay"));
      assert.equal(row.kind, "executed");
      if (mutation === "standalone-source") for (const c of row.compilations) c.source += "\n// unrelated source";
      if (mutation === "standalone-options") for (const c of row.compilations) c.options.experimentalIR = false;
      if (mutation === "extra-standalone-compile") row.compilations.push(structuredClone(row.compilations[0]));
      if (mutation === "adoption-wrapper") for (const c of row.compilations) c.source = row.fixture.source;
      if (mutation === "legacy-options") for (const c of row.compilations) c.options.target = "standalone";
      if (mutation === "missing-legacy-compile") row.compilations.pop();
      if (mutation === "row-identity") row.id = "unrelated-row";
      if (mutation === "extra-option") for (const c of row.compilations) c.options.backend = "linear";
      corrupt.terminal.reportSha256 = sha(JSON.stringify(corrupt.report));
      expect(() => validate(corrupt.report, corrupt.expected, corrupt.terminal)).toThrow();
    });
  });
}
