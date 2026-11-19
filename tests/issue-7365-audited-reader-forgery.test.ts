// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7365 A — inside `audited` the nested layout audits are skipped, so an index query there must answer from the
// ledger's private state alone. Each probe alters the public layout inside a block and restores it before the
// block's one exit audit, which therefore passes; the index a public-reading query would have named is recorded
// next to the answer, so every probe shows the alteration was able to steer one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { STABLE_FUNC_BASE } from "../src/wasm/physical/function-handles.js";
import {
  PhysicalModuleReservations,
  type PhysicalModuleStorage,
  type PhysicalReservation,
} from "../src/wasm/physical/module-reservations.js";

type ImportKind = "func" | "global" | "tag";

/** The index the PUBLIC layout names for a token: the import count of its space plus its position there. */
function layoutIndex(module: PhysicalModuleStorage, token: PhysicalReservation): number {
  const imported = (kind: ImportKind) => module.imports.filter((record) => record.desc.kind === kind);
  switch (token.kind) {
    case "function":
      return imported("func").length + module.funcOrdinalToPosition[token.handle - STABLE_FUNC_BASE]!;
    case "global":
      return imported("global").length + module.globals.indexOf(token.object);
    case "tag":
      return imported("tag").length + module.tags.indexOf(token.object);
    case "function-import":
      return imported("func").indexOf(token.object);
    case "global-import":
      return imported("global").indexOf(token.object);
    case "tag-import":
      return imported("tag").indexOf(token.object);
    case "type":
      return token.typeIndex;
    default:
      throw new Error(`no public coordinate for a ${token.kind} token`);
  }
}

const PHANTOM_IMPORTS = [
  { module: "phantom", name: "f", desc: { kind: "func", typeIdx: 0 } },
  { module: "phantom", name: "g", desc: { kind: "global", type: { kind: "i32" }, mutable: false } },
  { module: "phantom", name: "t", desc: { kind: "tag", typeIdx: 0 } },
] as const;

/** One phantom import per index space and a reversed ordinal map: every function, global and tag index moves. */
function alterLayout(module: PhysicalModuleStorage): void {
  module.funcOrdinalToPosition.reverse();
  module.imports.push(...structuredClone(PHANTOM_IMPORTS));
}
function restoreLayout(module: PhysicalModuleStorage): void {
  module.imports.length -= PHANTOM_IMPORTS.length;
  module.funcOrdinalToPosition.reverse();
}

interface Answer {
  readonly token: PhysicalReservation;
  /** What the ledger answered while the layout was altered. */
  readonly index: number;
  /** What the altered public layout named at that moment. */
  readonly steered: number;
}
interface BlockRun {
  readonly module: PhysicalModuleStorage;
  readonly answers: Answer[];
  /** The token lists the block itself asked `physicalIndices` for, in order. */
  readonly lists: (readonly PhysicalReservation[])[];
  /** Index queries the block made itself (the probe adds one per completion check). */
  own: number;
  altered: boolean;
  result?: unknown;
}
const probe = vi.hoisted(() => ({
  /** Which post-seal audited block of the compile, in program order, has its layout altered. */
  block: undefined as number | undefined,
  seen: 0,
  runs: [] as unknown[],
}));

vi.mock("../src/wasm/physical/module-reservations.js", async (original) => {
  const real = await original<typeof import("../src/wasm/physical/module-reservations.js")>();
  /** The real ledger; in the chosen block its replaced queries alter the layout, and the block's end restores it. */
  class ProbedReservations extends real.PhysicalModuleReservations {
    readonly #module: PhysicalModuleStorage;
    #run: BlockRun | undefined;
    #depth = 0;

    constructor(module: PhysicalModuleStorage) {
      super(module);
      this.#module = module;
    }

    #answer(token: PhysicalReservation, index: number): void {
      this.#run?.answers.push({ token, index, steered: layoutIndex(this.#module, token) });
    }

    #alter(): void {
      if (!this.#run || this.#run.altered) return;
      alterLayout(this.#module);
      this.#run.altered = true;
    }

    override audited<T>(check: () => T): T {
      const chosen = this.#depth === 0 && this.state === "sealed" && probe.seen++ === probe.block;
      if (!chosen) return this.#nested(() => super.audited(check));
      const run: BlockRun = { module: this.#module, answers: [], lists: [], own: 0, altered: false };
      probe.runs.push(run);
      this.#run = run;
      try {
        run.result = this.#nested(() =>
          super.audited(() => {
            try {
              return check();
            } finally {
              if (run.altered) restoreLayout(this.#module);
            }
          }),
        );
        return run.result as T;
      } finally {
        this.#run = undefined;
      }
    }

    #nested<T>(block: () => T): T {
      this.#depth++;
      try {
        return block();
      } finally {
        this.#depth--;
      }
    }

    override physicalIndex(token: PhysicalReservation): number {
      this.#alter();
      const index = super.physicalIndex(token);
      if (this.#run) this.#run.own++;
      this.#answer(token, index);
      return index;
    }

    override physicalIndices(tokens: readonly PhysicalReservation[]): readonly number[] {
      this.#alter();
      const indices = super.physicalIndices(tokens);
      if (this.#run) this.#run.own++;
      this.#run?.lists.push(tokens);
      tokens.forEach((token, position) => this.#answer(token, indices[position]!));
      return indices;
    }

    /** A completion check returns no index, so the probe asks for the token's index while the layout is altered. */
    override assertCompletedReservation(
      token: Parameters<PhysicalModuleReservations["assertCompletedReservation"]>[0],
    ) {
      this.#alter();
      super.assertCompletedReservation(token);
      if (this.#run) this.#answer(token, super.physicalIndex(token));
    }
  }
  return { ...real, PhysicalModuleReservations: ProbedReservations };
});

afterEach(() => {
  probe.block = undefined;
  probe.seen = 0;
  probe.runs = [];
});

const signature = { params: [], results: [] };

/** A frozen, filled ledger with an import and a definition in every index space that has imports. */
function ledger(storage = createEmptyModule() as PhysicalModuleStorage) {
  const tx = new PhysicalModuleReservations(storage);
  const functions = ["a", "b", "c"] as const;
  const tokens = [
    tx.reserveFunctionImport("import:function", "env", "f", signature),
    tx.reserveGlobalImport("import:global", "env", "g", { kind: "i32" }, false),
    tx.reserveTag("import:tag", signature, { kind: "import", module: "env", name: "t" }),
    ...functions.map((name) => tx.reserveFunction(`function:${name}`, name, signature)),
    tx.reserveGlobal("global:a", "ga", { kind: "i32" }, false),
    tx.reserveGlobal("global:b", "gb", { kind: "i32" }, false),
    tx.reserveTag("tag:a", signature, { kind: "defined", name: "ta" }),
  ];
  tx.freezeReservations();
  for (const token of tokens) {
    if (token.kind === "function") tx.fillFunction(token, { locals: [], body: [] });
    else if (token.kind === "global") tx.fillGlobal(token, [{ op: "i32.const", value: 0 }]);
  }
  return { tx, tokens };
}
const LEDGER_INDICES = [0, 0, 0, 1, 2, 3, 1, 2, 1];

describe("#7365 the ledger answers an index from its private state", () => {
  it("names the module's own coordinate for every token, one by one and as a list", () => {
    const module = createEmptyModule();
    const { tx, tokens } = ledger(module);
    expect(tokens.map((token) => tx.physicalIndex(token))).toEqual(LEDGER_INDICES);
    expect(tx.physicalIndices(tokens)).toEqual(LEDGER_INDICES);
    expect(tokens.map((token) => layoutIndex(module, token))).toEqual(LEDGER_INDICES);
  });

  it("is unaffected by a replaced `imports.filter`", () => {
    const module = createEmptyModule();
    const { tx, tokens } = ledger(module);
    module.imports.filter = (() => []) as typeof module.imports.filter;
    expect(tokens.map((token) => tx.physicalIndex(token))).toEqual(LEDGER_INDICES);
    expect(tx.physicalIndices(tokens)).toEqual(LEDGER_INDICES);
  });

  it("answers the true indices when the layout is altered and restored inside an audited block", () => {
    const module = createEmptyModule();
    const { tx, tokens } = ledger(module);
    const answers = tx.audited(() => {
      alterLayout(module);
      try {
        expect(tokens.map((token) => layoutIndex(module, token))).not.toEqual(LEDGER_INDICES);
        return [tokens.map((token) => tx.physicalIndex(token)), tx.physicalIndices(tokens)];
      } finally {
        restoreLayout(module);
      }
    });
    expect(answers).toEqual([LEDGER_INDICES, LEDGER_INDICES]);
    expect(tx.state).toBe("filling");
  });

  it("reads no public module state for a query inside an audited block", () => {
    const reads: PropertyKey[] = [];
    let watching = false;
    const storage = new Proxy(createEmptyModule() as PhysicalModuleStorage, {
      get(target, key, receiver) {
        if (watching) reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    const { tx, tokens } = ledger(storage);
    tx.audited(() => {
      watching = true;
      try {
        for (const token of tokens) {
          tx.physicalIndex(token);
          if (token.kind === "function" || token.kind === "global") tx.assertCompletedReservation(token);
        }
        tx.physicalIndices(tokens);
      } finally {
        watching = false;
      }
    });
    expect(reads).toEqual([]);
  });

  it("still refuses an altered layout at the query outside a block, and at the exit of a block that leaves it", () => {
    for (const inside of [false, true]) {
      const module = createEmptyModule();
      const { tx, tokens } = ledger(module);
      alterLayout(module);
      const query = () => tx.physicalIndex(tokens[3]!);
      expect(inside ? () => tx.audited(query) : query).toThrow("population");
      expect(tx.state).toBe("failed");
    }
  });
});

const options = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required", version: 1 }),
  backend: "wasmgc",
  target: "standalone",
  sourceMap: false,
  optimize: false,
  emitWat: false,
  fileName: "test.js",
  allowJs: true,
} as Test262CompileOptions;

const PLAIN = "if (1 !== 1) throw 1;";
const REALM = "function f(){ var o = { a: 1 }; return o.a; } if (f() !== 1) throw 1;";

/** Compile with the layout altered inside one post-seal block; the block must still be answered the true layout. */
async function probeBlock(source: string, block: number): Promise<BlockRun> {
  probe.block = block;
  const result = await compile(source, options);
  const errors = result.errors.map((error) => error.message);
  const [run, ...others] = probe.runs as BlockRun[];
  expect(others).toEqual([]);
  if (!run) throw new Error(`the compile ran no post-seal audited block ${block}: ${errors.join("; ")}`);
  expect(run.altered).toBe(true);
  const truth = (token: PhysicalReservation) => layoutIndex(run.module, token);
  expect(run.answers.filter((answer) => answer.steered !== truth(answer.token)).length).toBeGreaterThan(0);
  expect(
    run.answers
      .filter((answer) => answer.index !== truth(answer.token))
      .map((answer) => `${answer.token.key}: answered ${answer.index}, the layout names ${truth(answer.token)}`),
  ).toEqual([]);
  expect(errors).toEqual([]);
  return run;
}

describe("#7365 a post-seal reader block is answered the true layout while it is altered and restored", () => {
  it("the completion checks after seal", async () => {
    const run = await probeBlock(PLAIN, 0);
    expect(run.result).toBeUndefined();
    expect(run.own).toBeGreaterThan(0);
  });

  it("the support receipts recorded for the emission", async () => {
    const run = await probeBlock(PLAIN, 1);
    const receipts = run.result as readonly { readonly key: string; readonly index: number }[];
    expect(receipts.length).toBeGreaterThan(0);
    const truth = new Map(run.answers.map(({ token }) => [token.key, layoutIndex(run.module, token)]));
    expect(receipts).toEqual(receipts.map(({ key }) => ({ key, index: truth.get(key) })));
  });

  it("the support receipt reader", async () => {
    const run = await probeBlock(PLAIN, 2);
    expect(run.result).toBeUndefined();
    expect(run.own).toBe(0);
    expect(run.answers.every(({ token }) => token.kind === "function")).toBe(true);
  });

  it("the realm's completed slots", { timeout: 240_000 }, async () => {
    const run = await probeBlock(REALM, 1);
    const slots = run.result as Record<"functions" | "types" | "globals", ReadonlySet<number>>;
    const [functions, types, globals] = run.lists
      .slice(-3)
      .map((tokens) => new Set(tokens.map((token) => layoutIndex(run.module, token))));
    expect(slots).toEqual({ functions, types, globals });
    expect(slots.functions.size).toBeGreaterThan(0);
  });
});
