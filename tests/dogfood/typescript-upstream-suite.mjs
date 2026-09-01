// TypeScript 5.9.3 original utility and comment-scanner unit slice.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setupTypescriptUpstreamSuite } from "./setup-typescript-upstream-suite.mjs";
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

function transformTypescriptTest(source, projectionSpecifier) {
  return source.replace(
    /^import\s+\*\s+as\s+ts\s+from\s+["']\.\.\/_namespaces\/ts\.js["'];?\s*$/m,
    `import { base64decode, base64encode, convertToBase64, getLeadingCommentRanges, parsePseudoBigInt, SyntaxKind } from ${JSON.stringify(projectionSpecifier)};\nconst ts = { base64decode, base64encode, convertToBase64, getLeadingCommentRanges, parsePseudoBigInt, SyntaxKind, sys: { base64decode: (input) => base64decode(undefined, input), base64encode: (input) => base64encode(undefined, input) } };`,
  );
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const suite = setupTypescriptUpstreamSuite();
  const utilitiesPath = join(suite.root, "src", "compiler", "utilities.ts");
  const scannerPath = join(suite.root, "src", "compiler", "scanner.ts");
  const projectionPath = join(GENERATED_ROOT, "release-utilities.ts");
  mkdirSync(dirname(projectionPath), { recursive: true });
  writeFileSync(
    projectionPath,
    exactTypescriptProjection(readFileSync(utilitiesPath, "utf-8"), readFileSync(scannerPath, "utf-8")),
  );
  const runs = [];

  log(`[dogfood] typescript@${suite.pin.version} upstream ${suite.pin.tag} (${suite.pin.commit.slice(0, 12)})`);
  for (const filePath of suite.selectedPaths) {
    const file = suite.relativePath(filePath);
    const generatedPath = join(GENERATED_ROOT, file);
    const original = readFileSync(filePath, "utf-8");
    const transformed = transformTypescriptTest(original, moduleSpecifier(dirname(generatedPath), projectionPath));
    const source = `${UPSTREAM_TEST_SHIM}\nconst assert = __qunitAssert;\n${transformed}\n${UPSTREAM_TEST_EXPORTS}`;
    const result = await compileAndRunUpstreamModule({
      generatedPath,
      source,
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
    name: `typescript@${suite.pin.version}`,
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
  return (
    selectedFiles === 4 &&
    registered === 14 &&
    scored === 14 &&
    report.extraction.nativePassed === registered &&
    report.extraction.nativeFailed === 0 &&
    modules === selectedFiles &&
    report.compile.succeeded === modules &&
    report.compile.validated === modules &&
    scored === registered &&
    report.results.passed === scored &&
    report.results.failed === 0 &&
    report.results.runtimeFailed === 0
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  cliUpstreamHarness(runHarness, { reportSucceeded: typescriptUpstreamReportSucceeded });
}
