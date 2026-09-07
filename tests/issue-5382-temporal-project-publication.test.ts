// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const source = "export const Temporal = { marker: 'π' };\n";
const entry = "__js2wasm_temporal_entry.js";
const pkg = "node_modules/@js-temporal/polyfill";
const expected = {
  [`${pkg}/package.json`]: Buffer.from(
    JSON.stringify({ name: "@js-temporal/polyfill", version: "0.0.0-linked", main: "index.js" }),
  ).toString("hex"),
  [`${pkg}/index.js`]: Buffer.from(source).toString("hex"),
  [entry]: Buffer.from(
    'import { Temporal } from "@js-temporal/polyfill";\nexport function __js2wasm_temporal_probe() { return typeof Temporal; }\n',
  ).toString("hex"),
};
const root = fs.mkdtempSync(path.join(tmpdir(), "issue-5382-"));
const bundle = path.join(root, "provider.mjs");
const fixture = path.join(import.meta.dirname, "fixtures/issue-5382-temporal-publication-child.mjs");
type Outcome = {
  ok: boolean;
  finalRoot: string;
  stage?: string;
  paused: boolean;
  error?: { message: string; code?: string; cause?: unknown; errors?: unknown[] };
  events: Array<{ op: string; path: string; destination?: string }>;
  consumed: Array<{ entry: string; files: Record<string, string>; options: Record<string, unknown> }>;
  reads: Array<{ path: string; hex: string }>;
  memoryEvents: number;
  memory?: { cacheHit: boolean };
  key?: string;
  provider?: {
    cacheHit: boolean;
    namespace: string;
    getterField: string;
    cacheKey: string;
    bytes: number;
    sha256: string;
    exportBoundaries: unknown;
    exports: string[];
  };
};
let serial = 0;
const cache = () => path.join(root, `cache-${serial++}`);

function child(cacheDir: string, extra: Record<string, unknown> = {}) {
  const process = spawn(
    globalThis.process.execPath,
    [
      `--max-old-space-size=${extra.real ? 768 : 192}`,
      fixture,
      JSON.stringify({ bundle, cacheDir, polyfillSource: source, ...extra }),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  let outcome: Outcome | undefined;
  let reached = false;
  let acknowledge!: (value: { stage: string }) => void;
  let rejectBarrier!: (error: Error) => void;
  const ready = new Promise<{ stage: string }>((resolve, reject) => {
    acknowledge = resolve;
    rejectBarrier = reject;
  });
  // Tests without a barrier only await completion; retain rejection visibility there.
  void ready.catch(() => {});
  const timer = setTimeout(() => process.stdin.end(), extra.real ? 120000 : 15000);
  process.stderr.on("data", (data) => {
    stderr += data;
  });
  createInterface({ input: process.stdout }).on("line", (line) => {
    if (!line.startsWith("{")) {
      stderr += `${line}\n`;
      return;
    }
    const message = JSON.parse(line);
    if (message.barrier) {
      reached = true;
      acknowledge(message);
    } else outcome = message;
  });
  const done = new Promise<Outcome>((resolve, reject) => {
    process.on("error", reject);
    process.on("close", (code) => {
      clearTimeout(timer);
      if (!reached) rejectBarrier(new Error(`Barrier not reached: ${stderr} ${JSON.stringify(outcome)}`));
      if (code !== 0 || !outcome) reject(new Error(`child exit=${code}: ${stderr}`));
      else resolve(outcome);
    });
  });
  return { ready, done, release: () => process.stdin.end("x"), abandon: () => process.stdin.end() };
}

function complete(out: Outcome) {
  expect(out.ok, JSON.stringify(out.error)).toBe(true);
  expect(out.consumed).toHaveLength(1);
  expect(out.consumed[0].entry).toBe(path.join(out.finalRoot, entry));
  expect(out.consumed[0].entry).not.toContain(".staging-");
  expect(out.consumed[0].files).toEqual(expected);
}
function untouched(out: Outcome) {
  expect(
    out.events.filter(
      (event) =>
        ["writeFileSync", "openSync", "truncateSync", "renameSync", "rmSync", "mkdirSync"].includes(event.op) &&
        (event.path.startsWith(out.finalRoot) || event.destination?.startsWith(out.finalRoot)),
    ),
  ).toEqual([]);
}
beforeAll(async () => {
  await build({
    stdin: {
      contents:
        'export * from "./src/temporal-provider.ts"; export { getDefaultEnvironment, setDefaultEnvironment } from "./src/env.ts";',
      resolveDir: path.join(import.meta.dirname, ".."),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    plugins: [
      {
        name: "issue5382-compile-observer",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/index\.js$/ }, (args) =>
            args.importer.endsWith("temporal-provider.ts")
              ? { path: "compile-observer", namespace: "issue5382" }
              : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: "issue5382" }, () => ({
            contents:
              "export const compileProject = (...args) => globalThis.__issue5382Compile(...args); export const compileMulti = () => { throw Error('unused'); };",
          }));
        },
      },
    ],
  });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Opt-in because the pinned polyfill cold compile needs the team's heavy-test
// slot. The baseline must export the unchanged builder and environment seam.
it.skipIf(!process.env.ISSUE5382_BASELINE_BUNDLE)(
  "#5382 real linked-provider migration and old/new interleaving",
  { timeout: 300000 },
  async () => {
    const realBundle = path.join(root, "real-provider.mjs");
    const repo = path.join(import.meta.dirname, "..");
    await build({
      stdin: {
        contents:
          'export * from "./src/temporal-provider.ts"; export { getDefaultEnvironment, setDefaultEnvironment } from "./src/env.ts";',
        resolveDir: repo,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile: realBundle,
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    });
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"));
    const { loadTemporalPolyfillSource, writeTemporalPrewarmStamp, readTemporalPrewarmStamp } =
      await import("../scripts/test262-temporal.mjs");
    const polyfillSource = await loadTemporalPolyfillSource();
    const sourceFile = path.join(root, "polyfill.js");
    fs.writeFileSync(sourceFile, polyfillSource);
    const dir = cache();
    const oldConfig = { real: true, sourceFile, legacy: true, bundle: process.env.ISSUE5382_BASELINE_BUNDLE };
    const newConfig = { real: true, sourceFile, bundle: realBundle };
    const before = await child(dir, oldConfig).done;
    expect(before.ok, JSON.stringify(before.error)).toBe(true);
    expect(before.provider?.cacheHit).toBe(false);
    const metadata = () =>
      Object.fromEntries(
        Object.keys(expected).map((relative) => {
          const file = path.join(before.finalRoot, relative);
          const stat = fs.statSync(file);
          return [
            relative,
            { hex: fs.readFileSync(file).toString("hex"), mtime: stat.mtimeMs, ctime: stat.ctimeMs, ino: stat.ino },
          ];
        }),
      );
    const legacyBefore = metadata();
    const refs = () =>
      Object.fromEntries(
        fs
          .readdirSync(path.join(dir, "providers"))
          .filter((name) => name.endsWith(".ref.json"))
          .map((name) => [name, fs.readFileSync(path.join(dir, "providers", name), "utf8")]),
      );
    const refBefore = refs();
    expect(Object.keys(refBefore).length).toBeGreaterThan(0);
    writeTemporalPrewarmStamp(dir, {
      key: before.key,
      namespace: before.provider!.namespace,
      bytes: before.provider!.bytes,
    });
    const stampBefore = fs.readFileSync(path.join(dir, "prewarm.json"));
    const after = await child(dir, newConfig).done;
    expect(after.ok, JSON.stringify(after.error)).toBe(true);
    expect(after.provider?.cacheHit).toBe(true);
    expect(after.key).toBe(before.key);
    expect(readTemporalPrewarmStamp(dir)?.key).toBe(after.key);
    expect(fs.readFileSync(path.join(dir, "prewarm.json"))).toEqual(stampBefore);
    expect(after.provider).toEqual({ ...before.provider, cacheHit: true });
    expect(metadata()).toEqual(legacyBefore);
    expect(refs()).toEqual(refBefore);
    expect(after.finalRoot).not.toBe(before.finalRoot);
    const interleavings = [];
    for (const file of [entry, "index.js"]) {
      const reader = child(dir, { ...newConfig, barrier: `read:${file}`, compilerRead: true });
      await reader.ready;
      const old = await child(dir, oldConfig).done;
      expect(old.ok, JSON.stringify(old.error)).toBe(true);
      expect(old.provider?.cacheHit).toBe(true);
      expect(old.events.some((event) => event.op === "writeFileSync" && event.path.startsWith(before.finalRoot))).toBe(
        true,
      );
      reader.release();
      const result = await reader.done;
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(result.paused).toBe(true);
      expect(result.provider).toEqual(after.provider);
      untouched(result);
      for (const read of result.reads.filter((read) => read.path.startsWith(result.finalRoot))) {
        expect(read.hex).toBe(fs.readFileSync(read.path).toString("hex"));
      }
      expect(result.reads.length).toBeGreaterThanOrEqual(3);
      interleavings.push({
        file,
        provider: result.provider,
        reads: result.reads.map((read) => ({
          path: read.path,
          bytes: read.hex.length / 2,
          sha256: createHash("sha256").update(Buffer.from(read.hex, "hex")).digest("hex"),
        })),
      });
    }
    const report = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      baselineBundle: process.env.ISSUE5382_BASELINE_BUNDLE,
      sourceSha256: createHash("sha256").update(polyfillSource).digest("hex"),
      key: after.key,
      before: before.provider,
      after: after.provider,
      sourceRefs: refBefore,
      interleavings,
    };
    console.log("issue5382 real migration:", JSON.stringify(report));
    if (process.env.ISSUE5382_REPORT) fs.writeFileSync(process.env.ISSUE5382_REPORT, JSON.stringify(report, null, 2));
  },
);

describe("#5382 complete immutable source publication (stubbed compiler, real filesystem and processes)", () => {
  for (const file of ["package.json", "index.js", entry])
    it(`cold writer paused after ${file} loses to a complete winner`, async () => {
      const dir = cache();
      const a = child(dir, { barrier: `write:${file}` });
      const { stage } = await a.ready;
      const b = await child(dir).done;
      complete(b);
      a.release();
      const loser = await a.done;
      complete(loser);
      expect(loser.paused).toBe(true);
      expect(loser.finalRoot).toBe(b.finalRoot);
      expect(fs.existsSync(stage)).toBe(false);
      expect(loser.events.filter((e) => e.op === "rmSync").map((e) => e.path)).toEqual([stage]);
    });

  for (const winner of ["a", "b"])
    it(`two verified contenders, ${winner} publishes first`, async () => {
      const dir = cache();
      const a = child(dir, { barrier: "rename" });
      const b = child(dir, { barrier: "rename" });
      const [sa, sb] = await Promise.all([a.ready, b.ready]);
      const first = winner === "a" ? a : b;
      const second = winner === "a" ? b : a;
      first.release();
      const won = await first.done;
      complete(won);
      second.release();
      const lost = await second.done;
      complete(lost);
      expect(won.events.filter((e) => e.op === "rmSync")).toEqual([]);
      expect(lost.events.filter((e) => e.op === "rmSync").map((e) => e.path)).toEqual([
        winner === "a" ? sb.stage : sa.stage,
      ]);
    });

  for (const file of [entry, "index.js"])
    it(`warm reader at ${file} cannot be truncated by a warm initializer`, async () => {
      const dir = cache();
      complete(await child(dir).done);
      const a = child(dir, { barrier: `read:${file}`, compilerRead: true });
      await a.ready;
      const b = await child(dir).done;
      complete(b);
      untouched(b);
      a.release();
      const reader = await a.done;
      complete(reader);
      untouched(reader);
      expect(reader.paused).toBe(true);
    });

  const corruptions: Record<string, (directory: string) => void> = {
    "missing entry": (d) => fs.unlinkSync(path.join(d, entry)),
    "missing polyfill": (d) => fs.unlinkSync(path.join(d, pkg, "index.js")),
    "truncated entry": (d) => fs.truncateSync(path.join(d, entry)),
    "truncated polyfill": (d) => fs.truncateSync(path.join(d, pkg, "index.js")),
    "wrong metadata": (d) => fs.writeFileSync(path.join(d, pkg, "package.json"), "{}"),
    "same length wrong bytes": (d) =>
      fs.writeFileSync(path.join(d, entry), Buffer.alloc(Buffer.from(expected[entry], "hex").length, 120)),
    "empty root": (d) => {
      fs.rmSync(d, { recursive: true });
      fs.mkdirSync(d);
    },
    "symlink file": (d) => {
      fs.unlinkSync(path.join(d, entry));
      fs.symlinkSync(path.join(d, pkg, "index.js"), path.join(d, entry));
    },
    "symlink package": (d) => {
      fs.renameSync(path.join(d, pkg), path.join(d, "saved"));
      fs.symlinkSync(path.join(d, "saved"), path.join(d, pkg));
    },
    "symlink root": (d) => {
      fs.renameSync(d, `${d}-saved`);
      fs.symlinkSync(`${d}-saved`, d);
    },
  };
  for (const [name, corrupt] of Object.entries(corruptions))
    it(`rejects and preserves observed ${name}`, async () => {
      const dir = cache();
      const initial = await child(dir).done;
      complete(initial);
      corrupt(initial.finalRoot);
      const result = await child(dir).done;
      expect(result.ok).toBe(false);
      expect(result.consumed).toEqual([]);
      untouched(result);
      expect(fs.lstatSync(initial.finalRoot)).toBeDefined();
    });

  for (const empty of [false, true])
    it(`handles ${empty ? "empty" : "corrupt nonempty"} destination inserted before rename`, async () => {
      const dir = cache();
      const a = child(dir, { barrier: "rename" });
      const { stage } = await a.ready;
      const final = path.join(dir, path.basename(stage).slice(1).split(".staging-")[0]);
      fs.mkdirSync(final);
      if (!empty) fs.writeFileSync(path.join(final, "foreign"), "preserve");
      a.release();
      const result = await a.done;
      if (empty && result.ok) complete(result);
      else {
        expect(result.ok).toBe(false);
        expect(result.consumed).toEqual([]);
        expect(result.error).toBeDefined();
      }
      if (!empty) expect(fs.readFileSync(path.join(final, "foreign"), "utf8")).toBe("preserve");
      expect(fs.existsSync(stage)).toBe(false);
    });

  for (const fault of [
    { op: "mkdtempSync" },
    { op: "mkdirSync", where: ".staging-" },
    { op: "writeFileSync", where: ".staging-" },
    { op: "readFileSync", where: ".staging-" },
    { op: "renameSync", code: "EXDEV" },
    { op: "renameSync", code: "EACCES" },
  ])
    it(`preserves ${fault.op}/${fault.code ?? "EACCES"} and cleans only owned stage`, async () => {
      const dir = cache();
      fs.mkdirSync(dir);
      const sibling = fs.mkdtempSync(path.join(dir, ".temporal-project-v2-sibling.staging-"));
      const result = await child(dir, { fault }).done;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(fault.code ?? "EACCES");
      expect(result.consumed).toEqual([]);
      expect(fs.existsSync(sibling)).toBe(true);
      expect(result.events.filter((e) => e.op === "rmSync").every((e) => e.path === result.stage)).toBe(true);
      if (result.stage) expect(fs.existsSync(result.stage)).toBe(false);
    });

  it("preserves primary and cleanup errors together", async () => {
    const result = await child(cache(), { fault: { op: "writeFileSync" }, cleanupFailure: true }).done;
    expect(result.ok).toBe(false);
    expect(result.error?.cause).toMatchObject({ message: "injected writeFileSync" });
    expect(result.error?.errors).toHaveLength(2);
    expect(result.consumed).toEqual([]);
    expect(fs.existsSync(result.stage!)).toBe(true);
  });

  it("cleanup failure after a valid winner remains a failure", async () => {
    const dir = cache();
    const a = child(dir, { barrier: "rename", cleanupFailure: true });
    await a.ready;
    complete(await child(dir).done);
    a.release();
    const result = await a.done;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("injected cleanup");
    expect(result.consumed).toEqual([]);
    expect(fs.existsSync(result.stage!)).toBe(true);
  });

  it("warm verification read failure is not a miss", async () => {
    const dir = cache();
    complete(await child(dir).done);
    const result = await child(dir, { fault: { op: "readFileSync" } }).done;
    expect(result.error?.code).toBe("EACCES");
    expect(result.consumed).toEqual([]);
    untouched(result);
  });

  it("compile failure leaves the published tree reusable in a fresh process", async () => {
    const dir = cache();
    const failed = await child(dir, { compileFailure: true }).done;
    expect(failed.error?.message).toBe("injected compile failure");
    expect(fs.existsSync(failed.finalRoot)).toBe(true);
    const retry = await child(dir, { memory: true }).done;
    complete(retry);
    untouched(retry);
    expect(retry.memoryEvents).toBe(0);
    expect(retry.memory?.cacheHit).toBe(true);
  });

  it("failed compilation does not poison the attached process memory cache", async () => {
    const result = await child(cache(), { retryCompile: true, memory: true }).done;
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(result.consumed).toHaveLength(2);
    expect(result.consumed[0]).toEqual(result.consumed[1]);
    expect(result.memoryEvents).toBe(0);
    expect(result.memory?.cacheHit).toBe(true);
  });

  it("ignores abandoned private staging trees", async () => {
    const dir = cache();
    const dead = await child(dir, { abandonStage: true }).done;
    expect(dead.ok).toBe(false);
    expect(dead.consumed).toEqual([]);
    const abandoned = dead.stage!;
    const before = fs.readFileSync(path.join(abandoned, pkg, "package.json"));
    complete(await child(dir).done);
    expect(fs.readFileSync(path.join(abandoned, pkg, "package.json"))).toEqual(before);
    expect(fs.existsSync(path.join(abandoned, entry))).toBe(false);
  });

  it("preserves the existing length-prefixed identity and separates every fingerprinted option", async () => {
    const dir = cache();
    const cases = [
      {},
      { target: "wasi" },
      { fast: true },
      { nativeStrings: true },
      { utf8Storage: true },
      { semanticProviders: "native-first" },
      { hostBridge: "off" },
      { platform: "node" },
    ];
    const roots = new Set<string>();
    for (const compileOptions of cases) {
      const result = await child(dir, { compileOptions }).done;
      complete(result);
      const options = {
        target: "gc",
        fast: false,
        nativeStrings: false,
        utf8Storage: false,
        semanticProviders: "auto",
        hostBridge: "auto",
        platform: "web",
        ...compileOptions,
      };
      const hash = createHash("sha256");
      for (const part of [source, JSON.stringify(options)]) hash.update(`${part.length}:${part}\n`);
      expect(path.basename(result.finalRoot)).toBe(`temporal-project-v2-${hash.digest("hex")}`);
      expect(result.consumed[0].options).toMatchObject({
        ...compileOptions,
        allowJs: true,
        emitWat: false,
        skipSemanticDiagnostics: true,
        packageCacheDir: path.join(dir, "providers"),
      });
      roots.add(result.finalRoot);
    }
    expect(roots.size).toBe(cases.length);
    const changed = await child(dir, { polyfillSource: `${source}\n` }).done;
    expect(changed.ok).toBe(true);
    expect(roots.has(changed.finalRoot)).toBe(false);
  });
});
