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
  captureLoweringLegalityPredecessor,
  captureCurrentLoweringLegalityPredecessor,
} from "./helpers/ir-lowering-analysis-relocation.js";

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
function authenticateImplementation(): void {
  const physical = join(root, implementationPath);
  if (!existsSync(physical)) throw new Error(`component implementation missing: ${implementationPath}`);
  const actual = hashes(readFileSync(physical));
  if (
    actual.bytes !== implementationPin.bytes ||
    actual.sha256 !== implementationPin.sha256 ||
    actual.gitBlob !== implementationPin.gitBlob
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
    for (const path of allowed) {
      const src = join(root, path),
        dst = join(dir, path);
      const expected = path === receiptPath ? receiptPin : sourcePins.find((p) => p.path === path)!;
      pin(readFileSync(src), expected);
      expect(statSync(src).mode & 0o777).toBe(0o644);
      mkdirSync(resolve(dst, ".."), { recursive: true });
      copyFileSync(src, dst);
      chmodSync(dst, 0o644);
      pin(readFileSync(dst), expected);
    }
    const trace: string[] = [];
    const read: Reader = (path) => {
      if (!(allowed as readonly string[]).includes(path)) throw new Error(`fixture path not allowed: ${path}`);
      trace.push(path);
      return readFileSync(join(dir, path), "utf8");
    };
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
  it.each(operations)("default $name reader reconstructs independently pinned donor from installed files", (op) => {
    fixture((_dir, read) => {
      const current = read(op.input);
      const expected = independentDonor(read, op.witness).toString("utf8");
      authenticateImplementation();
      const actual = op.call(current);
      expect(actual).toBe(expected);
      pin(Buffer.from(actual), donorPins[op.witness]);
    });
  });
  it.each(operations)("default $name reader refuses missing installed receipt and succeeds after restoration", (op) => {
    fixture((_dir, read) => {
      const current = read(op.input);
      const expected = independentDonor(read, op.witness).toString("utf8");
      authenticateImplementation();
      expect(op.call(current)).toBe(expected);
      fault(join(root, receiptPath), "missing", () => {
        authenticateImplementation();
        let failure: unknown;
        try {
          op.call(current);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({ code: "ENOENT", path: join(root, receiptPath) });
      });
      authenticateImplementation();
      expect(op.call(current)).toBe(expected);
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
  it("fresh process refuses a valid inert implementation edit before an accepting import", () => {
    fixture((dir, read) => {
      const raw = read(plannerPath),
        expected = accepting(operations[0], raw, read);
      const script = `import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; const b=readFileSync(${JSON.stringify(join(root, implementationPath))}); const sha=(x)=>createHash('sha256').update(x).digest('hex'); const blob=createHash('sha1').update(Buffer.from('blob '+b.length+'\\0')).update(b).digest('hex'); if(b.length!==${implementationPin.bytes} || sha(b)!==${JSON.stringify(implementationPin.sha256)} || blob!==${JSON.stringify(implementationPin.gitBlob)}) { console.error('component implementation full pin'); process.exitCode=1; } else { const m=await import(${JSON.stringify(new URL("./helpers/ir-lowering-analysis-relocation.ts", import.meta.url).href)}); const allowed=${JSON.stringify(allowed)}; const read=(p)=>{if(!allowed.includes(p))throw Error('unknown fixture path');return readFileSync(${JSON.stringify(dir)}+'/'+p,'utf8');}; const out=m.captureLinearLayoutPredecessor(read(${JSON.stringify(plannerPath)}),read); console.log(JSON.stringify({bytes:Buffer.byteLength(out),sha256:sha(Buffer.from(out))})); }`;
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
function applicationInput(entry: ApplicationEntry): string | undefined {
  if (entry === "h2") return undefined;
  const bytes = Buffer.from(
    capturePresentationClassificationPredecessorPolicySource(
      captureArrayBufferIsViewMainPredecessorPolicySource(
        captureMainInventoryPredecessorPolicySource(
          captureSourceMapPositionInventoryPredecessorPolicySource(
            capturePositionClassFieldsMainPredecessorPolicySource(
              capturePositionFinallyMainPredecessorPolicySource(
                readFileSync(join(root, "scripts/compiler-boundaries.json"), "utf8"),
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
