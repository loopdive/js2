// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared Test262 fixture-graph discovery for the project and test262.fyi
// runners. This module deliberately performs no compilation and imports no
// optional test262.fyi code, so both verdict lanes can use one graph oracle.
import fs from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(ROOT, "test262");

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

// Keep quoted module specifiers intact while hiding comments and templates
// from the small import recognizers below. Test262 frontmatter often contains
// import examples which must not become real graph edges.
function maskCommentsAndTemplates(source) {
  const masked = source.split("");
  let quote;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" || (char === "/" && (next === "/" || next === "*"))) {
      const lineComment = char === "/" && next === "/";
      const blockComment = char === "/" && next === "*";
      const closing = blockComment ? "*/" : char;
      masked[index] = " ";
      if (blockComment || lineComment) masked[++index] = " ";
      for (index++; index < source.length; index++) {
        const current = source[index];
        if (current !== "\n" && current !== "\r") masked[index] = " ";
        if (lineComment && (current === "\n" || current === "\r")) break;
        if (!lineComment && current === "\\") {
          if (index + 1 < source.length) masked[++index] = " ";
          continue;
        }
        if (!lineComment && source.startsWith(closing, index)) {
          if (closing.length === 2) masked[++index] = " ";
          break;
        }
      }
    }
  }
  return masked.join("");
}

/** Return relative static import/export specifiers ending in `_FIXTURE.js`. */
export function staticFixtureSpecifiers(source) {
  const masked = maskCommentsAndTemplates(source);
  const declaration =
    /(?:^|[;\r\n])\s*(?:import\s+(?!\s*[.(])(?:(?:(?!;).)*?\bfrom\s*)?|export\s+(?:(?!;).)*?\bfrom\s*)(['"])([^'"]*_FIXTURE\.js)\1/gms;
  const specifiers = [];
  let match;
  while ((match = declaration.exec(masked)) !== null) specifiers.push(match[2]);
  return [...new Set(specifiers)];
}

/**
 * Return literal dynamic-import fixture specifiers. They are recorded
 * separately because js2's standalone backend cannot host `import()` yet;
 * treating them as eager static edges would silently change module semantics.
 */
export function dynamicFixtureSpecifiers(source) {
  const masked = maskCommentsAndTemplates(source);
  const dynamicImport = /\bimport\s*\(\s*(['"])([^'"]*_FIXTURE\.js)\1(?:\s*,[^)]*)?\)/gms;
  const specifiers = [];
  let match;
  while ((match = dynamicImport.exec(masked)) !== null) specifiers.push(match[2]);
  return [...new Set(specifiers)];
}

function resolveFixture(testRoot, importerPath, specifier, required = true) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error(`fixture specifier must be relative in ${importerPath}: ${specifier}`);
  }
  const absolute = resolve(testRoot, dirname(importerPath), specifier);
  if (absolute !== testRoot && !absolute.startsWith(`${testRoot}${sep}`)) {
    throw new Error(`fixture escapes pinned Test262 test root in ${importerPath}: ${specifier}`);
  }
  const fixturePath = relative(testRoot, absolute).replaceAll("\\", "/");
  if (!fixturePath.endsWith("_FIXTURE.js")) {
    throw new Error(`invalid Test262 fixture path in ${importerPath}: ${specifier}`);
  }
  const exists = fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  if (required && !exists) {
    throw new Error(`missing Test262 fixture imported by ${importerPath}: ${specifier}`);
  }
  return { absolute, fixturePath, exists };
}

/**
 * Read the reachable static Test262 fixture graph for one entry and separately
 * inventory literal dynamic fixture imports. Static keys stay rooted at the
 * pinned Test262 `test/` tree. Dynamic files are never promoted to static
 * edges; runners can reject an unsupported target without changing execution.
 */
export function discoverFixtureGraph(testPath, entrySource, { test262Root = TEST262_ROOT } = {}) {
  const normalizedEntry = normalizeTestPath(testPath);
  const testRoot = resolve(test262Root, "test");
  const fixtureFiles = {};
  const dynamicFixtureFiles = {};
  const visited = new Set();

  const visit = (importerPath, source) => {
    for (const specifier of dynamicFixtureSpecifiers(source)) {
      const { absolute, fixturePath, exists } = resolveFixture(testRoot, importerPath, specifier, false);
      // Dynamic imports are runtime edges, not eager compileMulti inputs. Some
      // parse-negative Test262 cases intentionally name a conventional
      // `empty_FIXTURE.js` which is absent because evaluation must never be
      // reached. Preserve the edge for standalone's honest #3494 verdict, but
      // do not let an unevaluated target abort discovery of the whole corpus.
      dynamicFixtureFiles[`./${fixturePath}`] = exists ? fs.readFileSync(absolute, "utf8") : null;
    }

    for (const specifier of staticFixtureSpecifiers(source)) {
      const { absolute, fixturePath } = resolveFixture(testRoot, importerPath, specifier);
      if (visited.has(fixturePath)) continue;
      visited.add(fixturePath);
      const fixtureSource = fs.readFileSync(absolute, "utf8");
      fixtureFiles[`./${fixturePath}`] = fixtureSource;
      visit(fixturePath, fixtureSource);
    }
  };

  visit(normalizedEntry, entrySource);
  return {
    entryFile: `./${normalizedEntry}`,
    fixtureFiles,
    dynamicFixtureFiles,
  };
}
