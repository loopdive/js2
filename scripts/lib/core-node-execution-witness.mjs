// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import inspector from "node:inspector";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const CORE = "src/ir/core/nodes.ts";
const PUBLIC = "src/index.ts";
const FACADE = "src/ir/nodes.ts";
const LOADER_OVERRIDE_KEYS = Object.freeze(["ESBUILD_BINARY_PATH", "TSX_TSCONFIG_PATH", "TSX_DISABLE_CACHE"]);
const FREE = Object.freeze([
  "asValueId",
  "asLabelId",
  "asAllocSiteId",
  "asBlockId",
  "forEachNestedBuffer",
  "forEachInstrDeep",
  "mapNestedBuffers",
  "directUses",
  "collectUses",
]);
export const CORE_NODE_EXECUTION_TARGETS = Object.freeze([
  ...FREE,
  "IrValueIdAllocator.constructor",
  "IrValueIdAllocator.fresh",
  "IrValueIdAllocator.count",
]);
export const CORE_NODE_EXECUTION_PROGRAMS = Object.freeze(
  [
    {
      name: "scalar",
      source: "export function run(a: number): number { return a * 2 + 1; }",
      args: [42],
      expected: 85,
    },
    {
      name: "vector",
      source: "export function run(): number { const values: number[] = [20, 22]; return values[0] + values[1]; }",
      args: [],
      expected: 42,
    },
    {
      name: "record",
      source:
        "export function run(): number { const value = { left: 20, right: 22 }; return value.left + value.right; }",
      args: [],
      expected: 42,
    },
    {
      name: "class",
      source:
        "class Counter { value: number; constructor(value: number) { this.value = value; } add(step: number): number { return this.value + step; } } export function run(): number { return new Counter(40).add(2); }",
      args: [],
      expected: 42,
    },
    {
      name: "closure",
      source:
        "export function run(): number { const base: number = 40; const add = (v: number): number => base + v; return add(2); }",
      args: [],
      expected: 42,
    },
    {
      name: "loop",
      source:
        "export function run(n: number): number { let sum: number = 0; for (let i: number = 0; i < n; i++) { if (i === 3) continue; sum += i; } return sum; }",
      args: [7],
      expected: 18,
    },
  ].map((row) => Object.freeze({ ...row, args: Object.freeze(row.args) })),
);
const OPTIONS = Object.freeze({ target: "standalone", optimize: false, experimentalIR: true, trackIrOutcomes: true });
const LIMITS = Object.freeze({
  cutAssessed: false,
  cutWitnessCount: null,
  cutStatus: "unknown",
  closureCertified: false,
  retirementCertified: false,
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const same = isDeepStrictEqual;
const read = (root, path) => readFileSync(resolve(root, path), "utf8");
const sourceHash = (root, path) => hash(read(root, path));

function fileIdentity(path) {
  path = realpathSync(path);
  return { path, sha256: hash(readFileSync(path)) };
}

function packageIdentity(path) {
  const directory = dirname(realpathSync(path)),
    files = {};
  function walk(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue;
      const name = prefix + entry.name,
        path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path, `${name}/`);
      else files[name] = fileIdentity(path);
    }
  }
  walk(directory);
  check(Object.keys(files).length > 1, `empty loader implementation: ${directory}`);
  return {
    directory,
    version: JSON.parse(readFileSync(path, "utf8")).version,
    files,
    sha256: hash(JSON.stringify(files)),
  };
}

/** Capture only the overrides supported by the installed loader/transformer.
 * Null means absent, distinct from an explicitly supplied empty string.
 */
export function coreNodeExecutionLoaderOverrides(env = process.env) {
  return Object.fromEntries(LOADER_OVERRIDE_KEYS.map((key) => [key, env[key] ?? null]));
}

function validateLoaderOverrides(root, overrides) {
  check(
    overrides && same(Object.keys(overrides).sort(), [...LOADER_OVERRIDE_KEYS].sort()),
    "missing/unknown loader override fields",
  );
  // The supported canonical launch uses esbuild's authenticated package binary
  // resolution, never an alternate executable selected by the environment.
  check(overrides.ESBUILD_BINARY_PATH === null, "ESBUILD_BINARY_PATH must be unset for the canonical loader");
  check(
    overrides.TSX_TSCONFIG_PATH === resolve(root, "tsconfig.json"),
    "TSX_TSCONFIG_PATH must equal canonical root/tsconfig.json",
  );
  check(overrides.TSX_DISABLE_CACHE === "1", "TSX_DISABLE_CACHE must equal '1'");
}

/** Read-only, compiler-free identity census shared by the parent and child.
 * The parent supplies its independently planned child launch, not report data.
 */
export function coreNodeExecutionRuntimeIdentity({ root, launch }) {
  root = realpathSync(root);
  check(
    launch &&
      Array.isArray(launch.execArgv) &&
      Array.isArray(launch.argv) &&
      typeof launch.nodeOptions === "string" &&
      typeof launch.coverageDirectory === "string",
    "missing independent child launch",
  );
  validateLoaderOverrides(root, launch.loaderOverrides);
  const require = createRequire(pathToFileURL(resolve(root, "package.json")));
  const tsxPackage = require.resolve("tsx/package.json");
  const loaderRequire = createRequire(tsxPackage);
  const esbuildPackage = loaderRequire.resolve("esbuild/package.json");
  const esbuildRequire = createRequire(esbuildPackage);
  const nativePackage = esbuildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/package.json`);
  const parserRequire = createRequire(import.meta.url);
  return {
    node: process.version,
    versions: { ...process.versions },
    platform: process.platform,
    arch: process.arch,
    executable: fileIdentity(process.execPath),
    launch: structuredClone(launch),
    loader: {
      tsx: packageIdentity(tsxPackage),
      esbuild: packageIdentity(esbuildPackage),
      native: packageIdentity(nativePackage),
    },
    parser: {
      package: fileIdentity(parserRequire.resolve("typescript/package.json")),
      implementation: fileIdentity(parserRequire.resolve("typescript")),
    },
    implementation: {
      helper: fileIdentity(fileURLToPath(import.meta.url)),
      cli: fileIdentity(fileURLToPath(new URL("../audit-core-node-execution.mjs", import.meta.url))),
    },
    configuration: ["package.json", "tsconfig.json", "pnpm-lock.yaml"].map((path) => fileIdentity(resolve(root, path))),
  };
}

function currentLaunch() {
  return {
    execArgv: [...process.execArgv],
    argv: process.argv.slice(1),
    nodeOptions: process.env.NODE_OPTIONS ?? "",
    coverageDirectory: process.env.NODE_V8_COVERAGE ?? "",
    loaderOverrides: coreNodeExecutionLoaderOverrides(),
  };
}

function physicalURL(url) {
  if (!url?.startsWith("file:")) return null;
  return realpathSync(fileURLToPath(new URL(url)));
}

function offset(source, location) {
  check(
    Number.isInteger(location?.lineNumber) && Number.isInteger(location?.columnNumber),
    "missing generated location",
  );
  const lines = source.split("\n");
  check(
    location.lineNumber >= 0 &&
      location.lineNumber < lines.length &&
      location.columnNumber >= 0 &&
      location.columnNumber <= lines[location.lineNumber].length,
    "generated location outside script",
  );
  let start = 0;
  for (let i = 0; i < location.lineNumber; i++) start += lines[i].length + 1;
  return start + location.columnNumber;
}

export function coreNodeExecutionSourceSnapshot(root) {
  const files = {};
  function walk(path) {
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = `${path}/${entry.name}`;
      check(!entry.isSymbolicLink(), `source symlink is not an authenticated snapshot: ${child}`);
      if (entry.isDirectory()) walk(child);
      else if (/\.(?:ts|js|mjs)$/.test(entry.name)) files[child] = hash(readFileSync(resolve(root, child)));
    }
  }
  walk("src");
  check(Object.keys(files).length > 0, "empty source snapshot");
  return { sha256: hash(JSON.stringify(files)), files };
}

function declaration(ts, source, description, generated = false) {
  const file = ts.createSourceFile(description.sourcePath, source, ts.ScriptTarget.Latest, true);
  check(file.parseDiagnostics.length === 0, `malformed source: ${description.sourcePath}`);
  let matches;
  if (description.member) {
    const classes = file.statements.filter(
      (node) => ts.isClassDeclaration(node) && node.name?.text === description.name,
    );
    // tsx may lower an exported class declaration into a named variable. This
    // checks the declaration's exact generated range, not a call-graph guess.
    if (generated)
      for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const node of statement.declarationList.declarations) {
          if (
            node.name.getText(file) === description.name &&
            node.initializer &&
            ts.isClassExpression(node.initializer)
          )
            classes.push(node.initializer);
        }
      }
    check(classes.length === 1, `missing/duplicate class declaration: ${description.name}`);
    if (description.member === "constructor") matches = classes;
    else
      matches = classes[0].members.filter(
        (node) =>
          node.name?.getText(file) === description.member &&
          (description.memberKind === "getter" ? ts.isGetAccessorDeclaration(node) : ts.isMethodDeclaration(node)),
      );
  } else {
    matches = file.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === description.name);
  }
  check(matches.length === 1, `missing/duplicate source declaration: ${description.id}`);
  const node = matches[0];
  return { start: node.getStart(file), end: node.end, sha256: hash(node.getText(file)) };
}

function mappingReceipt(parsed, generated, root, path, source, calibration) {
  const canonical = realpathSync(resolve(root, path));
  check(
    physicalURL(parsed.url) === canonical && !new URL(parsed.url).search && !new URL(parsed.url).hash,
    `noncanonical/query script: ${path}`,
  );
  if (!parsed.sourceMapURL) {
    check(calibration && generated === source, `missing source map: ${path}`);
    return { kind: "identity", sources: [canonical], sourceSha256: hash(source), sha256: hash(source) };
  }
  const match = /^data:application\/json(?:;charset=[^;,]+)?;base64,(.+)$/.exec(parsed.sourceMapURL);
  check(match, `unsupported source map: ${path}`);
  const text = Buffer.from(match[1], "base64").toString("utf8"),
    map = JSON.parse(text);
  check(
    map.version === 3 && map.sources?.length === 1 && map.sourcesContent?.length === 1,
    `source map is not single-origin: ${path}`,
  );
  const sourceName = `${map.sourceRoot ?? ""}${map.sourceRoot ? "/" : ""}${map.sources[0]}`;
  const mapped = sourceName.startsWith("file:")
    ? physicalURL(sourceName)
    : realpathSync(isAbsolute(sourceName) ? sourceName : resolve(dirname(canonical), sourceName));
  check(mapped === canonical && map.sourcesContent[0] === source, `stale/foreign source map content: ${path}`);
  return {
    kind: "inline-source-map",
    sources: [canonical],
    sourceSha256: hash(map.sourcesContent[0]),
    sha256: hash(text),
    url: parsed.sourceMapURL,
  };
}

/** Validate a receipt against independently supplied source bytes/hashes. No reachability inference. */
export function validateBoundFunctionReceipt(binding, expectedSourceHash) {
  check(
    /^[a-f0-9]{64}$/.test(expectedSourceHash ?? "") && binding && binding.sourceSha256 === expectedSourceHash,
    "stale/missing source receipt hash",
  );
  check(
    binding.objectId && binding.scriptId && binding.executionContextId !== undefined,
    "missing loaded function identity",
  );
  check(binding.mapping?.sourceSha256 === expectedSourceHash, "stale source-map receipt hash");
  const url = new URL(binding.url);
  check(
    url.protocol === "file:" && !url.search && !url.hash && same(binding.mapping.sources, [fileURLToPath(url)]),
    "foreign/query source origin",
  );
  let source;
  if (binding.mapping.kind === "inline-source-map") {
    const match = /^data:application\/json(?:;charset=[^;,]+)?;base64,(.+)$/.exec(binding.mapping.url);
    check(match, "missing source-map data");
    const text = Buffer.from(match[1], "base64").toString("utf8"),
      map = JSON.parse(text);
    check(
      hash(text) === binding.mapping.sha256 &&
        map.version === 3 &&
        map.sources?.length === 1 &&
        map.sourcesContent?.length === 1,
      "stale/duplicate source-map receipt",
    );
    const sourceName = `${map.sourceRoot ?? ""}${map.sourceRoot ? "/" : ""}${map.sources[0]}`;
    const mapped = sourceName.startsWith("file:")
      ? fileURLToPath(sourceName)
      : resolve(dirname(fileURLToPath(url)), sourceName);
    check(mapped === fileURLToPath(url), "foreign source-map origin");
    source = map.sourcesContent[0];
  } else {
    check(
      binding.mapping.kind === "identity" && binding.mapping.sha256 === expectedSourceHash,
      "unsupported source mapping",
    );
    source = binding.scriptSource;
  }
  check(typeof source === "string" && hash(source) === expectedSourceHash, "stale source-map content");
  const sourceDeclaration = binding.sourceDeclaration;
  check(
    Number.isInteger(sourceDeclaration?.start) &&
      Number.isInteger(sourceDeclaration?.end) &&
      sourceDeclaration.start >= 0 &&
      sourceDeclaration.end > sourceDeclaration.start &&
      sourceDeclaration.end <= source.length &&
      hash(source.slice(sourceDeclaration.start, sourceDeclaration.end)) === sourceDeclaration.sha256,
    "stale source declaration",
  );
  check(binding.scriptSha256 === hash(binding.scriptSource), "stale generated-script receipt hash");
  check(binding.functionSha256 === hash(binding.functionSource), "stale function receipt hash");
  const start = binding.scriptSource.indexOf(binding.functionSource);
  check(
    binding.functionSource.length > 0 &&
      start >= 0 &&
      binding.scriptSource.indexOf(binding.functionSource, start + 1) < 0,
    "function source missing/duplicated in generated script",
  );
  check(same(binding.range, { start, end: start + binding.functionSource.length }), "stale generated range");
  const declared = binding.generatedDeclaration;
  check(
    declared?.start === binding.range.start &&
      declared?.end === binding.range.end &&
      declared.sha256 === binding.functionSha256,
    "bound function is not the named canonical declaration",
  );
  check(binding.location?.scriptId === binding.scriptId, "foreign binding script");
  const at = offset(binding.scriptSource, binding.location);
  check(at >= binding.range.start && at < binding.range.end, "function location outside its generated range");
  return true;
}

function frameMatches(frame, binding) {
  if (
    !frame ||
    !binding ||
    frame.location?.scriptId !== binding.scriptId ||
    !frame.functionLocation ||
    !["scriptId", "lineNumber", "columnNumber"].every((key) => frame.functionLocation[key] === binding.location[key])
  )
    return false;
  const at = offset(binding.scriptSource, frame.location);
  return frame.url === binding.url && at >= binding.range.start && at < binding.range.end;
}

/** Only concrete paused frames can witness a target; function names are diagnostic labels. */
export function validatePausedObservation(observation, binding, publicRoot) {
  check(
    typeof binding.breakpointId === "string" &&
      binding.breakpointId.length > 0 &&
      same(observation.hitBreakpoints, [binding.breakpointId]) &&
      observation.breakpointId === binding.breakpointId,
    "missing/foreign/duplicate breakpoint attribution",
  );
  check(
    observation.active === true && typeof observation.windowId === "string" && observation.windowId.length > 0,
    "inactive compile window",
  );
  check(
    observation.target === binding.id && observation.firstHit === true && observation.exactCallCount === null,
    "invalid first-hit observation",
  );
  check(frameMatches(observation.frames?.[0], binding), "paused target frame does not match bound function");
  check(
    observation.frames.slice(1).filter((frame) => frameMatches(frame, publicRoot)).length === 1,
    "missing/ambiguous actual public-root frame",
  );
  return true;
}

export function validateBreakpointInstallations(window) {
  check(
    window.installations?.length === window.bindings.length && window.bindings.length > 0,
    "missing breakpoint installation acknowledgements",
  );
  const ids = new Set();
  for (const [index, binding] of window.bindings.entries()) {
    const installed = window.installations[index];
    check(
      installed.acknowledged === true &&
        installed.target === binding.id &&
        installed.objectId === binding.objectId &&
        typeof installed.breakpointId === "string" &&
        installed.breakpointId.length > 0 &&
        installed.breakpointId === binding.breakpointId &&
        !ids.has(installed.breakpointId),
      "foreign/duplicate breakpoint installation",
    );
    ids.add(installed.breakpointId);
  }
  return true;
}

function openInspector() {
  const session = new inspector.Session(),
    scripts = new Map();
  session.connect();
  session.on("Debugger.scriptParsed", ({ params }) => scripts.set(params.scriptId, params));
  const post = (method, params = {}) =>
    new Promise((resolve, reject) =>
      session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
    );
  return { session, scripts, post };
}

function checkUniqueScripts(scripts, paths) {
  for (const path of paths) {
    const matching = [...scripts.values()].filter((script) => {
      try {
        return physicalURL(script.url) === path;
      } catch {
        return false;
      }
    });
    check(matching.length === 1, `missing/duplicate loaded source instance: ${path}`);
    check(!new URL(matching[0].url).search && !new URL(matching[0].url).hash, `query module instance: ${path}`);
  }
}

async function bindFunction(context, description, key, index, calibration) {
  const { root, scripts, post } = context;
  // Parent-side admission imports this module without loading TypeScript. Only
  // the isolated instrumented child parses declarations before its window.
  const { default: ts } = await import("typescript");
  const source = read(root, description.sourcePath),
    canonical = realpathSync(resolve(root, description.sourcePath));
  const sourceDeclaration = declaration(ts, source, description);
  const evaluated = await post("Runtime.evaluate", {
    expression: `globalThis[${JSON.stringify(key)}][${index}]`,
    objectGroup: key,
  });
  check(
    !evaluated.exceptionDetails && evaluated.result?.type === "function" && evaluated.result.objectId,
    `not a bound function: ${description.id}`,
  );
  const details = await post("Runtime.getProperties", { objectId: evaluated.result.objectId, ownProperties: false });
  const locations = details.internalProperties?.filter((property) => property.name === "[[FunctionLocation]]") ?? [];
  check(locations.length === 1, `missing/duplicate FunctionLocation: ${description.id}`);
  const location = locations[0].value?.value,
    parsed = scripts.get(location?.scriptId);
  check(
    parsed && physicalURL(parsed.url) === canonical,
    `function is not declared in canonical file: ${description.id}`,
  );
  checkUniqueScripts(scripts, [canonical]);
  const { scriptSource } = await post("Debugger.getScriptSource", { scriptId: location.scriptId });
  const functionSource = Function.prototype.toString.call(description.fn);
  const start = scriptSource.indexOf(functionSource);
  const receipt = {
    id: description.id,
    sourcePath: description.sourcePath,
    sourceSha256: hash(source),
    sourceDeclaration,
    generatedDeclaration: declaration(ts, scriptSource, description, true),
    declaration: {
      id: description.id,
      name: description.name,
      sourcePath: description.sourcePath,
      ...(description.member
        ? { member: description.member, ...(description.memberKind ? { memberKind: description.memberKind } : {}) }
        : {}),
    },
    objectId: evaluated.result.objectId,
    scriptId: location.scriptId,
    url: parsed.url,
    executionContextId: parsed.executionContextId,
    v8ScriptHash: parsed.hash,
    scriptSha256: hash(scriptSource),
    scriptSource,
    functionSource,
    functionSha256: hash(functionSource),
    location,
    range: { start, end: start + functionSource.length },
    mapping: mappingReceipt(parsed, scriptSource, root, description.sourcePath, source, calibration),
  };
  validateBoundFunctionReceipt(receipt, hash(source));
  return { receipt, objectId: evaluated.result.objectId };
}

async function captureWindow(context, { targets, publicRoot, invoke, beforeWindow, calibration = false }) {
  check(
    targets.length > 0 && new Set(targets.map((target) => target.id)).size === targets.length,
    "missing/duplicate target ids",
  );
  check(
    targets.every((target) => typeof target.fn === "function") && typeof publicRoot.fn === "function",
    "missing target/public function",
  );
  check(
    new Set([...targets.map((target) => target.fn), publicRoot.fn]).size === targets.length + 1,
    "duplicate bound function objects",
  );
  const { session, post, scripts, root } = context;
  const key = `__js2_execution_witness_${randomUUID().replaceAll("-", "")}`,
    windowId = randomUUID();
  check(!Object.hasOwn(globalThis, key), "temporary binding collision");
  const ids = new Map(),
    installations = [],
    pending = [],
    observations = [],
    errors = [];
  let active = false,
    paused = false,
    openedAt = null,
    closedAt = null,
    bound = [],
    boundRoot,
    result;
  const sourcesBefore = Object.fromEntries(
    [...targets, publicRoot].map((target) => [target.sourcePath, sourceHash(root, target.sourcePath)]),
  );
  globalThis[key] = Object.freeze([...targets.map((target) => target.fn), publicRoot.fn]);
  const onPaused = ({ params }) => {
    paused = true;
    try {
      check(params.hitBreakpoints?.length === 1, "unattributed/ambiguous debugger pause");
      for (const breakpointId of params.hitBreakpoints) {
        const binding = ids.get(breakpointId);
        check(binding, "foreign/duplicate breakpoint pause");
        ids.delete(breakpointId);
        pending.push(post("Debugger.removeBreakpoint", { breakpointId }).catch((error) => errors.push(error.message)));
        const observation = {
          target: binding.id,
          breakpointId,
          hitBreakpoints: [...params.hitBreakpoints],
          active,
          windowId,
          firstHit: true,
          exactCallCount: null,
          at: process.hrtime.bigint().toString(),
          frames: params.callFrames.map((frame) => ({
            functionName: frame.functionName,
            location: frame.location,
            functionLocation: frame.functionLocation ?? null,
            url: scripts.get(frame.location.scriptId)?.url ?? null,
          })),
        };
        validatePausedObservation(observation, binding, boundRoot);
        observations.push(observation);
      }
    } catch (error) {
      errors.push(error.message);
    } finally {
      pending.push(
        post("Debugger.resume")
          .catch((error) => errors.push(error.message))
          .finally(() => {
            paused = false;
          }),
      );
    }
  };
  session.on("Debugger.paused", onPaused);
  try {
    for (const [index, target] of targets.entries()) {
      bound.push(await bindFunction(context, target, key, index, calibration));
    }
    boundRoot = (await bindFunction(context, publicRoot, key, targets.length, calibration)).receipt;
    for (const binding of bound) {
      const { breakpointId } = await post("Debugger.setBreakpointOnFunctionCall", { objectId: binding.objectId });
      check(
        typeof breakpointId === "string" && breakpointId.length > 0 && !ids.has(breakpointId),
        "missing/duplicate breakpoint id",
      );
      binding.receipt.breakpointId = breakpointId;
      installations.push({ target: binding.receipt.id, objectId: binding.objectId, breakpointId, acknowledged: true });
      ids.set(breakpointId, binding.receipt);
    }
    if (beforeWindow) {
      check(calibration, "production pre-window invocation forbidden");
      await beforeWindow();
    }
    openedAt = process.hrtime.bigint().toString();
    active = true;
    try {
      result = await invoke();
    } finally {
      active = false;
      closedAt = process.hrtime.bigint().toString();
    }
  } catch (error) {
    errors.push(error.message);
  } finally {
    active = false;
    for (const breakpointId of ids.keys())
      pending.push(post("Debugger.removeBreakpoint", { breakpointId }).catch((error) => errors.push(error.message)));
    // Drain every callback, including resume errors delivered while an earlier
    // batch settles. No callback may mutate a returned success report later.
    let completed = 0;
    while (completed < pending.length) {
      const batch = pending.slice(completed);
      completed = pending.length;
      await Promise.all(batch);
    }
    if (paused) errors.push("debugger resume did not settle");
    session.off("Debugger.paused", onPaused);
    await post("Runtime.releaseObjectGroup", { objectGroup: key }).catch((error) => errors.push(error.message));
    delete globalThis[key];
  }
  try {
    for (const [path, before] of Object.entries(sourcesBefore))
      check(sourceHash(root, path) === before, `source changed during window: ${path}`);
    checkUniqueScripts(scripts, [
      ...new Set([...targets, publicRoot].map((target) => realpathSync(resolve(root, target.sourcePath)))),
    ]);
  } catch (error) {
    errors.push(error.message);
  }
  return {
    result,
    window: {
      windowId,
      openedAt,
      closedAt,
      errors,
      publicRoot: boundRoot,
      bindings: bound.map((entry) => entry.receipt),
      installations,
      observations,
      targets: targets.map(({ id }) => ({
        id,
        status: observations.some((entry) => entry.target === id) ? "observed-first-hit" : "not-observed",
        exactCallCount: null,
      })),
    },
  };
}

/** Fixture-only surface. Its schema cannot pass the production validator. */
export async function calibrateBoundFunctionExecution({ root, targets, publicRoot, invoke, beforeWindow }) {
  const context = { ...openInspector(), root: realpathSync(root) };
  try {
    await context.post("Runtime.enable");
    await context.post("Debugger.enable");
    const captured = await captureWindow(context, { targets, publicRoot, invoke, beforeWindow, calibration: true });
    return { schema: "execution-calibration-v1", compilerWitness: false, ...LIMITS, ...captured.window };
  } finally {
    await context.post("Debugger.disable").catch(() => {});
    context.session.disconnect();
  }
}

function productionTargets(nodes, facade) {
  const targets = FREE.map((name) => ({ id: name, name, fn: nodes[name], sourcePath: CORE }));
  const allocator = nodes.IrValueIdAllocator;
  check(allocator === facade.IrValueIdAllocator, "allocator facade identity changed");
  for (const name of FREE) check(nodes[name] === facade[name], `facade identity changed: ${name}`);
  const getter = Object.getOwnPropertyDescriptor(allocator.prototype, "count");
  check(typeof getter?.get === "function" && getter.set === undefined, "missing actual count getter");
  targets.push(
    {
      id: "IrValueIdAllocator.constructor",
      name: "IrValueIdAllocator",
      member: "constructor",
      fn: allocator,
      sourcePath: CORE,
    },
    {
      id: "IrValueIdAllocator.fresh",
      name: "IrValueIdAllocator",
      member: "fresh",
      memberKind: "method",
      fn: allocator.prototype.fresh,
      sourcePath: CORE,
    },
    {
      id: "IrValueIdAllocator.count",
      name: "IrValueIdAllocator",
      member: "count",
      memberKind: "getter",
      fn: getter.get,
      sourcePath: CORE,
    },
  );
  check(
    targets.length === 12 && new Set(targets.map((target) => target.fn)).size === 12,
    "fixed 12-function denominator violated",
  );
  return targets;
}

function validateProgram(result, fixture) {
  check(
    result?.success === true && result.binary?.length > 0,
    `${fixture.name}: compilation failed: ${JSON.stringify(result?.errors)}`,
  );
  check(WebAssembly.validate(result.binary), `${fixture.name}: invalid binary`);
  const module = new WebAssembly.Module(result.binary),
    imports = WebAssembly.Module.imports(module);
  check(imports.length === 0, `${fixture.name}: host imports`);
  const instance = new WebAssembly.Instance(module, {});
  check(typeof instance.exports.run === "function", `${fixture.name}: no executable run export`);
  const values = [instance.exports.run(...fixture.args), instance.exports.run(...fixture.args)];
  check(same(values, [fixture.expected, fixture.expected]), `${fixture.name}: wrong executed values`);
  check(result.irCompiledFuncs?.includes("run"), `${fixture.name}: run not IR compiled`);
  const outcomes = result.irOutcomes?.filter((row) => row.displayName === "run");
  check(
    outcomes?.length === 1 &&
      outcomes[0].kind === "emitted" &&
      outcomes[0].irBodyEmissions === 1 &&
      outcomes[0].directBodyEmissions === 0,
    `${fixture.name}: run outcome is not IR1/direct0`,
  );
  check((result.irPostClaimErrors ?? []).length === 0, `${fixture.name}: post-claim errors`);
  return {
    name: fixture.name,
    source: fixture.source,
    args: fixture.args,
    expected: fixture.expected,
    options: OPTIONS,
    binary: {
      bytes: result.binary.length,
      sha256: hash(result.binary),
      base64: Buffer.from(result.binary).toString("base64"),
    },
    imports,
    values,
    runOutcome: outcomes[0],
    irCompiledFuncs: result.irCompiledFuncs,
    irPostClaimErrors: result.irPostClaimErrors ?? [],
  };
}

/** Recheck a serialized full-window report without ever promoting cut/closure/retirement. */
export function validateCoreNodeExecution(
  report,
  { expectedRoot, expectedSourceTreeSha256, expectedRuntimeIdentity } = {},
) {
  const errors = [];
  try {
    check(report?.schema === "execution-witness-v1", "not a compiler execution witness");
    for (const [key, value] of Object.entries(LIMITS)) check(report[key] === value, `cannot promote ${key}`);
    check(
      report.denominator === 12 && same(report.targets, CORE_NODE_EXECUTION_TARGETS),
      "fixed 12-target denominator required",
    );
    check(
      typeof expectedRoot === "string" && isAbsolute(expectedRoot) && report.provenance?.root === expectedRoot,
      "missing/foreign independent root",
    );
    check(/^[a-f0-9]{64}$/.test(expectedSourceTreeSha256 ?? ""), "missing independent source expectation");
    check(
      expectedRuntimeIdentity?.node &&
        expectedRuntimeIdentity.versions?.v8 &&
        expectedRuntimeIdentity.executable?.sha256 &&
        expectedRuntimeIdentity.loader?.tsx?.sha256 &&
        expectedRuntimeIdentity.loader?.esbuild?.sha256 &&
        expectedRuntimeIdentity.loader?.native?.sha256 &&
        expectedRuntimeIdentity.parser?.implementation?.sha256 &&
        expectedRuntimeIdentity.implementation?.helper?.sha256 &&
        expectedRuntimeIdentity.implementation?.cli?.sha256 &&
        expectedRuntimeIdentity.configuration?.length === 3 &&
        expectedRuntimeIdentity.launch?.coverageDirectory &&
        expectedRuntimeIdentity.launch?.execArgv?.length &&
        expectedRuntimeIdentity.launch?.argv?.length,
      "missing independent runtime/launch/implementation expectation",
    );
    validateLoaderOverrides(expectedRoot, expectedRuntimeIdentity.launch.loaderOverrides);
    check(
      same(report.provenance.runtime, expectedRuntimeIdentity),
      "stale/missing runtime/launch/implementation identity",
    );
    check(
      report.bindingContract?.facadeIdentity === true &&
        report.bindingContract?.distinctFunctions === 12 &&
        report.bindingContract?.sourcePath === CORE,
      "missing canonical/facade identity receipt",
    );
    check(Object.keys(report.provenance?.before?.files ?? {}).length > 0, "missing source snapshot");
    check(
      report.provenance?.before?.sha256 === hash(JSON.stringify(report.provenance.before.files)),
      "stale source-tree hash",
    );
    check(same(report.provenance.before, report.provenance.after), "source changed before/after production");
    check(report.provenance.before.sha256 === expectedSourceTreeSha256, "stale external source receipt");
    check(report.errors?.length === 0 && report.programs?.length === 6, "incomplete/failed production programs");
    const observed = new Set(),
      windows = new Set();
    for (const [index, fixture] of CORE_NODE_EXECUTION_PROGRAMS.entries()) {
      const program = report.programs[index],
        window = program.window;
      check(
        program.name === fixture.name &&
          program.source === fixture.source &&
          same(program.args, fixture.args) &&
          program.expected === fixture.expected &&
          same(program.options, OPTIONS),
        "mandatory program changed/missing",
      );
      check(
        same(program.values, [fixture.expected, fixture.expected]) && program.imports?.length === 0,
        "missing execution/zero-import evidence",
      );
      const bytes = Buffer.from(program.binary.base64, "base64");
      check(
        bytes.length > 0 &&
          bytes.length === program.binary.bytes &&
          hash(bytes) === program.binary.sha256 &&
          WebAssembly.validate(bytes),
        "invalid/stale binary evidence",
      );
      const module = new WebAssembly.Module(bytes);
      check(
        WebAssembly.Module.imports(module).length === 0 &&
          WebAssembly.Module.exports(module).some((entry) => entry.name === "run" && entry.kind === "function"),
        "binary contradicts zero-import/run receipt",
      );
      check(
        program.irCompiledFuncs.includes("run") &&
          program.runOutcome?.displayName === "run" &&
          program.runOutcome.kind === "emitted" &&
          program.runOutcome.irBodyEmissions === 1 &&
          program.runOutcome.directBodyEmissions === 0 &&
          program.irPostClaimErrors.length === 0,
        "invalid run outcome",
      );
      check(
        window.errors.length === 0 &&
          window.bindings.length === 12 &&
          same(
            window.targets.map((row) => row.id),
            CORE_NODE_EXECUTION_TARGETS,
          ),
        "invalid binding/window population",
      );
      check(
        typeof window.windowId === "string" && window.windowId.length > 0 && !windows.has(window.windowId),
        "missing/duplicate compile window",
      );
      windows.add(window.windowId);
      check(
        window.openedAt !== null && window.closedAt !== null && BigInt(window.closedAt) >= BigInt(window.openedAt),
        "invalid compile window times",
      );
      check(
        same(
          window.bindings.map((binding) => binding.id),
          CORE_NODE_EXECUTION_TARGETS,
        ),
        "missing/duplicate binding receipt",
      );
      check(new Set(window.bindings.map((binding) => binding.objectId)).size === 12, "duplicate bound object receipt");
      validateBreakpointInstallations(window);
      check(
        window.publicRoot.id === "public.compile" &&
          window.publicRoot.declaration.name === "compile" &&
          !window.publicRoot.declaration.member &&
          window.publicRoot.sourcePath === PUBLIC,
        "wrong public root",
      );
      for (const binding of [...window.bindings, window.publicRoot]) {
        check(
          fileURLToPath(binding.url) === resolve(report.provenance.root, binding.sourcePath),
          "binding outside canonical root",
        );
        validateBoundFunctionReceipt(binding, report.provenance.before.files[binding.sourcePath]);
      }
      check(
        new Set(window.bindings.map((binding) => binding.scriptId)).size === 1 &&
          window.bindings.every(
            (binding) => binding.sourcePath === CORE && binding.mapping.kind === "inline-source-map",
          ),
        "noncanonical target script",
      );
      check(
        new Set(window.bindings.map((binding) => JSON.stringify(binding.location))).size === 12,
        "duplicate target location",
      );
      for (const binding of window.bindings) {
        const [name, member] = binding.id.split(".");
        check(
          binding.declaration.name === name &&
            binding.declaration.member === member &&
            binding.declaration.sourcePath === CORE,
          "target/declaration identity mismatch",
        );
      }
      check(window.publicRoot.mapping.kind === "inline-source-map", "noncanonical public script");
      check(
        new Set([...window.bindings, window.publicRoot].map((binding) => binding.executionContextId)).size === 1,
        "mixed runtime contexts",
      );
      const unique = new Set();
      for (const observation of window.observations) {
        const binding = window.bindings.find((entry) => entry.id === observation.target);
        check(binding && !unique.has(observation.target), "unknown/duplicate first hit");
        unique.add(observation.target);
        check(
          observation.windowId === window.windowId &&
            BigInt(observation.at) >= BigInt(window.openedAt) &&
            BigInt(observation.at) <= BigInt(window.closedAt),
          "observation outside window",
        );
        validatePausedObservation(observation, binding, window.publicRoot);
        observed.add(observation.target);
      }
      for (const target of window.targets)
        check(
          target.exactCallCount === null &&
            target.status === (unique.has(target.id) ? "observed-first-hit" : "not-observed"),
          "zero-inferred/exact-count coverage is forbidden",
        );
    }
    check(
      observed.size === 12 &&
        CORE_NODE_EXECUTION_TARGETS.every((target) => observed.has(target)) &&
        report.fullWitnessCount === 12,
      "missed mandatory execution target",
    );
  } catch (error) {
    errors.push(error.message);
  }
  return { ok: errors.length === 0, errors, ...LIMITS };
}

/** Production runner: setup is outside the window; only public compile runs inside it. */
export async function runCoreNodeExecution({ root }) {
  root = realpathSync(root);
  const report = {
    schema: "execution-witness-v1",
    ok: false,
    denominator: 12,
    targets: CORE_NODE_EXECUTION_TARGETS,
    fullWitnessCount: 0,
    ...LIMITS,
    provenance: {},
    programs: [],
    errors: [],
  };
  let context;
  try {
    const launch = currentLaunch();
    // Retain the actual override values even when admission rejects the launch
    // before reading source or importing the compiler.
    report.provenance = { root, runtime: { launch } };
    const runtime = coreNodeExecutionRuntimeIdentity({ root, launch });
    const before = coreNodeExecutionSourceSnapshot(root);
    check(
      runtime.launch.coverageDirectory,
      "launch child with a private NODE_V8_COVERAGE directory before tsx initialization (source-content authentication only; coverage is not witness evidence)",
    );
    report.provenance = {
      root,
      before,
      runtime,
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    };
    context = { ...openInspector(), root };
    await context.post("Runtime.enable");
    await context.post("Debugger.enable");
    const { compile } = await import(pathToFileURL(resolve(root, PUBLIC)).href);
    const nodes = await import(pathToFileURL(resolve(root, CORE)).href);
    const facade = await import(pathToFileURL(resolve(root, FACADE)).href);
    productionTargets(nodes, facade);
    report.bindingContract = { facadeIdentity: true, distinctFunctions: 12, sourcePath: CORE };
    for (const fixture of CORE_NODE_EXECUTION_PROGRAMS) {
      const targets = productionTargets(nodes, facade);
      const captured = await captureWindow(context, {
        targets,
        publicRoot: { id: "public.compile", name: "compile", fn: compile, sourcePath: PUBLIC },
        invoke: () => compile(fixture.source, OPTIONS),
      });
      if (captured.window.errors.length) {
        report.programs.push({ name: fixture.name, window: captured.window });
        throw new Error(`${fixture.name}: ${captured.window.errors.join("; ")}`);
      }
      report.programs.push({ ...validateProgram(captured.result, fixture), window: captured.window });
    }
    checkUniqueScripts(
      context.scripts,
      [CORE, PUBLIC, FACADE].map((path) => realpathSync(resolve(root, path))),
    );
    report.provenance.after = coreNodeExecutionSourceSnapshot(root);
    report.fullWitnessCount = new Set(
      report.programs.flatMap((program) => program.window.observations.map((observation) => observation.target)),
    ).size;
    const verdict = validateCoreNodeExecution(report, {
      expectedRoot: root,
      expectedSourceTreeSha256: before.sha256,
      expectedRuntimeIdentity: coreNodeExecutionRuntimeIdentity({ root, launch: currentLaunch() }),
    });
    report.ok = verdict.ok;
    report.errors.push(...verdict.errors);
  } catch (error) {
    report.errors.push(error.stack ?? error.message);
  } finally {
    if (context) {
      await context.post("Debugger.disable").catch((error) => report.errors.push(error.message));
      context.session.disconnect();
    }
    if (report.provenance.before && !report.provenance.after) {
      try {
        report.provenance.after = coreNodeExecutionSourceSnapshot(root);
      } catch (error) {
        report.errors.push(error.message);
      }
    }
    if (report.errors.length) report.ok = false;
  }
  return report;
}
