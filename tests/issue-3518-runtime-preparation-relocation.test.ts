// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { reconstructRemainderRuntimeContractReceiptSources as reconstructRuntimeContractReceiptSources } from "./helpers/ir-remainder-runtime-contract-evolution.js";
import { beforeRemainderRuntimePreparationRelocation as beforeRuntimePreparationRelocation } from "./helpers/ir-remainder-runtime-preparation-relocation.js";
import { beforeSourceMapProgramValidatorRelocation } from "./helpers/ir-program-validator-relocation.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateRuntimePreparationRelocation,
  runtimePreparationRelocationCurrentPaths,
  runtimePreparationRelocationReceiptPath,
} from "./helpers/ir-runtime-preparation-relocation.js";
import {
  acceptedHistoricalDeclarations,
  assertCallableExtension,
  currentDeclarations,
  historicalIntrinsicSource,
} from "./helpers/ir-historical-runtime-reconstruction.js";
import { runtimeContractCurrentPaths } from "./helpers/ir-runtime-contract-evolution.js";

const repository = resolve(import.meta.dirname, "..");
type Reader = (path: string) => string;
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const rawRead: Reader = (path) => readFileSync(resolve(repository, path), "utf8");
const [support, implementation] = runtimePreparationRelocationCurrentPaths;
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const receiptText = rawRead(runtimePreparationRelocationReceiptPath);
const receipt = authenticateRuntimePreparationRelocation(receiptText);
afterEach(async () => {
  await setImmediate();
});

// Independent finite current-source proof, before the unchanged historical relocation recipe.
const remainderEdits = [
  {
    beforeOffset: 1142,
    afterOffset: 1142,
    before: "",
    after: 'import { irNumberRemainderCallableDeclaration } from "./number-remainder-callables.js";\n',
  },
  {
    beforeOffset: 39459,
    afterOffset: 39547,
    before: "                  irOrdinaryObjectCallableDeclaration(declaration.ref))\n",
    after:
      "                  irOrdinaryObjectCallableDeclaration(declaration.ref) ||\n                  irNumberRemainderCallableDeclaration(declaration.ref))\n",
  },
] as const;
function priorImplementation(source: string): string {
  expect(Buffer.byteLength(source)).toBe(49704);
  expect(hash(source)).toBe("171aa93513aacb9bebf80897f2c67a827b71f082647ced04a689ca17d116ba82");
  let bytes = Buffer.from(source);
  for (const edit of [...remainderEdits].reverse()) {
    const after = Buffer.from(edit.after);
    expect(bytes.subarray(edit.afterOffset, edit.afterOffset + after.length)).toEqual(after);
    bytes = Buffer.concat([
      bytes.subarray(0, edit.afterOffset),
      Buffer.from(edit.before),
      bytes.subarray(edit.afterOffset + after.length),
    ]);
  }
  expect(bytes.length).toBe(49541);
  expect(hash(bytes)).toBe("bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b");
  return bytes.toString("utf8");
}
function currentImplementation(prior: string): string {
  let bytes = Buffer.from(prior);
  expect(bytes.length).toBe(49541);
  expect(hash(bytes)).toBe("bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b");
  for (const edit of [...remainderEdits].reverse()) {
    const before = Buffer.from(edit.before);
    expect(bytes.subarray(edit.beforeOffset, edit.beforeOffset + before.length)).toEqual(before);
    bytes = Buffer.concat([
      bytes.subarray(0, edit.beforeOffset),
      Buffer.from(edit.after),
      bytes.subarray(edit.beforeOffset + before.length),
    ]);
  }
  expect(bytes.length).toBe(49704);
  expect(hash(bytes)).toBe("171aa93513aacb9bebf80897f2c67a827b71f082647ced04a689ca17d116ba82");
  return bytes.toString("utf8");
}
function currentCoordinate(priorOffset: number): number {
  let delta = 0;
  for (const edit of remainderEdits) {
    const beforeBytes = Buffer.byteLength(edit.before);
    if (priorOffset < edit.beforeOffset) break;
    if (beforeBytes > 0 && priorOffset < edit.beforeOffset + beforeBytes)
      throw Error("original mutation coordinate enters a replaced current-source span");
    delta += Buffer.byteLength(edit.after) - beforeBytes;
  }
  return priorOffset + delta;
}

function positive(): Reader {
  const historicalReader = beforeRuntimePreparationRelocation(beforeProgramValidatorRelocation(rawRead));
  expect(Buffer.byteLength(rawRead(support))).toBe(850);
  expect(hash(rawRead(support))).toBe("584322a7384556a6f3b82dc85cc30c2213510fe70f2cd437ccbef97826156351");
  expect(currentImplementation(priorImplementation(rawRead(implementation)))).toBe(rawRead(implementation));
  expect(Buffer.byteLength(historicalReader(support))).toBe(49626);
  expect(hash(historicalReader(support))).toBe("03e5d583b91a7589481c80e1ca1dd5a621fee3e593f5ca9537f9c573b8925e40");
  return historicalReader;
}
function override(reader: Reader, path: string, text: string): Reader {
  return (requested) => (requested === path ? text : reader(requested));
}
function replaceOne(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + from.length) !== -1 || from === to)
    throw Error("one exact changed span required");
  return text.slice(0, at) + to + text.slice(at + from.length);
}
function physicalRefusal(path: string, edit: (source: string) => string): void {
  positive();
  const original = rawRead(path),
    mutant = edit(original);
  expect(mutant).not.toBe(original);
  expect(() => beforeRuntimePreparationRelocation(override(rawRead, path, mutant))).toThrow(
    "runtime preparation relocation:",
  );
}
function historical(): Reader {
  const historicalReader = positive();
  const sources = reconstructRuntimeContractReceiptSources(historicalReader);
  expect(sources.size).toBe(runtimeContractCurrentPaths.length);
  for (const path of runtimeContractCurrentPaths) expect(sources.has(path)).toBe(true);
  return (path) => {
    if (!runtimeContractCurrentPaths.includes(path)) return historicalReader(path);
    const source = sources.get(path);
    if (source === undefined) throw Error("missing runtime historical source " + path);
    return source;
  };
}
function declarations(source: string) {
  return ts
    .createSourceFile(support, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    .statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
}
function reorder(source: string): string {
  const [first, second] = declarations(source);
  if (!first || !second) throw Error("two declarations required");
  return source.slice(0, first.getFullStart()) + second.getFullText() + first.getFullText() + source.slice(second.end);
}

describe("fixed runtime preparation source relocation", () => {
  it("authenticates the actual pair and independently replays every restored byte", () => {
    const historicalReader = positive(),
      restored = Buffer.from(historicalReader(support));
    expect(receipt.segments).toHaveLength(47);
    expect(receipt.segments.filter((segment) => segment.kind === "module-literal")).toHaveLength(23);
    const replay = Buffer.concat(
      receipt.segments.map((segment) =>
        segment.kind === "unchanged"
          ? restored.subarray(segment.beforeStart, segment.beforeEnd)
          : Buffer.from(segment.afterText!),
      ),
    );
    expect(replay.toString("utf8")).toBe(priorImplementation(rawRead(implementation)));
    expect(currentImplementation(replay.toString("utf8"))).toBe(rawRead(implementation));
    expect(historicalReader(implementation)).toBe(rawRead(implementation));
  });

  it("reads the mandatory pair once and delegates all other paths unchanged", () => {
    positive();
    const calls: string[] = [];
    const reader = beforeRuntimePreparationRelocation((path) => {
      calls.push(path);
      return rawRead(path);
    });
    expect(calls).toEqual([runtimePreparationRelocationReceiptPath, support, implementation]);
    reader(support);
    reader(support);
    expect(calls).toHaveLength(3);
    expect(reader("package.json")).toBe(rawRead("package.json"));
    expect(calls.at(-1)).toBe("package.json");
  });

  it.each(runtimePreparationRelocationCurrentPaths)("refuses missing, undefined and empty %s", (path) => {
    positive();
    expect(() =>
      beforeRuntimePreparationRelocation((requested) => {
        if (requested === path) throw Error("missing physical source " + path);
        return rawRead(requested);
      }),
    ).toThrow("missing physical source " + path);
    expect(() => beforeRuntimePreparationRelocation(override(rawRead, path, undefined as unknown as string))).toThrow(
      "missing nonempty source",
    );
    expect(() => beforeRuntimePreparationRelocation(override(rawRead, path, ""))).toThrow("missing nonempty source");
  });

  const receiptMutations: readonly [string, (r: Mutable<typeof receipt>) => void][] = [
    [
      "schema",
      (r) => {
        r.schema = "unknown";
      },
    ],
    [
      "version",
      (r) => {
        r.schema = "ir-runtime-preparation-relocation-v2";
      },
    ],
    [
      "fixed path",
      (r) => {
        r.currentPaths[1] = "src/ir/wrong.ts";
      },
    ],
    [
      "restored path",
      (r) => {
        r.restoredPath = implementation;
      },
    ],
    [
      "source pin",
      (r) => {
        r.before.sha256 = "0".repeat(64);
      },
    ],
    [
      "span pin",
      (r) => {
        r.segments[0].afterSha256 = "0".repeat(64);
      },
    ],
    [
      "overlap",
      (r) => {
        r.segments[1].afterStart--;
      },
    ],
    [
      "gap",
      (r) => {
        r.segments[1].afterStart++;
      },
    ],
    [
      "order",
      (r) => {
        [r.segments[0], r.segments[2]] = [r.segments[2], r.segments[0]];
      },
    ],
    [
      "dropped segment",
      (r) => {
        r.segments.splice(2, 1);
      },
    ],
    [
      "extra segment",
      (r) => {
        r.segments.push(r.segments[0]);
      },
    ],
    [
      "duplicate literal ordinal",
      (r) => {
        r.segments[3].ordinal = 0;
      },
    ],
    [
      "wrong reciprocal literal",
      (r) => {
        r.segments[1].afterText = "./wrong.js";
      },
    ],
    [
      "wrong inverse literal",
      (r) => {
        r.segments[1].beforeText = "./wrong.js";
      },
    ],
  ];
  it.each(receiptMutations)("refuses altered immutable receipt %s", (_label, mutate) => {
    positive();
    const altered = JSON.parse(receiptText) as Mutable<typeof receipt>;
    mutate(altered);
    const text = JSON.stringify(altered);
    expect(text).not.toBe(receiptText);
    expect(() =>
      beforeRuntimePreparationRelocation(override(rawRead, runtimePreparationRelocationReceiptPath, text)),
    ).toThrow("immutable receipt bytes mismatch");
  });
  it("refuses a whitespace-only raw receipt edit", () => {
    positive();
    expect(() => authenticateRuntimePreparationRelocation(receiptText + "\n")).toThrow(
      "immutable receipt bytes mismatch",
    );
  });

  it.each([
    [
      "wrong facade target",
      (text: string) => replaceOne(text, "./runtime/contracts/prepared.js", "./runtime/contracts/wrong.js"),
    ],
    [
      "value/type export",
      (text: string) =>
        replaceOne(text, "export type { PreparedIrRuntimeManifest }", "export { PreparedIrRuntimeManifest }"),
    ],
    ["added executable facade body", (text: string) => text + "const preparationBody = 1;\n"],
    [
      "alternate all-through-implementation facade",
      (text: string) =>
        text
          .replace('export type { PreparedIrRuntimeManifest } from "./runtime/contracts/prepared.js";\n', "")
          .replace('export { verifyIrIntrinsicInstruction } from "./runtime/intrinsic-verification.js";\n', "")
          .replace("  prepareIrRuntimeManifest,", "  prepareIrRuntimeManifest,\n  verifyIrIntrinsicInstruction,")
          .replace("PrepareIrRuntimeManifestInput }", "PrepareIrRuntimeManifestInput, PreparedIrRuntimeManifest }"),
    ],
  ] as const)("refuses %s", (_label, edit) => physicalRefusal(support, edit));

  it.each(receipt.segments.map((segment, index) => ({ segment, index })))(
    "refuses changed live bytes in fixed segment $index",
    ({ segment }) =>
      physicalRefusal(implementation, (text) => {
        const bytes = Buffer.from(text),
          prior = Buffer.from(priorImplementation(text)),
          at = currentCoordinate(segment.afterStart);
        expect(hash(prior.subarray(segment.afterStart, segment.afterEnd))).toBe(segment.afterSha256);
        expect(bytes[at]).toBe(prior[segment.afterStart]);
        bytes[at] = bytes[at] === 120 ? 121 : 120;
        return bytes.toString("utf8");
      }),
  );
  it.each(receipt.segments.filter((segment) => segment.kind === "module-literal"))(
    "refuses wrong module literal at ordinal $ordinal",
    (segment) =>
      physicalRefusal(implementation, (text) => {
        const bytes = Buffer.from(text),
          start = currentCoordinate(segment.afterStart),
          end = currentCoordinate(segment.afterEnd);
        expect(bytes.subarray(start, end)).toEqual(Buffer.from(segment.afterText!));
        return Buffer.concat([bytes.subarray(0, start), Buffer.from("./wrong.js"), bytes.subarray(end)]).toString(
          "utf8",
        );
      }),
  );
  it.each([
    ["header", (text: string) => text.replace("Copyright", "Copywrong")],
    [
      "comment",
      (text: string) =>
        replaceOne(text, "Project the semantic standalone clock intent", "Changed semantic standalone clock intent"),
    ],
    ["body", (text: string) => replaceOne(text, "function mapArray<T>", "function changedArray<T>")],
    ["trailer", (text: string) => text + "\n"],
    [
      "missing declaration",
      (text: string) => {
        const first = declarations(text)[0]!;
        return text.slice(0, first.getFullStart()) + text.slice(first.end);
      },
    ],
    ["duplicated declaration", (text: string) => text + declarations(text)[0]!.getFullText()],
    ["reordered declaration", reorder],
    [
      "removed overload",
      (text: string) => {
        const node = declarations(text).find((node) => ts.isFunctionDeclaration(node) && !node.body)!;
        if (!node) throw Error("overload required");
        return text.slice(0, node.getFullStart()) + text.slice(node.end);
      },
    ],
    [
      "duplicated overload",
      (text: string) => {
        const node = declarations(text).find((node) => ts.isFunctionDeclaration(node) && !node.body);
        if (!node) throw Error("overload required");
        return text.slice(0, node.end) + "\n" + node.getText() + text.slice(node.end);
      },
    ],
    [
      "reordered overload",
      (text: string) => {
        const overloads = declarations(text).filter((node) => ts.isFunctionDeclaration(node) && !node.body);
        const [first, second] = overloads;
        if (!first || !second) throw Error("two overloads required");
        return (
          text.slice(0, first.getFullStart()) + second.getFullText() + first.getFullText() + text.slice(second.end)
        );
      },
    ],
    [
      "duplicated literal",
      (text: string) =>
        text.replace('from "./contracts/prepared.js"', 'from "./contracts/prepared.js./contracts/prepared.js"'),
    ],
  ] as const)("refuses physical implementation %s", (_label, edit) => physicalRefusal(implementation, edit));

  it.each(runtimePreparationRelocationCurrentPaths)("recaptures changed %s after a successful invocation", (path) => {
    positive();
    let changed = false;
    const reader: Reader = (requested) =>
      rawRead(requested) + (changed && requested === path ? "\n// changed after success\n" : "");
    expect(hash(beforeRuntimePreparationRelocation(reader)(support))).toBe(receipt.before.sha256);
    changed = true;
    expect(() => beforeRuntimePreparationRelocation(reader)).toThrow("complete source SHA256/length mismatch: " + path);
  });
  it("refuses an old body or a second inverse instead of silently restoring pristine bytes", () => {
    const historicalReader = positive();
    expect(() => beforeRuntimePreparationRelocation(historicalReader)).toThrow(
      "complete source SHA256/length mismatch: " + support,
    );
    expect(() =>
      beforeRuntimePreparationRelocation(
        override(rawRead, support, historicalReader(support) + "\n// historical mutant\n"),
      ),
    ).toThrow("complete source SHA256/length mismatch: " + support);
  });
});

describe("finite remainder current-source relocation adapter", () => {
  it.each([
    "removed remainder import",
    "removed remainder predicate",
    "unrelated body byte",
    "duplicated new import",
    "reordered new import",
  ] as const)("refuses %s in the supplied current source", (kind) => {
    physicalRefusal(implementation, (source) => {
      const imported = remainderEdits[0].after;
      if (kind === "removed remainder import") return replaceOne(source, imported, "");
      if (kind === "removed remainder predicate")
        return replaceOne(source, remainderEdits[1].after, remainderEdits[1].before);
      if (kind === "unrelated body byte") return replaceOne(source, "function mapArray<T>", "function changedArray<T>");
      if (kind === "duplicated new import") return replaceOne(source, imported, imported + imported);
      const ordinary = 'import { irOrdinaryObjectCallableDeclaration } from "./ordinary-object-callables.js";\n';
      return replaceOne(source, imported + ordinary, ordinary + imported);
    });
    positive();
  });
  it("refuses exact prior49541 bytes as supplied current input", () => {
    positive();
    const prior = priorImplementation(rawRead(implementation));
    expect(() => beforeRuntimePreparationRelocation(override(rawRead, implementation, prior))).toThrow(
      "complete source SHA256/length mismatch: " + implementation,
    );
    positive();
  });
  it("freshly refuses changed current source after success and accepts exact restoration", () => {
    let source = rawRead(implementation);
    const reader = (path: string) => (path === implementation ? source : rawRead(path));
    expect(hash(beforeRuntimePreparationRelocation(reader)(support))).toBe(receipt.before.sha256);
    source += "\n// changed after healthy current capture\n";
    expect(() => beforeRuntimePreparationRelocation(reader)).toThrow(
      "complete source SHA256/length mismatch: " + implementation,
    );
    source = rawRead(implementation);
    expect(hash(beforeRuntimePreparationRelocation(reader)(support))).toBe(receipt.before.sha256);
  });
  it("delegates later implementation and unknown reads to the original supplied reader", () => {
    let source = rawRead(implementation);
    const marker = new Error("supplied late read failure");
    const reader = beforeRuntimePreparationRelocation((path) => {
      if (path === implementation) return source;
      if (path === "unknown") throw marker;
      return rawRead(path);
    });
    source += "\n// late raw implementation mutant\n";
    expect(reader(implementation)).toBe(source);
    expect(hash(reader(support))).toBe(receipt.before.sha256);
    let caught: unknown;
    try {
      reader("unknown");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(marker);
    expect(() =>
      beforeRuntimePreparationRelocation((path) => (path === implementation ? source : rawRead(path))),
    ).toThrow("complete source SHA256/length mismatch: " + implementation);
    positive();
  });
  it("refuses nonprimitive current source without coercion", () => {
    let touched = 0;
    const source = {
      toString() {
        touched++;
        return rawRead(implementation);
      },
    };
    expect(() =>
      beforeRuntimePreparationRelocation(override(rawRead, implementation, source as unknown as string)),
    ).toThrow("missing nonempty source: " + implementation);
    expect(touched).toBe(0);
    positive();
  });
  it("preserves the exact old relocation helper and immutable receipt bytes", () => {
    positive();
    const helper = rawRead("tests/helpers/ir-runtime-preparation-relocation.ts");
    expect(Buffer.byteLength(helper)).toBe(7007);
    expect(hash(helper)).toBe("8adf44a0f063d8b7fb7ed413a37e693c2c3e420b5a52cf6f9161cfceb9a901df");
    expect(rawRead(runtimePreparationRelocationReceiptPath)).toBe(receiptText);
    expect(Buffer.byteLength(receiptText)).toBe(19505);
    positive();
  });
});

describe("historical mutations occur after the physical relocation inverse", () => {
  it("replays the provider reordered-declaration guard in the old logical source", () => {
    const historicalReader = positive();
    expect(() => currentDeclarations(support, historicalReader)).not.toThrow();
    const mutant = reorder(historicalReader(support));
    expect(mutant).not.toBe(historicalReader(support));
    expect(() => currentDeclarations(support, override(historicalReader, support, mutant))).toThrow(
      /current declaration order/,
    );
  });
  it("preserves runtime-evolution changed input and old source injection refusals", () => {
    const historicalReader = positive();
    const sources = reconstructRuntimeContractReceiptSources(historicalReader);
    const old = sources.get(support)!;
    expect(old).not.toBe(historicalReader(support));
    for (const mutant of [historicalReader(support) + "\n// changed evolution input\n", old]) {
      expect(() => reconstructRuntimeContractReceiptSources(override(historicalReader, support, mutant))).toThrow(
        "runtime contract evolution: complete source SHA256/length mismatch: " + support,
      );
    }
  });
  it("preserves historical reconstruction mutation and declaration-mutation guards", () => {
    const source = historical();
    expect(() => assertCallableExtension(source)).not.toThrow();
    expect(acceptedHistoricalDeclarations(support, source)).toHaveLength(41);
    const original = source(support);
    // Replay the existing semantic vector mutation within a declaration. A
    // trailing source comment is outside this legacy declaration receipt's domain.
    const changedVectorDemand = replaceOne(
      original,
      "assertVectorCallableDemands(input.functions, input.vectorDemands)",
      "assertVectorCallableDemands([], input.vectorDemands)",
    );
    for (const [mutant, diagnostic] of [
      [changedVectorDemand, "exact clock/vector delta/neighbors function:prepareIrRuntimeManifest#2"],
      [reorder(original), "current declaration order/identity in " + support],
    ]) {
      expect(mutant).not.toBe(original);
      expect(() => acceptedHistoricalDeclarations(support, override(source, support, mutant))).toThrow(diagnostic);
    }
  });
  it("retains the program-data initial reconstruction chain and supplied reader authority", () => {
    const source = historical();
    expect(historicalIntrinsicSource(source).length).toBeGreaterThan(0);
    const historicalReader = positive();
    const calls: string[] = [];
    expect(
      reconstructRuntimeContractReceiptSources((path) => {
        calls.push(path);
        return historicalReader(path);
      }).size,
    ).toBe(runtimeContractCurrentPaths.length);
    expect(calls).toEqual(runtimeContractCurrentPaths);
    expect(() => reconstructRuntimeContractReceiptSources(override(historicalReader, support, ""))).toThrow(
      "runtime contract evolution: complete source SHA256/length mismatch: " + support,
    );
    expect(() => reconstructRuntimeContractReceiptSources(historicalReader, "{}")).toThrow(
      "runtime contract evolution:",
    );
  });
});

// Fresh whole component authentication precedes each explicit source-epoch bridge.
function assertSourceMapValidatorComponent(readLive: (path: string) => string): void {
  const path = "tests/helpers/ir-program-validator-relocation.ts";
  const text = readLive(path);
  if (typeof text !== "string" || text.length === 0)
    throw new Error("program validator relocation: nonempty primitive text required: " + path);
  if (
    Buffer.byteLength(text) !== 46642 ||
    createHash("sha256").update(text).digest("hex") !==
      "6e32ca208775e8eeae765bf3345cdd3cb1e0f40a1784f684afd9c4dff3a4cfe0"
  )
    throw new Error("program validator relocation: complete source pin mismatch: " + path);
}
function beforeProgramValidatorRelocation(readLive: (path: string) => string): (path: string) => string {
  if (typeof readLive !== "function") throw new Error("program validator relocation: physical reader required");
  assertSourceMapValidatorComponent(readLive);
  return beforeSourceMapProgramValidatorRelocation(readLive);
}
