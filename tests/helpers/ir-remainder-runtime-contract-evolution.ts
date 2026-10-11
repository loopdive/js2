// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import {
  reconstructRuntimeContractReceiptSources,
  runtimeContractCurrentPaths,
} from "./ir-runtime-contract-evolution.js";
type Reader = (path: string) => string;
const owners = [
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    prior: {
      bytes: 28324,
      sha256: "048358db8d8deeee38bb6d49e9fe9be41189441f6b26221733c832f16ce02cd1",
      gitBlob: "a9b945e529e106f61089a29440ae73d114d5d2c0",
    },
    current: {
      bytes: 28981,
      sha256: "0a1eb7cbbc6a1e963ed493f212a4b46ee92b2b3f445083c9d89ff9049c3ed74c",
      gitBlob: "240507b063b36f65b13c8bd3974a2b144832872f",
    },
    edits: [
      {
        beforeOffset: 1470,
        afterOffset: 1470,
        before: "",
        after: "  | NumberRemainderRuntimeFeature\n",
      },
      {
        beforeOffset: 18342,
        afterOffset: 18376,
        before: "",
        after:
          '/** The two existing numeric remainder recipes; not an open symbol family. */\nexport const NUMBER_REMAINDER_RUNTIME_FEATURES = Object.freeze([\n  "js.number.remainder",\n  "js.number.remainder.early-magnitude",\n] as const);\nexport type NumberRemainderRuntimeFeature = (typeof NUMBER_REMAINDER_RUNTIME_FEATURES)[number];\nexport const NUMBER_REMAINDER_RUNTIME_PROVIDER_IDS = Object.freeze([\n  "backend.js.number.remainder",\n  "backend.js.number.remainder.early-magnitude",\n] as const);\nexport type NumberRemainderRuntimeProviderId = (typeof NUMBER_REMAINDER_RUNTIME_PROVIDER_IDS)[number];\n\n',
      },
      {
        beforeOffset: 19019,
        afterOffset: 19639,
        before: "",
        after: "  | NumberRemainderRuntimeProviderId\n",
      },
    ],
  },
  {
    path: "src/ir/runtime/callable-declarations.ts",
    prior: {
      bytes: 5642,
      sha256: "6632f6ecb4221bf31e4cd733b51baf5095a0d7268da1b4f7d0ffa14c8cf27911",
      gitBlob: "81553cf192d6551d7a55b09553ad6cc6ee01e0f8",
    },
    current: {
      bytes: 5949,
      sha256: "9bb4316aea80478bcc21cf5424370a3ce1e393a43201ab156059499b9c0d061f",
      gitBlob: "bd1d3c872f6ca3aa85d2bb30ef36e774ee705ab2",
    },
    edits: [
      {
        beforeOffset: 1087,
        afterOffset: 1087,
        before: "",
        after:
          'import {\n  irNumberRemainderCallableDeclaration,\n  NUMBER_REMAINDER_RUNTIME_PROVIDERS,\n  numberRemainderProviderMismatch,\n} from "./number-remainder-callables.js";\n',
      },
      {
        beforeOffset: 4605,
        afterOffset: 4769,
        before: "",
        after: "        irNumberRemainderCallableDeclaration(ref) ??\n",
      },
      {
        beforeOffset: 4994,
        afterOffset: 5211,
        before: "",
        after: "  ...NUMBER_REMAINDER_RUNTIME_PROVIDERS,\n",
      },
      {
        beforeOffset: 5203,
        afterOffset: 5461,
        before: "    ordinaryObjectProviderMismatch(provider)\n",
        after: "    ordinaryObjectProviderMismatch(provider) ??\n    numberRemainderProviderMismatch(provider)\n",
      },
    ],
  },
  {
    path: "src/ir/runtime/manifest.ts",
    prior: {
      bytes: 104292,
      sha256: "ff36567f298b2ef4946caf7159d9e1647e0e9fdf920296735547dffca15a9ec8",
      gitBlob: "aadd390ab836833d18daff12282ffc2524f598f5",
    },
    current: {
      bytes: 104454,
      sha256: "1c10a56e7255e1db7897d184c7460ad07454252dd0a80176b211dc96918e54e9",
      gitBlob: "f76280d31ba32f6ad30abb2f7ed22397ddb6fd06",
    },
    edits: [
      {
        beforeOffset: 3761,
        afterOffset: 3761,
        before: "",
        after: "  NUMBER_REMAINDER_RUNTIME_FEATURES,\n  NUMBER_REMAINDER_RUNTIME_PROVIDER_IDS,\n",
      },
      {
        beforeOffset: 54395,
        afterOffset: 54473,
        before: "",
        after: "  ...NUMBER_REMAINDER_RUNTIME_FEATURES,\n",
      },
      {
        beforeOffset: 55372,
        afterOffset: 55490,
        before: "",
        after: "  ...NUMBER_REMAINDER_RUNTIME_PROVIDER_IDS,\n",
      },
    ],
  },
] as const;
type Owner = (typeof owners)[number];
function fail(detail: string): never {
  throw new Error("remainder runtime contract evolution: " + detail);
}
function pin(bytes: Buffer, expected: Owner["current"] | Owner["prior"], path: string): void {
  if (
    bytes.length !== expected.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256 ||
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== expected.gitBlob
  )
    fail("complete source SHA256/length/Git blob mismatch: " + path);
}
function priorSource(source: string, owner: Owner): string {
  if (typeof source !== "string" || source.length === 0) fail("missing nonempty primitive source: " + owner.path);
  const current = Buffer.from(source);
  pin(current, owner.current, owner.path);
  const chunks: Buffer[] = [];
  let beforeEnd = 0,
    afterEnd = 0;
  for (const edit of owner.edits) {
    const before = Buffer.from(edit.before),
      after = Buffer.from(edit.after);
    if (
      !Number.isSafeInteger(edit.beforeOffset) ||
      !Number.isSafeInteger(edit.afterOffset) ||
      edit.beforeOffset < beforeEnd ||
      edit.afterOffset < afterEnd ||
      edit.beforeOffset - beforeEnd !== edit.afterOffset - afterEnd ||
      edit.beforeOffset + before.length > owner.prior.bytes ||
      edit.afterOffset + after.length > current.length
    )
      fail("fixed source coordinates mismatch: " + owner.path);
    if (!current.subarray(edit.afterOffset, edit.afterOffset + after.length).equals(after))
      fail("fixed current source span mismatch: " + owner.path);
    chunks.push(current.subarray(afterEnd, edit.afterOffset), before);
    beforeEnd = edit.beforeOffset + before.length;
    afterEnd = edit.afterOffset + after.length;
  }
  chunks.push(current.subarray(afterEnd));
  const prior = Buffer.concat(chunks);
  pin(prior, owner.prior, owner.path);
  const replay: Buffer[] = [];
  beforeEnd = 0;
  for (const edit of owner.edits) {
    const before = Buffer.from(edit.before);
    if (!prior.subarray(edit.beforeOffset, edit.beforeOffset + before.length).equals(before))
      fail("fixed prior source span mismatch: " + owner.path);
    replay.push(prior.subarray(beforeEnd, edit.beforeOffset), Buffer.from(edit.after));
    beforeEnd = edit.beforeOffset + before.length;
  }
  replay.push(prior.subarray(beforeEnd));
  const forward = Buffer.concat(replay);
  pin(forward, owner.current, owner.path);
  if (!forward.equals(current)) fail("current source reciprocal mismatch: " + owner.path);
  return prior.toString("utf8");
}
/** A historical proof stage only; every supplied current owner is authenticated fresh on demand. */
export function beforeRemainderRuntimeContractOwners(reader: Reader): Reader {
  if (typeof reader !== "function") fail("supplied reader required");
  return (path) => {
    const source = reader(path),
      owner = owners.find((entry) => entry.path === path);
    return owner ? priorSource(source, owner) : source;
  };
}
/** Keep receipt validation and every old source/AST/recipe guard in the unchanged kernel. */
export function reconstructRemainderRuntimeContractReceiptSources(
  reader: Reader,
  receiptText?: string,
): ReadonlyMap<string, string> {
  return reconstructRuntimeContractReceiptSources(beforeRemainderRuntimeContractOwners(reader), receiptText);
}
export function beforeRemainderRuntimeContractReceiptSource(path: string, source: string, reader: Reader): string {
  if (!runtimeContractCurrentPaths.includes(path)) return source;
  const outputs = reconstructRemainderRuntimeContractReceiptSources((requested) =>
    requested === path ? source : reader(requested),
  );
  const result = outputs.get(path);
  if (result === undefined) fail("missing reconstructed source: " + path);
  return result;
}
export function readRemainderRuntimeContractReceiptSource(path: string, reader: Reader): string {
  if (!runtimeContractCurrentPaths.includes(path)) return reader(path);
  const result = reconstructRemainderRuntimeContractReceiptSources(reader).get(path);
  if (result === undefined) fail("missing reconstructed source: " + path);
  return result;
}
