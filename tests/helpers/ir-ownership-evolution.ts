// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";

interface OwnershipEvolution {
  readonly path: string;
  readonly currentSha: string;
  readonly currentBlob: string;
  readonly originalSha: string;
  readonly originalBlob: string;
  readonly hunks: readonly {
    readonly before: string;
    readonly after: string;
    readonly inverseHashes?: { readonly sha: string; readonly blob: string };
  }[];
}

// Explicit inverse compositions retain the original 3a119 receipts above.
// Each complete current file and reconstructed extraction file is pinned; only
// these reviewed later changes may be reversed, and forward replay is exact.
export const ownershipEvolutions: readonly OwnershipEvolution[] = [
  {
    // efe352fee8afc3feb6a28c34d00fc658dc1fb205: genuine runtime-support admission.
    path: "src/ir/program/input.ts",
    currentSha: "3c9da679634f7fcb8fee9a8e5664cc752ee1e6a370148d4d375e56f6462afbda",
    currentBlob: "07e2f9c4ec8b24f94028f76ba0ac7daebd963fb7",
    originalSha: "fc6d92f559b3a46e203ca5f8b1cf92ddf41cdc56d7f6ae326207b6596fcc6994",
    originalBlob: "a84b348e02b789c42efdc1343c5695eccfb02b65",
    hunks: [
      {
        before: 'import type { TypedIrProgramInput, TypedIrProgramOptions } from "./input-contracts.js";\n',
        after:
          'import type { TypedIrProgramInput, TypedIrProgramOptions } from "./input-contracts.js";\nimport { assertIrRuntimeSupport } from "./runtime-support.js";\n',
      },
      {
        before:
          '  fields(captured, ["inventory", "ir", "derivedUnits", "startup", "callables", "globals", "allocations"]);',
        after:
          '  fields(\n    captured,\n    ["inventory", "ir", "derivedUnits", "startup", "callables", "globals", "allocations"],\n    ["runtimeSupport"],\n  );',
      },
      {
        before: "  assertGlobalStorage(captured);\n  // Joint restoration",
        after:
          '  assertGlobalStorage(captured);\n  if (Object.hasOwn(captured, "runtimeSupport")) {\n    if (captured.runtimeSupport === undefined) invalid("typed input must omit absent runtime support");\n    assertIrRuntimeSupport(captured, captured.runtimeSupport);\n  }\n  // Joint restoration',
      },
    ],
  },
  {
    // ed15de69a9a301793429adee7b0e610a934b101e followed by inverse
    // 56d9922bc85a0bf1ffb105746b5926a3f0dca9a6, retaining the shared comment.
    path: "src/ir/program.ts",
    currentSha: "3df8deb9d3647466c2381957aa22410c593057cbdd855007b1279ebd755a5510",
    currentBlob: "59092bfff8a18c74e30fe9ac35d00336f10fcc19",
    originalSha: "6139bbb844b6ee0b2770a8e87e198d6dcd52c88f40dcdcd80ff598779a6d3cc0",
    originalBlob: "38d3777ee94effca8c912362a9d9ded4791e47fe",
    hunks: [
      {
        before:
          "  /** Explicitly resolved by the caller; never read from the environment during emission. */\n  readonly numberFormat?: Readonly<{ integerBeforeScratch: boolean }>;",
        after:
          "  /** Explicitly resolved by the caller; never read from the environment during emission. */\n  readonly stringConcatEmptyIdentity?: boolean;\n  readonly numberFormat?: Readonly<{ integerBeforeScratch: boolean }>;",
        inverseHashes: {
          sha: "17326568ce60a839c8a6a4915c5382b6c7d952e104759edce7fb32be82a270da",
          blob: "3bb2fa5d9612c0c96583a541a65f1af60b508ed3",
        },
      },
      {
        before: "  readonly moduleName: string;\n  readonly linear?: Readonly<",
        after:
          "  readonly moduleName: string;\n  /** Explicitly resolved by the caller; never read from the environment during emission. */\n  readonly numberFormat?: Readonly<{ integerBeforeScratch: boolean }>;\n  readonly linear?: Readonly<",
      },
    ],
  },
  {
    // This change caches only immutable internal-slot presence, not equality.
    path: "src/ir/program/data.ts",
    currentSha: "01cc4349696dca0b0f439e7b639e269a83d99849911a6db963dcc5b4b6ecea16",
    currentBlob: "fd8693ee3c82d08039b91af4d4a1bda408966176",
    originalSha: "eb0ee8f03921f3ce7e00cc50d91ac8920d0a3034a2da17a405f111a3f32b6143",
    originalBlob: "bbb0e0df80b9aec986f9b288581e2e8750d1f664",
    hunks: [
      {
        before: `function hasNativeCollectionState(value: object): boolean {
  for (const has of [Map.prototype.has, Set.prototype.has, WeakMap.prototype.has, WeakSet.prototype.has]) {
    try {
      Reflect.apply(has, value, [value]);
      return true;
    } catch {
      // Native methods authenticate internal slots even when the prototype was erased.
    }
  }
  return false;
}`,
        after: `// Internal collection slots cannot change on an existing object. Only that
// brand is cached: prototypes, descriptors, values and entries stay live data.
const nativeCollectionBrand = Object.freeze({
  cache: new WeakMap<object, boolean>(),
  get: WeakMap.prototype.get,
  set: WeakMap.prototype.set,
  apply: Reflect.apply,
  probes: Object.freeze([Map.prototype.has, Set.prototype.has, WeakMap.prototype.has, WeakSet.prototype.has]),
});

function hasNativeCollectionState(value: object): boolean {
  const { cache, get, set, apply, probes } = nativeCollectionBrand;
  const cached = apply(get, cache, [value]) as boolean | undefined;
  if (cached !== undefined) return cached;
  let hasSlots = false;
  for (let index = 0; index < probes.length; index++) {
    try {
      apply(probes[index]!, value, [value]);
      // Probe success authenticates the slot, even when membership is false.
      hasSlots = true;
      break;
    } catch {
      // Native methods authenticate internal slots even when the prototype was erased.
    }
  }
  apply(set, cache, [value, hasSlots]);
  return hasSlots;
}`,
      },
    ],
  },
];

export function sourceHashes(source: string) {
  return {
    sha: createHash("sha256").update(source).digest("hex"),
    blob: createHash("sha1")
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest("hex"),
  };
}
function reviewed(condition: boolean, detail: string): asserts condition {
  if (!condition) throw Error("unreviewed ownership evolution: " + detail);
}
function substituteOnce(source: string, from: string, to: string): string {
  reviewed(source.split(from).length === 2, "missing or repeated exact hunk");
  return source.replace(from, to);
}
export function inverseOwnershipEvolution(evolution: OwnershipEvolution, source: string): string {
  const { path } = evolution;
  const current = sourceHashes(source);
  reviewed(current.sha === evolution.currentSha && current.blob === evolution.currentBlob, path + " current file");
  let original = source;
  for (const hunk of evolution.hunks) {
    original = substituteOnce(original, hunk.after, hunk.before);
    if (hunk.inverseHashes) {
      const intermediate = sourceHashes(original);
      reviewed(
        intermediate.sha === hunk.inverseHashes.sha && intermediate.blob === hunk.inverseHashes.blob,
        path + " intermediate file",
      );
    }
  }
  const old = sourceHashes(original);
  reviewed(old.sha === evolution.originalSha && old.blob === evolution.originalBlob, path + " historical file");
  let replayed = original;
  for (const hunk of [...evolution.hunks].reverse()) replayed = substituteOnce(replayed, hunk.before, hunk.after);
  reviewed(replayed === source, path + " forward replay");
  return original;
}
export function historicalSource(path: string, source: string): string {
  const evolution = ownershipEvolutions.find((row) => row.path === path);
  return evolution ? inverseOwnershipEvolution(evolution, source) : source;
}
