// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7622 — the IR planning identity context (declaration → unit → function) was built only under
// `experimentalIR || trackIrOutcomes`. The exact callable lookups behind a namespace member call (`d.bump()` on
// `import * as d`, `N.f()` on a TS `namespace`) read it, so with IR off they declined, the receiver fell back to
// null and the call threw; the diagnostic `trackIrOutcomes` flag made the same program answer. The context is now
// built unconditionally, so every lane answers like node with or without the flag.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { compile, compileMulti, type CompileResult } from "../src/index.js";

type Program = string | Record<string, string>;

const PROGRAMS: readonly [string, Program][] = [
  [
    "import * as d; d.bump() writes the dependency's let",
    {
      entry: `import * as d from "./dep"; export function main(): number { d.bump(); return d.g * 10 + 3; }`,
      dep: `export let g = 1; export function bump(): void { g = 2; }`,
    },
  ],
  [
    "import * as d; a void d.f() whose namespace exports only f",
    {
      entry: `import * as d from "./dep"; let k = 0; export function main(): number { d.f(); return 5; }`,
      dep: `export function f(): void {}`,
    },
  ],
  [
    "TS namespace N.f() + 1 in one file",
    `namespace N { export function f(): number { return 4; } } export function main(): number { return N.f() + 1; }`,
  ],
  [
    "named import f() + 1",
    {
      entry: `import { f } from "./dep"; export function main(): number { return f() + 1; }`,
      dep: `export function f(): number { return 4; }`,
    },
  ],
];

const LANES = [
  { name: "IR on", options: { experimentalIR: true } },
  { name: "IR off", options: { experimentalIR: false } },
  { name: "IR off + trackIrOutcomes", options: { experimentalIR: false, trackIrOutcomes: true } },
  { name: "IR on + fast", options: { experimentalIR: true, fast: true } },
  { name: "IR off + fast", options: { experimentalIR: false, fast: true } },
] as const;

const nodeDir = mkdtempSync(join(tmpdir(), "issue-7622-"));
afterAll(() => rmSync(nodeDir, { recursive: true, force: true }));

/** Node's answer: the TS sources transpiled to ES modules and imported. */
async function nodeAnswer(name: string, program: Program): Promise<number> {
  const files = typeof program === "string" ? { entry: program } : program;
  const dir = mkdtempSync(join(nodeDir, `${PROGRAMS.findIndex(([n]) => n === name)}-`));
  for (const [file, source] of Object.entries(files)) {
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    writeFileSync(join(dir, `${file}.mjs`), js.replace(/from "\.\/(\w+)"/g, 'from "./$1.mjs"'));
  }
  const entry = (await import(pathToFileURL(join(dir, "entry.mjs")).href)) as { main: () => number };
  return entry.main();
}

async function wasmAnswer(program: Program, target: "gc" | "standalone", options: object): Promise<number> {
  const compileOptions = { target, ...options } as never;
  const result: CompileResult =
    typeof program === "string"
      ? await compile(program, compileOptions)
      : await compileMulti(
          Object.fromEntries(Object.entries(program).map(([file, source]) => [`${file}.ts`, source])),
          "entry.ts",
          compileOptions,
        );
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  const imports = (target === "standalone" ? {} : result.importObject) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (result.importObject as { setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.setInstance?.(instance);
  return (instance.exports.main as () => number)();
}

describe("#7622 — namespace function calls answer like node whatever experimentalIR/trackIrOutcomes say", () => {
  for (const [name, program] of PROGRAMS)
    for (const target of ["gc", "standalone"] as const)
      for (const lane of LANES)
        it(`${name} — ${target}, ${lane.name}`, async () => {
          expect(await wasmAnswer(program, target, lane.options)).toBe(await nodeAnswer(name, program));
        }, 60_000);
});
