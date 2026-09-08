// TypeScript 5.9.3 original core, utility, and comment-scanner unit slice.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupTypescriptUpstreamSuite } from "./setup-typescript-upstream-suite.mjs";
import { setupTypescriptRuntime } from "./setup-typescript-runtime.mjs";
import {
  UPSTREAM_TEST_EXPORTS,
  UPSTREAM_TEST_SHIM,
  cliUpstreamHarness,
  compileAndRunUpstreamModule,
  summarizeUpstreamRuns,
  writeUpstreamReport,
} from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = resolve(HERE, "..", "..", ".typescript-upstream-suite-generated");
const REPORT_PATH = join(HERE, "report", "typescript-upstream-suite.json");

export function typescriptUpstreamTarget(value) {
  if (value === undefined) return "gc";
  if (value === "gc" || value === "standalone") return value;
  throw new Error(`DOGFOOD_TARGET expects gc or standalone, received ${JSON.stringify(value)}`);
}

// The regular adapter exports strings, arrays, and an async callback entrypoint
// because the default WasmGC lane intentionally crosses the JavaScript host
// boundary through wrapExports(). Standalone cannot use that bridge without
// ceasing to be standalone. Its selected TypeScript callbacks are synchronous,
// so expose exactly one numeric-index/numeric-result entrypoint that raw Wasm
// exports can execute without an import object or value marshalling.
export const TYPESCRIPT_STANDALONE_TEST_EXPORTS = String.raw`
export function runStandaloneUpstreamTest(index: number): number {
  __upstreamAssertion = 0;
  __upstreamCurrentTestName = __upstreamTests[index].name;
  const beforeAllHooks = __upstreamTests[index].beforeAllHooks || [];
  for (let hookIndex = 0; hookIndex < beforeAllHooks.length; hookIndex++) {
    const hook = beforeAllHooks[hookIndex];
    if (!hook.__upstreamRan) { hook(); hook.__upstreamRan = true; }
  }
  const result = __upstreamTests[index].body(__qunitAssert);
  if (result && typeof result.then === "function") {
    throw new Error("standalone raw runner cannot execute an async upstream callback");
  }
  if (index === __upstreamTests.length - 1) {
    const afterAllHooks = __upstreamTests[index].afterAllHooks || [];
    for (let hookIndex = afterAllHooks.length - 1; hookIndex >= 0; hookIndex--) {
      const hook = afterAllHooks[hookIndex];
      if (!hook.__upstreamRan) { hook(); hook.__upstreamRan = true; }
    }
  }
  return 1;
}
`;

function typescriptTargetProvenance(requestedTarget, details) {
  const actualTargets = [...new Set(details.map((detail) => detail.actualTarget ?? null))];
  const importArtifacts = details.flatMap((detail) => [
    {
      file: detail.file,
      artifact: "entry",
      imports: detail.moduleImports ?? null,
    },
    ...(detail.linkedModuleImports ?? []).map((linked) => ({
      file: detail.file,
      artifact: linked.namespace,
      imports: linked.imports ?? null,
    })),
  ]);
  const importsKnown = importArtifacts.every((artifact) => Array.isArray(artifact.imports));
  const moduleImportCount = importsKnown
    ? importArtifacts.reduce((count, artifact) => count + artifact.imports.length, 0)
    : null;
  return {
    requestedTarget,
    actualTargets,
    importArtifacts: importArtifacts.map(({ file, artifact, imports }) => ({
      file,
      artifact,
      moduleImportCount: Array.isArray(imports) ? imports.length : null,
    })),
    moduleImportCount,
    zeroImports: moduleImportCount === 0,
  };
}

function moduleSpecifier(fromDirectory, target) {
  let value = relative(fromDirectory, target).replace(/\\/g, "/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`TypeScript utility marker changed: ${marker}`);
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error(`TypeScript utility body marker changed: ${marker}`);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index++) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (current === "\\") index++;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      continue;
    }
    if (current === "{") depth++;
    else if (current === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`TypeScript utility function is unterminated: ${marker}`);
}

function extractLine(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`TypeScript utility marker changed: ${marker}`);
  const end = source.indexOf("\n", start);
  return source.slice(start, end < 0 ? source.length : end);
}

function exactTypescriptCoreProjection(coreSource) {
  coreSource = coreSource.replace(/\r\n/g, "\n");
  const coreDeclarations = [
    extractLine(coreSource, "const hasOwnProperty ="),
    extractFunction(coreSource, "export function equateValues"),
    extractFunction(coreSource, "export function contains"),
    extractFunction(coreSource, "function unorderedRemoveItemAt"),
    extractFunction(coreSource, "export function isArray"),
    extractFunction(coreSource, "export function arrayFrom<T, U>(iterator: Iterable<T>, map?:"),
    extractFunction(coreSource, "export function equalOwnProperties"),
    extractFunction(coreSource, "export function createSet"),
  ].join("\n\n");
  return `type EqualityComparer<T> = (a: T, b: T) => boolean;\ninterface MapLike<T> { [key: string]: T; }\n${coreDeclarations}`;
}

function exactTypescriptProjection(utilitiesSource, scannerSource) {
  utilitiesSource = utilitiesSource.replace(/\r\n/g, "\n");
  scannerSource = scannerSource.replace(/\r\n/g, "\n");
  const startMarker = "/**\n * Replace each instance of non-ascii characters";
  const endMarker = "/** @internal */\nexport function readJsonOrUndefined";
  const start = utilitiesSource.indexOf(startMarker);
  const end = utilitiesSource.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("TypeScript base64 implementation markers changed");
  const declarations = utilitiesSource.slice(start, end);
  const parsePseudoBigInt = extractFunction(utilitiesSource, "export function parsePseudoBigInt");
  const scannerDeclarations = [
    extractFunction(scannerSource, "export function isWhiteSpaceLike"),
    extractFunction(scannerSource, "export function isWhiteSpaceSingleLine"),
    extractFunction(scannerSource, "export function isLineBreak"),
    extractLine(scannerSource, "const shebangTriviaRegex"),
    extractFunction(scannerSource, "function iterateCommentRanges"),
    extractFunction(scannerSource, "export function reduceEachLeadingCommentRange"),
    extractFunction(scannerSource, "function appendCommentRange"),
    extractFunction(scannerSource, "export function getLeadingCommentRanges"),
    extractFunction(scannerSource, "export function getShebang"),
  ].join("\n\n");
  const characterCodes = `const CharacterCodes = {
  maxAsciiCharacter: 0x7f,
  lineFeed: 0x0a,
  carriageReturn: 0x0d,
  lineSeparator: 0x2028,
  paragraphSeparator: 0x2029,
  nextLine: 0x0085,
  space: 0x20,
  nonBreakingSpace: 0x00a0,
  enQuad: 0x2000,
  zeroWidthSpace: 0x200b,
  narrowNoBreakSpace: 0x202f,
  ideographicSpace: 0x3000,
  mathematicalSpace: 0x205f,
  ogham: 0x1680,
  _0: 0x30,
  _9: 0x39,
  A: 0x41,
  B: 0x42,
  F: 0x46,
  O: 0x4f,
  X: 0x58,
  a: 0x61,
  b: 0x62,
  o: 0x6f,
  x: 0x78,
  asterisk: 0x2a,
  slash: 0x2f,
  formFeed: 0x0c,
  byteOrderMark: 0xfeff,
  tab: 0x09,
  verticalTab: 0x0b,
} as const;`;
  const scannerTypes = `interface TextRange { pos: number; end: number; }
export const SyntaxKind = { SingleLineCommentTrivia: 2, MultiLineCommentTrivia: 3 } as const;
type CommentKind = typeof SyntaxKind.SingleLineCommentTrivia | typeof SyntaxKind.MultiLineCommentTrivia;
interface CommentRange extends TextRange { hasTrailingNewLine?: boolean; kind: CommentKind; }`;
  return `const Debug = { assert(value: boolean, message?: string) { if (!value) throw new Error(message || "Debug assertion failed"); } };\n${characterCodes}\n${scannerTypes}\n${declarations}\n${parsePseudoBigInt}\n${scannerDeclarations}`;
}

export function transformTypescriptTest(source, projectionSpecifier, bufferSpecifier) {
  const members = /\bts\.(arrayFrom|createSet|equalOwnProperties)\b/.test(source)
    ? "arrayFrom, createSet, equalOwnProperties"
    : "base64decode, base64encode, convertToBase64, getLeadingCommentRanges, parsePseudoBigInt, SyntaxKind";
  const runtime = bufferSpecifier ? `import { Buffer } from ${JSON.stringify(bufferSpecifier)};\n` : "";
  const system = bufferSpecifier
    ? `{ base64decode: (input) => Buffer.from(input, "base64").toString("utf8"), base64encode: (input) => Buffer.from(input, "utf8").toString("base64") }`
    : "{}";
  return (
    runtime +
    source.replace(
      /^import\s+\*\s+as\s+ts\s+from\s+["']\.\.\/_namespaces\/ts\.js["'];?\s*$/m,
      `import { ${members} } from ${JSON.stringify(projectionSpecifier)};\nconst ts = { ${members}, sys: ${system} };`,
    )
  );
}

export async function runHarness({ quiet = false, target = process.env.DOGFOOD_TARGET } = {}) {
  const requestedTarget = typescriptUpstreamTarget(target);
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupTypescriptUpstreamSuite();
  const runtime = setupTypescriptRuntime();
  const utilitiesPath = join(suite.root, "src", "compiler", "utilities.ts");
  const scannerPath = join(suite.root, "src", "compiler", "scanner.ts");
  const projectionPath = join(GENERATED_ROOT, "release-utilities.ts");
  const coreProjectionPath = join(GENERATED_ROOT, "release-core.ts");
  mkdirSync(dirname(projectionPath), { recursive: true });
  writeFileSync(
    projectionPath,
    exactTypescriptProjection(readFileSync(utilitiesPath, "utf-8"), readFileSync(scannerPath, "utf-8")),
  );
  writeFileSync(
    coreProjectionPath,
    exactTypescriptCoreProjection(readFileSync(join(suite.root, "src", "compiler", "core.ts"), "utf-8")),
  );
  const runs = [];

  log(
    `[dogfood] typescript@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)}), target=${requestedTarget}`,
  );
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const original = readFileSync(filePath, "utf-8");
    const transformed = transformTypescriptTest(
      original,
      moduleSpecifier(dirname(generatedPath), file.endsWith("/compilerCore.ts") ? coreProjectionPath : projectionPath),
      /\bBuffer\b|\bts\.sys\b/.test(original) ? moduleSpecifier(dirname(generatedPath), runtime.entry) : undefined,
    );
    const source = `${UPSTREAM_TEST_SHIM}\nconst assert = __qunitAssert;\n${transformed}\n${UPSTREAM_TEST_EXPORTS}${
      requestedTarget === "standalone" ? TYPESCRIPT_STANDALONE_TEST_EXPORTS : ""
    }`;
    const result = await compileAndRunUpstreamModule({
      generatedPath,
      source,
      timeoutMs: 240_000,
      workerEnv:
        requestedTarget === "standalone"
          ? {
              DOGFOOD_TARGET: "standalone",
              DOGFOOD_PLATFORM: undefined,
              DOGFOOD_NODE_HOST_DEPS: undefined,
              DOGFOOD_INSTALL_JSDOM: undefined,
            }
          : { DOGFOOD_TARGET: "gc", DOGFOOD_PLATFORM: "node" },
    });
    runs.push({ file, result });
    log(
      `[dogfood] ${file}: ${result.native.statuses.filter(Boolean).length}/${result.native.count} native; ` +
        `${result.wasm?.statuses.filter(Boolean).length ?? 0}/${result.native.count} Wasm`,
    );
  }

  const report = summarizeUpstreamRuns({
    name: `typescript@${suite.pin.version}`,
    pin: suite.pin,
    testFiles: suite.testFiles,
    selectedFiles: suite.pin.selectedFiles,
    runs,
  });
  report.target = typescriptTargetProvenance(requestedTarget, report.compile.details);
  report.runtime = { oracleVersion: 3, packages: runtime.pins };
  writeUpstreamReport(REPORT_PATH, report);
  log(`[dogfood] ${report.summary.headline}; ${report.extraction.filesDeferred} upstream files explicitly deferred`);
  log(`[dogfood] report → ${REPORT_PATH}`);
  return report;
}

/**
 * TypeScript's adapter is an intentionally pinned slice, so its CLI can be a
 * strict gate: every selected callback must be native-compatible, every
 * generated module must validate, and every admitted callback must pass in
 * Wasm. Keep the positive floors here so an empty/partially extracted run
 * cannot look like an all-green result.
 */
export function typescriptUpstreamReportSucceeded(report) {
  const selectedFiles = report?.upstreamSuite?.selectedFiles?.length ?? 0;
  const registered = report?.extraction?.testsRegistered ?? 0;
  const scored = report?.results?.scored ?? 0;
  const modules = report?.compile?.modules ?? 0;
  const requestedTarget = report?.target?.requestedTarget;
  const targetDetails = report?.compile?.details;
  const explicitTargetAccepted =
    report?.target !== undefined &&
    (requestedTarget === "gc" || requestedTarget === "standalone") &&
    Array.isArray(targetDetails) &&
    targetDetails.length === modules &&
    report.target.actualTargets?.length === 1 &&
    report.target.actualTargets[0] === requestedTarget &&
    targetDetails.every(
      (detail) =>
        detail.requestedTarget === requestedTarget &&
        detail.actualTarget === requestedTarget &&
        detail.targetMatches === true,
    ) &&
    (requestedTarget !== "standalone" ||
      (report.target.moduleImportCount === 0 &&
        report.target.zeroImports === true &&
        targetDetails.every(
          (detail) =>
            detail.importPolicyMatches === true &&
            Array.isArray(detail.moduleImports) &&
            detail.moduleImports.length === 0 &&
            Array.isArray(detail.linkedModuleImports) &&
            detail.linkedModuleImports.every((linked) => Array.isArray(linked.imports) && linked.imports.length === 0),
        ))) &&
    targetDetails.every(
      (detail) =>
        Number.isSafeInteger(detail.nativeTestCount) &&
        detail.nativeTestCount > 0 &&
        detail.nativeStatusCount === detail.nativeTestCount &&
        detail.wasmTestCount === detail.nativeTestCount &&
        detail.wasmStatusCount === detail.wasmTestCount,
    );
  return (
    selectedFiles === 5 &&
    registered === 25 &&
    scored === 25 &&
    report.extraction.nativePassed === registered &&
    report.extraction.nativeFailed === 0 &&
    modules === selectedFiles &&
    report.compile.succeeded === modules &&
    report.compile.validated === modules &&
    scored === registered &&
    report.results.passed === scored &&
    report.results.failed === 0 &&
    report.results.runtimeFailed === 0 &&
    explicitTargetAccepted
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  cliUpstreamHarness(runHarness, { reportSucceeded: typescriptUpstreamReportSucceeded });
}
