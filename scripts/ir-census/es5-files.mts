// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The ES5 file list of the IR-only census (plan/log/es5-ir-only-census-*.md).
 *
 * ES5 = the edition ratchet's classifier, `classifyEdition(...) === 5`, over
 * every `test262/test/**.js` file except `_FIXTURE` helpers. The list is
 * shuffled with a seeded mulberry32 Fisher-Yates (seed 7106), so a census cut
 * short still samples every directory. Paths are relative to `test262/test/`.
 *
 *   npx tsx scripts/ir-census/es5-files.mts [--out .tmp/ir-census/es5-files.txt]
 */
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyEdition, parseFrontmatter } from "../generate-editions.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_ROOT = join(REPO_ROOT, "test262/test");
const SEED = 7106;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (name.endsWith(".js") && !name.includes("_FIXTURE")) out.push(path);
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function es5Files(): string[] {
  const files = walk(TEST_ROOT, [])
    .filter((path) => classifyEdition(parseFrontmatter(path), path) === 5)
    .map((path) => relative(TEST_ROOT, path));
  const random = mulberry32(SEED);
  for (let i = files.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [files[i], files[j]] = [files[j]!, files[i]!];
  }
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--out");
  const out = resolve(index >= 0 ? process.argv[index + 1]! : ".tmp/ir-census/es5-files.txt");
  const files = es5Files();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${files.join("\n")}\n`);
  console.error(`es5-files: ${files.length} files -> ${out}`);
}
