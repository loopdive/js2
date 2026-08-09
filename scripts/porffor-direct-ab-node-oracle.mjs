// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--source") {
  throw new Error(
    "usage: node --experimental-strip-types scripts/porffor-direct-ab-node-oracle.mjs --source <fixture.ts>",
  );
}
const sourcePath = resolve(args[1]);
const bytes = readFileSync(sourcePath);
const source = bytes.toString("utf8");
if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error("oracle source is not exact round-trippable UTF-8");
const module = await import(
  `${pathToFileURL(sourcePath).href}?sha=${createHash("sha256").update(bytes).digest("hex")}`
);
const canary = module.porfforSourceNativeCanary;
if (typeof canary !== "function") throw new Error("fixture export porfforSourceNativeCanary is absent");

const fixedSeeds = [-7, 0, 4, 31];
const iterations = 200_000;
let checksum = 0;
for (let index = 0; index < iterations; index++) checksum += canary(((index * 17) % 257) - 128);
const fixedOutputs = fixedSeeds.map(canary);
for (const value of [...fixedOutputs, checksum]) {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error(`oracle produced a non-finite or inexact value ${String(value)}`);
  }
}

process.stdout.write(
  `${JSON.stringify({
    sourcePath,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceBytes: bytes.length,
    function: "porfforSourceNativeCanary",
    fixedSeeds,
    fixedOutputs,
    iterations,
    seedFormula: "((index * 17) % 257) - 128",
    seedFormulaVersion: 1,
    checksumDecimal: String(checksum),
  })}\n`,
);
