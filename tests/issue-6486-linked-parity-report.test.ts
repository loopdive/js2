import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs tool, no types by design (it is a CI measurement script)
import { buildParityReport, parseJsonl, renderMarkdown } from "../scripts/test262-linked-parity.mjs";

const TOOL = join(__dirname, "..", "scripts", "test262-linked-parity.mjs");

function row(over: Record<string, unknown>) {
  return JSON.stringify({
    oracle_lane: "honest",
    file: "test/x.js",
    status: "pass",
    strict: "both",
    compile_ms: 10,
    exec_ms: 2,
    ...over,
  });
}

const HONEST = [
  row({ file: "a.js" }),
  row({ file: "b.js" }),
  row({ file: "c.js", status: "fail", error: "Expected SyntaxError but compiled clean" }),
].join("\n");

const LINKED = [
  // agreement
  row({ file: "a.js", oracle_lane: "linked-harness", compile_ms: 1 }),
  // a linked-lane MISS: scored by the honest assembly, agrees, still a miss
  row({
    file: "b.js",
    oracle_lane: "linked-harness-fallback",
    linked_fallback_reason: "linked compile failed: duplicate declaration",
    compile_ms: 12,
  }),
  // pass -> fail is c.js's mirror: honest fail, linked pass => fail->pass
  row({ file: "c.js", oracle_lane: "linked-harness", status: "pass", compile_ms: 1 }),
].join("\n");

describe("#6486 linked-lane parity report", () => {
  it("joins the two lanes by (file, strict) and scores agreement", () => {
    const report = buildParityReport(parseJsonl(HONEST).rows, parseJsonl(LINKED).rows);
    expect(report.rows.common).toBe(3);
    expect(report.agreement.agreed).toBe(2);
    expect(report.agreement.differed).toBe(1);
    expect(report.agreement.percent).toBeCloseTo(66.67, 1);
    expect(report.non_authoritative).toBe(true);
  });

  it("counts a fallback row separately from parity and histograms its reason", () => {
    const report = buildParityReport(parseJsonl(HONEST).rows, parseJsonl(LINKED).rows);
    expect(report.fallback.rows).toBe(1);
    expect(report.fallback.reasons).toEqual([{ key: "linked compile failed: duplicate declaration", count: 1 }]);
  });

  it("lists pass->fail and fail->pass separately", () => {
    const honest = [
      row({ file: "p.js", status: "pass" }),
      row({ file: "q.js", status: "compile_error", error: "boom" }),
    ].join("\n");
    const linked = [
      row({ file: "p.js", oracle_lane: "linked-harness", status: "fail", error: "assertion failed: deep" }),
      row({ file: "q.js", oracle_lane: "linked-harness", status: "pass" }),
    ].join("\n");
    const report = buildParityReport(parseJsonl(honest).rows, parseJsonl(linked).rows);
    expect(report.pass_to_fail).toHaveLength(1);
    expect(report.pass_to_fail[0].file).toBe("p.js");
    expect(report.fail_to_pass).toHaveLength(1);
    expect(report.fail_to_pass[0].file).toBe("q.js");
    expect(report.difference_buckets[0].count).toBe(1);
  });

  it("keys on (file, strict) so the two strict variants of a file do not collide", () => {
    const honest = [row({ file: "s.js", strict: "only" }), row({ file: "s.js", strict: "no", status: "fail" })].join(
      "\n",
    );
    const linked = [
      row({ file: "s.js", strict: "only", oracle_lane: "linked-harness" }),
      row({ file: "s.js", strict: "no", oracle_lane: "linked-harness", status: "fail" }),
    ].join("\n");
    const report = buildParityReport(parseJsonl(honest).rows, parseJsonl(linked).rows);
    expect(report.rows.common).toBe(2);
    expect(report.agreement.agreed).toBe(2);
  });

  it("ignores rows stamped with the wrong lane rather than silently mixing them", () => {
    const linked = [row({ file: "a.js", oracle_lane: "fast-nativeharness" })].join("\n");
    const report = buildParityReport(parseJsonl(HONEST).rows, parseJsonl(linked).rows);
    expect(report.rows.linked_lane_mismatch).toBe(1);
    expect(report.rows.common).toBe(0);
  });

  it("renders a Markdown summary that says it is non-authoritative", () => {
    const md = renderMarkdown(buildParityReport(parseJsonl(HONEST).rows, parseJsonl(LINKED).rows));
    expect(md).toContain("NON-AUTHORITATIVE");
    expect(md).toContain("fail → pass");
    expect(md).toContain("Linked-lane fallbacks: 1");
  });

  // (#3451 slice 6) The two lanes swapped ROLES, not places. The positional
  // arguments and every JSON field stay keyed by LANE — otherwise a report from
  // before the flip and one from after would need different readers — and only
  // the headings learn which lane is authoritative.
  it("defaults to the pre-flip roles (honest authoritative, linked audit)", () => {
    const md = renderMarkdown(buildParityReport(parseJsonl(HONEST).rows, parseJsonl(LINKED).rows));
    expect(md).toContain("authoritative lane: honest, audit lane: linked");
    expect(md).toContain("| status | honest (authoritative) | linked (audit) |");
  });

  it("labels the post-flip roles without moving any lane", () => {
    const report = buildParityReport(parseJsonl(HONEST).rows, parseJsonl(LINKED).rows, {
      roles: { authoritative: "linked", audit: "honest" },
    });
    const md = renderMarkdown(report);
    expect(md).toContain("authoritative lane: linked, audit lane: honest");
    expect(md).toContain("| status | honest (audit) | linked (authoritative) |");
    expect(md).toContain("pass → fail (honest [audit] pass, linked [authoritative] not)");
    // Schema is lane-keyed and UNCHANGED: same fields, same direction, same
    // numbers as the default-role render above.
    expect(report.status_totals.honest.total).toBe(3);
    expect(report.status_totals.linked.total).toBe(3);
    expect(report.pass_to_fail).toEqual([]);
    expect(report.fail_to_pass).toHaveLength(1);
  });

  it("CLI: the role flags reach the summary, and a bad pair is a usage error", () => {
    const dir = mkdtempSync(join(tmpdir(), "linked-parity-roles-"));
    const honestPath = join(dir, "honest.jsonl");
    const linkedPath = join(dir, "linked.jsonl");
    const out = join(dir, "parity.json");
    const summary = join(dir, "summary.md");
    writeFileSync(honestPath, HONEST + "\n");
    writeFileSync(linkedPath, LINKED + "\n");
    writeFileSync(summary, "");
    execFileSync(
      process.execPath,
      [
        TOOL,
        honestPath,
        linkedPath,
        "--out",
        out,
        "--summary",
        summary,
        "--authoritative-label",
        "linked",
        "--audit-label",
        "honest",
      ],
      { stdio: "pipe" },
    );
    expect(JSON.parse(readFileSync(out, "utf8")).roles).toEqual({ authoritative: "linked", audit: "honest" });
    expect(readFileSync(summary, "utf8")).toContain("authoritative lane: linked, audit lane: honest");

    // Naming the SAME lane for both roles would silently produce a report whose
    // headings claim something the data cannot support — refuse, don't render.
    let status = 0;
    try {
      execFileSync(
        process.execPath,
        [TOOL, honestPath, linkedPath, "--out", out, "--authoritative-label", "linked", "--audit-label", "linked"],
        { stdio: "pipe" },
      );
    } catch (error) {
      status = (error as { status?: number }).status ?? 0;
    }
    expect(status).toBe(2);
  });

  it("exits 0 on differences and writes the JSON report (it is a measurement, not a gate)", () => {
    const dir = mkdtempSync(join(tmpdir(), "linked-parity-"));
    const honestPath = join(dir, "honest.jsonl");
    const linkedPath = join(dir, "linked.jsonl");
    const out = join(dir, "nested", "parity.json");
    const summary = join(dir, "summary.md");
    writeFileSync(honestPath, HONEST + "\n");
    writeFileSync(linkedPath, LINKED + "\n");
    writeFileSync(summary, "");
    execFileSync(process.execPath, [TOOL, honestPath, linkedPath, "--out", out, "--summary", summary], {
      stdio: "pipe",
    });
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.agreement.differed).toBe(1);
    expect(readFileSync(summary, "utf8")).toContain("linked-harness parity");
  });

  it("skips cleanly with --allow-missing when the honest shards did not run", () => {
    const dir = mkdtempSync(join(tmpdir(), "linked-parity-missing-"));
    const linkedPath = join(dir, "linked.jsonl");
    const out = join(dir, "parity.json");
    writeFileSync(linkedPath, LINKED + "\n");
    execFileSync(process.execPath, [TOOL, join(dir, "absent.jsonl"), linkedPath, "--out", out, "--allow-missing"], {
      stdio: "pipe",
    });
    expect(JSON.parse(readFileSync(out, "utf8")).skipped).toBe(true);
  });
});
