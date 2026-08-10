#!/usr/bin/env node
/**
 * Refresh the landing-page ECMAScript edition catalog from TC39's canonical
 * finished-proposals table.
 *
 * The committed JSON is an offline fallback. Pages builds attempt a refresh,
 * but keep the last known-good artifact when GitHub is temporarily unavailable.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FINISHED_PROPOSALS_URL = "https://raw.githubusercontent.com/tc39/proposals/main/finished-proposals.md";

const OUTPUT_PATH = resolve(import.meta.dirname, "..", "website", "public", "es-edition-features.json");

export interface EsEditionFeature {
  name: string;
  edition: number;
  proposalUrl?: string;
}

interface EsEditionFeatureCatalog {
  source: string;
  updated: string;
  features: EsEditionFeature[];
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function cleanProposalName(markdown: string): string {
  return decodeHtml(markdown)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]+\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function referenceDefinitions(markdown: string): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const match of markdown.matchAll(/^\[([^\]]+)\]:\s*(\S+)\s*$/gm)) {
    definitions.set(match[1]!.toLowerCase(), match[2]!);
  }
  return definitions;
}

function proposalUrl(markdown: string, definitions: Map<string, string>): string | undefined {
  const inline = markdown.match(/\[[^\]]+\]\(([^)]+)\)/)?.[1];
  const reference = markdown.match(/\[[^\]]+\]\[([^\]]+)\]/)?.[1];
  const value = inline ?? (reference ? definitions.get(reference.toLowerCase()) : undefined);
  if (!value) return undefined;
  try {
    const parsed = new URL(value, FINISHED_PROPOSALS_URL);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function parseCompleteRow(row: string): string[] | null {
  const trimmed = row.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const columns = trimmed
    .slice(1, -1)
    .split("|")
    .map((column) => column.trim());
  return columns.length === 5 ? columns : null;
}

/** Parse the first table in finished-proposals.md without depending on a Markdown package. */
export function parseFinishedProposals(markdown: string): EsEditionFeature[] {
  const definitions = referenceDefinitions(markdown);
  const features: EsEditionFeature[] = [];
  let inTable = false;
  let sawFeature = false;
  let pending = "";

  const consume = (row: string): void => {
    const columns = parseCompleteRow(row);
    if (!columns) return;
    const year = Number(columns[4]);
    if (!Number.isInteger(year) || year < 2016 || year > 9999) return;
    const name = cleanProposalName(columns[0]!);
    if (!name) return;
    const url = proposalUrl(columns[0]!, definitions);
    features.push({ name, edition: year, ...(url ? { proposalUrl: url } : {}) });
    sawFeature = true;
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (!inTable) {
      if (/^\|\s*Proposal\s*\|.*Expected Publication Year\s*\|\s*$/.test(line)) inTable = true;
      continue;
    }

    if (/^\|\s*:?-+/.test(line)) continue;
    if (line.trim() === "") {
      if (pending) consume(pending);
      if (sawFeature) break;
      pending = "";
      continue;
    }

    if (line.trimStart().startsWith("|")) {
      if (pending) consume(pending);
      pending = line.trim();
    } else if (pending) {
      // A few upstream cells contain a literal newline (for example an author
      // name). Join it back before splitting the Markdown row.
      pending += ` ${line.trim()}`;
    }

    if (pending.endsWith("|") && parseCompleteRow(pending)) {
      consume(pending);
      pending = "";
    }
  }
  if (pending) consume(pending);

  const unique = new Map<string, EsEditionFeature>();
  for (const feature of features) unique.set(`${feature.edition}\0${feature.name}`, feature);
  return [...unique.values()];
}

function readExisting(): EsEditionFeatureCatalog | null {
  if (!existsSync(OUTPUT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) as EsEditionFeatureCatalog;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const existing = readExisting();
  let markdown: string;
  try {
    const response = await fetch(FINISHED_PROPOSALS_URL, {
      headers: { "user-agent": "js2wasm-es-edition-catalog" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    markdown = await response.text();
  } catch (error) {
    if (existing?.features?.length) {
      console.warn(
        `[sync-es-edition-features] TC39 refresh unavailable; keeping ${existing.features.length} cached feature(s): ${(error as Error).message}`,
      );
      return;
    }
    throw error;
  }

  const features = parseFinishedProposals(markdown);
  if (features.length < 50) {
    throw new Error(
      `TC39 finished-proposals parse returned only ${features.length} feature(s); refusing to replace cache.`,
    );
  }

  const unchanged =
    existing?.source === FINISHED_PROPOSALS_URL && JSON.stringify(existing.features) === JSON.stringify(features);
  if (unchanged) {
    console.log(`[sync-es-edition-features] Current (${features.length} features).`);
    return;
  }

  const catalog: EsEditionFeatureCatalog = {
    source: FINISHED_PROPOSALS_URL,
    updated: new Date().toISOString(),
    features,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`[sync-es-edition-features] Wrote ${features.length} feature(s) to ${OUTPUT_PATH}.`);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[sync-es-edition-features] ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
