// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { register } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [packetFile, censusFile, ...flags] = process.argv.slice(2);
if (
  flags.some(
    (flag) =>
      ![
        "--probe-forbidden-import",
        "--probe-forbidden-query",
        "--probe-forbidden-fragment",
        "--admission-only",
      ].includes(flag),
  )
)
  throw new Error("unknown source-free test mode");
const probe = flags.includes("--probe-forbidden-import");
const admissionOnly = flags.includes("--admission-only");
const forbidden = [
  /\/src\/(checker|frontend|codegen|codegen-linear)\//,
  /\/src\/(ts-api|compiler|index)\.[cm]?[jt]s$/,
  /\/src\/ir\/(from-ast|async-from-ast|async-prepare|identity|program-source|program-preparation|program-middleend)\.[cm]?[jt]s$/,
  /\/src\/ir\/passes\/gvn\.[cm]?[jt]s$/,
  /\/node_modules\/(typescript|typescript7)\//,
];
if (admissionOnly)
  forbidden.push(
    /\/src\/compiler\//,
    /\/src\/ir\/(program|program-input|alloc-registry|program-prepare-ir|program-codec|program-observation|program-validation|program-runtime-validation|verify)\.[cm]?[jt]s$/,
    /\/src\/ir\/(runtime-[^/]+|async-[^/]+|intrinsic[^/]*|string-runtime|generator-support)\.[cm]?[jt]s$/,
    /\/src\/runtime\/(?!contracts\/)/,
  );
const guardLoader = `data:text/javascript,${encodeURIComponent(`
  import { appendFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  let data;
  export function initialize(value) { data = value; }
  function rejectForbidden(url, parent, phase) {
    const normalized = url.startsWith("file:") ? fileURLToPath(url) : url;
    if (data.patterns.some(pattern => new RegExp(pattern).test(normalized))) {
      appendFileSync(data.file, JSON.stringify({url,parent:parent??null,phase})+"\\n");
      throw new Error("forbidden typed-preparation load: " + url);
    }
  }
  export async function resolve(specifier, context, next) {
    // Check requested and resolved file URLs independently.
    if (specifier.startsWith("file:") || ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")))
      rejectForbidden(new URL(specifier, context.parentURL).href, context.parentURL, "requested");
    const result = await next(specifier, context);
    appendFileSync(data.file, JSON.stringify({url:result.url,parent:context.parentURL??null})+"\\n");
    rejectForbidden(result.url, context.parentURL, "resolved");
    return result;
  }
`)}`;
function registerGuard() {
  register(guardLoader, {
    parentURL: import.meta.url,
    data: { file: censusFile, patterns: forbidden.map((pattern) => pattern.source) },
  });
}
registerGuard();

const beforeExit = process.listeners("exit");
function reachableObjects(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return seen;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      reachableObjects(key, seen);
      reachableObjects(item, seen);
    }
  } else if (value instanceof Set) {
    for (const item of value) reachableObjects(item, seen);
  } else {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if ("value" in descriptor) reachableObjects(descriptor.value, seen);
    }
  }
  return seen;
}
const report = {
  ok: false,
  roundTripBeforePreparation: false,
  encoded: null,
  sourceUnits: 0,
  bodies: 0,
  observations: 0,
  newExitListeners: 0,
  loaded: [],
  error: null,
  runtime: {
    node: process.version,
    v8: process.versions.v8,
    icu: process.versions.icu,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  },
  root: resolve("."),
  mode: admissionOnly ? "admission" : "preparation",
};
try {
  const { encodeTypedPacket, decodeTypedPacket } = await import("./typed-program-transport.mjs");
  const text = readFileSync(packetFile, "utf8");
  const { input, options } = decodeTypedPacket(text);
  report.roundTripBeforePreparation = encodeTypedPacket({ input, options }) === text;
  if (!report.roundTripBeforePreparation) throw new Error("transport changed packet before preparation");
  if (admissionOnly) {
    const { ownTypedIrProgramInput, ownTypedIrProgramOptions } = await import("../../src/ir/program/input.ts");
    const owned = ownTypedIrProgramInput(input);
    const controls = ownTypedIrProgramOptions(options);
    report.admissionRoundTrip = encodeTypedPacket({ input: owned.input, options: controls }) === text;
    if (!report.admissionRoundTrip) throw new Error("admission changed source packet");
    report.sources = owned.input.inventory.sources.length;
    report.sourceUnits = owned.input.inventory.terminalUnits.length;
    report.bodies = owned.input.ir.functions.length;
    report.globals = owned.input.globals.length;
    report.allocations = owned.input.allocations.size;
    const live = owned.input.allocations.entries.filter((entry) => entry.state === "live");
    report.liveSites = live.length;
    report.registrySharing = live.every((entry) => owned.allocations.resolve(entry.site.id)?.type === entry.site.type);
    const originalObjects = reachableObjects(input);
    const ownedObjects = reachableObjects(owned.input);
    report.ownedObjectCount = ownedObjects.size;
    report.registryDetached = [...ownedObjects].every((object) => !originalObjects.has(object));
    const shallow = { ...input, ir: { ...input.ir } };
    report.shallowCopyRejected = [...reachableObjects(shallow)].some((object) => originalObjects.has(object));
    report.registrySnapshot = encodeTypedPacket(owned.allocations.captureSnapshot());
    if (!live.length || !report.registrySharing || !report.registryDetached)
      throw new Error("admission did not restore nonempty owned allocation state");
    report.nextAllocation = owned.allocations.fresh(live[0].site.kind, live[0].site.type);
    if (report.nextAllocation !== report.allocations) throw new Error("restored next allocation ID changed");
    if (probe) await import("../../src/ir/program-input.ts");
    for (const [flag, suffix] of [
      ["--probe-forbidden-query", "?admission-guard"],
      ["--probe-forbidden-fragment", "#admission-guard"],
    ]) {
      if (!flags.includes(flag)) continue;
      const url = new URL("../../src/ir/program-input.ts" + suffix, import.meta.url).href;
      // Separately exercise this exact loader in plain Node: tsx strips query
      // suffixes before this process's guard sees them. Rejection occurs before
      // TypeScript loading, so this control does not need a TS loader.
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { register } from "node:module"; register(${JSON.stringify(guardLoader)}, ${JSON.stringify({ parentURL: import.meta.url, data: { file: censusFile, patterns: forbidden.map((pattern) => pattern.source) } })}); await import(${JSON.stringify(url)});`,
        ],
        { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      if (child.error || child.signal || child.status !== 1)
        throw new Error("plain Node guard control did not reject: " + child.error);
      report.plainNodeGuardStatus = child.status;
      throw new Error(child.stderr);
    }
    report.newExitListeners = process.listeners("exit").filter((listener) => !beforeExit.includes(listener)).length;
    if (report.newExitListeners) throw new Error("admission installed legacy effects");
    report.ok = true;
  } else {
    const { subscribePreparedIrProgram } = await import("../../src/ir/program-observation.ts");
    const unsubscribe = subscribePreparedIrProgram(() => {
      report.observations++;
    });
    try {
      const { prepareTypedIrProgram } = await import("../../src/ir/program-prepare-ir.ts");
      const { encodePreparedIrProgram, decodePreparedIrProgram } = await import("../../src/ir/program-codec.ts");
      const result = prepareTypedIrProgram(input, options);
      if (result.kind !== "prepared") throw new Error(`${result.kind}: ${result.detail}`);
      report.sourceUnits = result.program.inventory.terminalUnits.length;
      report.bodies = result.program.ir.functions.length;
      report.encoded = encodePreparedIrProgram(result.program);
      if (encodePreparedIrProgram(decodePreparedIrProgram(report.encoded)) !== report.encoded)
        throw new Error("prepared codec replay differs");
      if (probe) await import("../../src/ts-api.ts");
      report.newExitListeners = process.listeners("exit").filter((listener) => !beforeExit.includes(listener)).length;
      if (report.observations || report.newExitListeners) throw new Error("typed entry installed legacy effects");
      report.ok = true;
    } finally {
      unsubscribe();
    }
  }
} catch (error) {
  report.error = String(error?.stack ?? error);
}
report.loaded = readFileSync(censusFile, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((row) => JSON.parse(row));
process.stdout.write(JSON.stringify(report) + "\n");
process.exitCode = report.ok ? 0 : 1;
