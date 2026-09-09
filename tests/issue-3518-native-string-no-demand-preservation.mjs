// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Explicit A/B CLI, not an automatically discovered Vitest test. No source transforms.
// Three-arm invocation:
// node THIS_FILE --original-root ABS --repaired-baseline-root ABS --candidate-root ABS --pins-file ABS
// Independently prepare/review this JSON (the runner NEVER creates or refreshes it):
// {
//   "schema": "no-demand-three-arm-pins-v1",
//   "runnerSha256": "SHA256 of this final runner file",
//   "arms": {
//     "original": {"head":"2ccdcffd9d7939eb4b64e2d0f4910856acd13a9e", "emitterBlob":"GIT_BLOB", "sourceCensusSha256":"SHA256"},
//     "repaired": {"head":"EXACT_HEAD", "emitterBlob":"REVIEWED_GIT_BLOB", "sourceCensusSha256":"SHA256"},
//     "candidate": {"head":"EXACT_HEAD", "emitterBlob":"SAME_REVIEWED_GIT_BLOB", "sourceCensusSha256":"SHA256"}
//   }
// }
// emitterBlob: git hash-object src/ir/backend/wasmgc-emitter.ts (without -w).
// sourceCensusSha256: SHA256(JSON.stringify(rows)), rows are unique lexically
// sorted [relativePath, SHA256(raw file bytes)] for git ls-files --cached --others
// --exclude-standard -z -- src tests/helpers tsconfig.json package.json pnpm-lock.yaml.
// All git commands must run with GIT_* removed from a copied environment.
// Compare this census against every physical src/tests/helpers file; ignored
// or symlinked inputs are rejected. Review these inputs before signing off pins.
// The runner hash lives only in the external pins JSON, never in its own bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  realpathSync,
  mkdtempSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  scannerRuntimeIdentity,
  scannerChildEnvironment,
} from "../scripts/verify-native-scanner-source-preservation.mjs";

const BASE = "2ccdcffd9d7939eb4b64e2d0f4910856acd13a9e";
const EMITTER = "src/ir/backend/wasmgc-emitter.ts";
const script = fileURLToPath(import.meta.url);
const fixtures = [
  {
    name: "numeric",
    expected: 42,
    files: {
      "./math.ts": "export function double(x: number): number { return x * 2; }",
      "./entry.ts": 'import { double } from "./math"; export function run(): number { return double(20) + 2; }',
    },
  },
  {
    name: "vector",
    expected: 42,
    files: {
      "./entry.ts":
        "export function run(): number { const values: number[] = [10, 20, 12]; return values[0] + values[1] + values[2]; }",
    },
  },
  {
    name: "alias",
    expected: 42,
    files: {
      "./entry.ts": "export function run(): number { return 42; } export { run as again };",
    },
  },
  {
    name: "startup",
    expected: 132,
    files: {
      "./base.ts": "export var digit: number = 1; digit = digit * 10 + 3;",
      "./entry.ts":
        'import { digit } from "./base"; var answer: number = digit * 10 + 2; export function run(): number { return answer; } export { run as again };',
    },
  },
];
const rows = [
  { id: "numeric", fixture: fixtures[0], utf8: false, deferred: false, reverse: false },
  { id: "vector", fixture: fixtures[1], utf8: false, deferred: false, reverse: false },
  { id: "alias", fixture: fixtures[2], utf8: true, deferred: false, reverse: false },
  { id: "startup-immediate", fixture: fixtures[3], utf8: false, deferred: false, reverse: false },
  { id: "startup-deferred", fixture: fixtures[3], utf8: true, deferred: true, reverse: false },
  { id: "startup-deferred-reversed", fixture: fixtures[3], utf8: true, deferred: true, reverse: true },
];
assert.equal(rows.length, 6);
const producerRow = { ...rows[1], id: "vector-canonical-producers", producerDriven: true };
const expectedIds = [...rows.map((row) => row.id), producerRow.id];
const hash = (value) => createHash("sha256").update(value).digest("hex");
// This historical CLI is not import-safe. Reuse its exact pinned encoder
// without executing its top-level compiler workload or maintaining another copy.
const parityHelper = new URL("./helpers/physical-completion-source-parity.mjs", import.meta.url);
const paritySource = readFileSync(parityHelper, "utf8");
assert.equal(hash(paritySource), "de28abf56df5978afafae7c63a5ff0077a104264cfcea5b7ca094683dfa10829");
const exactStart = paritySource.indexOf("function exact(value) {");
const exactEnd = paritySource.indexOf("\nasync function execute(", exactStart);
assert.ok(exactStart >= 0 && exactEnd > exactStart);
const exact = Function(`return (${paritySource.slice(exactStart, exactEnd).trim()});`)();
const json = (value) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "bigint"
      ? { bigint: String(item) }
      : typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0))
        ? { number: String(Object.is(item, -0) ? "-0" : item) }
        : item,
  );
function git(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
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
  const census = new Set(paths);
  function walk(relative) {
    assert.ok(lstatSync(join(root, relative)).isDirectory(), `symlinked source directory: ${relative}`);
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else {
        assert.ok(entry.isFile(), `symlinked/non-file source: ${path}`);
        assert.ok(census.has(path), `uncovered ignored source: ${path}`);
      }
    }
  }
  walk("src");
  walk("tests/helpers");
  for (const path of paths) assert.ok(lstatSync(join(root, path)).isFile(), `symlinked/non-file input: ${path}`);
  return paths.map((path) => [path, hash(readFileSync(join(root, path)))]);
}

async function child(root, output) {
  assert.equal(process.env.ESBUILD_BINARY_PATH, undefined);
  assert.equal(process.env.TSX_TSCONFIG_PATH, join(root, "tsconfig.json"));
  assert.equal(process.env.TSX_DISABLE_CACHE, "1");
  const expected = JSON.parse(Buffer.from(process.argv[5], "base64").toString("utf8"));
  assert.ok(["original", "repaired", "candidate"].includes(expected.arm));
  const identity = scannerRuntimeIdentity(root, process.env, expected.runtime);
  assert.equal(hash(readFileSync(script)), expected.runnerHash);
  const { register } = await import(pathToFileURL(identity.paths.tsxEntry).href);
  register({ tsconfig: join(root, "tsconfig.json") });
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  const { sourceInput, requireProgram, typedOptions } = await load("tests/helpers/typed-program-fixtures.ts");
  const { prepareWholeIrProgram } = await load("src/ir/program-preparation.ts");
  const { encodePreparedIrProgram, decodePreparedIrProgram } = await load("src/ir/program-codec.ts");
  const { acceptPreparedIrProgram, acceptedPhysicalSetupPlan, emitAcceptedIrProgram, emittedStartupAdapterIndex } =
    await load("src/ir/program-consumer.ts");
  const { collectNativeStringValueDemands } = await load("src/ir/program/native-string-value-demands.ts");
  const { emitBinary } = await load("src/emit/binary.ts");
  const { emitWat } = await load("src/emit/wat.ts");
  const { buildIrUnitInventory } = await load("src/ir/identity.ts");
  const { buildIrPlanningIdentityContext } = await load("src/ir/planning-identity.ts");
  const { buildIrModuleInitPlan } = await load("src/ir/module-init-plan.ts");
  const { buildIrProgramCallableBindingGraph } = await load("src/ir/program-callable-bindings.ts");
  const { buildNativeFamilyLogicalVectors } = await load("src/ir/program-logical-types.ts");
  const { lowerFunctionAstToIr, typeNodeToIr } = await load("src/ir/from-ast.ts");
  const { AllocSiteRegistry } = await load("src/ir/analysis/alloc-registry.ts");
  const { captureTypedIrProgramInput } = await load("src/ir/program-source.ts");
  const { prepareTypedIrProgram } = await load("src/ir/program-prepare-ir.ts");
  const { irUnitCallableBindingId } = await load("src/ir/core/callable-bindings.ts");
  const { forEachInstrDeep } = await load("src/ir/core/nodes.ts");
  const { walkInstructions } = await load("src/wasm/model/instruction-walk.ts");
  function vectorProgram(input) {
    const inventory = buildIrUnitInventory(input.sourceFiles, {
      ...input.inventoryOptions,
      checker: input.checker,
      entrySource: input.entrySource,
    });
    const identity = buildIrPlanningIdentityContext(inventory);
    assert.equal(inventory.allUnits.length, 1);
    assert.equal(inventory.terminalUnits.length, 1);
    const owner = inventory.terminalUnits[0];
    assert.equal(owner.displayName, "run");
    const declaration = identity.declarationByUnitId.get(owner.id);
    assert.ok(declaration?.body && declaration.type);
    assert.equal(declaration.parameters.length, 0);
    const sourceFiles = inventory.sources.map((source) => identity.sourceFileBySourceId.get(source.id));
    const startup = sourceFiles.map((sourceFile) =>
      buildIrModuleInitPlan({
        sourceFile,
        checker: input.checker,
        identityContext: identity,
        target: input.policy.target === "strict-no-host" ? "standalone" : input.policy.target,
        deferTopLevelInit: input.deferTopLevelInit,
      }),
    );
    for (const plan of startup) {
      assert.equal(plan.executable, false);
      assert.deepEqual(plan.bindings, []);
      assert.deepEqual(plan.liveSeeds, []);
      assert.deepEqual(plan.evaluations, []);
      assert.deepEqual(plan.gaps, []);
    }
    const graph = buildIrProgramCallableBindingGraph({
      checker: input.checker,
      sourceFiles,
      identityContext: identity,
    });
    assert.deepEqual(graph.uses, []);
    const exported = startup.some((plan) =>
      plan.exports.some(
        (entry) => entry.externalName === "run" && entry.targetBindingId === irUnitCallableBindingId(owner.id),
      ),
    );
    assert.equal(exported, true);
    const facts = buildNativeFamilyLogicalVectors(input.checker, declaration, new Map());
    assert.ok(facts.size > 0);
    const allocations = new AllocSiteRegistry();
    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: owner.id,
      funcName: owner.displayName,
      exported,
      identityContext: identity,
      checker: input.checker,
      logicalVectorTypes: facts,
      allocRegistry: allocations,
      directCalls: new Map(),
      paramTypeOverrides: [],
      returnTypeOverride: typeNodeToIr(declaration.type, owner.displayName),
    });
    assert.deepEqual(lowered.lifted, []);
    assert.deepEqual(lowered.liftedUnitProvenance, []);
    assert.equal(lowered.main.unitId, owner.id);
    for (const record of graph.records) assert.equal(record.targetUnitId, owner.id);
    const carrier = {
      kind: "prepared",
      inventory,
      ir: { functions: [lowered.main] },
      derivedUnits: [],
      startup,
      callables: graph.records,
      globals: [],
      allocations,
    };
    return requireProgram(prepareTypedIrProgram(captureTypedIrProgramInput(carrier), typedOptions));
  }
  const records = [];
  let current;
  const progress = (stage, detail = {}) => {
    current = { ...current, ...detail, stage };
    appendFileSync(`${output}.progress.jsonl`, `${json(current)}\n`);
    console.log(json(current));
  };
  const complete = (record) => {
    records.push(record);
    appendFileSync(`${output}.completed.jsonl`, `${json(record)}\n`);
    progress("row-completed");
  };
  try {
    for (const row of [...rows, producerRow]) {
      current = {
        id: row.id,
        kind:
          row.id === "vector" ? "source-refusal" : row.producerDriven ? "producer-ir-execution" : "source-execution",
        variant: null,
      };
      progress("source-input");
      const source = { ...sourceInput(row.fixture.files, row.reverse), deferTopLevelInit: row.deferred };
      progress("prepare");
      if (row.id === "vector") {
        const refused = prepareWholeIrProgram(source);
        assert.equal(refused.kind, "unsupported");
        assert.equal(refused.code, "body-shape-rejected");
        assert.equal(
          refused.detail,
          "ir/from-ast: resolver cannot register vec for number[] annotation on 'values' (run)",
        );
        complete({ id: row.id, kind: "source-refusal", refusal: exact(refused) });
        continue;
      }
      const program = row.producerDriven ? vectorProgram(source) : requireProgram(prepareWholeIrProgram(source));
      progress("codec");
      const wire = encodePreparedIrProgram(program);
      const decoded = decodePreparedIrProgram(wire);
      assert.equal(encodePreparedIrProgram(decoded), wire);
      const versions = [];
      for (const input of [program, decoded]) {
        progress("accept", { variant: input === program ? "original" : "decoded" });
        const accepted = acceptPreparedIrProgram(input, {
          backend: "wasmgc",
          target: "standalone",
          sharedExceptionTag: false,
          utf8Storage: row.utf8,
          sourceMap: false,
          moduleName: "no-demand-preservation",
        });
        assert.equal(accepted.kind, "accepted", `${row.id}: ${json(accepted.kind === "accepted" ? {} : accepted)}`);
        const demands = collectNativeStringValueDemands(input, accepted.runtime);
        assert.equal(demands.literals.length, 0, row.id);
        assert.equal(demands.intrinsics.filter((item) => item.instruction.id === "js.number.unbox").length, 0, row.id);
        assert.equal(Object.hasOwn(acceptedPhysicalSetupPlan(accepted), "nativeStrings"), false, row.id);
        if (row.producerDriven) {
          assert.equal(accepted.runtime.prepared.functions.length, 1);
          assert.equal(accepted.runtime.prepared.functions[0].unitId, input.inventory.terminalUnits[0].id);
          const instructions = [];
          for (const fn of accepted.runtime.prepared.functions)
            for (const block of fn.blocks)
              for (const instruction of block.instrs)
                forEachInstrDeep(instruction, (nested) => instructions.push(nested));
          assert.ok(
            instructions.some((instruction) => instruction.kind === "vec.new_fixed"),
            "vector allocation optimized away",
          );
          assert.ok(
            instructions.some((instruction) => instruction.kind === "vec.get"),
            "vector reads missing",
          );
          assert.ok(acceptedPhysicalSetupPlan(accepted).vectors.layouts.includes("f64"), "actual f64 layout missing");
        }
        progress("emit");
        const emitted = emitAcceptedIrProgram(accepted);
        progress("module-assertions");
        assert.deepEqual(
          emitted.emittedUnitIds,
          accepted.runtime.prepared.functions.map((fn) => fn.unitId),
        );
        const module = emitted.module;
        if (row.producerDriven) {
          const opcodes = [];
          for (const fn of module.functions) walkInstructions(fn.body, (instruction) => opcodes.push(instruction.op));
          for (const opcode of ["array.new_fixed", "struct.new", "array.get", "struct.get"])
            assert.ok(opcodes.includes(opcode), `actual vector operation missing: ${opcode}`);
        }
        assert.deepEqual(module.imports, []);
        assert.ok(Array.isArray(module.funcOrdinalToPosition), `${row.id}: missing function order`);
        assert.equal(module.funcOrdinalToPosition.length, module.functions.length);
        assert.equal(new Set(module.funcOrdinalToPosition).size, module.functions.length);
        for (const position of module.funcOrdinalToPosition) {
          assert.ok(Number.isInteger(position) && position >= 0 && position < module.functions.length);
        }
        for (const fn of module.functions)
          assert.ok(Array.isArray(fn.body), `${row.id}: missing actual instruction body`);
        const startup = emittedStartupAdapterIndex(emitted);
        if (row.fixture.name === "startup") {
          assert.ok(Number.isInteger(startup));
          if (row.deferred) {
            assert.equal(module.startFuncIdx, undefined);
            assert.deepEqual(module.exports.find((entry) => entry.name === "__module_init")?.desc, {
              kind: "func",
              index: startup,
            });
          } else assert.equal(module.startFuncIdx, startup);
        } else {
          assert.equal(startup, undefined);
          assert.equal(module.startFuncIdx, undefined);
        }
        progress("binary");
        const binary = emitBinary(module);
        progress("wat");
        const wat = emitWat(module);
        const artifact = `${output}.${row.id}.${current.variant}`;
        writeFileSync(`${artifact}.wasm`, binary);
        writeFileSync(`${artifact}.wat`, wat);
        writeFileSync(`${artifact}.module.json`, json(exact(module)));
        progress("artifacts-retained", { artifact });
        const values = [];
        if (row.producerDriven && expected.arm === "original") {
          progress("instantiate-original-known-defect", { fresh: 0 });
          let failure;
          try {
            await WebAssembly.instantiate(binary);
          } catch (error) {
            failure = error;
          }
          assert.ok(
            failure instanceof WebAssembly.CompileError,
            "original must reproduce the actual vector CompileError",
          );
          assert.equal(
            failure.message,
            'WebAssembly.instantiate(): Compiling function #0:"run" failed: struct.new[1] expected type (ref 1), found local.get of type (ref null 1) @+97',
          );
          const defect = {
            id: row.id,
            variant: current.variant,
            stage: current.stage,
            class: failure.name,
            detail: failure.message,
          };
          appendFileSync(`${output}.expected-defects.jsonl`, `${json(defect)}\n`);
          versions.push(
            exact({
              kind: "expected-defect-reproduction",
              defect: { stage: defect.stage, class: defect.class, detail: defect.detail },
              bytes: Buffer.from(binary).toString("base64"),
              wat,
              module,
            }),
          );
          progress("expected-defect-reproduced");
          continue;
        }
        for (let fresh = 0; fresh < 2; fresh++) {
          progress("instantiate", { fresh });
          const { instance } = await WebAssembly.instantiate(binary);
          if (row.deferred && emittedStartupAdapterIndex(emitted) !== undefined) {
            progress("startup");
            assert.equal(typeof instance.exports.__module_init, "function");
            instance.exports.__module_init();
          }
          for (const name of row.fixture.name === "alias" || row.fixture.name === "startup"
            ? ["run", "again"]
            : ["run"]) {
            assert.equal(typeof instance.exports[name], "function");
            for (let repeat = 0; repeat < 2; repeat++) {
              progress("call", { exportName: name, repeat });
              const result = instance.exports[name]();
              assert.ok(Object.is(result, row.fixture.expected), `${row.id}/${name}: ${result}`);
              values.push(result);
            }
          }
        }
        versions.push(
          exact({
            bytes: Buffer.from(binary).toString("base64"),
            wat,
            types: module.types,
            imports: module.imports,
            exports: module.exports,
            globals: module.globals,
            tags: module.tags,
            functions: module.functions,
            resources: Object.fromEntries(
              [
                "types",
                "imports",
                "globals",
                "tags",
                "tables",
                "elements",
                "exports",
                "startFuncIdx",
                "stringPool",
                "memories",
                "dataSegments",
                "canonicalRuntimeRecGroup",
              ].map((key) => [key, { present: Object.hasOwn(module, key), value: module[key] }]),
            ),
            order: module.funcOrdinalToPosition,
            units: emitted.emittedUnitIds,
            startup: startup === undefined ? { present: false } : { present: true, index: startup },
            start: { present: Object.hasOwn(module, "startFuncIdx"), index: module.startFuncIdx ?? null },
            values,
          }),
        );
        appendFileSync(
          `${output}.variants.jsonl`,
          `${json({ id: row.id, kind: current.kind, variant: current.variant, record: versions.at(-1) })}\n`,
        );
        progress("variant-completed");
      }
      progress("original-decoded-comparison");
      assert.equal(json(versions[0]), json(versions[1]), `${row.id}: original/decoded mismatch`);
      complete({
        id: row.id,
        kind: row.producerDriven
          ? expected.arm === "original"
            ? "expected-defect-reproduction"
            : "producer-ir-execution"
          : "source-execution",
        versions,
      });
    }
    progress("final-provenance");
    scannerRuntimeIdentity(root, process.env, identity);
    assert.equal(hash(readFileSync(script)), expected.runnerHash);
    assert.deepEqual(
      records.map((row) => row.id),
      expectedIds,
    );
    writeFileSync(
      output,
      json({
        schema: "no-demand-three-arm-v1",
        arm: expected.arm,
        rows: records,
        runtime: identity,
        runnerHash: expected.runnerHash,
      }),
    );
  } catch (error) {
    appendFileSync(
      `${output}.failures.jsonl`,
      `${json({ ...current, completedIds: records.map((row) => row.id), error: { name: error?.name, message: error?.message, stack: error?.stack, code: error?.code } })}\n`,
    );
    throw error;
  }
}

if (process.argv[2] === "--child") {
  await child(realpathSync(process.argv[3]), process.argv[4]);
} else {
  const args = process.argv.slice(2);
  assert.equal(
    args.length,
    8,
    "required: --original-root ABS --repaired-baseline-root ABS --candidate-root ABS --pins-file ABS",
  );
  assert.deepEqual(
    [args[0], args[2], args[4], args[6]],
    ["--original-root", "--repaired-baseline-root", "--candidate-root", "--pins-file"],
  );
  for (const index of [1, 3, 5, 7]) assert.ok(isAbsolute(args[index]));
  const baseline = realpathSync(args[1]),
    repaired = realpathSync(args[3]),
    candidate = realpathSync(args[5]);
  assert.equal(new Set([baseline, repaired, candidate]).size, 3);
  const pinsBytes = readFileSync(args[7]);
  const pins = JSON.parse(pinsBytes);
  assert.equal(pins.schema, "no-demand-three-arm-pins-v1");
  assert.equal(pins.runnerSha256, hash(readFileSync(script)));
  assert.equal(pins.arms.original.head, BASE);
  assert.equal(git(baseline, ["rev-parse", "HEAD"]).trim(), BASE);
  assert.equal(
    git(baseline, ["diff", "HEAD", "--", "src", "tests/helpers", "tsconfig.json", "package.json", "pnpm-lock.yaml"]),
    "",
  );
  assert.equal(
    git(baseline, [
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
  const originalSource = readFileSync(join(baseline, EMITTER), "utf8");
  const oldSpan =
    '    out.push({ op: "local.get", index: dataScratchLocal });\n    out.push({ op: "struct.new", typeIdx: layout.vecStructTypeIdx });';
  assert.equal(originalSource.split(oldSpan).length, 2, "unique original emitter refinement site required");
  const repairedSource = originalSource.replace(
    oldSpan,
    '    out.push({ op: "local.get", index: dataScratchLocal });\n    out.push({ op: "ref.as_non_null" });\n    out.push({ op: "struct.new", typeIdx: layout.vecStructTypeIdx });',
  );
  assert.equal(
    readFileSync(join(repaired, EMITTER), "utf8"),
    repairedSource,
    "repair must be exactly the reviewed one-instruction refinement",
  );
  assert.equal(
    readFileSync(join(candidate, EMITTER), "utf8"),
    repairedSource,
    "candidate must carry identical emitter repair",
  );
  const originalSnapshot = snapshot(baseline),
    repairedSnapshot = snapshot(repaired);
  assert.deepEqual(
    repairedSnapshot.filter(([path]) => path !== EMITTER),
    originalSnapshot.filter(([path]) => path !== EMITTER),
    "original/repaired assessed inputs differ outside emitter",
  );
  const output = mkdtempSync(join(tmpdir(), "js2-no-demand-pair-"));
  const runnerHash = hash(readFileSync(script));
  const receipts = [],
    reports = [];
  for (const [arm, root] of [
    ["original", baseline],
    ["repaired", repaired],
    ["candidate", candidate],
  ]) {
    const env = scannerChildEnvironment(root);
    env.JS2WASM_IR_GVN = "0";
    const before = snapshot(root),
      identity = scannerRuntimeIdentity(root, env);
    const pin = pins.arms[arm];
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), pin.head, `${arm} HEAD differs`);
    assert.equal(hash(json(before)), pin.sourceCensusSha256, `${arm} source census differs`);
    assert.equal(git(root, ["hash-object", EMITTER]).trim(), pin.emitterBlob, `${arm} emitter blob differs`);
    assert.equal(hash(readFileSync(script)), runnerHash);
    if (receipts.length)
      assert.deepEqual(identity.content, receipts[0].runtime.content, "arms must use identical native runtime content");
    const report = join(output, `${arm}.json`);
    const expected = Buffer.from(JSON.stringify({ arm, runtime: identity, runnerHash })).toString("base64");
    const result = spawnSync(process.execPath, [script, "--child", root, report, expected], {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(join(output, `${arm}.stdout`), result.stdout ?? "");
    writeFileSync(join(output, `${arm}.stderr`), result.stderr ?? "");
    const receipt = {
      arm,
      root,
      runnerHash,
      parityHelperHash: hash(paritySource),
      head: git(root, ["rev-parse", "HEAD"]).trim(),
      status: result.status,
      signal: result.signal,
      runtime: identity,
      before,
      after: snapshot(root),
    };
    receipts.push(receipt);
    writeFileSync(
      join(output, "receipt.json"),
      json({
        baseline: BASE,
        pinsSha256: hash(pinsBytes),
        pins,
        population: expectedIds,
        sourceExecutions: 5,
        sourceRefusals: 1,
        originalExpectedDefects: 1,
        repairedCandidateProducerIrExecutions: 1,
        fixturesHash: hash(json(fixtures)),
        receipts,
      }),
    );
    assert.equal(result.status, 0, `${arm} failed; retained ${output}: ${result.stderr}`);
    assert.deepEqual(receipt.after, before, `${arm} inputs changed`);
    assert.equal(hash(json(receipt.after)), pin.sourceCensusSha256);
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), pin.head);
    assert.equal(git(root, ["hash-object", EMITTER]).trim(), pin.emitterBlob);
    assert.deepEqual(readFileSync(args[7]), pinsBytes, "reviewed pins changed during execution");
    scannerRuntimeIdentity(root, env, identity);
    assert.equal(hash(readFileSync(script)), runnerHash);
    const parsed = JSON.parse(readFileSync(report, "utf8"));
    assert.deepEqual(parsed.runtime, identity);
    assert.equal(parsed.runnerHash, runnerHash);
    assert.equal(parsed.schema, "no-demand-three-arm-v1");
    assert.equal(parsed.arm, arm);
    assert.deepEqual(
      parsed.rows.map((row) => row.id),
      expectedIds,
    );
    reports.push(parsed.rows);
  }
  assert.equal(reports[0][6].kind, "expected-defect-reproduction");
  for (const rows of reports) assert.equal(rows[1].kind, "source-refusal");
  assert.deepEqual(reports[0][1], reports[1][1]);
  assert.deepEqual(reports[0][1], reports[2][1]);
  assert.deepEqual(reports[2], reports[1], `repaired/candidate no-demand mismatch; retained ${output}`);
  console.log(
    `PASS: original known vector defect reproduced; repaired/candidate parity for 5 source executions + 1 exact source refusal + 1 producer-IR vector execution; receipts ${output}`,
  );
}
