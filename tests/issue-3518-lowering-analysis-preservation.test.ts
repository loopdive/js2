import { captureDenoPostPositionMainPredecessorPolicySource } from "./helpers/ir-deno-post-position-main-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { capturePositionFinallyMainPredecessorPolicySource } from "./helpers/ir-position-finally-main-successor.js";
import { capturePositionClassFieldsMainPredecessorPolicySource } from "./helpers/ir-position-class-fields-main-successor.js";
import { captureSourceMapPositionInventoryPredecessorPolicySource } from "./helpers/ir-source-map-position-inventory-successor.js";
import { captureMainInventoryPredecessorPolicySource } from "./helpers/ir-main-inventory-source-successor.js";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { captureC1CurrentPopulation } from "./helpers/ir-c1-current-source.js";
import {
  captureArrayBufferIsViewMainPredecessorPolicySource,
  capturePresentationClassificationPredecessorPolicySource,
  captureLoweringAnalysisPredecessorPolicy,
  captureLoweringAnalysisPredecessorPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import {
  captureLinearLayoutPredecessor,
  captureLinearLayoutGeometry,
  captureLoweringLegalityPredecessor,
  captureCurrentLoweringLegalityPredecessor,
} from "./helpers/ir-lowering-analysis-relocation.js";

import { captureGeometryCurrentMainPredecessorPolicySource } from "./helpers/ir-c1-historical-authority.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const receiptPath = "tests/helpers/ir-lowering-analysis-relocation.json";
const plannerPath = "src/ir/analysis/linear-memory-plan.ts";
const layoutPath = "src/ir/analysis/contracts/linear-memory-layout.ts";
const adapterPath = "src/ir/backend/legality.ts";
const ownerPath = "src/ir/analysis/backend-legality.ts";
const implementationPath = "tests/helpers/ir-lowering-analysis-relocation.ts";
// Root supplied independent formatted implementation pin; freshly checked before every accepting call.
const implementationPin = {
  bytes: 18956,
  sha256: "253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99",
  gitBlob: "c732f2eb22a127714373bc8fa363514bcf7a818b",
};
const historicalSourcePins = [
  {
    path: plannerPath,
    bytes: 49040,
    sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
    gitBlob: "a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c",
  },
  {
    path: layoutPath,
    bytes: 4670,
    sha256: "dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72",
    gitBlob: "cac9d1e33659380a6ee8d8e03014af53e1123533",
  },
  {
    path: adapterPath,
    bytes: 5833,
    sha256: "5b67993fe312a0f5a52f9ef816c76a10cd32470f7e2a53819dec736764f45878",
    gitBlob: "c38edb2f3d1350b0ea23f887c9349ac768d48afa",
  },
  {
    path: ownerPath,
    bytes: 21362,
    sha256: "e6bdc35fbf47fc26581c24cbecb08f27a4d590a7006d005031b6a309db26b506",
    gitBlob: "34a1399bdd963163f2155f0de0933d085dbc4f25",
  },
] as const;
const currentOwnerPin = {
  path: ownerPath,
  bytes: 21387,
  sha256: "cdd60287d9c98f700eca41f351f02ac609f3e9fdd43a25e28d7951f16f0c1a37",
  gitBlob: "157777ff1c14c6cf5f0e4241c4e361843d694f5b",
};
const sourcePins = historicalSourcePins.map((entry) => (entry.path === ownerPath ? currentOwnerPin : entry));
const ownerInsertionOffset = 8250;
const ownerInsertion = Buffer.from('    case "early.return":\n');
// Independent fixture oracle: this does not invoke the source component under test.
function historicalOwner(current: Buffer): Buffer {
  pin(current, currentOwnerPin);
  expect(ownerInsertion).toHaveLength(25);
  expect(current.subarray(ownerInsertionOffset, ownerInsertionOffset + ownerInsertion.length)).toEqual(ownerInsertion);
  const before = Buffer.concat([
    current.subarray(0, ownerInsertionOffset),
    current.subarray(ownerInsertionOffset + ownerInsertion.length),
  ]);
  pin(before, historicalSourcePins[3]);
  const replay = Buffer.concat([
    before.subarray(0, ownerInsertionOffset),
    ownerInsertion,
    before.subarray(ownerInsertionOffset),
  ]);
  pin(replay, currentOwnerPin);
  expect(replay).toEqual(current);
  return before;
}
const receiptPin = {
  bytes: 111423,
  sha256: "dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134",
  gitBlob: "6fee96e10bb22a1f3071ddc41b4a2af39ee96763",
};
const donorPins = {
  planner: {
    bytes: 52704,
    sha256: "382cb4acee2de86904da1c0162ecc8b9de4250f9f9cb49dcba57b1a056c1cc3c",
    gitBlob: "ae6f9ab03e01c80622e56a69c5b05c6826366d69",
  },
  legality: {
    bytes: 26410,
    sha256: "6a64764b2691d6b2994258a966afabdac0b981fc036f611be5d8969032a3db98",
    gitBlob: "d4854103ad1fae2f12c105fc0e1a66e2d20a5c6e",
  },
} as const;
const allowed = [receiptPath, plannerPath, layoutPath, adapterPath, ownerPath] as const;
type Reader = (path: string) => string;
function hashes(bytes: Buffer) {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gitBlob: createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex"),
  };
}
function pin(bytes: Buffer, expected: { bytes: number; sha256: string; gitBlob: string }) {
  expect(hashes(bytes)).toEqual({ bytes: expected.bytes, sha256: expected.sha256, gitBlob: expected.gitBlob });
}
// Independent physical geometry authority. Historical fixtures below are derived only after this replay.
const geometryReceiptPath = "tests/helpers/ir-linear-layout-geometry-successor.json";
const sharedGeometryPath = "src/shared/contracts/linear-memory-layout.ts";
const completeGeometryImplementationPin = {
  bytes: 35439,
  sha256: "87bf7de1961b821cf303b5d7e686a5e44614b08b7b371ee6afe4a16172a7851e",
  gitBlob: "4260f7bdb92344a9b20427b75113020b6d9e31a9",
};
const geometryReceiptPin = {
  bytes: 69621,
  sha256: "e4af32c53ea548b693fbcee78c55b3af47b7985e2dc1b340ddf9c28e0a8f573f",
  gitBlob: "2ad1d8ef1c76fb3cfe9dfa951ccf826f4e03c010",
};
const actualGeometryPins = [
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    bytes: 45359,
    sha256: "08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc",
    gitBlob: "3db990eb21e3ed216cd798548af6d076e32ed9e1",
  },
  {
    path: "src/ir/analysis/contracts/linear-memory-layout.ts",
    bytes: 3161,
    sha256: "83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91",
    gitBlob: "0dd2108962236a64e2b96479309b5b1e9735c90e",
  },
  {
    path: "src/shared/contracts/linear-memory-layout.ts",
    bytes: 7580,
    sha256: "08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937",
    gitBlob: "59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee",
  },
] as const;
const geometryBeforePins = [
  {
    path: "src/ir/analysis/linear-memory-plan.ts",
    bytes: 49040,
    sha256: "5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52",
    gitBlob: "a44148b86cf60d75a8ebcd9decd2f0fc3a5aad1c",
  },
  {
    path: "src/ir/analysis/contracts/linear-memory-layout.ts",
    bytes: 4763,
    sha256: "977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754",
    gitBlob: "280a72ab47f43584f93efb664e3e64b55dc896b5",
  },
] as const;
const forwardingBeforePin = {
  bytes: 4670,
  sha256: "dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72",
  gitBlob: "cac9d1e33659380a6ee8d8e03014af53e1123533",
};
const geometryReadOrder = [
  geometryReceiptPath,
  ...actualGeometryPins.map((entry) => entry.path),
  "tests/helpers/ir-lowering-analysis-relocation.json",
] as const;
type GeometryPin = { bytes: number; sha256: string; gitBlob: string };
type GeometryCopy = {
  kind: "copy";
  name: string;
  path: string;
  offset: number;
  length: number;
  sourceSha256: string;
  outputOffset: number;
};
type GeometryLiteral = { kind: "literal"; name: string; text: string; outputOffset: number };
type GeometryRecipe = { path: string; pin: GeometryPin; pieces: (GeometryCopy | GeometryLiteral)[] };
type GeometryCoverage = { path: string; spans: { offset: number; length: number; sha256: string; uses: number }[] };
type GeometryReceipt = {
  schema: string;
  sourceBase: string;
  currentInputs: typeof actualGeometryPins;
  geometryBeforeInputs: typeof geometryBeforePins;
  sharedAbsentBefore: boolean;
  oldAuthority: {
    helperPrefix: { path: string; bytes: number; sha256: string };
    receipt: GeometryPin & { path: string };
  };
  geometry: {
    inverse: GeometryRecipe[];
    inverseCoverage: GeometryCoverage[];
    forward: GeometryRecipe[];
    forwardCoverage: GeometryCoverage[];
  };
  forwarding: {
    commit: string;
    parent: string;
    path: string;
    offset: number;
    length: number;
    beforePin: GeometryPin;
    afterPin: GeometryPin;
    inverseText: string;
    forwardText: string;
  };
};
function geometryBytePin(bytes: Buffer): GeometryPin {
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gitBlob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  };
}
function requireGeometryPin(bytes: Buffer, expected: GeometryPin): void {
  expect(geometryBytePin(bytes)).toEqual({ bytes: expected.bytes, sha256: expected.sha256, gitBlob: expected.gitBlob });
}
function independentlyReplayGeometry(
  recipes: GeometryRecipe[],
  coverage: GeometryCoverage[],
  sources: ReadonlyMap<string, Buffer>,
  expected: readonly (GeometryPin & { path: string })[],
): Map<string, Buffer> {
  expect(recipes.map((entry) => entry.path)).toEqual(expected.map((entry) => entry.path));
  expect(coverage.map((entry) => entry.path)).toEqual([...sources.keys()]);
  const copied: GeometryCopy[] = [];
  const outputs = new Map<string, Buffer>();
  for (const [index, recipe] of recipes.entries()) {
    expect(recipe.pin).toEqual({
      bytes: expected[index]!.bytes,
      sha256: expected[index]!.sha256,
      gitBlob: expected[index]!.gitBlob,
    });
    let cursor = 0;
    const pieces: Buffer[] = [];
    for (const piece of recipe.pieces) {
      expect(piece.outputOffset).toBe(cursor);
      expect(typeof piece.name).toBe("string");
      expect(piece.name.length).toBeGreaterThan(0);
      let value: Buffer;
      if (piece.kind === "copy") {
        const donor = sources.get(piece.path);
        expect(donor).toBeDefined();
        if (!donor) throw new Error("independent geometry donor outside closed source domain: " + piece.path);
        expect(Number.isSafeInteger(piece.offset) && piece.offset >= 0).toBe(true);
        expect(Number.isSafeInteger(piece.length) && piece.length > 0).toBe(true);
        expect(piece.offset + piece.length).toBeLessThanOrEqual(donor.length);
        value = donor.subarray(piece.offset, piece.offset + piece.length);
        expect(createHash("sha256").update(value).digest("hex")).toBe(piece.sourceSha256);
        copied.push(piece);
      } else {
        expect(piece.kind).toBe("literal");
        value = Buffer.from(piece.text, "utf8");
        expect(value.toString("utf8")).toBe(piece.text);
        expect(value.length).toBeGreaterThan(0);
      }
      pieces.push(value);
      cursor += value.length;
    }
    const output = Buffer.concat(pieces);
    requireGeometryPin(output, expected[index]!);
    expect(outputs.has(recipe.path)).toBe(false);
    outputs.set(recipe.path, output);
  }
  // Every input byte has one explicit coverage interval, including discarded/introduced spans with zero use.
  for (const row of coverage) {
    const source = sources.get(row.path)!;
    let cursor = 0;
    for (const span of row.spans) {
      expect(span.offset).toBe(cursor);
      expect(Number.isSafeInteger(span.length) && span.length > 0).toBe(true);
      const end = span.offset + span.length;
      expect(end).toBeLessThanOrEqual(source.length);
      expect(createHash("sha256").update(source.subarray(span.offset, end)).digest("hex")).toBe(span.sha256);
      const users = copied.filter(
        (piece) => piece.path === row.path && piece.offset < end && piece.offset + piece.length > span.offset,
      );
      for (const piece of users) {
        expect(piece.offset).toBeLessThanOrEqual(span.offset);
        expect(piece.offset + piece.length).toBeGreaterThanOrEqual(end);
      }
      expect(users).toHaveLength(span.uses);
      cursor = end;
    }
    expect(cursor).toBe(source.length);
  }
  return outputs;
}
function independentGeometryViews(readCurrent: (path: string) => string) {
  const receiptBytes = Buffer.from(readCurrent(geometryReceiptPath));
  requireGeometryPin(receiptBytes, geometryReceiptPin);
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as GeometryReceipt;
  expect(Object.keys(receipt)).toEqual([
    "schema",
    "sourceBase",
    "currentInputs",
    "geometryBeforeInputs",
    "sharedAbsentBefore",
    "oldAuthority",
    "geometry",
    "forwarding",
  ]);
  expect(receipt.schema).toBe("ir-linear-layout-geometry-successor-v1");
  expect(receipt.sourceBase).toBe("b932e3a05e353acc59e7b547ef4e417a5d8637e1");
  expect(receipt.currentInputs).toEqual(actualGeometryPins);
  expect(receipt.geometryBeforeInputs).toEqual(geometryBeforePins);
  expect(receipt.sharedAbsentBefore).toBe(true);
  expect(receipt.oldAuthority.helperPrefix).toEqual({
    path: "tests/helpers/ir-lowering-analysis-relocation.ts",
    bytes: 18956,
    sha256: "253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99",
  });
  const current = new Map(
    actualGeometryPins.map((entry) => {
      const source = Buffer.from(readCurrent(entry.path));
      requireGeometryPin(source, entry);
      return [entry.path, source] as const;
    }),
  );
  const oldReceipt = Buffer.from(readCurrent(receipt.oldAuthority.receipt.path));
  requireGeometryPin(oldReceipt, {
    bytes: 111423,
    sha256: "dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134",
    gitBlob: "6fee96e10bb22a1f3071ddc41b4a2af39ee96763",
  });
  const before = independentlyReplayGeometry(
    receipt.geometry.inverse,
    receipt.geometry.inverseCoverage,
    current,
    geometryBeforePins,
  );
  const forward = independentlyReplayGeometry(
    receipt.geometry.forward,
    receipt.geometry.forwardCoverage,
    before,
    actualGeometryPins,
  );
  for (const [path, source] of current) expect(forward.get(path)).toEqual(source);
  const forwarding = receipt.forwarding;
  expect([forwarding.commit, forwarding.parent, forwarding.path, forwarding.offset, forwarding.length]).toEqual([
    "2a98b75de993bdc568e3668a2965c026876fe322",
    "6c88d157444ea4ae377a7ef1b82b15ef2f4f6603",
    "src/ir/analysis/contracts/linear-memory-layout.ts",
    2820,
    93,
  ]);
  const layout = before.get(forwarding.path)!;
  requireGeometryPin(layout, geometryBeforePins[1]);
  expect(forwarding.afterPin).toEqual({
    bytes: geometryBeforePins[1].bytes,
    sha256: geometryBeforePins[1].sha256,
    gitBlob: geometryBeforePins[1].gitBlob,
  });
  expect(forwarding.beforePin).toEqual(forwardingBeforePin);
  const inverseSpan = Buffer.from(forwarding.inverseText);
  expect(inverseSpan).toHaveLength(93);
  expect(layout.subarray(2820, 2913)).toEqual(inverseSpan);
  const loweringLayout = Buffer.concat([layout.subarray(0, 2820), layout.subarray(2913)]);
  requireGeometryPin(loweringLayout, forwardingBeforePin);
  // Authored forward operand is read separately; never manufacture it from the inverse result.
  const forwardSpan = Buffer.from(forwarding.forwardText);
  expect(forwardSpan).toHaveLength(93);
  expect(Buffer.concat([loweringLayout.subarray(0, 2820), forwardSpan, loweringLayout.subarray(2820)])).toEqual(layout);
  return {
    currentPlanner: current.get(actualGeometryPins[0].path)!.toString("utf8"),
    currentLayout: current.get(actualGeometryPins[1].path)!.toString("utf8"),
    currentShared: current.get(actualGeometryPins[2].path)!.toString("utf8"),
    geometryBeforePlanner: before.get(geometryBeforePins[0].path)!.toString("utf8"),
    geometryBeforeLayout: layout.toString("utf8"),
    loweringBeforePlanner: before.get(geometryBeforePins[0].path)!.toString("utf8"),
    loweringBeforeLayout: loweringLayout.toString("utf8"),
  };
}

function authenticateImplementation(): void {
  const physical = join(root, implementationPath);
  if (!existsSync(physical)) throw new Error(`component implementation missing: ${implementationPath}`);
  const source = readFileSync(physical);
  const actual = hashes(source);
  const prefix = hashes(source.subarray(0, implementationPin.bytes));
  if (
    actual.bytes !== completeGeometryImplementationPin.bytes ||
    actual.sha256 !== completeGeometryImplementationPin.sha256 ||
    actual.gitBlob !== completeGeometryImplementationPin.gitBlob ||
    prefix.bytes !== implementationPin.bytes ||
    prefix.sha256 !== implementationPin.sha256 ||
    prefix.gitBlob !== implementationPin.gitBlob
  )
    throw new Error(`component implementation full pin: ${implementationPath}`);
}
const operations = [
  {
    name: "linear-layout",
    input: plannerPath,
    witness: "planner",
    call: captureLinearLayoutPredecessor,
    trace: [receiptPath, layoutPath],
  },
  {
    name: "backend-legality",
    input: adapterPath,
    witness: "legality",
    call: captureCurrentLoweringLegalityPredecessor,
    trace: [receiptPath, adapterPath, ownerPath],
  },
] as const;
function accepting(op: (typeof operations)[number], raw: string, reader: Reader): string {
  authenticateImplementation();
  return op.call(raw, reader);
}
function fixture(run: (dir: string, read: Reader, trace: string[]) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "js2-d1-source-component-"));
  let completed = false;
  try {
    authenticateImplementation();
    const acquisitionTrace: string[] = [];
    const geometryReader: Reader = (path) => {
      if (!(geometryReadOrder as readonly string[]).includes(path))
        throw new Error("unknown geometry fixture path: " + path);
      acquisitionTrace.push(path);
      const physical = join(root, path);
      expect(statSync(physical).mode & 0o777).toBe(0o644);
      return readFileSync(physical, "utf8");
    };
    const expected = independentGeometryViews(geometryReader);
    expect(acquisitionTrace).toEqual(geometryReadOrder);
    acquisitionTrace.length = 0;
    authenticateImplementation();
    const captured = captureLinearLayoutGeometry(expected.currentPlanner, geometryReader);
    expect(acquisitionTrace).toEqual(geometryReadOrder);
    expect(Object.keys(captured)).toEqual([...Object.keys(expected), "originalPlanner"]);
    expect(Object.isFrozen(captured)).toBe(true);
    for (const [field, value] of Object.entries(expected)) expect(captured[field as keyof typeof captured]).toBe(value);
    for (const path of allowed) {
      const src = join(root, path),
        dst = join(dir, path);
      const expectedPin = path === receiptPath ? receiptPin : sourcePins.find((entry) => entry.path === path)!;
      mkdirSync(resolve(dst, ".."), { recursive: true });
      if (path === plannerPath || path === layoutPath) {
        const historical = path === plannerPath ? expected.loweringBeforePlanner : expected.loweringBeforeLayout;
        pin(Buffer.from(historical), expectedPin);
        writeFileSync(dst, historical);
      } else {
        pin(readFileSync(src), expectedPin);
        expect(statSync(src).mode & 0o777).toBe(0o644);
        copyFileSync(src, dst);
      }
      chmodSync(dst, 0o644);
      pin(readFileSync(dst), expectedPin);
    }
    const trace: string[] = [];
    const read: Reader = (path) => {
      if (!(allowed as readonly string[]).includes(path)) throw new Error(`fixture path not allowed: ${path}`);
      trace.push(path);
      return readFileSync(join(dir, path), "utf8");
    };
    expect(captured.originalPlanner).toBe(independentDonor(read, "planner").toString("utf8"));
    pin(Buffer.from(captured.originalPlanner), donorPins.planner);
    trace.length = 0;
    run(dir, read, trace);
    completed = true;
  } finally {
    // Failed restoration/fixture evidence is retained rather than deleting its backup.
    if (completed) rmSync(dir, { recursive: true, force: true });
  }
}
function snapshot(path: string) {
  const s = statSync(path);
  return { ...hashes(readFileSync(path)), mode: s.mode & 0o777, ino: s.ino, dev: s.dev };
}
// Fixed-target harness retains original custody until expected fault state and restoration prove exact.
function fault(path: string, action: "missing" | "corrupt", run: () => void, replacement?: Buffer): void {
  const before = snapshot(path),
    bytes = readFileSync(path),
    lock = `${path}.d1-component-lock`,
    backup = `${path}.d1-component-backup`;
  if (existsSync(backup)) throw new Error("stale component backup");
  const fd = openSync(lock, "wx");
  closeSync(fd);
  let operationFailed = false,
    operationError: unknown;
  let restorationFailed = false,
    restorationError: unknown;
  let expectedFault: ReturnType<typeof snapshot> | undefined;
  try {
    if (action === "missing") renameSync(path, backup);
    else {
      const backupFd = openSync(backup, "wx");
      try {
        writeFileSync(backupFd, bytes);
      } finally {
        closeSync(backupFd);
      }
      chmodSync(backup, before.mode);
      expect(hashes(readFileSync(backup))).toEqual(hashes(bytes));
      writeFileSync(path, replacement ?? Buffer.concat([bytes, Buffer.from("\n// inert component fault\n")]));
      expectedFault = snapshot(path);
      expect(expectedFault.ino).toBe(before.ino);
      expect(expectedFault.dev).toBe(before.dev);
      expect(expectedFault.mode).toBe(before.mode);
      expect(expectedFault.sha256).not.toBe(before.sha256);
    }
    run();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    if (action === "missing") {
      if (existsSync(path)) throw new Error("unexpected replacement blocks restoration");
      expect(snapshot(backup)).toEqual(before);
      renameSync(backup, path);
    } else {
      if (!expectedFault) throw new Error("fault installation incomplete; backup and lock retained");
      expect(snapshot(path)).toEqual(expectedFault);
      expect(hashes(readFileSync(backup))).toEqual(hashes(bytes));
      expect(statSync(backup).mode & 0o777).toBe(before.mode);
      writeFileSync(path, readFileSync(backup));
    }
    expect(snapshot(path)).toEqual(before);
    if (action === "corrupt") rmSync(backup);
    rmSync(lock);
  } catch (error) {
    restorationFailed = true;
    restorationError = error;
  }
  if (operationFailed && restorationFailed)
    throw new AggregateError(
      [operationError, restorationError],
      "component operation AND restoration failed; custody retained",
    );
  if (restorationFailed) throw restorationError;
  if (operationFailed) throw operationError;
}
function replaceOnce(raw: string, from: string, to: string): string {
  expect(raw.split(from)).toHaveLength(2);
  const changed = raw.replace(from, to);
  expect(changed).not.toBe(raw);
  return changed;
}

// Independent test-only reducer: complete authentic before pins constrain every output.
// Its inputs are fixed physical CURRENT fixture files, never the helper's returned donor.
function independentDonor(read: Reader, witness: "planner" | "legality"): Buffer {
  const raw = Buffer.from(read(receiptPath));
  pin(raw, receiptPin);
  const receipt = JSON.parse(raw.toString("utf8")) as {
    pairs: {
      name: string;
      currentPaths: string[];
      inverse: {
        completeCoverage: boolean;
        beforeDerivedFromActualCurrent: boolean;
        pieces: {
          beforeOffset: number;
          text?: string;
          path?: string;
          offset?: number;
          length?: number;
          sourceSha256?: string;
          leading?: string;
          reverseModifier?: [string, string] | null;
        }[];
      };
    }[];
  };
  expect(receipt.pairs.map((pair) => pair.name)).toEqual(["linear-layout", "backend-legality"]);
  const sources = new Map<string, Buffer>();
  for (const current of sourcePins) {
    const bytes = Buffer.from(read(current.path));
    pin(bytes, current);
    sources.set(current.path, current.path === ownerPath ? historicalOwner(bytes) : bytes);
  }
  expect(receipt.pairs.map((pair) => pair.inverse.pieces.length)).toEqual([99, 30]);
  const pair = receipt.pairs[witness === "planner" ? 0 : 1]!;
  const pairPaths = witness === "planner" ? [plannerPath, layoutPath] : [adapterPath, ownerPath];
  expect(pair.currentPaths).toEqual(pairPaths);
  expect(pair.inverse.completeCoverage).toBe(true);
  expect(pair.inverse.beforeDerivedFromActualCurrent).toBe(true);
  const output: Buffer[] = [];
  let cursor = 0;
  for (const piece of pair.inverse.pieces) {
    expect(Number.isSafeInteger(piece.beforeOffset)).toBe(true);
    expect(piece.beforeOffset).toBe(cursor);
    let part: Buffer;
    if (piece.text !== undefined) part = Buffer.from(piece.text);
    else {
      expect(pairPaths).toContain(piece.path);
      const source = sources.get(piece.path!);
      expect(source).toBeDefined();
      expect(Number.isSafeInteger(piece.offset)).toBe(true);
      expect(Number.isSafeInteger(piece.length)).toBe(true);
      expect(piece.offset!).toBeGreaterThanOrEqual(0);
      expect(piece.length!).toBeGreaterThan(0);
      expect(piece.offset! + piece.length!).toBeLessThanOrEqual(source!.length);
      const fragment = source!.subarray(piece.offset!, piece.offset! + piece.length!);
      expect(createHash("sha256").update(fragment).digest("hex")).toBe(piece.sourceSha256);
      let text = fragment.toString("utf8");
      if (piece.reverseModifier) {
        expect(witness).toBe("planner");
        expect(piece.reverseModifier).toEqual(["export interface LinearLayoutBase", "interface LinearLayoutBase"]);
        text = replaceOnce(text, piece.reverseModifier[0], piece.reverseModifier[1]);
      }
      part = Buffer.from((piece.leading ?? "") + text);
    }
    output.push(part);
    cursor += part.length;
    expect(Number.isSafeInteger(cursor)).toBe(true);
  }
  expect(cursor).toBe(donorPins[witness].bytes);
  const donor = Buffer.concat(output);
  pin(donor, donorPins[witness]);
  return donor;
}

describe("D1 independent lowering source preservation component", () => {
  it("independently replays all four current byte streams from the authentic donors", () => {
    authenticateImplementation();
    fixture((dir, read) => {
      const rawReceipt = Buffer.from(read(receiptPath));
      pin(rawReceipt, receiptPin);
      const receipt = JSON.parse(rawReceipt.toString("utf8")) as {
        pairs: {
          name: string;
          forward: {
            path: string;
            pieces: {
              afterOffset: number;
              text?: string;
              original?: "planner" | "legality";
              offset?: number;
              length?: number;
              sourceSha256?: string;
              leading?: string;
              forwardModifier?: [string, string] | null;
            }[];
          }[];
        }[];
      };
      expect(receipt.pairs.map((pair) => pair.name)).toEqual(["linear-layout", "backend-legality"]);
      const witnesses = { planner: independentDonor(read, "planner"), legality: independentDonor(read, "legality") };
      expect(receipt.pairs.map((pair) => pair.forward.map((stream) => stream.pieces.length))).toEqual([
        [86, 20],
        [9, 25],
      ]);
      let streams = 0;
      for (const pair of receipt.pairs)
        for (const forward of pair.forward) {
          const pieces: Buffer[] = [];
          let cursor = 0;
          for (const piece of forward.pieces) {
            expect(piece.afterOffset).toBe(cursor);
            let part: Buffer;
            if (piece.text !== undefined) part = Buffer.from(piece.text);
            else {
              expect(piece.original).toBe(pair.name === "linear-layout" ? "planner" : "legality");
              const donor = witnesses[piece.original!];
              pin(donor, donorPins[piece.original!]);
              expect(Number.isSafeInteger(piece.offset)).toBe(true);
              expect(Number.isSafeInteger(piece.length)).toBe(true);
              expect(piece.offset!).toBeGreaterThanOrEqual(0);
              expect(piece.length!).toBeGreaterThan(0);
              expect(piece.offset! + piece.length!).toBeLessThanOrEqual(donor.length);
              const fragment = donor.subarray(piece.offset!, piece.offset! + piece.length!);
              expect(createHash("sha256").update(fragment).digest("hex")).toBe(piece.sourceSha256);
              let text = fragment.toString("utf8");
              if (piece.forwardModifier) {
                expect(pair.name).toBe("linear-layout");
                expect(piece.forwardModifier).toEqual([
                  "interface LinearLayoutBase",
                  "export interface LinearLayoutBase",
                ]);
                text = replaceOnce(text, piece.forwardModifier[0], piece.forwardModifier[1]);
              }
              part = Buffer.from((piece.leading ?? "") + text);
            }
            pieces.push(part);
            cursor += part.length;
          }
          const replay = Buffer.concat(pieces);
          const expectedPin = historicalSourcePins.find((entry) => entry.path === forward.path);
          expect(expectedPin).toBeDefined();
          pin(replay, expectedPin!);
          const currentReplay =
            forward.path === ownerPath
              ? Buffer.concat([
                  replay.subarray(0, ownerInsertionOffset),
                  ownerInsertion,
                  replay.subarray(ownerInsertionOffset),
                ])
              : replay;
          pin(currentReplay, sourcePins.find((entry) => entry.path === forward.path)!);
          expect(currentReplay).toEqual(Buffer.from(read(forward.path)));
          streams++;
        }
      expect(streams).toBe(4);
    });
  });
  it.each(operations)("reconstructs complete authentic $name donor with fresh ordered reads twice", (op) => {
    fixture((dir, read, trace) => {
      const input = read(op.input);
      trace.length = 0;
      const expected = independentDonor(read, op.witness).toString("utf8");
      pin(Buffer.from(expected), donorPins[op.witness]);
      for (let invocation = 0; invocation < 2; invocation++) {
        trace.length = 0;
        const actual = accepting(op, input, read);
        expect(actual).toBe(expected);
        pin(Buffer.from(actual), donorPins[op.witness]);
        expect(trace).toEqual(op.trace);
      }
    });
  });
  it.each(operations)("refuses nonprimitive $name source before any component reads", (op) => {
    authenticateImplementation();
    let coercions = 0;
    const hostile = {
      [Symbol.toPrimitive]() {
        coercions++;
        throw new Error("coercion sentinel");
      },
    };
    for (const raw of [null, undefined, 7, {}, [], new String("source"), hostile]) {
      let reads = 0;
      expect(() =>
        op.call(raw as unknown as string, () => {
          reads++;
          throw new Error("reader sentinel");
        }),
      ).toThrow("primitive source required");
      expect(reads).toBe(0);
    }
    expect(coercions).toBe(0);
  });
  it.each(operations)("refuses stale authentic predecessor as current $name operand", (op) => {
    fixture((dir, read) => {
      const current = read(op.input);
      expect(accepting(op, current, read)).toBe(independentDonor(read, op.witness).toString("utf8"));
      const original = independentDonor(read, op.witness).toString("utf8");
      expect(() => accepting(op, original, read)).toThrow(
        op.name === "linear-layout"
          ? `full pin changed ${plannerPath}`
          : `supplied current source differs ${adapterPath}`,
      );
      expect(accepting(op, current, read)).toBe(original);
    });
  });
  it.each(operations)("refuses supplied $name population mismatch despite healthy physical source", (op) => {
    fixture((_dir, read) => {
      const raw = read(op.input),
        expected = accepting(op, raw, read);
      expect(() => accepting(op, raw + "\n// supplied mismatch\n", read)).toThrow(
        op.name === "linear-layout"
          ? `full pin changed ${plannerPath}`
          : `supplied current source differs ${adapterPath}`,
      );
      expect(accepting(op, raw, read)).toBe(expected);
    });
  });
  it.each(operations)(
    "installed $name reader reconstructs independently pinned donor through its current API",
    (op) => {
      fixture((_dir, read) => {
        const current = op.name === "linear-layout" ? readFileSync(join(root, plannerPath), "utf8") : read(op.input);
        const expected = independentDonor(read, op.witness).toString("utf8");
        authenticateImplementation();
        const actual =
          op.name === "linear-layout" ? captureLinearLayoutGeometry(current).originalPlanner : op.call(current);
        expect(actual).toBe(expected);
        pin(Buffer.from(actual), donorPins[op.witness]);
      });
    },
  );
  it.each(operations)("installed $name reader refuses missing old receipt and succeeds after restoration", (op) => {
    fixture((_dir, read) => {
      const current = op.name === "linear-layout" ? readFileSync(join(root, plannerPath), "utf8") : read(op.input);
      const expected = independentDonor(read, op.witness).toString("utf8");
      authenticateImplementation();
      expect(
        op.name === "linear-layout" ? captureLinearLayoutGeometry(current).originalPlanner : op.call(current),
      ).toBe(expected);
      fault(join(root, receiptPath), "missing", () => {
        authenticateImplementation();
        let failure: unknown;
        try {
          op.name === "linear-layout" ? captureLinearLayoutGeometry(current).originalPlanner : op.call(current);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({ code: "ENOENT", path: join(root, receiptPath) });
      });
      authenticateImplementation();
      expect(
        op.name === "linear-layout" ? captureLinearLayoutGeometry(current).originalPlanner : op.call(current),
      ).toBe(expected);
    });
  });

  const sourceFaults = [
    {
      label: "retained planner algorithm",
      path: plannerPath,
      from: "export class LinearMemoryPlan",
      to: "export class LinearMemoryPlam",
      op: operations[0],
    },
    { label: "canonical layout readonly", path: layoutPath, from: "readonly", to: "readonlx", op: operations[0] },
    {
      label: "canonical layout import route",
      path: layoutPath,
      from: "../../core/nodes.js",
      to: "../../core/nodex.js",
      op: operations[0],
    },
    {
      label: "retained target adapter",
      path: adapterPath,
      from: "export function projectIrBackendTargetProfile",
      to: "export function projectIrBackendTargetProfily",
      op: operations[1],
    },
    {
      label: "canonical verifier body",
      path: ownerPath,
      from: "function bytecodeInstrError",
      to: "function bytecodeInstrErrop",
      op: operations[1],
    },
    {
      label: "canonical verifier import",
      path: ownerPath,
      from: "../core/types.js",
      to: "../core/typex.js",
      op: operations[1],
    },
  ] as const;
  it.each(sourceFaults)("refuses changed $label without source projection", ({ path, from, to, op }) => {
    fixture((dir, read) => {
      const raw = read(op.input),
        expected = accepting(op, raw, read),
        physical = join(dir, path),
        original = readFileSync(physical, "utf8");
      const changed =
        path === layoutPath && from === "readonly"
          ? original.replace("readonly", "readonlx")
          : replaceOnce(original, from, to);
      expect(changed).not.toBe(original);
      fault(
        physical,
        "corrupt",
        () => {
          expect(() => accepting(op, path === op.input ? changed : raw, read)).toThrow(`full pin changed ${path}`);
        },
        Buffer.from(changed),
      );
      expect(accepting(op, raw, read)).toBe(expected);
    });
  });
  it.each(operations)("refuses appended and missing $name source fragments", (op) => {
    fixture((_dir, read) => {
      const raw = read(op.input),
        expected = accepting(op, raw, read);
      for (const mutant of [raw + "\nexport const unexpectedExecutable = 1;\n", raw.slice(1), raw + raw])
        expect(() => accepting(op, mutant, read)).toThrow(
          op.name === "linear-layout"
            ? `full pin changed ${plannerPath}`
            : `supplied current source differs ${adapterPath}`,
        );
      expect(accepting(op, raw, read)).toBe(expected);
    });
  });
  it.each(operations)("coordinate and topology mutations meet immutable receipt pin for $name", (op) => {
    fixture((dir, read) => {
      const raw = read(op.input),
        expected = accepting(op, raw, read),
        path = join(dir, receiptPath),
        original = readFileSync(path, "utf8"),
        before = snapshot(path);
      for (const mutation of ["coordinate", "fragment digest", "pair order", "extra field"] as const) {
        const value = JSON.parse(original);
        if (mutation === "coordinate") value.pairs[0].inverse.pieces[0].beforeOffset++;
        else if (mutation === "fragment digest")
          value.pairs[0].inverse.pieces.find((p: { sourceSha256?: string }) => p.sourceSha256).sourceSha256 =
            "0".repeat(64);
        else if (mutation === "pair order") value.pairs.reverse();
        else value.extra = true;
        const changed = JSON.stringify(value);
        expect(changed).not.toBe(original);
        fault(
          path,
          "corrupt",
          () => {
            expect(() => accepting(op, raw, read)).toThrow(`full pin changed ${receiptPath}`);
          },
          Buffer.from(changed),
        );
        expect(accepting(op, raw, read)).toBe(expected);
      }
    });
  });
  const physicalCases = operations.flatMap((op) =>
    [receiptPath, ...(op.name === "linear-layout" ? [layoutPath] : [adapterPath, ownerPath])].flatMap((path) =>
      (["missing", "corrupt"] as const).map((action) => ({ op, path, action })),
    ),
  );
  it.each(physicalCases)(
    "fresh $op.name capture refuses warm $action of $path and recovers",
    ({ op, path, action }) => {
      fixture((dir, read) => {
        const raw = read(op.input),
          expected = accepting(op, raw, read);
        fault(join(dir, path), action, () => {
          expect(() => accepting(op, raw, read)).toThrow(action === "missing" ? /ENOENT/ : `full pin changed ${path}`);
        });
        expect(accepting(op, raw, read)).toBe(expected);
      });
    },
  );
  it.each(["missing", "corrupt"] as const)(
    "cached module does not bypass independent implementation %s guard",
    (action) => {
      fixture((_dir, read, trace) => {
        const raw = read(plannerPath),
          expected = accepting(operations[0], raw, read);
        fault(join(root, implementationPath), action, () => {
          trace.length = 0;
          expect(() => accepting(operations[0], raw, read)).toThrow(
            action === "missing" ? "component implementation missing:" : "component implementation full pin:",
          );
          expect(trace).toEqual([]);
        });
        expect(accepting(operations[0], raw, read)).toBe(expected);
      });
    },
  );
  it("fresh process authenticates complete geometry implementation before explicit historical API import", () => {
    fixture((dir, read) => {
      const raw = read(plannerPath),
        expected = accepting(operations[0], raw, read);
      const script = `import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; const b=readFileSync(${JSON.stringify(join(root, implementationPath))}); const sha=(x)=>createHash('sha256').update(x).digest('hex'); const blob=createHash('sha1').update(Buffer.from('blob '+b.length+'\\0')).update(b).digest('hex'); if(b.length!==${completeGeometryImplementationPin.bytes} || sha(b)!==${JSON.stringify(completeGeometryImplementationPin.sha256)} || blob!==${JSON.stringify(completeGeometryImplementationPin.gitBlob)} || sha(b.subarray(0,${implementationPin.bytes}))!==${JSON.stringify(implementationPin.sha256)}) { console.error('component implementation full pin'); process.exitCode=1; } else { const m=await import(${JSON.stringify(new URL("./helpers/ir-lowering-analysis-relocation.ts", import.meta.url).href)}); const allowed=${JSON.stringify(allowed)}; const read=(p)=>{if(!allowed.includes(p))throw Error('unknown fixture path');return readFileSync(${JSON.stringify(dir)}+'/'+p,'utf8');}; const out=m.captureLinearLayoutPredecessor(read(${JSON.stringify(plannerPath)}),read); console.log(JSON.stringify({bytes:Buffer.byteLength(out),sha256:sha(Buffer.from(out))})); }`;
      const invoke = () =>
        spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
          cwd: root,
          encoding: "utf8",
        });
      for (const phase of ["healthy before", "corrupt", "healthy after"] as const) {
        const check = () => {
          const child = invoke();
          expect(child.error).toBeUndefined();
          expect(child.signal).toBeNull();
          if (phase === "corrupt") {
            expect(child.status).toBe(1);
            expect(child.stderr.trim()).toBe("component implementation full pin");
            expect(child.stdout).toBe("");
          } else {
            expect(child.status).toBe(0);
            expect(child.stderr).toBe("");
            expect(JSON.parse(child.stdout)).toEqual({
              bytes: donorPins.planner.bytes,
              sha256: donorPins.planner.sha256,
            });
          }
        };
        if (phase === "corrupt") fault(join(root, implementationPath), "corrupt", check);
        else check();
      }
      expect(accepting(operations[0], raw, read)).toBe(expected);
    });
  });
});

// Current geometry uses its own reader channel; the historical fixture/deep validators above remain direct.
describe("D1 independently authenticated current geometry acquisition", () => {
  function actualReader(trace: string[]): Reader {
    return (path) => {
      if (!(geometryReadOrder as readonly string[]).includes(path))
        throw new Error("unknown current geometry path: " + path);
      trace.push(path);
      return readFileSync(join(root, path), "utf8");
    };
  }
  function healthy() {
    authenticateImplementation();
    const expected = independentGeometryViews(actualReader([]));
    const trace: string[] = [];
    const first = captureLinearLayoutGeometry(expected.currentPlanner, actualReader(trace));
    expect(trace).toEqual(geometryReadOrder);
    fixture((_dir, historicalRead) => {
      expect(first).toEqual({
        ...expected,
        originalPlanner: independentDonor(historicalRead, "planner").toString("utf8"),
      });
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.values(first).every((field) => typeof field === "string")).toBe(true);
    trace.length = 0;
    authenticateImplementation();
    const second = captureLinearLayoutGeometry(expected.currentPlanner, actualReader(trace));
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(trace).toEqual(geometryReadOrder);
    return first;
  }
  it("proves all eight fresh frozen current/predecessor fields with five ordered reads", () => {
    healthy();
  });
  it.each(geometryReadOrder)("retains fresh current geometry refusal and restoration for %s", (changedPath) => {
    const before = healthy();
    const trace: string[] = [];
    const reader: Reader = (path) => {
      const text = actualReader(trace)(path);
      return path === changedPath ? text + "\n// current geometry reader mutation\n" : text;
    };
    expect(() => captureLinearLayoutGeometry(before.currentPlanner, reader)).toThrow();
    expect(trace).toContain(changedPath);
    expect(healthy()).toEqual(before);
  });
  it("keeps supplied current geometry mismatch on the actual public API", () => {
    const before = healthy(),
      trace: string[] = [];
    expect(() => captureLinearLayoutGeometry(before.currentPlanner + "\n", actualReader(trace))).toThrow();
    expect(trace).toEqual(geometryReadOrder.slice(0, 2));
    expect(healthy()).toEqual(before);
  });
  it("rereads a changed second-call current reader after healthy capture", () => {
    const before = healthy(),
      trace: string[] = [];
    let changed = false;
    const reader: Reader = (path) => {
      const source = actualReader(trace)(path);
      return changed && path === sharedGeometryPath ? source + "\n// second-call geometry mutation\n" : source;
    };
    authenticateImplementation();
    expect(captureLinearLayoutGeometry(before.currentPlanner, reader)).toEqual(before);
    expect(trace).toEqual(geometryReadOrder);
    trace.length = 0;
    changed = true;
    expect(() => captureLinearLayoutGeometry(before.currentPlanner, reader)).toThrow(
      "lowering analysis relocation: full pin changed " + sharedGeometryPath,
    );
    expect(trace).toEqual(geometryReadOrder.slice(0, 4));
    changed = false;
    trace.length = 0;
    authenticateImplementation();
    expect(captureLinearLayoutGeometry(before.currentPlanner, reader)).toEqual(before);
    expect(trace).toEqual(geometryReadOrder);
  });
  it("keeps current primitive and reader priority before any authority IO", () => {
    let io = 0,
      coercions = 0;
    const bad = {
      toString() {
        coercions++;
        return "source";
      },
    };
    const reader: Reader = () => {
      io++;
      throw new Error("current geometry IO bomb");
    };
    expect(() => captureLinearLayoutGeometry(bad as unknown as string, reader)).toThrow(/primitive/);
    expect(() => captureLinearLayoutGeometry("source", null as unknown as Reader)).toThrow(
      "lowering analysis relocation: authority reader must be a function",
    );
    expect(io).toBe(0);
    expect(coercions).toBe(0);
  });
});

// Application acceptance goes through the real caller guards, not accepting() above.
const applicationOriginalPins = [
  {
    path: "src/ir/program.ts",
    bytes: 21542,
    sha256: "3df8deb9d3647466c2381957aa22410c593057cbdd855007b1279ebd755a5510",
    gitBlob: "59092bfff8a18c74e30fe9ac35d00336f10fcc19",
  },
  {
    path: "src/ir/program-abi-contracts.ts",
    bytes: 11056,
    sha256: "855ce794bc57f152a564c388b0d0c5de3ae056d4382c097fc3182c0a68343fda",
    gitBlob: "61792aab44a2e238342140c18206839b0f0503af",
  },
  {
    path: "src/ir/prepared-component-dependencies.ts",
    bytes: 74563,
    sha256: "0ea7a1b7d7ce5bf0a035d8b3a4c9c5a65aabd841ddd3c7a7c10bf82b11c9b8a7",
    gitBlob: "c75052c6c51a824bc1ad0af99155271fb4d30480",
  },
  {
    path: "src/ir/generator-support.ts",
    bytes: 8816,
    sha256: "fbc2d0cb9837ca7a55ac1dc6cef62b0f51a91ccf41a5c4a09c1854599f07a01f",
    gitBlob: "b054a6a5a28326a0dc77edb6cf16bfa834d2507a",
  },
] as const;
const applicationEntries = ["h2", "policy-semantic", "policy-raw"] as const;
type ApplicationEntry = (typeof applicationEntries)[number];
const policyCurrentPin = {
  bytes: 583986,
  sha256: "0cbff25993c92150c6c7cd45934b25552b315266833adc84301f49287d3982ee",
  gitBlob: "37d83315305278b25047fa4ed6b38af24b3cf9ce",
};
const policyBeforePin = {
  bytes: 583163,
  sha256: "0ec45a8b2c003e0b4baf84556f8612e20fca88a3d48f81a13f8cf43ac113fdd0",
  gitBlob: "391b2701b382df0af5a42536fd61a830fd596eb4",
};
const policyBeforeDataSha256 = "f7ed5862d447d03557ed0e2a61060d143fcc9f2036e02120ac56839829082a83";
// ROOT fills this literal only after final v2 authority review; no candidate is accepted as its own expectation.
const finalPolicyImplementationFreeze: string =
  '{"bytes":103380,"sha256":"52c3cc6514ae8f1084dd154a94d7dca34c061a6e45baedf1d8bc094aac526b8e","gitBlob":"13581c9dd08696c08ba660fe433bc4a9b0fbe2cf"}';
function authenticatePolicyImplementation(): void {
  if (finalPolicyImplementationFreeze.includes("ROOT_FINAL_V2")) throw new Error(finalPolicyImplementationFreeze);
  const expected = JSON.parse(finalPolicyImplementationFreeze) as GeometryPin;
  const path = "tests/helpers/ir-c1-historical-authority.ts";
  const actual = geometryBytePin(readFileSync(join(root, path)));
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || actual.gitBlob !== expected.gitBlob)
    throw new Error("external C1 implementation full pin: " + path);
}
function applicationInput(entry: ApplicationEntry): string | undefined {
  if (entry === "h2") return undefined;
  authenticatePolicyImplementation();
  const bytes = Buffer.from(
    capturePresentationClassificationPredecessorPolicySource(
      captureArrayBufferIsViewMainPredecessorPolicySource(
        captureMainInventoryPredecessorPolicySource(
          captureSourceMapPositionInventoryPredecessorPolicySource(
            capturePositionClassFieldsMainPredecessorPolicySource(
              capturePositionFinallyMainPredecessorPolicySource(
                captureDenoPostPositionMainPredecessorPolicySource(
                  captureGeometryCurrentMainPredecessorPolicySource(
                    readFileSync(join(root, "scripts/compiler-boundaries.json"), "utf8"),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  pin(bytes, policyCurrentPin);
  return bytes.toString("utf8");
}
// Same fixed package route as the normal C1 reader; this seam records reads, never overrides data.
function applicationAuthority(path: string): string {
  if (path.startsWith("typescript-package/")) {
    const suffix = path.slice("typescript-package/".length);
    expect([
      "package.json",
      "lib/typescript.ts",
      "lib/typescript.tsx",
      "lib/typescript.d.ts",
      "lib/typescript.js",
      "lib/typescript.jsx",
    ]).toContain(suffix);
    const packageRoot = resolve(createRequire(import.meta.url).resolve("typescript/package.json"), "..");
    return readFileSync(join(packageRoot, suffix), "utf8");
  }
  return readFileSync(join(root, path), "utf8");
}
function normalApplication(entry: ApplicationEntry, raw: string | undefined, trace: string[]): unknown {
  if (entry === "h2") {
    const capture = captureC1CurrentPopulation(undefined, (path) => {
      trace.push(path);
      return applicationAuthority(path);
    });
    return {
      historicalLegality: hashes(Buffer.from(capture.historicalPopulation.get(adapterPath)!)),
      observedLegality: capture.observedCurrentPins.find((record) => record.path === adapterPath)!.pin,
      originals: [...capture.originals].map(([path, source]) => ({ path, ...hashes(Buffer.from(source)) })),
    };
  }
  if (entry === "policy-raw") return hashes(Buffer.from(captureLoweringAnalysisPredecessorPolicySource(raw!)));
  const before = captureLoweringAnalysisPredecessorPolicy(JSON.parse(raw!));
  if (!Array.isArray(before.moves)) throw new Error("application predecessor moves must be an array");
  return {
    dataSha256: createHash("sha256").update(JSON.stringify(before)).digest("hex"),
    files: before.files.length,
    activationHistory: before.activationHistory.length,
    moves: before.moves.length,
  };
}
function applicationExpected(entry: ApplicationEntry): unknown {
  if (entry === "h2")
    return {
      historicalLegality: donorPins.legality,
      observedLegality: { bytes: sourcePins[2].bytes, sha256: sourcePins[2].sha256, gitBlob: sourcePins[2].gitBlob },
      originals: applicationOriginalPins,
    };
  if (entry === "policy-raw") return policyBeforePin;
  return { dataSha256: policyBeforeDataSha256, files: 1822, activationHistory: 103, moves: 10 };
}
function implementationGuardMessage(entry: ApplicationEntry): string {
  return entry === "h2"
    ? `C1 current source: full pin mismatch: ${implementationPath}`
    : `lowering analysis policy evolution: full pin changed: ${implementationPath}`;
}
function requireMissingApplication(
  entry: ApplicationEntry,
  raw: string | undefined,
  trace: string[],
  path: string,
): void {
  let error: unknown;
  try {
    normalApplication(entry, raw, trace);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: "ENOENT", path: join(root, path) });
}

describe("D1 real guarded application implementation authority", () => {
  it.each(["missing", "corrupt"] as const)(
    "fresh external policy implementation guard refuses cached final H1 %s and restores acceptance",
    (action) => {
      const path = "tests/helpers/ir-c1-historical-authority.ts";
      const before = applicationInput("policy-raw")!;
      expect(normalApplication("policy-raw", before, [])).toEqual(policyBeforePin);
      fault(join(root, path), action, () => {
        if (action === "missing") {
          let error: unknown;
          try {
            applicationInput("policy-raw");
          } catch (caught) {
            error = caught;
          }
          expect(error).toMatchObject({ code: "ENOENT", path: join(root, path) });
        } else expect(() => applicationInput("policy-raw")).toThrow("external C1 implementation full pin: " + path);
      });
      expect(applicationInput("policy-raw")).toBe(before);
      expect(normalApplication("policy-raw", before, [])).toEqual(policyBeforePin);
    },
  );

  it.each(
    applicationEntries.flatMap((entry) => (["missing", "corrupt"] as const).map((action) => ({ entry, action }))),
  )("$entry refuses cached implementation $action and restores genuine acceptance", ({ entry, action }) => {
    const input = applicationInput(entry),
      trace: string[] = [];
    expect(normalApplication(entry, input, trace)).toEqual(applicationExpected(entry));
    // Healthy missing-source-receipt witness proves that the later proof is ordinarily required.
    fault(join(root, receiptPath), "missing", () => requireMissingApplication(entry, input, [], receiptPath));
    fault(join(root, implementationPath), action, () => {
      // Both faults are real. The local caller implementation guard must win before the source proof.
      fault(join(root, receiptPath), "missing", () => {
        trace.length = 0;
        if (action === "missing") requireMissingApplication(entry, input, trace, implementationPath);
        else expect(() => normalApplication(entry, input, trace)).toThrow(implementationGuardMessage(entry));
        if (entry === "h2") {
          expect(trace.filter((path) => path === implementationPath)).toEqual([implementationPath]);
          expect(trace.filter((path) => path === receiptPath)).toEqual([]);
        }
      });
    });
    expect(normalApplication(entry, input, [])).toEqual(applicationExpected(entry));
  });
  it.each(applicationEntries)(
    "%s fresh preload refuses inert implementation edit through the normal caller",
    (entry) => {
      const input = applicationInput(entry);
      expect(normalApplication(entry, input, [])).toEqual(applicationExpected(entry));
      const moduleUrl = new URL(
        entry === "h2" ? "./helpers/ir-c1-current-source.ts" : "./helpers/ir-runtime-program-policy-evolution.ts",
        import.meta.url,
      ).href;
      const body =
        entry === "h2"
          ? `const c=m.captureC1CurrentPopulation(); out={historicalLegality:hashes(Buffer.from(c.historicalPopulation.get(${JSON.stringify(adapterPath)}))),observedLegality:c.observedCurrentPins.find(r=>r.path===${JSON.stringify(adapterPath)}).pin,originals:[...c.originals].map(([path,source])=>({path,...hashes(Buffer.from(source))}))};`
          : entry === "policy-raw"
            ? `out=hashes(Buffer.from(m.captureLoweringAnalysisPredecessorPolicySource(raw)));`
            : `const b=m.captureLoweringAnalysisPredecessorPolicy(JSON.parse(raw));out={dataSha256:sha(Buffer.from(JSON.stringify(b))),files:b.files.length,activationHistory:b.activationHistory.length,moves:b.moves.length};`;
      // No helper-body precheck or local wrapper: import and invoke the NORMAL application module.
      const script = `import{createHash}from'node:crypto';import{readFileSync}from'node:fs';const sha=b=>createHash('sha256').update(b).digest('hex');const hashes=b=>({bytes:b.length,sha256:sha(b),gitBlob:createHash('sha1').update(Buffer.from('blob '+b.length+'\\0')).update(b).digest('hex')});try{const m=await import(${JSON.stringify(moduleUrl)});const raw=${JSON.stringify(input)};let out;${body}console.log(JSON.stringify(out));}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}`;
      const invoke = () =>
        spawnSync(process.execPath, ["--import", "tsx", "--input-type=module"], {
          cwd: root,
          encoding: "utf8",
          input: script,
        });
      for (const phase of ["healthy before", "corrupt", "healthy after"] as const) {
        const check = () => {
          const child = invoke();
          expect(child.error).toBeUndefined();
          expect(child.signal).toBeNull();
          if (phase === "corrupt") {
            expect(child.status).toBe(1);
            expect(child.stdout).toBe("");
            expect(child.stderr.trim()).toBe(implementationGuardMessage(entry));
          } else {
            expect(child.status).toBe(0);
            expect(child.stderr).toBe("");
            expect(JSON.parse(child.stdout)).toEqual(applicationExpected(entry));
          }
        };
        if (phase === "corrupt") fault(join(root, implementationPath), "corrupt", check);
        else check();
      }
      expect(normalApplication(entry, input, [])).toEqual(applicationExpected(entry));
    },
  );
  it("raw application primitive guard wins before a missing helper without coercion", () => {
    const input = applicationInput("policy-raw")!;
    expect(normalApplication("policy-raw", input, [])).toEqual(policyBeforePin);
    let coercions = 0;
    const hostile = {
      [Symbol.toPrimitive]() {
        coercions++;
        throw new Error("invocation sentinel");
      },
    };
    const operands = [null, undefined, 7, {}, [], new String(input), hostile];
    fault(join(root, implementationPath), "missing", () => {
      requireMissingApplication("policy-raw", input, [], implementationPath);
      for (const bad of operands)
        expect(() => captureLoweringAnalysisPredecessorPolicySource(bad as string)).toThrow(
          "lowering analysis policy evolution: raw input must be a primitive string",
        );
      expect(coercions).toBe(0);
    });
    expect(coercions).toBe(0);
    expect(normalApplication("policy-raw", input, [])).toEqual(policyBeforePin);
  });
  it("semantic application descriptor guard wins before a missing helper without getter invocation", () => {
    const input = applicationInput("policy-semantic")!;
    expect(normalApplication("policy-semantic", input, [])).toEqual(applicationExpected("policy-semantic"));
    const bad = JSON.parse(input) as Record<string, unknown>;
    let calls = 0;
    Object.defineProperty(bad, "trap", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("invocation sentinel");
      },
    });
    fault(join(root, implementationPath), "missing", () => {
      requireMissingApplication("policy-semantic", input, [], implementationPath);
      expect(() => captureLoweringAnalysisPredecessorPolicy(bad)).toThrow(
        "runtime program policy evolution: accessor or hidden policy field",
      );
      expect(calls).toBe(0);
    });
    expect(calls).toBe(0);
    expect(normalApplication("policy-semantic", input, [])).toEqual(applicationExpected("policy-semantic"));
  });
});

// Current-entry controls use current fixtures; historical data never replaces installed source.
describe("D1 fixed early-return current-owner bridge", () => {
  it("independently proves the current-owner inverse and original API historical contract", () => {
    fixture((_dir, read) => {
      authenticateImplementation();
      const adapter = read(adapterPath);
      const current = Buffer.from(read(ownerPath));
      const original = historicalOwner(current).toString("utf8");
      const historicalRead: Reader = (path) => (path === ownerPath ? original : read(path));
      const expected = independentDonor(read, "legality").toString("utf8");
      expect(captureLoweringLegalityPredecessor(adapter, historicalRead)).toBe(expected);
      expect(() => captureLoweringLegalityPredecessor(adapter, read)).toThrow(`full pin changed ${ownerPath}`);
      expect(captureCurrentLoweringLegalityPredecessor(adapter, read)).toBe(expected);
      expect(captureCurrentLoweringLegalityPredecessor(adapter)).toBe(expected);
    });
  });
  it.each([
    "wrong insertion",
    "missing insertion",
    "extra insertion",
    "same text wrong coordinate",
    "old owner",
    "unrelated same-size edit",
  ] as const)("current owner full pin refuses %s and rereads healthy restoration without caching", (name) => {
    fixture((_dir, read, trace) => {
      authenticateImplementation();
      const adapter = read(adapterPath),
        current = Buffer.from(read(ownerPath));
      const original = historicalOwner(current);
      const expected = independentDonor(read, "legality").toString("utf8");
      expect(captureCurrentLoweringLegalityPredecessor(adapter, read)).toBe(expected);
      let changed: Buffer;
      if (name === "missing insertion" || name === "old owner") changed = original;
      else if (name === "extra insertion")
        changed = Buffer.concat([
          current.subarray(0, ownerInsertionOffset),
          ownerInsertion,
          current.subarray(ownerInsertionOffset),
        ]);
      else if (name === "same text wrong coordinate")
        changed = Buffer.concat([
          original.subarray(0, ownerInsertionOffset + 1),
          ownerInsertion,
          original.subarray(ownerInsertionOffset + 1),
        ]);
      else {
        changed = Buffer.from(current);
        const offset = name === "wrong insertion" ? ownerInsertionOffset + 10 : 0;
        changed[offset] = changed[offset]! ^ 1;
      }
      expect(changed.equals(current)).toBe(false);
      let reads = 0;
      const mutant: Reader = (path) => {
        if (path === ownerPath) {
          reads++;
          return changed.toString("utf8");
        }
        return read(path);
      };
      expect(() => captureCurrentLoweringLegalityPredecessor(adapter, mutant)).toThrow(`full pin changed ${ownerPath}`);
      expect(reads).toBe(1);
      trace.length = 0;
      expect(captureCurrentLoweringLegalityPredecessor(adapter, read)).toBe(expected);
      expect(trace).toEqual([receiptPath, adapterPath, ownerPath]);
    });
  });
  it("refuses nonprimitive owner data after genuine receipt and adapter reads", () => {
    fixture((_dir, read, trace) => {
      const adapter = read(adapterPath);
      authenticateImplementation();
      trace.length = 0;
      let coercions = 0;
      const hostile = {
        [Symbol.toPrimitive]() {
          coercions++;
          throw new Error("unexpected owner coercion");
        },
      };
      expect(() =>
        captureCurrentLoweringLegalityPredecessor(adapter, (path) => {
          if (path === ownerPath) {
            trace.push(path);
            return hostile as unknown as string;
          }
          return read(path);
        }),
      ).toThrow(`primitive authority text required ${ownerPath}`);
      expect(trace).toEqual([receiptPath, adapterPath, ownerPath]);
      expect(coercions).toBe(0);
      expect(captureCurrentLoweringLegalityPredecessor(adapter, read)).toBe(
        independentDonor(read, "legality").toString("utf8"),
      );
    });
  });
  it("current-entry primitive guard refuses a getter before missing authority IO", () => {
    authenticateImplementation();
    let getterCalls = 0,
      reads = 0;
    const hostile = Object.defineProperty({}, Symbol.toPrimitive, {
      get() {
        getterCalls++;
        throw new Error("unexpected coercion getter");
      },
    });
    const missing = Object.assign(new Error("missing current-entry receipt witness"), { code: "ENOENT" });
    const missingRead: Reader = () => {
      reads++;
      throw missing;
    };
    expect(() => captureCurrentLoweringLegalityPredecessor(hostile as unknown as string, missingRead)).toThrow(
      "primitive source required",
    );
    expect(getterCalls).toBe(0);
    expect(reads).toBe(0);
    fixture((_dir, read) => {
      const adapter = read(adapterPath);
      expect(() => captureCurrentLoweringLegalityPredecessor(adapter, missingRead)).toThrow(missing);
      expect(reads).toBe(1);
      expect(captureCurrentLoweringLegalityPredecessor(adapter, read)).toBe(
        independentDonor(read, "legality").toString("utf8"),
      );
    });
    expect(getterCalls).toBe(0);
  });
  it("missing owner is a real authority error and healthy capture does not cache it", () => {
    fixture((_dir, read) => {
      const adapter = read(adapterPath),
        expected = independentDonor(read, "legality").toString("utf8");
      authenticateImplementation();
      const missing = Object.assign(new Error("missing current canonical owner"), { code: "ENOENT" });
      expect(captureCurrentLoweringLegalityPredecessor(adapter, read)).toBe(expected);
      expect(() =>
        captureCurrentLoweringLegalityPredecessor(adapter, (path) => {
          if (path === ownerPath) throw missing;
          return read(path);
        }),
      ).toThrow(missing);
      expect(captureCurrentLoweringLegalityPredecessor(adapter, read)).toBe(expected);
    });
  });
});
