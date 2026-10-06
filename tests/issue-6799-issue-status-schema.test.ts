// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6799 — `check:issues` rejects a frontmatter `status:` outside the list in
 * plan/issues/SCHEMA.md. The list is parsed from SCHEMA.md itself, so these
 * tests pin the parser and the one vocabulary it must read.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSchemaStatuses } from "../scripts/lib/issue-status-schema.mjs";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

describe("#6799 issue status vocabulary", () => {
  it("reads exactly the documented statuses from SCHEMA.md", () => {
    const schema = readFileSync(resolve(ROOT, "plan/issues/SCHEMA.md"), "utf8");
    expect(parseSchemaStatuses(schema)).toEqual([
      "backlog",
      "ready",
      "in-progress",
      "in-review",
      "blocked",
      "suspended",
      "done",
      "wont-fix",
    ]);
  });

  it("stops at the next top-level field and tolerates a gloss after the value", () => {
    const text = [
      "- `title`",
      "  - Human-readable.",
      "- `status`",
      "  - One of:",
      "    - `ready`",
      "    - `in-review` — PR open, author is not the merger",
      "      (continuation line)",
      "- `sprint`",
      "    - `not-a-status`",
    ].join("\n");
    expect(parseSchemaStatuses(text)).toEqual(["ready", "in-review"]);
  });

  it("returns nothing (which the gate treats as a FAILURE) when the list is missing", () => {
    expect(parseSchemaStatuses("# no schema here\n")).toEqual([]);
  });

  it("update-issues --check fails on off-schema and on an unreadable vocabulary", () => {
    const src = readFileSync(resolve(ROOT, "scripts/update-issues.mjs"), "utf8");
    expect(src).toContain("off-schema statuses");
    expect(src).toContain("unreadable status vocabulary");
    // Judged on the RAW value: the alias table must not launder `in_progress`.
    expect(src).toContain("schemaStatusSet.has(rec.rawStatus)");
  });
});
