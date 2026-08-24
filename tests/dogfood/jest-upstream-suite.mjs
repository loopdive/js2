// Jest 30.4.2 original utility unit slice.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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

function matchingParenthesis(source, openIndex) {
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function rewriteCurriedEachCalls(source) {
  let output = "";
  let cursor = 0;
  const callPattern = /\b(describe|it|test)(?:\.concurrent)?\.each\s*\(/g;
  while (true) {
    const match = callPattern.exec(source);
    if (!match) break;
    const firstOpen = callPattern.lastIndex - 1;
    const firstClose = matchingParenthesis(source, firstOpen);
    if (firstClose < 0) break;
    let secondOpen = firstClose + 1;
    while (/\s/.test(source[secondOpen] ?? "")) secondOpen++;
    if (source[secondOpen] !== "(") {
      callPattern.lastIndex = firstClose + 1;
      continue;
    }
    const secondClose = matchingParenthesis(source, secondOpen);
    if (secondClose < 0) break;
    output += source.slice(cursor, match.index);
    const helper = match[1] === "describe" ? "__upstreamDescribeEachDirect" : "__upstreamEachDirect";
    const secondArguments = rewriteCurriedEachCalls(source.slice(secondOpen + 1, secondClose));
    output += `${helper}(${source.slice(firstOpen + 1, firstClose)}, ${secondArguments})`;
    cursor = secondClose + 1;
    callPattern.lastIndex = cursor;
  }
  return output + source.slice(cursor);
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

function readSnapshotEntries(filePath) {
  const snapshotPath = join(dirname(filePath), "__snapshots__", `${basename(filePath)}.snap`);
  if (!existsSync(snapshotPath)) return [];
  const source = readFileSync(snapshotPath, "utf8");
  const entries = [];
  const pattern = /exports\[`((?:\\`|[^`])*)`\]\s*=\s*`([\s\S]*?)`;/g;
  for (const match of source.matchAll(pattern)) {
    const raw = match[2];
    let expected = raw;
    try {
      expected = JSON.parse(raw.trim());
    } catch {
      // Non-JSON snapshots (notably pretty-format's Object {...} form) are
      // left as their literal template value without the snapshot delimiter's
      // leading/trailing newline.
      expected = raw.trim();
    }
    entries.push([match[1].replace(/\\`/g, "`").replace(/ \d+$/, ""), expected]);
  }
  return entries;
}

function transformJestTest(source, filePath, generatedPath, { normalizeCjs = false } = {}) {
  let importIndex = 0;
  const namespaceReplacements = [];
  const defaultsUnit = filePath.endsWith(join("jest-config", "src", "__tests__", "Defaults.test.ts"));
  let transformed = source.replace(
    /import\s+((?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]+\}|[A-Za-z_$][\w$]*))\s+from\s+(["'])(\.\.?\/?[^"']*)\2;?/g,
    (_match, bindings, quote, specifier) => {
      // The original defaults unit asserts the public `defaults` singleton,
      // but importing the package index eagerly loads Jest's complete config
      // graph. Keep the upstream test body unchanged and resolve this one
      // named export to its defining module so unrelated package dependencies
      // do not make the native oracle unavailable.
      const directDefaults = defaultsUnit && specifier === "../" && bindings.replace(/\s/g, "") === "{defaults}";
      const target = resolveJestImport(filePath, directDefaults ? "../Defaults.js2wasm" : specifier);
      const rewritten = moduleSpecifier(dirname(generatedPath), target);
      if (directDefaults) return `import defaults from ${quote}${rewritten}${quote};`;
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
      const runtimeNamed = (named) => {
        if (!named.startsWith("{")) return named;
        const members = named
          .slice(1, -1)
          .split(",")
          .map((member) => member.trim())
          .filter((member) => member && !member.startsWith("type "));
        return members.length > 0 ? `{ ${members.join(", ")} }` : "";
      };
      if (bindings.startsWith("{")) {
        const named = runtimeNamed(bindings);
        return (
          `import * as ${namespaceName} from ${quote}${rewritten}${quote};` +
          (named ? `\nconst ${named} = ${normalized};` : "")
        );
      }
      if (bindings.startsWith("* as ")) {
        const name = bindings.slice("* as ".length).trim();
        return `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` + `const ${name} = ${normalized};`;
      }
      const comma = bindings.indexOf(",");
      if (comma >= 0) {
        const defaultName = bindings.slice(0, comma).trim();
        const named = runtimeNamed(bindings.slice(comma + 1).trim());
        return (
          `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` +
          `const ${defaultName} = ${normalized};` +
          (named ? `\nconst ${named} = ${normalized};` : "")
        );
      }
      return (
        `import * as ${namespaceName} from ${quote}${rewritten}${quote};\n` +
        `const ${bindings.trim()} = ${normalized};`
      );
    },
  );
  for (const { pattern, replacement } of namespaceReplacements) transformed = transformed.replace(pattern, replacement);
  // Preserve the original registration callbacks but lower Jest's curried
  // `*.each(cases)(name, body)` surface to a direct shim call. This avoids
  // requiring the Wasm lane to materialize a temporary callable with a
  // package-owned function property.
  transformed = rewriteCurriedEachCalls(transformed);
  // The original hook-error unit indexes the global object with a dynamic
  // name. Resolve that standard Jest API through the same local hook wrappers
  // so the Wasm lane does not depend on dynamic host-object property lookup.
  return transformed.replace(/\bglobalThis\[fn\]\(el\)/g, "__upstreamCallNamedHook(fn, el)");
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupJestUpstreamSuite({ force: process.env.DOGFOOD_JEST_UPSTREAM_FORCE === "1" });
  const runs = [];

  log(`[dogfood] jest@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const original = readFileSync(filePath, "utf-8");
    const transformed = transformJestTest(original, filePath, generatedPath);
    const nativeTransformed = transformJestTest(original, filePath, generatedPath, { normalizeCjs: true });
    const nodeModuleBindings = /\b__dirname\b|\b__filename\b/.test(original)
      ? `const __dirname = ${JSON.stringify(dirname(filePath))};\nconst __filename = ${JSON.stringify(filePath)};`
      : "";
    const snapshotEntries = readSnapshotEntries(filePath);
    const snapshotSetup = snapshotEntries.length
      ? `__upstreamInstallSnapshotMatcher(${JSON.stringify(snapshotEntries)});`
      : "";
    const snapshotFormatterImport = file.endsWith("expectationResultFactory.test.ts")
      ? `import {format as __upstreamPrettyFormat} from ${JSON.stringify(
          moduleSpecifier(dirname(generatedPath), join(suite.root, "node_modules/pretty-format/index.ts")),
        )};`
      : "";
    const source = `${nodeModuleBindings}\n${snapshotFormatterImport}\n${UPSTREAM_TEST_SHIM}\n${snapshotSetup}\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const nativeSource = `${nodeModuleBindings}\n${snapshotFormatterImport}\n${UPSTREAM_TEST_SHIM}\n${snapshotSetup}\n${nativeTransformed}\n${UPSTREAM_TEST_EXPORTS}`;
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
