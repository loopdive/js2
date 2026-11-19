// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7380 — Prepared-path byte identity. Compiles every program of tests/fixtures/prepared-proving-programs.json (the
// distinct programs the issue-7354-*, test262-prepared-* and issue-7188 tests hand to the strict Prepared entry)
// and prints one line per program: `<row> <program hash> bytes <sha256>`, `refused <messages>` or `threw <message>`.
// Run it on a base and on a head (file-copy A/B) and diff the two outputs; an empty diff is the proof. It writes no
// committed hash: it is a comparison tool, not a pin.
//
// Usage: npx tsx scripts/prepared-byte-identity.mts [--from N] [--to N] > out.txt
// `JS2WASM_VALIDATE_PREPARED=1` runs the Prepared self-checks (src/shared/contracts/prepared-validation.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compile, compileMulti, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.ts";

interface ProvingProgram {
  compile: "compile" | "compileMulti";
  entryFile: string;
  files: Record<string, string>;
  options: Record<string, unknown>;
}

const argument = (name: string): number | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : Number(process.argv[index + 1]);
};
const fixture = new URL("../tests/fixtures/prepared-proving-programs.json", import.meta.url);
const programs = JSON.parse(readFileSync(fixture, "utf8")) as ProvingProgram[];
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

for (let row = argument("--from") ?? 0; row < Math.min(argument("--to") ?? programs.length, programs.length); row++) {
  const program = programs[row]!;
  const options = {
    ...program.options,
    wholeProgram: { kind: "prepared-program-required", version: 1 },
  } as Test262CompileOptions;
  let outcome: string;
  try {
    const result =
      program.compile === "compile"
        ? await compile(program.files[program.entryFile]!, options)
        : await compileMulti(program.files, program.entryFile, options);
    outcome = result.success
      ? `bytes ${sha256(result.binary)}`
      : `refused ${result.errors.map((error) => error.message).join(" | ")}`;
  } catch (error) {
    outcome = `threw ${error instanceof Error ? error.message : String(error)}`;
  }
  console.log(`${row} ${sha256(JSON.stringify(program)).slice(0, 12)} ${outcome.replace(/\s+/g, " ")}`);
}
