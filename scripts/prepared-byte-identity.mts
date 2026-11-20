// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7380 — Prepared-path byte identity. Compiles every program of tests/fixtures/prepared-proving-programs.json and
// prints one line per program: `<row> <program hash> bytes <sha256>`, `refused <messages>` or `threw <message>`.
// Run it on a base and on a head (file-copy A/B) and diff the two outputs; an empty diff is the proof. It writes no
// committed hash: it is a comparison tool, not a pin.
//
// Usage: npx tsx scripts/prepared-byte-identity.mts [--from N] [--to N] > out.txt
// `JS2WASM_VALIDATE_PREPARED=1` runs the Prepared self-checks (src/shared/contracts/prepared-validation.ts).
import { provingOutcome, provingProgramKey, provingPrograms } from "../tests/helpers/prepared-proving-programs.ts";

const argument = (name: string): number | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : Number(process.argv[index + 1]);
};
const to = Math.min(argument("--to") ?? provingPrograms.length, provingPrograms.length);
for (let row = argument("--from") ?? 0; row < to; row++) {
  const program = provingPrograms[row]!;
  console.log(`${row} ${provingProgramKey(program)} ${(await provingOutcome(program)).outcome}`);
}
