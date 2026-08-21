// Jest 30.4.2 original @jest/get-type and @jest/util unit slice.

import { readFileSync, statSync } from "node:fs";
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
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
    join(base, "index.jsx"),
  ];
  const target = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!target) throw new Error(`[dogfood] Jest relative import not found: ${specifier} from ${filePath}`);
  return target;
}

function transformJestTest(source, filePath, generatedPath, { normalizeCjs = false } = {}) {
  let importIndex = 0;
  const namespaceReplacements = [];
  let transformed = source.replace(
    /import\s+((?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]+\}|[A-Za-z_$][\w$]*))\s+from\s+(["'])(\.\.?\/?[^"']*)\2;?/g,
    (_match, bindings, quote, specifier) => {
      const target = resolveJestImport(filePath, specifier);
      const rewritten = moduleSpecifier(dirname(generatedPath), target);
      const namespaceName = `__jestImport${importIndex++}`;
      // The compiler's internal-module namespace value is demand-driven,
      // while Jest's source tests use `import * as x` as a plain object.
      // Rebind only the members the original test reads through named
      // imports; this preserves the upstream body without requiring a whole
      // module namespace carrier at runtime.
      if (bindings.startsWith("* as ")) {
        const name = bindings.slice("* as ".length).trim();
        const members = [...source.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, "g"))]
          .map((match) => match[1])
          .filter((member, index, values) => values.indexOf(member) === index);
        if (members.length > 0) {
          const imported = members.map((member) => `${member} as ${namespaceName}_${member}`).join(", ");
          namespaceReplacements.push({
            pattern: new RegExp(`\\b${name}\\.(${members.join("|")})\\b`, "g"),
            replacement: (_full, member) => `${namespaceName}_${member}`,
          });
          return `import { ${imported} } from ${quote}${rewritten}${quote};`;
        }
      }
      if (!normalizeCjs) return `import ${bindings} from ${quote}${rewritten}${quote};`;
      const normalized = `${namespaceName}.default?.default ?? ${namespaceName}.default ?? ${namespaceName}`;
      if (bindings.startsWith("{")) {
        return (
          `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` + `const ${bindings} = ${normalized};`
        );
      }
      if (bindings.startsWith("* as ")) {
        const name = bindings.slice("* as ".length).trim();
        return `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` + `const ${name} = ${normalized};`;
      }
      const comma = bindings.indexOf(",");
      if (comma >= 0) {
        const defaultName = bindings.slice(0, comma).trim();
        const named = bindings.slice(comma + 1).trim();
        return (
          `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` +
          `const ${defaultName} = ${normalized};\n` +
          `const ${named} = ${normalized};`
        );
      }
      return (
        `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` +
        `const ${bindings.trim()} = ${normalized};`
      );
    },
  );
  for (const { pattern, replacement } of namespaceReplacements) transformed = transformed.replace(pattern, replacement);
  return transformed;
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
