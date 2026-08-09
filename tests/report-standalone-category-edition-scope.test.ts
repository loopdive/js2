// The report page's STANDALONE view must honour the edition slider in its
// category table.
//
// Observed symptom: selecting ES2026 in the standalone tab still listed
// `built-ins/Temporal` — 4,603 proposal tests — as a category row. Temporal is
// not in any published edition.
//
// Root cause: a different code path from the host-side Error Patterns leak
// (see report-error-patterns-edition-scope.test.ts). The standalone view was
// constructed with `categoryEditions: null`, so `computeAllowedCategories`
// bailed out and returned null, which `applyFilters` reads as "no edition
// filter at all" — every standalone category row stayed visible at every
// slider position. The host view was unaffected because it was passed the map.
//
// The map is legitimately shared: an edition is a property of the test file's
// frontmatter, not of the compile target, and the filter reads only the map's
// edition KEYS, never its host pass/fail counts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname ?? ".", "..");
const REPORT_HTML = join(ROOT, "website", "public", "benchmarks", "report.html");
const RESULTS = join(ROOT, "website", "public", "benchmarks", "results");
const CATEGORY_EDITIONS = join(RESULTS, "test262-category-editions.json");
const STANDALONE_REPORT = join(RESULTS, "test262-standalone-report.json");

const html = readFileSync(REPORT_HTML, "utf-8");

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found in report.html`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      seen = true;
    } else if (source[i] === "}") {
      depth--;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

/**
 * Build the page's REAL `computeAllowedCategories` as a callable, supplying the
 * two things it closes over (`computeAllowedEditions` and `view`). Running the
 * literal source keeps this test honest if the rule is ever edited.
 */
function buildAllowedCategories(
  source: string,
): (allowedEditions: Set<string> | null, categoryEditions: unknown) => Set<string> | null {
  const body = `
    return function (allowedEditions, categoryEditions) {
      const view = { categoryEditions };
      const computeAllowedEditions = () => allowedEditions;
      ${extractFunction(source, "computeAllowedCategories")}
      return computeAllowedCategories();
    };
  `;
  return new Function(body)() as ReturnType<typeof buildAllowedCategories>;
}

/**
 * Evaluate the standalone view's LITERAL `categoryEditions:` expression, so a
 * data-level assertion exercises the real wiring instead of assuming a map was
 * passed. With the bug present this returns null and the filter goes inert.
 */
function buildStandaloneCategoryEditions(source: string): (categoryEditions: unknown) => unknown {
  const at = source.indexOf('mode: "standalone"');
  expect(at, "standalone view not found").toBeGreaterThanOrEqual(0);
  const expr = /categoryEditions:\s*([^,\n]+),/.exec(source.slice(at, source.indexOf("}", at)));
  expect(expr, "standalone view has no categoryEditions field").not.toBeNull();
  return new Function(`return function (categoryEditions) { return (${expr?.[1]}); };`)() as (
    categoryEditions: unknown,
  ) => unknown;
}

describe("report page standalone view — category edition scoping", () => {
  it("passes the shared category×edition map to the standalone view", () => {
    const standalone = html.slice(html.indexOf('mode: "standalone"'));
    const wiring = standalone.slice(0, standalone.indexOf("}"));
    // `categoryEditions: null` is the bug: it disables the filter entirely
    // rather than narrowing it.
    expect(wiring).not.toMatch(/categoryEditions:\s*null/);
    expect(wiring).toMatch(/categoryEditions:\s*categoryEditions\s*\|\|\s*null/);
  });

  it("reads only edition keys from the map, never host counts", () => {
    // This is what makes sharing the host-derived map sound. If the filter ever
    // starts summing counts, the standalone view would be reporting host
    // numbers and this sharing would no longer be safe.
    const src = extractFunction(html, "computeAllowedCategories");
    expect(src).toContain("Object.keys(byEdition).some");
  });

  it("returns null (no filter) only when there is no edition selection", () => {
    const compute = buildAllowedCategories(html);
    const map = { "built-ins/Array": { ES5: 10 }, "built-ins/Temporal": { Proposals: 4603 } };

    // Slider at overall → no edition filter, everything visible. That is the
    // legitimate null, and it must survive.
    expect(compute(null, map)).toBeNull();

    // An edition IS selected and a map is present → a real filter.
    const allowed = compute(new Set(["ES5", "ES2026"]), map);
    expect(allowed).toBeInstanceOf(Set);
    expect(allowed?.has("built-ins/Array")).toBe(true);
    expect(allowed?.has("built-ins/Temporal")).toBe(false);
  });

  it("hides every proposal-only category under a published edition", () => {
    if (!existsSync(CATEGORY_EDITIONS) || !existsSync(STANDALONE_REPORT)) return;

    const compute = buildAllowedCategories(html);
    const map = JSON.parse(readFileSync(CATEGORY_EDITIONS, "utf-8")) as Record<string, Record<string, unknown>>;
    const standalone = JSON.parse(readFileSync(STANDALONE_REPORT, "utf-8")) as {
      categories?: Array<{ name: string }>;
    };
    const categories = standalone.categories ?? [];
    expect(categories.length).toBeGreaterThan(10);

    // Widest published selection the slider can make.
    const published = new Set<string>();
    for (const byEdition of Object.values(map)) {
      for (const ed of Object.keys(byEdition)) {
        if (/^ES(\d{4}|5|3 \/ Core|[12])$/.test(ed)) published.add(ed);
      }
    }
    // Route the map through the standalone view's own wiring — with the bug
    // present this yields null and every row below stays visible.
    const asWired = buildStandaloneCategoryEditions(html)(map);
    const allowed = compute(published, asWired);
    expect(allowed, "standalone view produced no category filter").toBeInstanceOf(Set);

    const visible = categories.map((c) => c.name).filter((name) => allowed?.has(name));
    // The headline symptom.
    expect(visible).not.toContain("built-ins/Temporal");
    // …and no other proposal-scope category rides along.
    expect(visible).not.toContain("built-ins/AbstractModuleSource");
    // The filter must narrow, not blank the table.
    expect(visible.length).toBeGreaterThan(categories.length / 2);
  });
});
