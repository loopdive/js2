// styled-components 6.4.4 original synchronous utility-unit slice.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupStyledComponentsUpstreamSuite } from "./setup-styled-components-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".styled-components-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "styled-components-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformStyledComponentsTest(source, filePath, generatedPath, { normalizeCjs = false } = {}) {
  source = source.replace(
    /import\s+(\{[^}]+\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s+from\s+(["'])(\.\.?\/[^"']+)\2;?/g,
    (_match, bindings, quote, specifier) => {
      let target = resolve(dirname(filePath), specifier);
      if (existsSync(`${target}.ts`)) target = `${target}.ts`;
      else if (existsSync(`${target}.tsx`)) target = `${target}.tsx`;
      return `import ${bindings} from ${quote}${moduleSpecifier(dirname(generatedPath), target)}${quote};`;
    },
  );
  let importIndex = 0;
  return source.replace(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])(\.\.?\/[^"']+)\2;?/g,
    (_match, localName, quote, specifier) => {
      const namespaceName = `__styledComponentsImport${importIndex++}`;
      let target = resolve(dirname(filePath), specifier);
      if (existsSync(`${target}.ts`)) target = `${target}.ts`;
      else if (existsSync(`${target}.tsx`)) target = `${target}.tsx`;
      const rewritten = moduleSpecifier(dirname(generatedPath), target);
      if (!normalizeCjs) return `import ${localName} from ${quote}${rewritten}${quote};`;
      // The pinned monorepo has no `type: module`, so tsx exposes its TS
      // default export through one extra CJS-interop `default` layer. The
      // compiler sees the same source as ESM. Normalize only that loader seam;
      // the imported implementation and upstream callback stay unchanged.
      return (
        `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` +
        `const ${localName} = (${namespaceName}.default && ${namespaceName}.default.default) || ${namespaceName}.default;`
      );
    },
  );
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupStyledComponentsUpstreamSuite();
  const runs = [];
  const versionFixturePath = join(GENERATED_ROOT, "styled-components-version.ts");
  // First write into GENERATED_ROOT — a focused `--only` run (the #4604 matrix
  // worker) starts from a clean checkout where nothing else has created it
  // (mirrors eslint-upstream-suite.mjs). The serial path never reached this
  // line in CI before the matrix split, which is how the gap shipped.
  mkdirSync(GENERATED_ROOT, { recursive: true });
  writeFileSync(versionFixturePath, `globalThis.__VERSION__ = ${JSON.stringify(suite.pin.version)};\nexport {};\n`);

  log(`[dogfood] styled-components@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const original = readFileSync(filePath, "utf-8");
    const transformed = transformStyledComponentsTest(original, filePath, generatedPath);
    const nativeTransformed = transformStyledComponentsTest(original, filePath, generatedPath, { normalizeCjs: true });
    // The release build replaces this compile-time constant in Rollup. The
    // upstream source tests import `SC_VERSION` through constants.ts, so the
    // adapter must provide the same package version in both execution lanes.
    const buildFixtures = `var __VERSION__ = ${JSON.stringify(suite.pin.version)};`;
    const versionImport = `import ${JSON.stringify(moduleSpecifier(dirname(generatedPath), versionFixturePath))};`;
    const source = `${versionImport}\n${buildFixtures}\n${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const nativeSource = `${versionImport}\n${buildFixtures}\n${UPSTREAM_TEST_SHIM}\n${nativeTransformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, nativeSource, timeoutMs: 240_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `styled-components@${suite.pin.version}`,
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
