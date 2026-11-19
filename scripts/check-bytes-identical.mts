// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7350 B2c) Byte-identity check for a pure move: compile a list of test262 files exactly as the runner
 * assembles them (`assembleOriginalHarness`), on several targets, and record a hash of each binary. Run it on
 * the base tree and on the change, then compare.
 *
 *   npx tsx scripts/check-bytes-identical.mts hash --files <list> --out <rows.jsonl> \
 *     [--targets default,standalone,linear] [--shard i/N]
 *   npx tsx scripts/check-bytes-identical.mts compare <base.jsonl> <head.jsonl>
 *
 * `<list>` holds test262 paths relative to `test262/` (`test/built-ins/...`), one per line. A file the runner
 * skips is recorded as skipped; a compile that fails records its first error, so a change that turns a compile
 * into a failure (or back) counts as a difference. `compare` exits 1 when any row differs or is missing.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TREE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Target = "default" | "standalone" | "linear";

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function hash(argv: readonly string[]): Promise<void> {
  const list = flag(argv, "--files");
  const out = flag(argv, "--out");
  if (!list || !out) throw new Error("hash needs --files and --out");
  const targets = (flag(argv, "--targets") ?? "default,standalone,linear").split(",") as Target[];
  const [shard, shards] = (flag(argv, "--shard") ?? "0/1").split("/").map(Number) as [number, number];
  const { compile } = await import(join(TREE, "src/index.ts"));
  const runner = await import(join(TREE, "tests/test262-runner.ts"));
  const harness = await import(join(TREE, "tests/test262-original-harness.ts"));
  const files = readFileSync(list, "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((_, index) => index % shards === shard);
  writeFileSync(out, "");
  for (const file of files) {
    const path = join(TREE, "test262", file);
    const source = readFileSync(path, "utf8");
    const meta = runner.parseMeta(source);
    if (!meta.negative && runner.shouldSkip(source, meta, path)?.skip) {
      appendFileSync(out, `${JSON.stringify({ file, skip: true })}\n`);
      continue;
    }
    const assembled = harness.assembleOriginalHarness(source, meta).primary.source;
    for (const target of targets) {
      const options =
        target === "linear"
          ? { ...runner.originalHarnessCompileOptions(meta, undefined), target: "linear" }
          : runner.originalHarnessCompileOptions(meta, target === "standalone" ? "standalone" : undefined);
      let result: string;
      try {
        const compiled = await compile(assembled, { ...options, fileName: path });
        result = compiled.success
          ? createHash("sha1").update(compiled.binary).digest("hex")
          : `fail:${String(compiled.errors?.[0]?.message ?? "").slice(0, 120)}`;
      } catch (error) {
        result = `threw:${String((error as Error).message).slice(0, 120)}`;
      }
      appendFileSync(out, `${JSON.stringify({ file, target, result })}\n`);
    }
  }
}

function compare(basePath: string, headPath: string): number {
  const rows = (path: string) =>
    new Map(
      readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { file: string; target?: string; result?: string; skip?: true })
        .map((row) => [`${row.file} ${row.target ?? "skip"}`, row.result ?? "skip"]),
    );
  const base = rows(basePath);
  const head = rows(headPath);
  const differing = [...base].filter(([key, value]) => head.get(key) !== value).map(([key]) => key);
  const missing = [...head.keys()].filter((key) => !base.has(key));
  console.log(`compared ${base.size} rows: ${differing.length} differ, ${missing.length} only in head`);
  for (const key of [...differing, ...missing].slice(0, 40)) console.log(`  ${key}`);
  return differing.length + missing.length === 0 ? 0 : 1;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "hash") await hash(rest);
else if (mode === "compare") process.exit(compare(rest[0]!, rest[1]!));
else {
  console.error("usage: check-bytes-identical.mts hash|compare …");
  process.exit(2);
}
