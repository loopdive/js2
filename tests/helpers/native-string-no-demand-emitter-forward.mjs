// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Independent landed import-only change, not a hash learned from the candidate.
export const NO_DEMAND_EMITTER_IMPORT_FORWARD = Object.freeze({
  commit: "c257b46620fb4996bf5233763b80298c1fd03dc6",
  parent: "120cd638cf2a971934eaaccf47aaf65f06491f3d",
  path: "src/ir/backend/wasmgc-emitter.ts",
  beforeBlob: "d62446f4e1942b870fac851ffa71b8ee7a6cb438",
  beforeSha256: "a23bbcb037bf8bb0fd2b22bc4c85a86d43e87ce90b77c8a2f1b0588ccbac1167",
  afterBlob: "336b924af282ba7e90de26f8488756163fc2c6dc",
  afterSha256: "49a1de064065e161f911b1d79492231b9b7b4c59823887e3a709a7e7ad80ca64",
  repairedBlob: "e2affc4733c5a1a67d977f5ffcd021c1c50f0b6f",
  repairedSha256: "caba0379bf1a1515b5d8966d51a90064a572bd4c380370a57a2606eba4245e1b",
  candidateBlob: "6d63e989d71cbdff20cc81fbe6487cc1aa37b376",
  candidateSha256: "85b4a5765a5e690476828251006c97e3f0445817501ece6a6586038178f0da41",
});

const oldImport = 'import { emitConstInstr, type IrLowerResolver } from "../lower.js";';
const newImports =
  'import { emitConstInstr } from "./wasm-constants.js";\nimport type { IrLowerResolver } from "./lower-contracts.js";';

function requireSource(source, sha256, blob, label) {
  assert.equal(typeof source, "string", `${label} must be text`);
  const bytes = Buffer.from(source, "utf8");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, `${label} SHA-256 differs`);
  assert.equal(
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    blob,
    `${label} Git blob differs`,
  );
}

// Verifies text only. It never changes a source file or an emitted program.
export function verifyNoDemandEmitterImportForward(proof) {
  const pin = NO_DEMAND_EMITTER_IMPORT_FORWARD;
  assert.deepEqual(
    Object.keys(proof).sort(),
    ["afterSource", "beforeSource", "candidateSource", "commit", "parent", "repairedSource"],
    "unexpected import-forward proof fields",
  );
  assert.equal(proof.commit, pin.commit, "fixed import commit differs");
  assert.equal(proof.parent, pin.parent, "fixed import parent differs");
  requireSource(proof.beforeSource, pin.beforeSha256, pin.beforeBlob, "authority before source");
  requireSource(proof.afterSource, pin.afterSha256, pin.afterBlob, "authority after source");
  assert.equal(proof.beforeSource.split(oldImport).length, 2, "one exact authority import required");
  assert.equal(proof.afterSource.split(newImports).length, 2, "one exact forwarded authority import required");
  assert.equal(
    proof.beforeSource.replace(oldImport, newImports),
    proof.afterSource,
    "fixed authority changes more than the reviewed imports",
  );
  requireSource(proof.repairedSource, pin.repairedSha256, pin.repairedBlob, "repaired emitter");
  assert.equal(proof.repairedSource.split(oldImport).length, 2, "one exact repaired import required");
  assert.equal(typeof proof.candidateSource, "string", "candidate emitter must be text");
  assert.equal(proof.candidateSource.split(newImports).length, 2, "one exact candidate import pair required");
  assert.equal(proof.candidateSource.includes(oldImport), false, "candidate retains the old import");
  assert.equal(
    proof.candidateSource.replace(newImports, oldImport),
    proof.repairedSource,
    "candidate inverse must reproduce exact repaired emitter",
  );
  assert.equal(
    proof.repairedSource.replace(oldImport, newImports),
    proof.candidateSource,
    "candidate must contain only the reviewed import forwarding",
  );
  requireSource(proof.candidateSource, pin.candidateSha256, pin.candidateBlob, "forwarded candidate emitter");
}
