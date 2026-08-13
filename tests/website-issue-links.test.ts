// Issue references on the website must link to THIS project's markdown issues,
// never to github.com/<repo>/issues/<id>.
//
// Why this matters more than a normal broken link: the repo has no GitHub
// issues at all, and — per CLAUDE.md — issue ids share ONE number sequence with
// pull requests. So github.com/loopdive/js2wasm/issues/661 does not 404. GitHub
// redirects it to PR #661, an unrelated page that looks entirely legitimate.
// Measured before this fix:
//   report.html  #661  "Temporal proposal/polyfill gap"
//                      -> PR "docs(#1632): escalate Function.bind/toString"
//   npm-compat   #1031 (lodash)
//                      -> PR "feat(number): add standalone integer radix toString"
//   npm-compat   #1710 (acorn)
//                      -> PR "fix(#6408): standalone object-literal data/method keys"
// Nothing on the page signals the mismatch, which is why it went unnoticed.
//
// The correct target is the dashboard's markdown viewer, which already resolves
// a bare id (including suffixed ids like 1326c) through plan/issues/index.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname ?? ".", "..");
const REPORT_HTML = join(ROOT, "website", "public", "benchmarks", "report.html");
const NPM_CHART = join(ROOT, "website", "components", "npm-compat-chart.js");
const ISSUE_VIEWER = join(ROOT, "website", "dashboard", "issue.html");

const read = (p: string) => readFileSync(p, "utf-8");

describe("website issue links", () => {
  it("never points an issue id at the GitHub issues tracker", () => {
    for (const [name, path] of [
      ["report.html", REPORT_HTML],
      ["npm-compat-chart.js", NPM_CHART],
    ] as const) {
      const src = read(path);
      // Any interpolation of an id into an issues URL is the bug, in either
      // template form.
      expect(src, `${name} still builds a GitHub issues URL`).not.toMatch(
        /github\.com\/loopdive\/js2\/issues\/(\$\{|"\s*\+|'\s*\+)/,
      );
    }
  });

  it("routes both report and npm-compat issue refs to the markdown viewer", () => {
    expect(read(REPORT_HTML)).toContain('assetPath("dashboard/issue.html?id="');
    const chart = read(NPM_CHART);
    expect(chart).toContain("dashboard/issue.html?id=");
    // Both call sites go through the one helper rather than hand-rolling a URL.
    expect(chart).toContain("_issueUrl(pkg.issue)");
    expect(chart).toContain("_issueUrl(b.issue)");
  });

  it("accepts the numeric `id` parameter the new links use", () => {
    const viewer = read(ISSUE_VIEWER);
    // Linking to ?id= against a viewer that only reads ?slug= would render the
    // "Invalid issue URL" error for every link on the site.
    expect(viewer).toMatch(/params\.get\("slug"\)\s*\|\|\s*params\.get\("id"\)/);
  });

  it("resolves issue data relative to the deployment base path", () => {
    const viewer = read(ISSUE_VIEWER);
    // The site is served from a domain root AND from loopdive.github.io/js2/.
    // Absolute "/plan/issues/…" 404s under the subpath, which would make every
    // one of these links land on a broken viewer there.
    expect(viewer).toContain("const BASE_PATH =");
    expect(viewer).toMatch(/issueAsset\(`plan\/issues\/\$\{slug\}\.md`\)/);
    expect(viewer).toContain('issueAsset("plan/issues/index.json")');
    expect(viewer).not.toMatch(/fetch\(["'`]\/plan\/issues\//);
  });

  it("links ids that the issue index can actually resolve", () => {
    const indexPath = join(ROOT, "plan", "issues");
    if (!existsSync(indexPath)) return;

    // Every id referenced by the standalone root-cause buckets must correspond
    // to a real plan/issues/<id>-*.md, or the viewer will 404 on it.
    const reportBuilder = join(ROOT, "scripts", "build-test262-report.mjs");
    if (!existsSync(reportBuilder)) return;
    const ids = new Set<string>();
    for (const m of read(reportBuilder).matchAll(/issues:\s*\[([^\]]*)\]/g)) {
      for (const raw of m[1].matchAll(/["']#?([0-9]+[a-z]?)["']/g)) ids.add(raw[1]);
    }
    expect(ids.size).toBeGreaterThan(10);

    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(indexPath).filter((f) => f.endsWith(".md"));
    const known = new Set(files.map((f) => f.split("-")[0]));

    const dangling = [...ids].filter((id) => !known.has(id));
    expect(dangling, `issue ids referenced by the report with no plan/issues file: ${dangling.join(", ")}`).toEqual([]);
  });
});
