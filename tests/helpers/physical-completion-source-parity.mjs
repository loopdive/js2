// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Explicit-root historical measurement, not a full compiler closure certificate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [rootArgument, arm, output] = process.argv.slice(2);
assert(rootArgument && output && ["baseline", "candidate"].includes(arm));
const root = realpathSync(rootArgument);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function sourceSnapshot() {
  const rows = [];
  function walk(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else {
        assert(entry.isFile(), `unassessed source entry: ${file}`);
        rows.push([file, sha(readFileSync(join(root, file)))]);
      }
    }
  }
  walk("src");
  assert(rows.length > 1_000, "source census unexpectedly empty or reduced");
  return {
    head: git("rev-parse", "HEAD"),
    sourceFiles: rows,
    sourceSha256: sha(JSON.stringify(rows)),
    tsconfig: sha(readFileSync(join(root, "tsconfig.json"))),
  };
}
const before = sourceSnapshot();
if (arm === "baseline") {
  assert.equal(git("diff", "e3de0f3ff7d7828c66b3fea7946f08e593bf77d8", "--", "src"), "");
  assert.equal(git("ls-files", "--others", "--exclude-standard", "--", "src"), "");
}
const urls = [];
async function load(path) {
  const url = pathToFileURL(join(root, path)).href;
  urls.push(url);
  return import(url);
}
const checker = await load("src/checker/index.ts");
const preparation = await load("src/ir/program-preparation.ts");
const consumer = await load("src/ir/program-consumer.ts");
const codec = await load("src/ir/program-codec.ts");
const binary = await load("src/emit/binary.ts");
const wat = await load("src/emit/wat.ts");
const observation = await load("src/ir/program-observation.ts");
const fixtures = [
  {
    name: "main",
    expected: 42,
    units: 2,
    startup: false,
    files: {
      "./math.ts": "export function double(x: number): number { return x * 2; }",
      "./entry.ts":
        'import { double as twice } from "./math"; export function main(): number { return twice(20) + 2; }',
    },
  },
  {
    name: "read",
    expected: 132,
    units: 3,
    startup: true,
    files: {
      "./base.ts": "export var digit: number = 1; digit = digit * 10 + 3;",
      "./entry.ts":
        'import { digit } from "./base"; var answer: number = digit * 10 + 2; export function read(): number { return answer; }',
    },
  },
];
const options = {
  backend: "wasmgc",
  target: "standalone",
  sharedExceptionTag: false,
  utf8Storage: false,
  sourceMap: false,
  moduleName: "ir-whole-program-replay",
};
// Preserve descriptor presence, holes, bytes and numeric bits in the receipt.
function exact(value) {
  if (value === undefined) return ["undefined"];
  if (typeof value === "number") {
    const bits = Buffer.alloc(8);
    bits.writeDoubleLE(value);
    return ["f64", bits.toString("hex")];
  }
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return ["bytes", Buffer.from(value).toString("hex")];
  if (Array.isArray(value))
    return [
      "array",
      value.length,
      Array.from({ length: value.length }, (_, index) =>
        Object.hasOwn(value, index) ? [index, exact(value[index])] : [index, "hole"],
      ),
    ];
  return ["record", Object.keys(value).map((key) => [key, exact(value[key])])];
}
async function execute(program, fixture, deferred) {
  const phases = [];
  const off = observation.subscribePreparedIrProgram((event) => {
    if (event.program === program) phases.push(event.phase);
  });
  try {
    const acceptance = consumer.acceptPreparedIrProgram(program, {
      ...options,
      sharedExceptionTag: fixture.shared ?? false,
    });
    assert.equal(acceptance.kind, "accepted", JSON.stringify(acceptance.kind === "accepted" ? {} : acceptance));
    const selected = acceptance.runtime.prepared.functions.map((fn) => fn.unitId);
    assert.equal(selected.length, fixture.units);
    const emitted = consumer.emitAcceptedIrProgram(acceptance);
    const module = emitted.module;
    assert.deepEqual(emitted.emittedUnitIds, selected);
    assert.equal(module.functions.length, fixture.units + Number(fixture.startup));
    const imports = {};
    if (fixture.throws && fixture.shared) {
      assert.equal(module.imports.length, 1);
      assert.equal(module.imports[0].desc.kind, "tag");
      assert.equal(module.tags.length, 0);
      const tag = module.imports[0];
      imports[tag.module] = { [tag.name]: new WebAssembly.Tag({ parameters: ["externref"] }) };
    } else {
      assert.deepEqual(module.imports, []);
      assert.equal(module.tags.length, fixture.throws ? 1 : 0);
    }
    const startup = consumer.emittedStartupAdapterIndex(emitted);
    assert.equal(startup !== undefined, fixture.startup);
    const bytes = binary.emitBinary(module);
    assert(bytes.byteLength > 8);
    const encoded = Buffer.from(bytes).toString("base64");
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    if (fixture.startup && deferred) {
      assert.equal(typeof instance.exports.__module_init, "function");
      instance.exports.__module_init();
    }
    const exported = instance.exports[fixture.name];
    let values;
    if (fixture.global) {
      assert(exported instanceof WebAssembly.Global);
      assert.deepEqual(module.exports.find((entry) => entry.name === fixture.name)?.desc, { kind: "global", index: 0 });
      values = [exported.value, exported.value];
      assert.deepEqual(values, [fixture.expected, fixture.expected]);
    } else {
      assert.equal(typeof exported, "function");
      if (fixture.throws) {
        values = [];
        for (let repeat = 0; repeat < 2; repeat++) {
          let thrown;
          try {
            exported();
          } catch (error) {
            thrown = error;
          }
          assert(thrown instanceof WebAssembly.Exception, "expected actual Wasm exception");
          if (fixture.shared) {
            const tag = module.imports[0];
            assert(thrown.is(imports[tag.module][tag.name]));
            assert.equal(thrown.getArg(imports[tag.module][tag.name], 0), null);
          }
          values.push({ kind: "WasmException", sharedTagVerified: fixture.shared });
        }
      } else {
        values = [exported(), exported()];
        assert.deepEqual(values, [fixture.expected, fixture.expected]);
      }
    }
    assert.deepEqual(phases, ["accepted", "emission-started", "emitted"]);
    assert.throws(() => consumer.emitAcceptedIrProgram(acceptance), /already emitted/);
    // Function instruction handles intentionally migrate from live indices to
    // stable handles. Compare their serialized meaning, not that representation.
    const resources = Object.fromEntries(
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
    );
    return {
      bytes: encoded,
      wat: wat.emitWat(module),
      resources: exact(resources),
      functions: exact(
        module.functions.map(({ name, typeIdx, locals, exported }) => ({
          name,
          typeIdx,
          locals,
          exported,
        })),
      ),
      units: selected,
      startup,
      phases,
      values,
    };
  } finally {
    off();
  }
}
const rows = [];
const cases = [];
for (const reverse of [false, true])
  for (const deferred of [false, true]) for (const fixture of fixtures) cases.push({ fixture, reverse, deferred });
cases.push({
  fixture: {
    name: "answer",
    expected: 42,
    units: 1,
    startup: true,
    global: true,
    files: { "./entry.ts": "export let answer: number = 42;" },
  },
  reverse: false,
  deferred: false,
});
for (const shared of [false, true])
  cases.push({
    fixture: {
      name: "fail",
      units: 1,
      startup: false,
      throws: true,
      shared,
      files: { "./entry.ts": "export function fail(): void { throw null; }" },
    },
    reverse: false,
    deferred: false,
  });
for (const { fixture, reverse, deferred } of cases) {
  const ast = checker.analyzeMultiSource(fixture.files, "./entry.ts");
  const prepared = preparation.prepareWholeIrProgram({
    sourceFiles: reverse ? [...ast.sourceFiles].reverse() : ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { target: "standalone", backend: "wasmgc" },
    deferTopLevelInit: deferred,
  });
  assert.equal(prepared.kind, "prepared", JSON.stringify(prepared.kind === "prepared" ? {} : prepared));
  const wire = codec.encodePreparedIrProgram(prepared.program);
  const decoded = codec.decodePreparedIrProgram(wire);
  assert.equal(codec.encodePreparedIrProgram(decoded), wire);
  const original = await execute(prepared.program, fixture, deferred);
  const replayed = await execute(decoded, fixture, deferred);
  assert.deepEqual(replayed, original);
  rows.push({
    id: `${fixture.name}:reverse=${reverse}:deferred=${deferred}:shared=${fixture.shared ?? false}`,
    wire,
    original,
    replayed,
  });
}
assert.equal(rows.length, 11);
assert.equal(new Set(rows.map((row) => row.id)).size, 11);
const after = sourceSnapshot();
assert.deepEqual(after, before, "source changed during measurement");
writeFileSync(
  output,
  JSON.stringify(
    {
      schema: "physical-completion-source-parity-v1",
      arm,
      root,
      before,
      urls,
      runtime: process.version,
      execArgv: process.execArgv,
      helperSha256: sha(readFileSync(new URL(import.meta.url))),
      fixtureSha256: sha(JSON.stringify(cases)),
      rows,
      closureCertified: false,
      retirementCertified: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    arm,
    rows: rows.length,
    executions: rows.length * 2,
    sourceFiles: before.sourceFiles.length,
    sourceSha256: before.sourceSha256,
  }),
);
