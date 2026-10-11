// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6790 — runtime state that has to belong to one instance was kept per process.
//
// 1. The Node eval Worker kept every object it ever handed to the host, in both
//    threads, until `terminate()`.
// 2. The dynamic class-parent registry (`class C extends <value>`) was one
//    process-wide table keyed by class NAME, so two live instances that each
//    declared a `C` with a different parent shared one entry.
// 3. The #5225 linked-provider decoder registry was one Set for the whole
//    process, so a second linked project could be answered by the first
//    project's exports unless the caller knew to call
//    `resetLinkedProjectRegistry()` first — which no public entry point did.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile, compileProject, instantiateLinkedProject } from "../src/index.js";
import { type NodeEvalWorkerEvaluator, connectNodeEvalWorker } from "../src/runtime-node-eval-worker.js";
import { buildImports } from "../src/runtime.js";
import { createCrossModuleStructOwners } from "../src/runtime/cross-module-struct-owners.js";

setFlagsFromString("--expose-gc");
const hostGc = runInNewContext("gc") as () => void;

/** Collect on the host and let the FinalizationRegistry callbacks run. */
async function settleHost(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    hostGc();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("#6790 part 1 — the Node eval Worker releases handles the host dropped", () => {
  let workerBuildDir: string;
  let workerEntryUrl: URL;
  let evaluator: NodeEvalWorkerEvaluator | undefined;
  const indirect = { direct: false } as const;

  beforeAll(async () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    await mkdir(temporaryRoot, { recursive: true });
    workerBuildDir = await mkdtemp(join(temporaryRoot, "eval-worker-6790-"));
    const outfile = join(workerBuildDir, "worker.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./fixtures/node-eval-worker.mjs", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile,
    });
    workerEntryUrl = pathToFileURL(outfile);
    evaluator = await connectNodeEvalWorker(new Worker(workerEntryUrl));
    // The Worker realm's own collector, reached without --expose-gc on the
    // Worker (execArgv rejects it): the flag is process-wide once set.
    evaluator.evaluate(
      "globalThis.__refs = []; process.getBuiltinModule('v8').setFlagsFromString('--expose-gc');" +
        " globalThis.__gc = process.getBuiltinModule('vm').runInNewContext('gc'); 0",
      indirect,
    );
  });

  afterAll(async () => {
    await evaluator?.terminate();
    await rm(workerBuildDir, { recursive: true, force: true });
  });

  /** Worker-realm objects minted by the loop below that are still alive. */
  const liveInWorker = (): number =>
    evaluator!.evaluate("__gc(); __refs.filter((ref) => ref.deref() !== undefined).length", indirect) as number;

  it('keeps 10,000 eval("({})") results bounded in both realms', async () => {
    const hostRefs: WeakRef<object>[] = [];
    let peakInWorker = 0;
    for (let chunk = 0; chunk < 10; chunk++) {
      for (let i = 0; i < 1_000; i++) {
        const proxy = evaluator!.evaluate(
          "(() => { const o = {}; __refs.push(new WeakRef(o)); return o; })()",
          indirect,
        ) as object;
        hostRefs.push(new WeakRef(proxy));
      }
      // A real host yields to its event loop between bursts; that is where the
      // releases are produced. Before #6790 this count only ever grew.
      await settleHost();
      peakInWorker = Math.max(peakInWorker, liveInWorker());
    }
    expect(hostRefs.length).toBe(10_000);
    // A single straggler (the newest proxy can sit in a register) is fine; the
    // pre-fix value was 10,000 in each realm.
    expect(hostRefs.filter((ref) => ref.deref() !== undefined).length).toBeLessThan(10);
    expect(liveInWorker()).toBeLessThan(10);
    expect(peakInWorker).toBeLessThan(1_000 + 10);
  }, 120_000);

  it("re-mints a released object under a fresh handle instead of a dead one", async () => {
    evaluator!.evaluate("globalThis.__kept = { n: 7 }; 0", indirect);
    const read = (): unknown => (evaluator!.evaluate("__kept", indirect) as { n: unknown }).n;
    expect(read()).toBe(7);
    await settleHost();
    // The first proxy is gone and its handle released; the same Worker object
    // must come back usable, which it cannot if the Worker still maps it to
    // the released id.
    evaluator!.evaluate("0", indirect);
    expect(read()).toBe(7);
  });

  it("never releases a handle the host still holds", async () => {
    const held = evaluator!.evaluate("({ n: 41, inc() { return ++this.n; } })", indirect) as {
      n: number;
      inc(): number;
    };
    for (let i = 0; i < 200; i++) evaluator!.evaluate("({})", indirect);
    await settleHost();
    evaluator!.evaluate("0", indirect);
    expect(held.inc()).toBe(42);
    expect(held.n).toBe(42);
  });
});

describe("#6790 part 2 — class parents are registered per instance, not per class name", () => {
  /** A host constructor that stamps who constructed the receiver, with a static of the same label. */
  function makeBase(label: string, log: string[]): Function {
    const Base = function (this: Record<string, unknown>) {
      log.push(label);
      this.tag = label;
    } as unknown as Function & { who?: string };
    Base.who = label;
    return Base;
  }

  /** Instantiate one compiled binary with the host value its heritage reads at init. */
  async function instantiateWith(
    result: Awaited<ReturnType<typeof compile>>,
    slot: string,
    value: unknown,
  ): Promise<Record<string, () => unknown>> {
    (globalThis as Record<string, unknown>)[slot] = value;
    try {
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
      imports.setInstance?.(instance);
      return instance.exports as unknown as Record<string, () => unknown>;
    } finally {
      delete (globalThis as Record<string, unknown>)[slot];
    }
  }

  it("each instance's SuperCall runs its own parent (property-access heritage)", async () => {
    const slot = "__issue6790_ns";
    const result = await compile(
      `
        const NS: any = (globalThis as any).${slot};
        class C extends NS.Base {
          constructor() { super(); }
        }
        export function tag(): any { const c: any = new C(); return c.tag; }
        export function staticWho(): any { return (C as any).who; }
      `,
      { fileName: "issue-6790-a.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    // The heritage this test is about: resolved by NAME at the SuperCall.
    expect(result.imports.some((d) => d.name.startsWith("__call_dynamic_class_parent_"))).toBe(true);

    const log: string[] = [];
    const a = await instantiateWith(result, slot, { Base: makeBase("A", log) });
    const b = await instantiateWith(result, slot, { Base: makeBase("B", log) });

    // Before #6790 the second registration overwrote the first: A's `new C()`
    // ran B's constructor (tag "B", log ["B"]) and `C.who` read "B".
    log.length = 0;
    expect(a.tag!()).toBe("A");
    expect(log).toEqual(["A"]);
    log.length = 0;
    expect(b.tag!()).toBe("B");
    expect(log).toEqual(["B"]);
    expect(a.staticWho!()).toBe("A");
    expect(b.staticWho!()).toBe("B");
  }, 120_000);

  it("two different programs declaring the same class name keep their own static parents", async () => {
    const slotA = "__issue6790_baseA";
    const slotB = "__issue6790_baseB";
    const program = (slot: string, extra: string) =>
      compile(
        `
          const P: any = (globalThis as any).${slot};
          class C extends P {
            constructor() { super(); }
          }
          export function staticWho(): any { return (C as any).who; }
          export function ${extra}(): number { return 1; }
        `,
        { fileName: `issue-6790-${extra}.ts`, skipSemanticDiagnostics: true },
      );
    const [first, second] = await Promise.all([program(slotA, "first"), program(slotB, "second")]);
    expect(first.success && second.success).toBe(true);
    expect(first.imports.some((d) => d.name === "__register_class_parent")).toBe(true);

    const log: string[] = [];
    const a = await instantiateWith(first, slotA, makeBase("A", log));
    const b = await instantiateWith(second, slotB, makeBase("B", log));
    expect(a.staticWho!()).toBe("A");
    expect(b.staticWho!()).toBe("B");
  }, 120_000);
});

describe("#6790 part 3 — each linked instantiation is its own decoder project", () => {
  // Two instances of ONE provider binary share canonical WasmGC types, so each
  // names the other's structs (the #5364 model). Consumers name nothing.
  const fakeModule = (names: Set<object>): Record<string, Function> => ({
    __struct_field_names: (obj: object) => (names.has(obj) ? "year,month,day" : ""),
  });

  /** Replays `instantiateLinkedProviders` + `wireCompiledInstance` for two projects, no reset. */
  function twoProjects() {
    const registry = createCrossModuleStructOwners(() => true);
    const struct1 = {};
    const struct2 = {};
    const shared = new Set([struct1, struct2]);
    const [provider1, consumer1, provider2, consumer2] = [
      fakeModule(shared),
      fakeModule(new Set()),
      fakeModule(shared),
      fakeModule(new Set()),
    ];
    const [root1, root2] = [{}, {}];
    registry.beginProject(root1);
    registry.registerModule(provider1, root1);
    registry.registerModule(consumer1, root1);
    registry.beginProject(root2);
    registry.registerModule(provider2, root2);
    registry.registerModule(consumer2, root2);
    return { registry, struct1, struct2, provider1, consumer1, provider2, consumer2, root1 };
  }

  it("the second project decodes through its own provider with no reset call", () => {
    const { registry, struct2, provider2, consumer2 } = twoProjects();
    // Before #6790: provider1 — the first module in the process-wide Set that
    // could name the struct.
    expect(registry.decoderFor(struct2, consumer2)).toBe(provider2);
    expect(registry.peersOf(consumer2)).toEqual([provider2]);
  });

  it("the first project keeps working while the second is live (a reset could not)", () => {
    const { registry, struct1, provider1, consumer1, provider2 } = twoProjects();
    expect(registry.decoderFor(struct1, consumer1)).toBe(provider1);
    expect(registry.peersOf(consumer1)).not.toContain(provider2);
  });

  it("resolves a host-bridge export view through its raw module's project", () => {
    const { registry, struct1, provider1, consumer1 } = twoProjects();
    // `_hostBridgeExportView` hands readers `Object.create(rawExports)`.
    expect(registry.decoderFor(struct1, Object.create(consumer1))).toBe(provider1);
  });

  it("keeps a re-registered module in its own project after a newer one opened", () => {
    const { registry, struct1, provider1, consumer1, provider2 } = twoProjects();
    // `wrapLinkedProviderValue` re-registers its provider, without a root, on
    // every crossing — possibly long after the next project opened.
    registry.registerModule(provider1);
    expect(registry.decoderFor(struct1, consumer1)).toBe(provider1);
    expect(registry.peersOf(provider2)).not.toContain(provider1);
  });

  it("answers a reader outside every project from the newest project", () => {
    const { registry, struct2, provider2 } = twoProjects();
    expect(registry.decoderFor(struct2, undefined)).toBe(provider2);
    expect(registry.decoderFor(struct2, fakeModule(new Set()))).toBe(provider2);
  });

  it("two live projects from one compiled result both read correctly, with no reset anywhere", async () => {
    // A REGRESSION GUARD through the public path, not a repro: #5364 measured
    // that a small provider never reaches the registry's cross-project arm
    // (only the Temporal polyfill's surface does), so this passes on base too.
    // It pins that scoping by project keeps the #5225 consumer-literal route and
    // the class identities right in BOTH projects — including the first one
    // after the second is instantiated, which a reset-on-instantiate would break.
    const root = mkdtempSync(join(tmpdir(), "issue-6790-"));
    const packageRoot = join(root, "node_modules", "box6790");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "box6790", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(
      join(packageRoot, "index.js"),
      `let built = 0;
       export class Box {
         constructor(v) { built = built + 1; this.v = v; }
         builtInThisModule() { return built; }
         addFrom(o) { return this.v + o.a + o.b; }
       }`,
    );
    const entry = join(root, "main.js");
    writeFileSync(
      entry,
      `import { Box } from "box6790";
       export function make(n) { return new Box(n); }
       export function theClass() { return Box; }
       export function instOf(b) { return b instanceof Box; }
       export function literalSum(b) { return b.addFrom({ a: 2, b: 5 }); }`,
    );
    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    expect(result.linkPlan?.mode, `fallbackReason=${result.linkPlan?.fallbackReason}`).toBe("separate");

    const instantiate = async (builds: number) => {
      const { instance } = await instantiateLinkedProject(result);
      const exports = instance.exports as unknown as Record<string, (arg?: unknown) => any>;
      let box: any;
      for (let i = 0; i < builds; i++) box = exports.make!(i + 1);
      return { exports, box };
    };
    const read = ({ exports, box }: Awaited<ReturnType<typeof instantiate>>) => ({
      instanceOf: Boolean(exports.instOf!(box)),
      constructorIsBox: box.constructor === exports.theClass!(),
      builtInThisModule: box.builtInThisModule(),
      literalSum: exports.literalSum!(box),
    });

    const first = await instantiate(3);
    const second = await instantiate(1);
    expect(read(second)).toEqual({ instanceOf: true, constructorIsBox: true, builtInThisModule: 1, literalSum: 8 });
    expect(read(first)).toEqual({ instanceOf: true, constructorIsBox: true, builtInThisModule: 3, literalSum: 10 });
  }, 300_000);
});

describe("#6790 — no process-wide name-keyed registry left in src/runtime/", () => {
  it("lists every module-level Map/Set, each with the reason it is not per-instance state", () => {
    const runtimeDir = fileURLToPath(new URL("../src/runtime/", import.meta.url));
    const files = (readdirSync(runtimeDir, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts"));
    const moduleLevel = /^(?:export )?(?:const|let|var) ([A-Za-z_$][\w$]*)(?: *:[^=]+)? *= *new (?:Map|Set)\b/;
    const found: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(join(runtimeDir, file), "utf8").split("\n")) {
        const match = moduleLevel.exec(line);
        if (match) found.push(`${file.replaceAll("\\", "/")}::${match[1]}`);
      }
    }
    expect(found.sort()).toEqual([
      // Memo of a compiler-emitted export-name CSV → its split list: the value
      // is a pure function of the key, so two instances can never disagree.
      "init-marshal-registry.ts::_classDispatchNameLists",
      // A constant list of method names, never written.
      "string-predicate-adapter.ts::HOST_STRING_SYMBOL_DISPATCH",
    ]);
  });
});
