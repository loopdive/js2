// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3451 — inventory the literal Test262 harness/object-linking boundary.
 *
 * This is intentionally read-only. It derives every harness prefix through the
 * same assembler used by the authoritative runner, then reports the immutable
 * object-key cardinality and the script-global ABI the future linker must
 * preserve. Run:
 *
 *   pnpm run inventory:test262-linked-harness
 *   pnpm run inventory:test262-linked-harness -- --json
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "../src/ts-api.js";
import {
  assembleLinkedHarness,
  assembleOriginalHarness,
  type HarnessSourcePart,
  type LinkedHarnessAssembly,
  type LinkedHarnessVariant,
  type OriginalHarnessVariant,
} from "../tests/test262-original-harness.js";
import { findTestFiles, matchesPathFilter, parseMeta, shouldSkip, TEST_CATEGORIES } from "../tests/test262-runner.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));
const KEY_VERSION = 1;
const TARGET_LANES = ["js-host", "standalone"] as const;

interface DeclarationSite {
  name: string;
  part: string;
}

export interface HarnessAbiInventory {
  declaredSymbols: string[];
  duplicateDeclarations: Record<string, string[]>;
  topLevelEffectStatements: number;
}

export interface HarnessObjectInventory extends HarnessAbiInventory {
  sourceKey: string;
  /** Target-namespaced inventory keys. Production cache keys must additionally
   * include the compiler/options/runtime ABI versions described in #3451. */
  targetSourceKeys: Record<(typeof TARGET_LANES)[number], string>;
  prefixSha256: string;
  prefixBytes: number;
  orderedIncludes: string[];
  async: boolean;
  tests: number;
  potentialVariants: number;
  consumedHarnessSymbols: string[];
}

export interface LinkedHarnessInventoryReport {
  schemaVersion: 1;
  corpusRoot: string;
  discoveredTests: number;
  eligibleTests: number;
  skippedTests: number;
  rawTests: number;
  asyncTests: number;
  fixtureGraphTests: number;
  potentialVariants: number;
  potentialHarnessCompilationsPerLane: number;
  potentialHarnessSourceBytesPerLane: number;
  uniqueHarnessSourceBytesPerLane: number;
  assemblyParityChecks: number;
  uniqueHarnessSources: number;
  targetSpecificHarnessObjects: number;
  harnessObjects: HarnessObjectInventory[];
}

interface MutableHarnessObject extends HarnessObjectInventory {
  consumed: Set<string>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, out);
  }
}

function statementDeclarations(source: string, part: string): DeclarationSite[] {
  const file = ts.createSourceFile(part, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites: DeclarationSite[] = [];
  for (const statement of file.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name
    ) {
      sites.push({ name: statement.name.text, part });
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const names: string[] = [];
        bindingNames(declaration.name, names);
        for (const name of names) sites.push({ name, part });
      }
    }
  }
  return sites;
}

function topLevelEffectCount(source: string): number {
  const file = ts.createSourceFile("harness.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let effects = 0;
  for (const statement of file.statements) {
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.declarations.some((declaration) => declaration.initializer !== undefined))
        effects++;
      continue;
    }
    // Classes evaluate `extends`, computed names, and static fields/blocks.
    // All other script statements likewise participate in ordered initialization.
    effects++;
  }
  return effects;
}

export function inventoryHarnessAbi(parts: readonly HarnessSourcePart[], finalPrefix: string): HarnessAbiInventory {
  const originalSites = parts.flatMap((part) => statementDeclarations(part.source, part.name));
  const byName = new Map<string, string[]>();
  for (const site of originalSites) {
    const sites = byName.get(site.name) ?? [];
    sites.push(site.part);
    byName.set(site.name, sites);
  }

  const finalDeclarations = statementDeclarations(finalPrefix, "linked-harness.js")
    .map((site) => site.name)
    .sort();
  const duplicateDeclarations = Object.fromEntries(
    [...byName]
      .filter(([, sites]) => sites.length > 1)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sites]) => [name, sites]),
  );

  return {
    declaredSymbols: [...new Set(finalDeclarations)],
    duplicateDeclarations,
    topLevelEffectStatements: topLevelEffectCount(finalPrefix),
  };
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isBindingElement(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) ||
    (ts.isMethodDeclaration(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  );
}

function isLexicalScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node);
}

function addBinding(scope: Set<string> | undefined, name: ts.BindingName | undefined): void {
  if (!scope || !name) return;
  const found: string[] = [];
  bindingNames(name, found);
  for (const entry of found) scope.add(entry);
}

function bodyScopeDeclarations(file: ts.SourceFile): Map<ts.Node, Set<string>> {
  const declarations = new Map<ts.Node, Set<string>>();
  const scopes: ts.Node[] = [];

  const current = () => declarations.get(scopes.at(-1)!);
  const nearestFunctionOrSource = () => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i]!;
      if (ts.isSourceFile(scope) || ts.isFunctionLike(scope)) return declarations.get(scope);
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    // Declarations bind in the containing scope, before a function introduces
    // its own parameter/local scope.
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) addBinding(current(), node.name);

    const opensScope = isLexicalScope(node);
    if (opensScope) {
      declarations.set(node, new Set<string>());
      scopes.push(node);
    }

    if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) addBinding(current(), node.name);
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) addBinding(current(), parameter.name);
    }
    if (ts.isCatchClause(node)) addBinding(current(), node.variableDeclaration?.name);
    if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const blockScoped =
        ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      addBinding(blockScoped ? current() : nearestFunctionOrSource(), node.name);
    }

    ts.forEachChild(node, visit);
    if (opensScope) scopes.pop();
  };
  visit(file);
  return declarations;
}

/**
 * Return the harness-declared identifier roots consumed by a body. The scan is
 * syntax-aware (property names and declaration sites are excluded) and removes
 * names shadowed by body declarations. It deliberately does not infer dynamic
 * string/globalThis lookups; those remain runtime ABI requirements.
 */
export function consumedHarnessSymbols(body: string, declaredSymbols: readonly string[]): string[] {
  const candidates = new Set(declaredSymbols);
  const file = ts.createSourceFile("body.js", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = bodyScopeDeclarations(file);
  const scopes: ts.Node[] = [];
  const consumed = new Set<string>();
  const visit = (node: ts.Node): void => {
    const opensScope = isLexicalScope(node);
    if (opensScope) scopes.push(node);
    const shadowed = (name: string) => scopes.some((scope) => declarations.get(scope)?.has(name) === true);
    if (ts.isIdentifier(node) && candidates.has(node.text) && !shadowed(node.text) && !isDeclarationName(node)) {
      consumed.add(node.text);
    }
    ts.forEachChild(node, visit);
    if (opensScope) scopes.pop();
  };
  visit(file);
  return [...consumed].sort();
}

export function harnessObjectSourceKey(assembly: LinkedHarnessAssembly): string {
  if (assembly.raw) return "raw";
  const orderedIncludes = assembly.harnessParts
    .map((part) => part.name)
    .filter((name) => !name.startsWith("__js2wasm_") && name !== "assert.js" && name !== "sta.js");
  return sha256(
    JSON.stringify({
      version: KEY_VERSION,
      async: assembly.async,
      orderedIncludes,
      prefixSha256: sha256(assembly.harnessPrefix),
    }),
  );
}

function newHarnessObject(assembly: LinkedHarnessAssembly): MutableHarnessObject {
  const sourceKey = harnessObjectSourceKey(assembly);
  const abi = inventoryHarnessAbi(assembly.harnessParts, assembly.harnessPrefix);
  const orderedIncludes = assembly.harnessParts
    .map((part) => part.name)
    .filter(
      (name) =>
        !name.startsWith("__js2wasm_") &&
        name !== "assert.js" &&
        name !== "sta.js" &&
        !(assembly.async && name === "doneprintHandle.js"),
    );
  return {
    sourceKey,
    targetSourceKeys: {
      "js-host": `js-host:${sourceKey}`,
      standalone: `standalone:${sourceKey}`,
    },
    prefixSha256: sha256(assembly.harnessPrefix),
    prefixBytes: Buffer.byteLength(assembly.harnessPrefix),
    orderedIncludes,
    async: assembly.async,
    tests: 0,
    potentialVariants: 0,
    consumedHarnessSymbols: [],
    consumed: new Set<string>(),
    ...abi,
  };
}

function verifyVariantSplit(
  body: string,
  linkedPrefix: string,
  linked: LinkedHarnessVariant,
  original: OriginalHarnessVariant,
  label: string,
): void {
  const directive = original.strict ? '"use strict";\n' : "";
  const originalPrefix = original.source.slice(0, original.source.length - body.length);
  const strictNeutralPrefix = original.strict ? originalPrefix.slice(directive.length) : originalPrefix;
  if (strictNeutralPrefix !== linkedPrefix) {
    throw new Error(`${label}: linked harness prefix differs from the authoritative assembly`);
  }
  if (linked.bodySource !== directive + body) {
    throw new Error(`${label}: linked body unit differs from the authoritative body/strictness`);
  }
  if (linked.bodyLineOffset !== (original.strict ? 1 : 0)) {
    throw new Error(`${label}: linked body line offset is inconsistent`);
  }
}

function verifyAssemblySplit(
  body: string,
  meta: ReturnType<typeof parseMeta>,
  linked: LinkedHarnessAssembly,
  label: string,
): number {
  const original = assembleOriginalHarness(body, meta);
  verifyVariantSplit(body, linked.harnessPrefix, linked.primary, original.primary, `${label} [primary]`);
  if ((linked.strictRerun === undefined) !== (original.strictRerun === undefined)) {
    throw new Error(`${label}: linked/original strict-rerun gating differs`);
  }
  if (linked.strictRerun && original.strictRerun) {
    verifyVariantSplit(body, linked.harnessPrefix, linked.strictRerun, original.strictRerun, `${label} [strict]`);
  }
  return linked.strictRerun ? 2 : 1;
}

export function buildLinkedHarnessInventory(): LinkedHarnessInventoryReport {
  const includeProposals = process.env.TEST262_INCLUDE_PROPOSALS === "1";
  const seen = new Set<string>();
  const objects = new Map<string, MutableHarnessObject>();
  let discoveredTests = 0;
  let eligibleTests = 0;
  let skippedTests = 0;
  let rawTests = 0;
  let asyncTests = 0;
  let fixtureGraphTests = 0;
  let potentialVariants = 0;
  let assemblyParityChecks = 0;

  for (const category of TEST_CATEGORIES) {
    for (const filePath of findTestFiles(category)) {
      const relPath = relative(TEST262_ROOT, filePath);
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      discoveredTests++;
      if (!matchesPathFilter(relPath)) continue;
      if (!includeProposals && (relPath.startsWith("test/staging/") || relPath.startsWith("staging/"))) continue;

      const body = readFileSync(filePath, "utf8");
      const meta = parseMeta(body);
      if (!meta.negative) {
        const filter = shouldSkip(body, meta, filePath);
        if (filter.skip) {
          skippedTests++;
          continue;
        }
      }

      eligibleTests++;
      const assembly = assembleLinkedHarness(body, meta);
      const variants = assembly.strictRerun ? 2 : 1;
      assemblyParityChecks += verifyAssemblySplit(body, meta, assembly, relPath);
      potentialVariants += variants;
      if (assembly.async) asyncTests++;
      if (/(?:from\s*|import\s*\(|require\s*\()["'][^"']*_FIXTURE\.js["']/.test(body)) fixtureGraphTests++;
      if (assembly.raw) {
        rawTests++;
        continue;
      }

      const key = harnessObjectSourceKey(assembly);
      let object = objects.get(key);
      if (!object) {
        object = newHarnessObject(assembly);
        objects.set(key, object);
      }
      object.tests++;
      object.potentialVariants += variants;
      for (const name of consumedHarnessSymbols(body, object.declaredSymbols)) object.consumed.add(name);
    }
  }

  const harnessObjects = [...objects.values()]
    .map(({ consumed, ...object }) => ({
      ...object,
      consumedHarnessSymbols: [...consumed].sort(),
    }))
    .sort((a, b) => b.tests - a.tests || a.sourceKey.localeCompare(b.sourceKey));
  const potentialHarnessCompilationsPerLane = harnessObjects.reduce((sum, object) => sum + object.potentialVariants, 0);
  const potentialHarnessSourceBytesPerLane = harnessObjects.reduce(
    (sum, object) => sum + object.prefixBytes * object.potentialVariants,
    0,
  );
  const uniqueHarnessSourceBytesPerLane = harnessObjects.reduce((sum, object) => sum + object.prefixBytes, 0);

  return {
    schemaVersion: 1,
    corpusRoot: relative(ROOT, TEST262_ROOT) || "test262",
    discoveredTests,
    eligibleTests,
    skippedTests,
    rawTests,
    asyncTests,
    fixtureGraphTests,
    potentialVariants,
    potentialHarnessCompilationsPerLane,
    potentialHarnessSourceBytesPerLane,
    uniqueHarnessSourceBytesPerLane,
    assemblyParityChecks,
    uniqueHarnessSources: harnessObjects.length,
    targetSpecificHarnessObjects: harnessObjects.length * TARGET_LANES.length,
    harnessObjects,
  };
}

function printSummary(report: LinkedHarnessInventoryReport): void {
  const duplicateKeys = report.harnessObjects.filter(
    (object) => Object.keys(object.duplicateDeclarations).length > 0,
  ).length;
  const consumed = new Set(report.harnessObjects.flatMap((object) => object.consumedHarnessSymbols));
  const duplicates = new Set(report.harnessObjects.flatMap((object) => Object.keys(object.duplicateDeclarations)));
  console.log("#3451 Test262 linked-harness inventory");
  console.log(`discovered tests: ${report.discoveredTests}`);
  console.log(`eligible tests: ${report.eligibleTests} (${report.skippedTests} filtered)`);
  console.log(`potential body variants: ${report.potentialVariants}`);
  console.log(`raw bypass tests: ${report.rawTests}`);
  console.log(`async tests: ${report.asyncTests}`);
  console.log(`fixture-graph tests: ${report.fixtureGraphTests}`);
  console.log(`authoritative assembly split checks: ${report.assemblyParityChecks}`);
  console.log(`unique strict-neutral harness sources: ${report.uniqueHarnessSources}`);
  console.log(`target-specific harness objects (two lanes): ${report.targetSpecificHarnessObjects}`);
  console.log(
    `potential harness compiles per lane: ${report.potentialHarnessCompilationsPerLane} -> ` +
      `${report.uniqueHarnessSources}`,
  );
  console.log(
    `potential harness source bytes per lane: ${report.potentialHarnessSourceBytesPerLane} -> ` +
      `${report.uniqueHarnessSourceBytesPerLane}`,
  );
  console.log(`keys with duplicate top-level declarations: ${duplicateKeys}`);
  console.log(`duplicate declaration names: ${[...duplicates].sort().join(", ") || "(none)"}`);
  console.log(`distinct consumed harness symbols: ${consumed.size}`);
  console.log(`consumed harness symbols: ${[...consumed].sort().join(", ")}`);
  console.log("largest harness keys:");
  for (const object of report.harnessObjects.slice(0, 12)) {
    console.log(
      `  ${object.tests} tests / ${object.potentialVariants} variants / ${object.prefixBytes} bytes / ` +
        `${object.orderedIncludes.join(",") || "(base harness)"}`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = buildLinkedHarnessInventory();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
}
