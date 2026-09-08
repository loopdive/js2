// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { register } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [packetFile, censusFile, probe] = process.argv.slice(2);
const forbidden = [
  /\/src\/(checker|frontend|codegen|codegen-linear)\//,
  /\/src\/(ts-api|compiler|index)\.[cm]?[jt]s$/,
  /\/src\/ir\/(from-ast|async-from-ast|async-prepare|identity|program-source|program-preparation|program-middleend)\.[cm]?[jt]s$/,
  /\/src\/ir\/passes\/gvn\.[cm]?[jt]s$/,
  /\/node_modules\/(typescript|typescript7)\//,
];
register(
  `data:text/javascript,${encodeURIComponent(`
  import { appendFileSync } from "node:fs";
  let data;
  export function initialize(value) { data = value; }
  export async function resolve(specifier, context, next) {
    const result = await next(specifier, context);
    appendFileSync(data.file, JSON.stringify({url:result.url,parent:context.parentURL??null})+"\\n");
    if (data.patterns.some(pattern => new RegExp(pattern).test(result.url)))
      throw new Error("forbidden typed-preparation load: " + result.url);
    return result;
  }
`)}`,
  { parentURL: import.meta.url, data: { file: censusFile, patterns: forbidden.map((pattern) => pattern.source) } },
);

const beforeExit = process.listeners("exit");
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
};
try {
  const { encodeTypedPacket, decodeTypedPacket } = await import("./typed-program-transport.mjs");
  const text = readFileSync(packetFile, "utf8");
  const { input, options } = decodeTypedPacket(text);
  report.roundTripBeforePreparation = encodeTypedPacket({ input, options }) === text;
  if (!report.roundTripBeforePreparation) throw new Error("transport changed packet before preparation");
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
