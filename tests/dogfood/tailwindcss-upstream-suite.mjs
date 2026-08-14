// Tailwind CSS 4.3.3 original synchronous utility-unit slice.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupTailwindcssUpstreamSuite } from "./setup-tailwindcss-upstream-suite.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".tailwindcss-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "tailwindcss-upstream-suite.json");

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function transformTailwindcssTest(source, filePath, generatedPath, { normalizeCjs = false } = {}) {
  source = source.replace(/^import\s+\{[^\n]+\}\s+from\s+["']vitest["'];?\s*$/gm, "");
  let importIndex = 0;
  return source.replace(
    /import\s+\{([^}]+)\}\s+from\s+(["'])(\.\.?\/[^"']+)\2;?/g,
    (_match, bindings, quote, specifier) => {
      let target = resolve(dirname(filePath), specifier);
      if (existsSync(`${target}.ts`)) target = `${target}.ts`;
      else if (existsSync(`${target}.tsx`)) target = `${target}.tsx`;
      const rewritten = moduleSpecifier(dirname(generatedPath), target);
      if (!normalizeCjs) return `import {${bindings}} from ${quote}${rewritten}${quote};`;
      const namespaceName = `__tailwindImport${importIndex++}`;
      return (
        `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` +
        `const {${bindings}} = ${namespaceName}.default || ${namespaceName};`
      );
    },
  );
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupTailwindcssUpstreamSuite();
  const runs = [];

  log(`[dogfood] tailwindcss@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const original = readFileSync(filePath, "utf-8");
    const transformed = transformTailwindcssTest(original, filePath, generatedPath);
    const nativeTransformed = transformTailwindcssTest(original, filePath, generatedPath, { normalizeCjs: true });
    const source = `${UPSTREAM_TEST_SHIM}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const nativeSource = `${UPSTREAM_TEST_SHIM}\n${nativeTransformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({ generatedPath, source, nativeSource, timeoutMs: 240_000 });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `tailwindcss@${suite.pin.version}`,
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
