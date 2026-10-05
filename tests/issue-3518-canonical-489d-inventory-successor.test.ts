// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  captureArrayBufferIsViewMainPredecessorPolicySource,
  capturePresentationClassificationPredecessorPolicySource,
  captureLoweringAnalysisPredecessorPolicySource,
  captureWasmGcHelperPredecessorPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { captureProgramValidatorPredecessorPolicySource } from "./helpers/ir-runtime-program-policy-evolution.js";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureNestedStackificationPredecessorPolicySource,
  authenticateCanonical489dInventoryEvolution,
  beforeCanonical489dInventoryPolicy,
  captureCanonical489dPredecessorPolicy,
  captureCanonical489dPredecessorPolicySource,
  beforeCanonical3c6InventoryPolicy,
  beforeCanonical489dInventoryPolicySource,
  beforeCanonical3c6InventoryPolicySource,
  type MutableIrRuntimeProgramPolicy as Policy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
// Independent literal authority; never derived from a inspected mutation.
const expected = {
  schema: 1,
  kind: "fixed-canonical-489d-inventory-only-successor",
  provenance: {
    checkpoint: "367022d3e960d6346cacad134fd89a12e2afd3ee",
    previousMain: "3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8",
    incomingMain: "489d0aacd45b5eb7b11cb06ef4c613a719c20f18",
    planSha256: "23dc1411c73d288132e44c6cdb9bb1c8f5a791648601fc15969c00f069eacd21",
    inventoryOnly: true,
  },
  before: {
    source: {
      bytes: 577771,
      sha256: "2573c40f37d35a8996dab8cfb7ac5c94ef1b57be0f664845878b21e2b516777a",
      gitBlob: "8a7a71945ac6c7728c43cd91ae80a8c270b444cf",
    },
    dataSha256: "4cf6541e0c4677135d54cc2aa47b29763122e4fc416caff66c6165d3cb1e33ac",
    fileCount: 1808,
    filesSha256: "63c4be5ba7d77abd122bbcd55f8273e1fd9ee7a9e59fe522d374d3a0f8c1f54b",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  current: {
    source: {
      bytes: 579411,
      sha256: "82cc93fe5db9e58c118c46fc85db6b3cd4e09656c347358f8334945e70a99d40",
      gitBlob: "9b8282d67bd0d06b1c27ad005ec27c220c1c0d18",
    },
    dataSha256: "f0d41bf5acb4d3378a4b2fa18dd06c5e0720b52deb781ae97ee53dcc0594944c",
    fileCount: 1813,
    filesSha256: "8e5de381a3bd0165b308077ce119567fa9f4804d5143c7fcecec34118224021b",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 187631,
    sha256: "4358379bba95549871b4e17c358b586b8443ec098fb70278eefa4949f96cbeaa",
    gitBlob: "b8f29db92a90343762aff898dd010e5ac8306560",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-canonical-3c6.json",
    bytes: 64620,
    sha256: "4a9cd6bd5109ab1cd3cbb1050066ef18377bb5e686f9f3111d572123fbc9127c",
    gitBlob: "46b0ea9de836a5d4d8a8438fda87892438f3d1e0",
  },
  rowChanges: [
    {
      operation: "addition",
      beforeIndex: 297,
      currentIndex: 297,
      row: {
        path: "src/codegen/classes/class-ctor-call-apply.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/class-constructor-wrapper.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/class-dynamic-keys.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/class-constructor-wrapper.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/class-dynamic-keys.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 302,
      currentIndex: 303,
      row: {
        path: "src/codegen/classes/class-heritage-comma.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/class-heritage-check.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/class-instance-method-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/class-heritage-check.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/classes/class-heritage-runtime-get.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 302,
      currentIndex: 304,
      row: {
        path: "src/codegen/classes/class-heritage-runtime-get.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/class-heritage-check.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/class-instance-method-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/classes/class-heritage-comma.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/class-instance-method-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 368,
      currentIndex: 371,
      row: {
        path: "src/codegen/classes/ctor-return-override.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/cross-hierarchy-operands.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/custom-iterable.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/cross-hierarchy-operands.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/custom-iterable.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 408,
      currentIndex: 412,
      row: {
        path: "src/codegen/classes/derived-ctor-this-guard.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/derived-ascii-case.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/derived-split-scalar.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/derived-ascii-case.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/derived-split-scalar.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
  raw: {
    spans: [
      {
        beforeOffset: 140128,
        afterOffset: 140128,
        before: "",
        after:
          '    {\n      "path": "src/codegen/classes/class-ctor-call-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "9f6ab9f503be20bd5f3e166c56d8772dd07b196cc3ac62dbd12b1af274646bd9",
      },
      {
        beforeOffset: 141727,
        afterOffset: 142054,
        before: "",
        after:
          '    {\n      "path": "src/codegen/classes/class-heritage-comma.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/classes/class-heritage-runtime-get.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "bf1fd16db3a0fd8005f56a64e7c8de9abaaa99df264978b1cf3fedab14ae732d",
      },
      {
        beforeOffset: 162880,
        afterOffset: 163865,
        before: "",
        after:
          '    {\n      "path": "src/codegen/classes/ctor-return-override.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "47071fb74fc050c93d32e8f69fae66cdea9502589400147b890295a84353fc5f",
      },
      {
        beforeOffset: 175944,
        afterOffset: 177255,
        before: "",
        after:
          '    {\n      "path": "src/codegen/classes/derived-ctor-this-guard.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "2854cb381a4b29e5ad8e0a1477d9aa55b5a8675bcf390aec303e385d5038dda7",
      },
    ],
  },
} as const;
const receiptPath = "tests/helpers/ir-runtime-program-policy-canonical-489d.json";
const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const raw = (): string => {
  const text = captureNestedStackificationPredecessorPolicySource(
    captureProgramValidatorPredecessorPolicySource(
      captureWasmGcHelperPredecessorPolicySource(
        captureLoweringAnalysisPredecessorPolicySource(
          capturePresentationClassificationPredecessorPolicySource(
            captureArrayBufferIsViewMainPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
          ),
        ),
      ),
    ),
  );
  expect(Buffer.byteLength(text)).toBe(579411);
  expect(sha(text)).toBe("82cc93fe5db9e58c118c46fc85db6b3cd4e09656c347358f8334945e70a99d40");
  return text;
};
const policy = (): Policy => JSON.parse(raw());
function reject(p: Policy): void {
  expect(() => beforeCanonical489dInventoryPolicy(p)).toThrow(
    "canonical 489d inventory evolution: complete policy profile mismatch",
  );
  expect(() => captureCanonical489dPredecessorPolicy(p)).toThrow(
    "canonical 489d inventory evolution: complete policy profile mismatch",
  );
}
function receiptMutant(change: (r: any) => void): void {
  const r = clone(expected);
  change(r);
  const text = JSON.stringify(r, null, 2) + "\n";
  expect(text).not.toBe(read(receiptPath));
  expect(() => authenticateCanonical489dInventoryEvolution(text)).toThrow("receipt digest mismatch");
}
const physical = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const physicalFaultAuthorities = [receiptPath, helperPath];
function expectMissingAuthority(action: () => void, path: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "ENOENT", path: physical(path) });
}
/** Synchronous, checkout-exclusive real faults; retain recovery bytes/lock on any unsafe restore. */
function withAuthorityFault(path: string, kind: "mutation" | "missing", action: () => void, byte: 0 = 0): void {
  if (!physicalFaultAuthorities.includes(path)) throw new Error("unapproved current-main authority fault: " + path);
  if (
    ![0].includes(byte) ||
    (byte !== 0 && (path !== "tests/helpers/ir-runtime-program-policy-evolution.ts" || kind !== "mutation"))
  )
    throw new Error("unapproved current-main authority fault byte");
  const target = physical(path);
  const scratch = resolve(import.meta.dirname, "../.tmp/c1-main-epoch/canonical-489d-inventory-authority-faults");
  mkdirSync(scratch, { recursive: true });
  const lock = join(scratch, "checkout.lock");
  // Exclusive creation fails closed if another operation owns this checkout.
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let backupDirectory: string | undefined;
  let backup: string | undefined;
  let restored = true;
  const failures: unknown[] = [];
  const cleanupRestoredFault = (): void => {
    if (backup) {
      // Missing-input restoration renames the sole original out of this operation directory.
      try {
        lstatSync(backup);
        unlinkSync(backup);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (backupDirectory) rmdirSync(backupDirectory);
    unlinkSync(lock);
  };
  try {
    const initial = lstatSync(target);
    if (!initial.isFile() || initial.isSymbolicLink())
      throw new Error("authority target must be a regular non-symlink file: " + target);
    const original = readFileSync(target);
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(join(scratch, "operation-"));
    backup = join(backupDirectory, "original");
    const recovery = backup;
    writeFileSync(lock, JSON.stringify({ path, kind, backup }) + "\n", {
      flag: "r+",
    });
    const verifyTarget = (bytes: Buffer): void => {
      const stat = lstatSync(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.ino !== initial.ino ||
        stat.dev !== initial.dev ||
        (stat.mode & 0o7777) !== mode ||
        !readFileSync(target).equals(bytes)
      )
        throw new Error("unexpected authority edit; refusing to overwrite: " + target);
    };
    const restoreFault = (): void => {
      const saved = lstatSync(recovery);
      if (
        !saved.isFile() ||
        saved.isSymbolicLink() ||
        (saved.mode & 0o7777) !== mode ||
        !readFileSync(recovery).equals(original)
      )
        throw new Error("recovery copy differs from captured authority");
      if (kind === "mutation") {
        verifyTarget(mutated);
        writeFileSync(target, original);
        chmodSync(target, mode);
      } else {
        expectMissingAuthority(() => {
          lstatSync(target);
        }, path);
        if (saved.ino !== initial.ino || saved.dev !== initial.dev)
          throw new Error("renamed authority identity changed");
        renameSync(recovery, target);
        chmodSync(target, mode);
      }
      verifyTarget(original);
      restored = true;
    };
    verifyTarget(original);
    if (kind === "mutation") {
      writeFileSync(recovery, original, { flag: "wx", mode });
      chmodSync(recovery, mode);
    }
    restored = false;
    try {
      if (kind === "mutation") {
        writeFileSync(target, mutated);
        chmodSync(target, mode);
        verifyTarget(mutated);
        if (byte === 0) {
          expect(mutated[0]).not.toBe(original[0]);
          expect(mutated.subarray(1).equals(original.subarray(1))).toBe(true);
        } else {
          expect(mutated[byte]).not.toBe(original[byte]);
          expect(mutated.subarray(0, byte).equals(original.subarray(0, byte))).toBe(true);
          expect(mutated.subarray(byte + 1).equals(original.subarray(byte + 1))).toBe(true);
        }
      } else {
        renameSync(target, recovery);
        expectMissingAuthority(() => {
          readFileSync(target);
        }, path);
        expect(() => lstatSync(target)).toThrow(/ENOENT/);
      }
      action();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        restoreFault();
      } catch (error) {
        failures.push(
          new Error(
            "authority restoration failed; recovery retained at " + backup + "; checkout lock retained at " + lock,
            { cause: error },
          ),
        );
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (restored) {
      try {
        cleanupRestoredFault();
      } catch (error) {
        failures.push(
          new Error("authority cleanup failed; checkout lock/recovery retained at " + lock + " / " + backup, {
            cause: error,
          }),
        );
      }
    }
  }
  // Propagate only after every safe restoration/cleanup path has completed.
  if (failures.length > 1) throw new AggregateError(failures, "authority operation and recovery failures: " + target);
  if (failures.length === 1) throw failures[0];
}

afterEach(async () => {
  await setImmediate();
});
describe("fixed inventory-only canonical 489d successor", () => {
  it("proves the fixed five identities, complete current profiles and reciprocal1808 predecessor", () => {
    expect(Buffer.byteLength(read(receiptPath))).toBe(14714);
    expect(sha(read(receiptPath))).toBe("52dc8a9359369565c5d1f39f01af8d9c8d853aa1e4b0a1f469622e350f3a7497");
    expect(authenticateCanonical489dInventoryEvolution()).toEqual(expected);
    expect(Object.keys(expected)).not.toContain("sourcePins");
    const text = raw(),
      p = policy();
    expect(p.files).toHaveLength(1813);
    expect(sha(JSON.stringify(p))).toBe(expected.current.dataSha256);
    for (const [key, pin] of [
      ["files", expected.current.filesSha256],
      ["layers", expected.current.layersSha256],
      ["activationHistory", expected.current.activationHistorySha256],
      ["allowedEdges", expected.current.allowedEdgesSha256],
    ] as const)
      expect(sha(JSON.stringify(p[key]))).toBe(pin);
    expect(p.activationHistory).toHaveLength(101);
    expect(expected.rowChanges.map((change) => change.row.path)).toEqual([
      "src/codegen/classes/class-ctor-call-apply.ts",
      "src/codegen/classes/class-heritage-comma.ts",
      "src/codegen/classes/class-heritage-runtime-get.ts",
      "src/codegen/classes/ctor-return-override.ts",
      "src/codegen/classes/derived-ctor-this-guard.ts",
    ]);
    for (const change of expected.rowChanges) {
      expect(Object.keys(p.files[change.currentIndex]!)).toEqual([
        "path",
        "state",
        "layer",
        "destination",
        "owner",
        "nextBoundary",
      ]);
      expect(p.files[change.currentIndex]).toEqual(change.row);
    }
    const predecessorRaw = beforeCanonical489dInventoryPolicySource(text);
    const predecessor = beforeCanonical489dInventoryPolicy(p);
    expect(Buffer.byteLength(predecessorRaw)).toBe(577771);
    expect(sha(predecessorRaw)).toBe("2573c40f37d35a8996dab8cfb7ac5c94ef1b57be0f664845878b21e2b516777a");
    expect(predecessor.files).toHaveLength(1808);
    expect(JSON.parse(predecessorRaw)).toEqual(predecessor);
    expect(JSON.parse(beforeCanonical3c6InventoryPolicySource(predecessorRaw))).toEqual(
      beforeCanonical3c6InventoryPolicy(predecessor),
    );
    expect(beforeCanonical3c6InventoryPolicy(predecessor).files).toHaveLength(1782);
    expect(p.files.filter((row) => !expected.rowChanges.some((change) => change.row.path === row.path))).toEqual(
      predecessor.files,
    );
    expect(p.layers).toEqual(predecessor.layers);
    expect(p.activationHistory).toEqual(predecessor.activationHistory);
    expect(p.allowedEdges).toEqual(predecessor.allowedEdges);
    expect(p.files[1812]).toEqual(predecessor.files[1807]);
    expect(p.files[1812]!.path).toBe("src/ir/runtime/intrinsic-preparation.ts");
    const replay = clone(predecessor);
    expected.rowChanges.forEach((change, inserted) =>
      replay.files.splice(change.beforeIndex + inserted, 0, clone(change.row)),
    );
    expect(replay).toEqual(p);
    const bytes = Buffer.from(predecessorRaw),
      pieces: Buffer[] = [];
    let consumed = 0;
    for (const span of expected.raw.spans) {
      pieces.push(bytes.subarray(consumed, span.beforeOffset), Buffer.from(span.after));
      consumed = span.beforeOffset;
    }
    pieces.push(bytes.subarray(consumed));
    expect(Buffer.concat(pieces).toString("utf8")).toBe(text);
    const captured = captureCanonical489dPredecessorPolicy(p);
    const capturedRaw = captureCanonical489dPredecessorPolicySource(text);
    const independent = clone(p);
    for (const change of [...expected.rowChanges].reverse()) independent.files.splice(change.currentIndex, 1);
    expect(captured).toEqual(independent);
    expect(captured).toEqual(predecessor);
    expect(capturedRaw).toBe(predecessorRaw);
    expect(JSON.parse(capturedRaw)).toEqual(independent);
    expect(Buffer.byteLength(capturedRaw)).toBe(expected.before.source.bytes);
    expect(sha(capturedRaw)).toBe(expected.before.source.sha256);
    expect(captured.files).not.toBe(p.files);
  });
  for (const change of expected.rowChanges) {
    it(`refuses missing row ${change.row.path}`, () => {
      const p = policy();
      p.files.splice(change.currentIndex, 1);
      reject(p);
    });
    it(`refuses duplicate row ${change.row.path}`, () => {
      const p = policy();
      p.files.splice(change.currentIndex, 0, clone(change.row));
      reject(p);
    });
    it(`refuses forbidden clean state ${change.row.path}`, () => {
      const p = policy();
      p.files[change.currentIndex]!.state = "clean";
      reject(p);
    });
  }
  it("refuses swapping the same-index comma/runtime-get additions", () => {
    const p = policy();
    [p.files[303], p.files[304]] = [p.files[304]!, p.files[303]!];
    reject(p);
  });
  it("refuses an extra ownership row key", () => {
    const p = policy();
    p.files[297]!.sourcePins = "unapproved";
    reject(p);
  });
  it("refuses a changed retained row", () => {
    const p = policy();
    p.files[0]!.path += " changed";
    reject(p);
  });
  it("refuses activation-history mutation", () => {
    const p = policy();
    p.activationHistory.reverse();
    reject(p);
  });
  it("refuses allowedEdges mutation", () => {
    const p = policy();
    expect(p.allowedEdges["ir-runtime"]).not.toContain("frontend-ts");
    p.allowedEdges["ir-runtime"].push("frontend-ts");
    expect(p.allowedEdges["ir-runtime"]).toContain("frontend-ts");
    reject(p);
  });
  for (const [index, span] of expected.raw.spans.entries()) {
    it(`refuses omitted raw insertion group ${index}`, () => {
      const text = raw();
      const mutant = text.slice(0, span.afterOffset) + text.slice(span.afterOffset + span.after.length);
      expect(() => beforeCanonical489dInventoryPolicySource(mutant)).toThrow(
        "canonical complete raw source profile mismatch",
      );
      expect(() => captureCanonical489dPredecessorPolicySource(mutant)).toThrow(
        "canonical complete raw source profile mismatch",
      );
    });
    it(`refuses duplicated raw insertion group ${index}`, () => {
      const text = raw();
      const mutant = text.slice(0, span.afterOffset) + span.after + text.slice(span.afterOffset);
      expect(() => beforeCanonical489dInventoryPolicySource(mutant)).toThrow(
        "canonical complete raw source profile mismatch",
      );
      expect(() => captureCanonical489dPredecessorPolicySource(mutant)).toThrow(
        "canonical complete raw source profile mismatch",
      );
    });
    it(`refuses reordered complete raw insertion group ${index}`, () => {
      const text = raw(),
        bytes = Buffer.from(text);
      const destination = 579284;
      expect(bytes.subarray(destination).toString("utf8")).toMatch(
        /^ {4}\{\n {6}"path": "src\/ir\/runtime\/intrinsic-preparation\.ts"/,
      );
      expect(Buffer.byteLength(text.slice(0, span.afterOffset))).toBe(span.afterOffset);
      expect(Buffer.byteLength(text.slice(0, destination))).toBe(destination);
      const mutant = Buffer.concat([
        bytes.subarray(0, span.afterOffset),
        bytes.subarray(span.afterOffset + Buffer.byteLength(span.after), destination),
        Buffer.from(span.after),
        bytes.subarray(destination),
      ]).toString("utf8");
      const current = JSON.parse(text) as Policy,
        reordered = JSON.parse(mutant) as Policy;
      expect(Buffer.byteLength(mutant)).toBe(Buffer.byteLength(text));
      expect(reordered.files.map((row) => JSON.stringify(row)).sort()).toEqual(
        current.files.map((row) => JSON.stringify(row)).sort(),
      );
      expect(reordered.files).not.toEqual(current.files);
      expect(() => beforeCanonical489dInventoryPolicySource(mutant)).toThrow(
        "canonical complete raw source profile mismatch",
      );
      expect(() => captureCanonical489dPredecessorPolicySource(mutant)).toThrow(
        "canonical complete raw source profile mismatch",
      );
    });
  }
  it("refuses the stale1808 semantic predecessor", () => {
    expect(() => beforeCanonical489dInventoryPolicy(beforeCanonical489dInventoryPolicy(policy()))).toThrow(
      "complete policy profile mismatch",
    );
    const stale = captureCanonical489dPredecessorPolicy(policy());
    expect(() => captureCanonical489dPredecessorPolicy(stale)).toThrow("complete policy profile mismatch");
  });
  it("refuses the stale1808 raw predecessor", () => {
    expect(() => beforeCanonical489dInventoryPolicySource(beforeCanonical489dInventoryPolicySource(raw()))).toThrow(
      "canonical complete raw source profile mismatch",
    );
    const stale = captureCanonical489dPredecessorPolicySource(raw());
    expect(() => captureCanonical489dPredecessorPolicySource(stale)).toThrow(
      "canonical complete raw source profile mismatch",
    );
  });
  it("raw wrapper refusal precedes missing receipt without conversion", () => {
    const text = raw();
    let calls = 0;
    const boxed = new String(text);
    boxed.toString = () => {
      calls++;
      throw new Error("conversion executed");
    };
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => beforeCanonical489dInventoryPolicySource(text), receiptPath);
      expect(() => beforeCanonical489dInventoryPolicySource(boxed as unknown as string)).toThrow(
        "raw input must be a primitive string",
      );
      expect(calls).toBe(0);
    });
    let captureCalls = 0;
    const captureBoxed = new String(text);
    captureBoxed.toString = () => {
      captureCalls++;
      throw new Error("conversion executed");
    };
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => captureCanonical489dPredecessorPolicySource(text), receiptPath);
      expect(() => captureCanonical489dPredecessorPolicySource(captureBoxed as unknown as string)).toThrow(
        "raw input must be a primitive string",
      );
      expect(captureCalls).toBe(0);
    });
  });
  it("non-object policy refusal precedes missing receipt", () => {
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => authenticateCanonical489dInventoryEvolution(), receiptPath);
      expect(() => beforeCanonical489dInventoryPolicy(null)).toThrow("policy input must be a plain object");
    });
    const healthy = policy();
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => captureCanonical489dPredecessorPolicy(healthy), receiptPath);
      expect(() => captureCanonical489dPredecessorPolicy(null)).toThrow("policy input must be a plain object");
    });
  });
  it("getter refusal precedes missing receipt and never executes the getter", () => {
    const p = policy();
    let calls = 0;
    Object.defineProperty(p, "files", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("getter executed");
      },
    });
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => authenticateCanonical489dInventoryEvolution(), receiptPath);
      expect(() => beforeCanonical489dInventoryPolicy(p)).toThrow("accessor or hidden policy field");
      expect(calls).toBe(0);
    });
    const captureInput = policy(),
      healthy = policy();
    let captureCalls = 0;
    Object.defineProperty(captureInput, "files", {
      enumerable: true,
      get() {
        captureCalls++;
        throw new Error("getter executed");
      },
    });
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => captureCanonical489dPredecessorPolicy(healthy), receiptPath);
      expect(() => captureCanonical489dPredecessorPolicy(captureInput)).toThrow("accessor or hidden policy field");
      expect(captureCalls).toBe(0);
    });
  });
  it("hidden and symbol keys refuse before missing receipt", () => {
    const hidden = policy(),
      symbol = policy();
    Object.defineProperty(hidden, "hidden", { value: 1, enumerable: false });
    Object.defineProperty(symbol, Symbol("key"), { value: 1, enumerable: true });
    for (const p of [hidden, symbol])
      withAuthorityFault(receiptPath, "missing", () => {
        expectMissingAuthority(() => authenticateCanonical489dInventoryEvolution(), receiptPath);
        expect(() => beforeCanonical489dInventoryPolicy(p)).toThrow("policy evolution:");
      });
    const captureHidden = policy(),
      captureSymbol = policy(),
      healthy = policy();
    Object.defineProperty(captureHidden, "hidden", { value: 1, enumerable: false });
    Object.defineProperty(captureSymbol, Symbol("key"), { value: 1, enumerable: true });
    for (const input of [captureHidden, captureSymbol])
      withAuthorityFault(receiptPath, "missing", () => {
        expectMissingAuthority(() => captureCanonical489dPredecessorPolicy(healthy), receiptPath);
        expect(() => captureCanonical489dPredecessorPolicy(input)).toThrow("policy evolution:");
      });
  });
  it("throwing descriptor proxy refuses before missing receipt", () => {
    const p = new Proxy(policy(), {
      ownKeys() {
        throw new Error("489d descriptor trap");
      },
    });
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => authenticateCanonical489dInventoryEvolution(), receiptPath);
      expect(() => beforeCanonical489dInventoryPolicy(p)).toThrow("489d descriptor trap");
    });
    const captureInput = new Proxy(policy(), {
        ownKeys() {
          throw new Error("489d descriptor trap");
        },
      }),
      healthy = policy();
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => captureCanonical489dPredecessorPolicy(healthy), receiptPath);
      expect(() => captureCanonical489dPredecessorPolicy(captureInput)).toThrow("489d descriptor trap");
    });
  });
  it("cycle refuses before missing receipt", () => {
    const p = policy();
    p.cycle = p;
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => authenticateCanonical489dInventoryEvolution(), receiptPath);
      expect(() => beforeCanonical489dInventoryPolicy(p)).toThrow("non-JSON or cyclic policy");
    });
    const captureInput = policy(),
      healthy = policy();
    captureInput.cycle = captureInput;
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => captureCanonical489dPredecessorPolicy(healthy), receiptPath);
      expect(() => captureCanonical489dPredecessorPolicy(captureInput)).toThrow("non-JSON or cyclic policy");
    });
  });
  it("refuses a changed new receipt byte", () => {
    const text = read(receiptPath);
    expect(() => authenticateCanonical489dInventoryEvolution("[" + text.slice(1))).toThrow("receipt digest mismatch");
  });
  it("refuses an added receipt schema field", () => {
    receiptMutant((r) => {
      r.sourcePins = [];
    });
  });
  it("refuses the stale prior3c6 receipt", () => {
    expect(() =>
      authenticateCanonical489dInventoryEvolution(read("tests/helpers/ir-runtime-program-policy-canonical-3c6.json")),
    ).toThrow("receipt digest mismatch");
  });
  for (const path of physicalFaultAuthorities)
    for (const kind of ["mutation", "missing"] as const)
      for (const api of ["receipt", "semantic", "raw"] as const) {
        it(`freshly refuses ${kind} physical ${path} through ${api} after success`, () => {
          const p = policy(),
            text = raw();
          authenticateCanonical489dInventoryEvolution();
          beforeCanonical489dInventoryPolicy(p);
          beforeCanonical489dInventoryPolicySource(text);
          const action = () => {
            if (api === "receipt") authenticateCanonical489dInventoryEvolution();
            else if (api === "semantic") beforeCanonical489dInventoryPolicy(p);
            else beforeCanonical489dInventoryPolicySource(text);
          };
          withAuthorityFault(path, kind, () => {
            if (kind === "missing") expectMissingAuthority(action, path);
            else
              expect(action).toThrow(
                path === receiptPath
                  ? "receipt digest mismatch"
                  : "complete canonical predecessor helper prefix changed",
              );
          });
          action();
        });
      }
  it("rechecks a changed mutable argument and accepts exact restoration", () => {
    const p = policy(),
      original = p.files[297]!.owner;
    const first = beforeCanonical489dInventoryPolicy(p);
    p.files[297]!.owner = "changed";
    reject(p);
    expect(first.files).toHaveLength(1808);
    p.files[297]!.owner = original;
    expect(beforeCanonical489dInventoryPolicy(p)).toEqual(first);
    const captureInput = policy();
    const firstCapture = captureCanonical489dPredecessorPolicy(captureInput);
    captureInput.files[297]!.owner = "changed";
    expect(() => captureCanonical489dPredecessorPolicy(captureInput)).toThrow("complete policy profile mismatch");
    expect(firstCapture.files).toHaveLength(1808);
    expect(captureCanonical489dPredecessorPolicy(policy())).toEqual(firstCapture);
  });
});

describe("fresh canonical 489d inventory capture authority", () => {
  for (const path of physicalFaultAuthorities)
    for (const kind of ["mutation", "missing"] as const)
      for (const api of ["semantic", "raw"] as const)
        it(`fresh capture refuses ${kind} physical ${path} through ${api} after success`, () => {
          const p = policy(),
            text = raw();
          const action = () =>
            api === "semantic"
              ? captureCanonical489dPredecessorPolicy(p)
              : captureCanonical489dPredecessorPolicySource(text);
          const first = action();
          if (typeof first === "string") {
            expect(Buffer.byteLength(first)).toBe(expected.before.source.bytes);
            expect(sha(first)).toBe(expected.before.source.sha256);
          } else expect(first.files).toHaveLength(expected.before.fileCount);
          withAuthorityFault(path, kind, () => {
            if (kind === "missing") expectMissingAuthority(action, path);
            else
              expect(action).toThrow(
                path === receiptPath
                  ? "receipt digest mismatch"
                  : "complete canonical predecessor helper prefix changed",
              );
          });
          expect(action()).toEqual(first);
        });
});
