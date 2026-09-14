// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { verifyNoDemandEmitterImportForward } from "./helpers/native-string-no-demand-emitter-forward.mjs";

const oldImport = 'import { emitConstInstr, type IrLowerResolver } from "../lower.js";';
const newImports =
  'import { emitConstInstr } from "./wasm-constants.js";\nimport type { IrLowerResolver } from "./lower-contracts.js";';
const oldSite =
  '    out.push({ op: "local.get", index: dataScratchLocal });\n    out.push({ op: "struct.new", typeIdx: layout.vecStructTypeIdx });';
const repairedSite =
  '    out.push({ op: "local.get", index: dataScratchLocal });\n    out.push({ op: "ref.as_non_null" });\n    out.push({ op: "struct.new", typeIdx: layout.vecStructTypeIdx });';
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function canonicalProof() {
  const candidateSource = readFileSync(new URL("../src/ir/backend/wasmgc-emitter.ts", import.meta.url), "utf8");
  expect(candidateSource.split(newImports)).toHaveLength(2);
  expect(candidateSource.split(repairedSite)).toHaveLength(2);
  const repairedSource = candidateSource.replace(newImports, oldImport);
  const afterSource = candidateSource.replace(repairedSite, oldSite);
  const beforeSource = afterSource.replace(newImports, oldImport);
  // Fixed Git-source hashes authenticated before this test was written. The
  // current file only supplies bytes; it cannot choose the expected identities.
  // No historical Git checkout or lazy fetch is needed by an ordinary CI test.
  expect(hash(beforeSource)).toBe("a23bbcb037bf8bb0fd2b22bc4c85a86d43e87ce90b77c8a2f1b0588ccbac1167");
  expect(hash(afterSource)).toBe("49a1de064065e161f911b1d79492231b9b7b4c59823887e3a709a7e7ad80ca64");
  expect(hash(repairedSource)).toBe("caba0379bf1a1515b5d8966d51a90064a572bd4c380370a57a2606eba4245e1b");
  expect(hash(candidateSource)).toBe("85b4a5765a5e690476828251006c97e3f0445817501ece6a6586038178f0da41");
  expect(beforeSource.replace(oldSite, repairedSite)).toBe(repairedSource);
  return {
    commit: "c257b46620fb4996bf5233763b80298c1fd03dc6",
    parent: "120cd638cf2a971934eaaccf47aaf65f06491f3d",
    beforeSource,
    afterSource,
    repairedSource,
    candidateSource,
  };
}

function rejects(
  change: (proof: ReturnType<typeof canonicalProof>) => ReturnType<typeof canonicalProof>,
  diagnostic: string,
) {
  const proof = canonicalProof();
  expect(() => verifyNoDemandEmitterImportForward(proof)).not.toThrow();
  const changed = change({ ...proof });
  expect(changed).not.toStrictEqual(proof);
  expect(() => verifyNoDemandEmitterImportForward(changed)).toThrow(diagnostic);
}

it("authenticates the landed import pair and exact repaired-emitter inverse", () => {
  const proof = canonicalProof();
  expect(() => verifyNoDemandEmitterImportForward(proof)).not.toThrow();
  expect(proof.candidateSource.replace(newImports, oldImport)).toBe(proof.repairedSource);
});

it("rejects a different fixed commit or parent after the canonical positive", () => {
  rejects((proof) => ({ ...proof, commit: "0".repeat(40) }), "fixed import commit differs");
  rejects((proof) => ({ ...proof, parent: "0".repeat(40) }), "fixed import parent differs");
});

it("rejects altered before or after authority bytes after the canonical positive", () => {
  rejects(
    (proof) => ({ ...proof, beforeSource: proof.beforeSource + "\n" }),
    "authority before source SHA-256 differs",
  );
  rejects((proof) => ({ ...proof, afterSource: proof.afterSource + "\n" }), "authority after source SHA-256 differs");
});

it("rejects absent forwarding and a missing import after the canonical positive", () => {
  rejects((proof) => ({ ...proof, candidateSource: proof.repairedSource }), "one exact candidate import pair required");
  rejects(
    (proof) => ({ ...proof, candidateSource: proof.candidateSource.replace(newImports, "") }),
    "one exact candidate import pair required",
  );
});

it("rejects duplicate forwarded imports after the canonical positive", () => {
  rejects(
    (proof) => ({
      ...proof,
      candidateSource: proof.candidateSource.replace(newImports, newImports + "\n" + newImports),
    }),
    "one exact candidate import pair required",
  );
});

it("rejects retargeted, value-kind and attributed imports after the canonical positive", () => {
  for (const replacement of [
    newImports.replace("./wasm-constants.js", "../lower.js"),
    newImports.replace("import type { IrLowerResolver }", "import { IrLowerResolver }"),
    newImports.replace('"./lower-contracts.js";', '"./lower-contracts.js" with { type: "json" };'),
  ]) {
    rejects(
      (proof) => ({ ...proof, candidateSource: proof.candidateSource.replace(newImports, replacement) }),
      "one exact candidate import pair required",
    );
  }
});

it("rejects a missing or duplicate nullability guard after the canonical positive", () => {
  for (const replacement of [
    oldSite,
    repairedSite.replace(
      '    out.push({ op: "ref.as_non_null" });',
      '    out.push({ op: "ref.as_non_null" });\n    out.push({ op: "ref.as_non_null" });',
    ),
  ]) {
    rejects(
      (proof) => ({ ...proof, candidateSource: proof.candidateSource.replace(repairedSite, replacement) }),
      "candidate inverse must reproduce exact repaired emitter",
    );
  }
});

it("rejects unrelated candidate edits and a matching forged repaired pair", () => {
  rejects(
    (proof) => ({ ...proof, candidateSource: proof.candidateSource + "\n" }),
    "candidate inverse must reproduce exact repaired emitter",
  );
  rejects(
    (proof) => ({
      ...proof,
      candidateSource: proof.candidateSource + "\n",
      repairedSource: proof.repairedSource + "\n",
    }),
    "repaired emitter SHA-256 differs",
  );
});
