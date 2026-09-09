// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { register } from "node:module";
import { readFileSync } from "node:fs";

const [packetFile, censusFile, mode = "replay"] = process.argv.slice(2);
if (!packetFile || !censusFile || !["replay", "probe"].includes(mode))
  throw new Error("invalid runtime-support replay arguments");
const patterns = [
  /\/src\/(checker|frontend|codegen|codegen-linear|stdlib)\//,
  /\/src\/(ts-api|compiler|index)\.[cm]?[jt]s$/,
  /\/src\/ir\/(from-ast|async-from-ast|async-prepare|identity|program-source|program-preparation|program-middleend)\.[cm]?[jt]s$/,
  /\/node_modules\/(typescript|typescript7)\//,
];
const loader = `data:text/javascript,${encodeURIComponent(`
  import { appendFileSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  let data;
  export function initialize(value) { data = value; }
  function inspect(url, parent) {
    const path = url.startsWith("file:") ? fileURLToPath(url) : url;
    const denied = data.patterns.some(pattern => new RegExp(pattern).test(path));
    appendFileSync(data.file, JSON.stringify({url, parent:parent??null, denied}) + "\\n");
    if (denied) throw new Error("forbidden runtime-support replay load: " + url);
  }
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith("file:") || ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")))
      inspect(new URL(specifier, context.parentURL).href, context.parentURL);
    const result = await next(specifier, context);
    inspect(result.url, context.parentURL);
    return result;
  }
`)}`;
register(loader, {
  parentURL: import.meta.url,
  data: { file: censusFile, patterns: patterns.map((pattern) => pattern.source) },
});

const report = { ok: false, decoded: false, batches: 0, calls: 0, literals: 0, error: null };
try {
  const { decodePreparedIrProgram, encodePreparedIrProgram } = await import("../../src/ir/program-codec.ts");
  const { assertIrRuntimeSupport } = await import("../../src/ir/program/runtime-support.ts");
  const text = readFileSync(packetFile, "utf8");
  const program = decodePreparedIrProgram(text);
  assertIrRuntimeSupport(program, program.runtimeSupport);
  if (encodePreparedIrProgram(program) !== text) throw new Error("canonical support bytes changed");
  report.batches = program.runtimeSupport?.batches.length ?? 0;
  for (const batch of program.runtimeSupport?.batches ?? []) {
    report.calls += batch.calls.length;
    report.literals += batch.literals.length;
  }
  if (report.batches !== 1 || report.calls === 0 || report.literals === 0)
    throw new Error("empty support replay is not evidence");
  report.decoded = true;
  if (mode === "probe") await import("../../src/ir/from-ast.ts");
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
}
process.stdout.write(JSON.stringify(report) + "\n");
