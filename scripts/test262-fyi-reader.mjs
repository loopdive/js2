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

export { discoverFixtureGraph, dynamicFixtureSpecifiers, staticFixtureSpecifiers } from "./test262-fixture-graph.mjs";

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

export async function loadOriginalHarnessTests(selectedPaths) {
  const reader = requireOptionalInputs();
  const { default: readTests } = await import(pathToFileURL(reader).href);
  const runtime = fs.readFileSync(RUNTIME_PATH, "utf8");
  if (!selectedPaths) return attachFixtureGraphs(await readTests(TEST262_ROOT, readHarnessPreludes(), runtime));

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
    return attachFixtureGraphs(await readTests(scratch, readHarnessPreludes(), runtime));
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
