// The landing page shows the source of every benchmark it charts — the WASI
// host group always did; the JavaScript host group did not, so its four bars
// (`fib`, `loop`, `string`, `array`) were unattributed numbers.
//
// Inlining source into index.html is only honest if it cannot drift from the
// file that is actually compiled and timed. These tests pin that: each snippet
// must appear VERBATIM in its source file, and every charted benchmark must
// have a snippet.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname ?? ".", "..");
const INDEX_HTML = join(ROOT, "website", "index.html");
const BENCH_DIR = join(ROOT, "website", "playground", "examples", "benchmarks");
const SIDEBAR_JSON = join(ROOT, "benchmarks", "results", "playground-benchmark-sidebar.json");

const html = readFileSync(INDEX_HTML, "utf-8");

/** Undo the HTML entities the inlined <pre> blocks must use. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The `<pre>` body of each `data-test="<id>"` group in the JS-host section. */
function inlinedSources(): Map<string, string> {
  const out = new Map<string, string>();
  const section = html.slice(
    html.indexOf('<h3 class="host-bench-title">JavaScript host</h3>'),
    html.indexOf('<h3 class="host-bench-title">WASI host</h3>'),
  );
  expect(section.length, "JavaScript host section not found").toBeGreaterThan(0);

  for (const m of section.matchAll(
    /data-test="([^"]+)"[\s\S]*?<pre class="how-code js">\n([\s\S]*?)<\/pre\s*\n?\s*>/g,
  )) {
    out.set(m[1], unescapeHtml(m[2]));
  }
  return out;
}

describe("landing page — JavaScript host benchmark sources", () => {
  it("shows a source block for every charted benchmark", () => {
    const charted = (JSON.parse(readFileSync(SIDEBAR_JSON, "utf-8")) as Array<{ path: string }>).map((r) =>
      r.path.replace(/^examples\/benchmarks\//, "").replace(/\.ts$/, ""),
    );
    expect(charted.length).toBeGreaterThan(0);

    const shown = inlinedSources();
    for (const id of charted) {
      expect(shown.has(id), `no source block for charted benchmark "${id}"`).toBe(true);
    }
  });

  it("inlines the measured kernel verbatim from its source file", () => {
    const shown = inlinedSources();
    expect(shown.size).toBeGreaterThan(0);

    for (const [id, snippet] of shown) {
      const file = join(BENCH_DIR, `${id}.ts`);
      expect(existsSync(file), `${id}.ts missing from ${BENCH_DIR}`).toBe(true);
      const source = readFileSync(file, "utf-8");

      // Verbatim, not merely similar — a paraphrased benchmark is a lie about
      // what was measured.
      expect(
        source.includes(snippet.trim()),
        `the source shown on the landing page for "${id}" is not present verbatim in ${id}.ts`,
      ).toBe(true);
    }
  });

  it("shows the exported function the harness actually times", () => {
    // The generator times one named export per file; showing any other function
    // would misattribute the measurement.
    const generator = readFileSync(join(ROOT, "scripts", "generate-playground-benchmark-sidebar.mjs"), "utf-8");
    const shown = inlinedSources();

    for (const [id, snippet] of shown) {
      const entry = new RegExp(`examples/benchmarks/${id}\\.ts["'][^}]*exportName:\\s*["']([^"']+)["']`).exec(
        generator,
      );
      expect(entry, `generator has no entry for ${id}.ts`).not.toBeNull();
      const exportName = entry?.[1] ?? "";
      expect(snippet, `source for "${id}" omits the timed export ${exportName}`).toContain(`function ${exportName}(`);
    }
  });

  it("does not show the playground DOM scaffolding as if it were measured", () => {
    // Each benchmark file also exports main() to draw the playground card. It
    // is compiled but never timed, so including it would overstate the kernel.
    for (const [id, snippet] of inlinedSources()) {
      expect(snippet, `source for "${id}" includes untimed main() scaffolding`).not.toContain("export function main(");
    }
  });
});
