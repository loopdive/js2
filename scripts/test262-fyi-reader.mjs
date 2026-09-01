// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Lightweight access to test262.fyi's source assembler. Keep compiler/runtime
// imports out of this module so parity tests can compare source records without
// loading a second bundled compiler into the Vitest process.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverFixtureGraph } from "./test262-fixture-graph.mjs";
import { ITERATOR_BINDING_PREAMBLE, needsIteratorBinding } from "./test262-iterator-binding.mjs";

export {
  discoverFixtureGraph,
  dynamicFixtureSpecifiers,
  hasSelfModuleImport,
  staticFixtureSpecifiers,
  staticRelativeModuleSpecifiers,
} from "./test262-fixture-graph.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FYI_ROOT = join(ROOT, "test262-fyi", "data");
const TEST262_ROOT = join(ROOT, "test262");
const RUNTIME_PATH = join(ROOT, "scripts", "test262-fyi-runtime.js");

function normalizeTestPath(path) {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/^test\//, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`invalid test262 path: ${path}`);
  }
  return normalized;
}

function attachFixtureGraphs(tests) {
  for (const test of tests) {
    const graph = discoverFixtureGraph(test.file, test.contents);
    if (Object.keys(graph.fixtureFiles).length > 0 || Object.keys(graph.dynamicFixtureFiles).length > 0) {
      Object.assign(test, graph);
    }
  }
  return tests;
}

function requireOptionalInputs() {
  const reader = join(FYI_ROOT, "runner", "read.js");
  if (!fs.existsSync(reader)) {
    throw new Error(
      "test262-fyi/data is not initialized; run: git submodule update --init --checkout test262-fyi/data",
    );
  }
  if (!fs.existsSync(join(TEST262_ROOT, "harness", "assert.js"))) {
    throw new Error("test262 is not initialized; run: git submodule update --init test262");
  }
  return reader;
}

function readHarnessPreludes() {
  const harnessDir = join(TEST262_ROOT, "harness");
  const preludes = {};
  for (const entry of fs.readdirSync(harnessDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      preludes[entry.name] = fs.readFileSync(join(harnessDir, entry.name), "utf8");
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const child of fs.readdirSync(join(harnessDir, entry.name), { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith(".js")) {
        preludes[`${entry.name}/${child.name}`] = fs.readFileSync(join(harnessDir, entry.name, child.name), "utf8");
      }
    }
  }
  return preludes;
}

// (#4626) A test that DECLARES its own top-level `$262` (harness
// detachArrayBuffer-host-detachArrayBuffer.js) collides with the runtime
// shim's `var $262 = {…}` — the compiler gives duplicate top-level vars no
// last-assignment-wins semantics, so the test's override silently never took
// effect. Rename the SHIM segment's `$262` occurrences in place (same byte
// length, so line/offset math is unaffected). The slice AFTER the runtime
// segment is assert.js + sta.js + the test body; only a declaration there
// (not a mere reference — harness includes reference `$262` and must keep
// binding the single remaining declaration) triggers the rename. Mirrors the
// tests/test262-original-harness.ts assembleVariant fix for the in-process
// lane.
function shadowRuntime262ForOwnDeclarations(tests, runtime) {
  const renamed = runtime.replace(/\$262\b/g, () => "$26_");
  for (const test of tests) {
    if (typeof test?.contents !== "string") continue;
    const at = test.contents.indexOf(runtime);
    if (at < 0) continue;
    const tail = test.contents.slice(at + runtime.length);
    if (/\b(?:var|let|const)\s+\$262\b/.test(tail)) {
      test.contents = test.contents.slice(0, at) + renamed + tail;
    }
  }
  return tests;
}

// test262.fyi assembles the upstream harness before it exposes records to this
// runner. Keep its records aligned with tests/test262-original-harness.ts by
// adding the same feature-gated, compiled `%Iterator%` binding immediately
// before the literal upstream body. The body itself remains byte-for-byte
// untouched, which is important both to the Test262 source contract and to
// strict reruns (the runner prepends their directive outside `contents`).
export function provisionIteratorBindingsInOriginalHarnessRecords(tests) {
  for (const test of tests) {
    if (typeof test?.contents !== "string") continue;
    const raw = Array.isArray(test.flags) ? test.flags.includes("raw") : test.flags?.raw === true;
    if (raw) continue;

    const body = fs.readFileSync(join(TEST262_ROOT, "test", normalizeTestPath(test.file)), "utf8");
    if (!needsIteratorBinding(body)) continue;
    if (!test.contents.endsWith(body)) {
      throw new Error(`original-harness record does not preserve literal body: ${test.file}`);
    }

    const prefix = test.contents.slice(0, -body.length);
    if (prefix.endsWith(ITERATOR_BINDING_PREAMBLE)) continue;
    test.contents = prefix + ITERATOR_BINDING_PREAMBLE + body;
  }
  return tests;
}

export async function loadOriginalHarnessTests(selectedPaths) {
  const reader = requireOptionalInputs();
  const { default: readTests } = await import(pathToFileURL(reader).href);
  const runtime = fs.readFileSync(RUNTIME_PATH, "utf8");
  if (!selectedPaths)
    return attachFixtureGraphs(
      provisionIteratorBindingsInOriginalHarnessRecords(
        shadowRuntime262ForOwnDeclarations(await readTests(TEST262_ROOT, readHarnessPreludes(), runtime), runtime),
      ),
    );

  // test262.fyi's reader eagerly retains every assembled source in the corpus.
  // Give parity tests a sparse mirror so small samples do not require hundreds
  // of megabytes merely to exercise the original reader implementation.
  const scratch = fs.mkdtempSync(join(tmpdir(), "js2wasm-test262-fyi-reader-"));
  try {
    for (const path of selectedPaths) {
      const normalized = normalizeTestPath(path);
      const destination = join(scratch, "test", normalized);
      fs.mkdirSync(dirname(destination), { recursive: true });
      fs.copyFileSync(join(TEST262_ROOT, "test", normalized), destination);
    }
    return attachFixtureGraphs(
      provisionIteratorBindingsInOriginalHarnessRecords(
        shadowRuntime262ForOwnDeclarations(await readTests(scratch, readHarnessPreludes(), runtime), runtime),
      ),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function discoverTestPaths() {
  const testRoot = join(TEST262_ROOT, "test");
  const paths = [];
  const scan = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        scan(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.includes("_FIXTURE")) {
        paths.push(absolute.slice(testRoot.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  scan(testRoot);
  return paths.sort((a, b) => a.localeCompare(b));
}
