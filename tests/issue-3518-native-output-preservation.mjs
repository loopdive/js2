// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Additive current-base comparison; never edits or refreshes historical evidence.
// node THIS --baseline ABS --candidate ABS --pins ABS --output ABS
// External reviewed pins: {schema:"native-output-preservation-pins-v1",
// runnerSha256, helperSha256, arms:{baseline:{head,sourceCensusSha256,runtimeContentSha256},
// candidate:{head,sourceCensusSha256,runtimeContentSha256}}}.
// Source census = SHA256(JSON.stringify(sorted [path,SHA256(bytes)] rows from
// git ls-files --cached --others --exclude-standard for src,tests/helpers,
// tsconfig.json,package.json,pnpm-lock.yaml)); physical census must match.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  scannerChildEnvironment,
  scannerRuntimeIdentity,
} from "../scripts/verify-native-scanner-source-preservation.mjs";
const BASE = "eca2873afc539e2cc7fc9a0a39365b35750cfbc5";
const script = fileURLToPath(import.meta.url);
const helper = fileURLToPath(new URL("../scripts/verify-native-scanner-source-preservation.mjs", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = JSON.stringify;
const numeric = {
  "./math.ts": "export function double(x: number): number { return x * 2; }",
  "./entry.ts": 'import { double } from "./math"; export function run(): number { return double(20) + 2; }',
};
const startup = {
  "./base.ts": "export var digit: number = 1; digit = digit * 10 + 3;",
  "./entry.ts":
    'import { digit } from "./base"; var answer: number = digit * 10 + 2; export function run(): number { return answer; } export { run as again };',
};
const rows = [
  { id: "numeric", files: numeric, expected: 42 },
  {
    id: "alias",
    files: { "./entry.ts": "export function run(): number { return 42; } export { run as again };" },
    expected: 42,
    alias: true,
    utf8: true,
  },
  ...[
    { id: "startup-immediate", deferred: false },
    { id: "startup-deferred", deferred: true, utf8: true },
    { id: "startup-deferred-reversed", deferred: true, utf8: true, reverse: true },
  ].map((row) => ({ ...row, files: startup, expected: 132, startup: true, alias: true })),
  ...[" 42 ", "-0", "\ud800"].flatMap((text, index) =>
    [false, true].map((utf8) => ({
      id: `native-parse-${index}-${utf8}`,
      utf8,
      native: true,
      expected: Number(text),
      files: {
        "./entry.ts": `function parse(s: string): number { return +s; } export function run(): number { return parse(${json(text)}); }`,
      },
    })),
  ),
  ...[false, true].map((integerBeforeScratch) => ({
    id: `unused-formatter-${integerBeforeScratch}`,
    files: numeric,
    expected: 42,
    numberFormat: { integerBeforeScratch },
  })),
];
assert.equal(rows.length, 13);
assert.equal(new Set(rows.map((row) => row.id)).size, 13);
function exact(value) {
  if (value === undefined) return ["undefined"];
  if (typeof value === "number") {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleLE(value);
    return ["f64", bytes.toString("hex")];
  }
  if (typeof value === "bigint") return ["bigint", String(value)];
  assert(!["function", "symbol"].includes(typeof value), "unserializable receipt");
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return ["bytes", Buffer.from(value).toString("hex")];
  if (value instanceof Map) return ["map", [...value].map(([key, item]) => [exact(key), exact(item)])];
  if (value instanceof Set) return ["set", [...value].map(exact)];
  if (Array.isArray(value))
    return [
      "array",
      value.length,
      Array.from({ length: value.length }, (_, index) =>
        Object.hasOwn(value, index) ? [index, exact(value[index])] : [index, "hole"],
      ),
    ];
  assert([Object.prototype, null].includes(Object.getPrototypeOf(value)), "foreign receipt prototype");
  return [
    "record",
    Reflect.ownKeys(value).map((key) => {
      assert.equal(typeof key, "string", "symbol receipt property");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert(Object.hasOwn(descriptor, "value"), "accessor receipt property");
      return [key, exact(descriptor.value)];
    }),
  ];
}
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function snapshot(root) {
  const paths = [
    ...new Set(
      git(root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "src",
        "tests/helpers",
        "tsconfig.json",
        "package.json",
        "pnpm-lock.yaml",
      ])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  assert(paths.length > 1000, "empty/incomplete source census");
  const census = new Set(paths);
  function walk(relative) {
    assert(lstatSync(join(root, relative)).isDirectory(), `non-directory ${relative}`);
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else {
        assert(entry.isFile(), `non-file ${path}`);
        assert(census.has(path), `uncovered input ${path}`);
      }
    }
  }
  walk("src");
  walk("tests/helpers");
  return paths.map((path) => {
    assert(lstatSync(join(root, path)).isFile(), `non-file ${path}`);
    return [path, sha(readFileSync(join(root, path)))];
  });
}
async function child(root, directory, expected) {
  assert.equal(sha(readFileSync(helper)), expected.helperSha256);
  const runtime = scannerRuntimeIdentity(root, process.env, expected.runtime);
  assert.equal(sha(readFileSync(script)), expected.runnerSha256);
  const { register } = await import(pathToFileURL(runtime.paths.tsxEntry).href);
  register({ tsconfig: join(root, "tsconfig.json") });
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  const { sourceInput, requireProgram } = await load("tests/helpers/typed-program-fixtures.ts");
  const { prepareWholeIrProgram } = await load("src/ir/program-preparation.ts");
  const { encodePreparedIrProgram, decodePreparedIrProgram } = await load("src/ir/program-codec.ts");
  const { acceptPreparedIrProgram, acceptedPhysicalSetupPlan, emitAcceptedIrProgram, emittedStartupAdapterIndex } =
    await load("src/ir/program-consumer.ts");
  const { emitBinary } = await load("src/emit/binary.ts");
  const { emitWat } = await load("src/emit/wat.ts");
  const complete = [];
  let current;
  try {
    for (const row of rows) {
      current = { id: row.id, stage: "prepare" };
      const source = { ...sourceInput(row.files, row.reverse), deferTopLevelInit: !!row.deferred };
      if (row.native)
        Object.assign(source, {
          policy: {
            backend: "wasmgc",
            target: "standalone",
            stringConst: { storage: "native" },
            numberBoundary: { box: "unsupported", unbox: "native" },
          },
          nativeStringValueProjection: "standalone-native",
        });
      if (row.native) source.runtimePolicies = [source.policy];
      const program = requireProgram(prepareWholeIrProgram(source));
      const wire = encodePreparedIrProgram(program);
      writeFileSync(join(directory, `${row.id}.program`), wire);
      const decoded = decodePreparedIrProgram(wire);
      assert.equal(encodePreparedIrProgram(decoded), wire);
      const variants = [];
      for (const [variant, input] of [
        ["source", program],
        ["decoded", decoded],
      ]) {
        current = { id: row.id, variant, stage: "accept" };
        const options = {
          backend: "wasmgc",
          target: "standalone",
          sharedExceptionTag: false,
          utf8Storage: !!row.utf8,
          sourceMap: false,
          moduleName: "no-output-current-preservation",
          ...(row.numberFormat ? { numberFormat: row.numberFormat } : {}),
        };
        const accepted = acceptPreparedIrProgram(input, options);
        assert.equal(accepted.kind, "accepted", json(accepted.kind === "accepted" ? {} : accepted));
        const plan = acceptedPhysicalSetupPlan(accepted);
        assert.equal(plan.nativeStrings?.resources.output, undefined, "unexpected stdout resources");
        assert.equal(plan.nativeNumberFormat, undefined, "unexpected formatter resources");
        if (row.native) assert(plan.nativeStrings, "native parse positive control lost resources");
        else assert.equal(plan.nativeStrings, undefined, "no-demand row gained string resources");
        current.stage = "emit";
        const emitted = emitAcceptedIrProgram(accepted),
          module = emitted.module;
        assert.deepEqual(
          emitted.emittedUnitIds,
          accepted.runtime.prepared.functions.map((fn) => fn.unitId),
        );
        assert.equal(module.imports.length, 0);
        assert(!module.exports.some((entry) => entry.name.startsWith("__stdout")));
        const start = emittedStartupAdapterIndex(emitted);
        if (row.startup) {
          assert(Number.isInteger(start));
          assert.equal(module.startFuncIdx, row.deferred ? undefined : start);
        } else {
          assert.equal(start, undefined);
          assert.equal(module.startFuncIdx, undefined);
        }
        const binary = emitBinary(module),
          wat = emitWat(module);
        const prefix = join(directory, `${row.id}.${variant}`);
        writeFileSync(`${prefix}.wasm`, binary);
        writeFileSync(`${prefix}.wat`, wat);
        writeFileSync(`${prefix}.module.json`, json(exact(module)));
        current.stage = "execute";
        const values = [];
        for (let fresh = 0; fresh < 2; fresh++) {
          const { instance } = await WebAssembly.instantiate(binary);
          if (row.deferred) {
            assert.equal(typeof instance.exports.__module_init, "function");
            instance.exports.__module_init();
          }
          const value = instance.exports.run();
          assert(Object.is(value, row.expected), row.id);
          if (row.alias) assert(Object.is(instance.exports.again(), row.expected), `${row.id} alias`);
          values.push(value);
        }
        const record = exact({
          binary,
          wat,
          module,
          emittedUnitIds: emitted.emittedUnitIds,
          startup: start,
          declarations: plan.nativeStrings?.resources.declarations,
          values,
        });
        variants.push(record);
        appendFileSync(join(directory, "variants.jsonl"), json({ id: row.id, variant, record }) + "\n");
      }
      assert.deepEqual(variants[0], variants[1], `${row.id}: source/decoded artifact mismatch`);
      complete.push({ id: row.id, wire, variants });
    }
    assert.equal(complete.length, 13);
    scannerRuntimeIdentity(root, process.env, runtime);
    assert.equal(sha(readFileSync(helper)), expected.helperSha256);
    writeFileSync(
      join(directory, "report.json"),
      json({ schema: "native-output-preservation-arm-v1", runtime, rows: complete }),
    );
  } catch (error) {
    writeFileSync(
      join(directory, "failure.json"),
      json({
        ...current,
        completed: complete.map((row) => row.id),
        error: { name: error.name, message: error.message, stack: error.stack },
      }),
    );
    throw error;
  }
}
if (process.argv[2] === "--child") {
  await child(
    realpathSync(process.argv[3]),
    process.argv[4],
    JSON.parse(Buffer.from(process.argv[5], "base64").toString()),
  );
} else {
  const args = process.argv.slice(2);
  assert.equal(args.length, 8);
  assert.deepEqual([args[0], args[2], args[4], args[6]], ["--baseline", "--candidate", "--pins", "--output"]);
  for (const index of [1, 3, 5, 7]) assert(isAbsolute(args[index]));
  const roots = { baseline: realpathSync(args[1]), candidate: realpathSync(args[3]) };
  assert.notEqual(roots.baseline, roots.candidate);
  const pinsBytes = readFileSync(args[5]),
    pins = JSON.parse(pinsBytes),
    runnerSha256 = sha(readFileSync(script));
  assert.equal(pins.schema, "native-output-preservation-pins-v1");
  assert.equal(pins.runnerSha256, runnerSha256);
  assert.equal(sha(readFileSync(helper)), pins.helperSha256);
  assert.equal(pins.arms.baseline.head, BASE);
  const output = args[7];
  mkdirSync(output);
  const receipts = [],
    reports = [];
  for (const [arm, root] of Object.entries(roots)) {
    const pin = pins.arms[arm],
      before = snapshot(root),
      env = scannerChildEnvironment(root);
    env.JS2WASM_IR_GVN = "0";
    const runtime = scannerRuntimeIdentity(root, env);
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), pin.head);
    assert.equal(sha(json(before)), pin.sourceCensusSha256);
    assert.equal(sha(json(runtime.content)), pin.runtimeContentSha256);
    if (arm === "baseline")
      assert.equal(
        git(root, [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          "src",
          "tests/helpers",
          "tsconfig.json",
          "package.json",
          "pnpm-lock.yaml",
        ]),
        "",
      );
    if (receipts.length) assert.deepEqual(runtime.content, receipts[0].runtime.content);
    const directory = join(output, arm);
    mkdirSync(directory);
    const expected = Buffer.from(json({ runtime, runnerSha256, helperSha256: pins.helperSha256 })).toString("base64");
    const result = spawnSync(
      process.execPath,
      ["--experimental-wasm-exnref", script, "--child", root, directory, expected],
      { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 600_000 },
    );
    writeFileSync(join(directory, "stdout.log"), result.stdout ?? "");
    writeFileSync(join(directory, "stderr.log"), result.stderr ?? "");
    const after = snapshot(root);
    receipts.push({
      arm,
      root,
      head: pin.head,
      runnerSha256,
      helperSha256: pins.helperSha256,
      effectiveHeapMiB: 2048,
      runtime,
      before,
      after,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    });
    writeFileSync(
      join(output, "receipt.json"),
      json({
        schema: "native-output-preservation-v1",
        pins,
        pinsSha256: sha(pinsBytes),
        rows: rows.map((row) => row.id),
        expectedEmissions: 52,
        receipts,
      }),
    );
    assert.deepEqual(after, before, `${arm} source drift`);
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), pin.head);
    scannerRuntimeIdentity(root, env, runtime);
    assert.equal(sha(readFileSync(script)), runnerSha256);
    assert.equal(sha(readFileSync(helper)), pins.helperSha256);
    assert.deepEqual(readFileSync(args[5]), pinsBytes);
    assert.equal(result.status, 0, `${arm} failed: retained ${directory}`);
    const report = JSON.parse(readFileSync(join(directory, "report.json")));
    assert.equal(report.schema, "native-output-preservation-arm-v1");
    assert.deepEqual(report.runtime, runtime);
    assert.deepEqual(
      report.rows.map((row) => row.id),
      rows.map((row) => row.id),
    );
    reports.push(report.rows);
  }
  assert.deepEqual(reports[0], reports[1], `current-base/candidate difference: retained ${output}`);
  writeFileSync(
    join(output, "passed.json"),
    json({ passed: true, rows: 13, variants: 2, arms: 2, emissions: 52, freshInstantiations: 104 }),
  );
  console.log(`PASS: 13 rows, 52 emissions, 104 fresh instantiations; ${output}`);
}
