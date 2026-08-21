// Jest 30.4.2 original @jest/get-type unit slice.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupJestUpstreamSuite } from "./setup-jest-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".jest-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "jest-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function resolveJestImport(filePath, specifier) {
  const base = resolve(dirname(filePath), specifier);
  const candidates = [
    /\.(?:[cm]?js|tsx?)$/.test(base) ? base : null,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
    join(base, "index.mjs"),
  ];
  return candidates.find((candidate) => candidate !== null && existsSync(candidate)) ?? null;
}

function transformJestTest(source, filePath, generatedPath, { normalizeCjs = false } = {}) {
  let importIndex = 0;
  source = source.replace(
    /import\s+((?:\*\s+as\s+[A-Za-z_$][\w$]*)|(?:[A-Za-z_$][\w$]*))\s+from\s+(["'])(\.\.?\/?[^"']*)\2;?/g,
    (_match, binding, quote, specifier) => {
      const target = resolveJestImport(filePath, specifier);
      if (!target) throw new Error(`[dogfood] Jest published source is missing ${specifier} imported by ${filePath}`);
      const rewritten = moduleSpecifier(dirname(generatedPath), target);
      if (!normalizeCjs) return `import ${binding} from ${quote}${rewritten}${quote};`;
      const namespaceName = `__jestImport${importIndex++}`;
      return (
        `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` +
        `const ${binding.replace(/^\*\s+as\s+/, "")} = ${namespaceName}.default?.default ?? ${namespaceName}.default ?? ${namespaceName};`
      );
    },
  );
  return source.replace(
    /import\s+\{([^}]+)\}\s+from\s+(["'])(\.\.?\/?[^"']*)\2;?/g,
    (_match, bindings, quote, specifier) => {
      const target = resolveJestImport(filePath, specifier);
      if (!target) throw new Error(`[dogfood] Jest published source is missing ${specifier} imported by ${filePath}`);
      const rewritten = moduleSpecifier(dirname(generatedPath), target);
      if (!normalizeCjs) return `import {${bindings}} from ${quote}${rewritten}${quote};`;
      const namespaceName = `__jestImport${importIndex++}`;
      return (
        `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` +
        `const {${bindings}} = ${namespaceName}.default || ${namespaceName};`
      );
    },
  );
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupJestUpstreamSuite();
  const runs = [];

  log(`[dogfood] jest@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const original = readFileSync(filePath, "utf-8");
    const transformed = transformJestTest(original, filePath, generatedPath);
    const nativeTransformed = transformJestTest(original, filePath, generatedPath, { normalizeCjs: true });
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const nativeSource = `${UPSTREAM_TEST_SHIM}\n${nativeTransformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({
      generatedPath,
      source,
      nativeSource,
      timeoutMs: 240_000,
      workerEnv: { DOGFOOD_PLATFORM: "node" },
    });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `jest@${suite.pin.version}`,
    pin: suite.pin,
    testFiles: suite.testFiles,
    selectedFiles: suite.pin.selectedFiles,
    runs,
  });
  writeUpstreamReport(REPORT_PATH, report);
  log(`[dogfood] ${report.summary.headline}; ${report.extraction.filesDeferred} upstream files explicitly deferred`);
  log(`[dogfood] report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) cliUpstreamHarness(runHarness);
