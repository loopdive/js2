// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The issue `status:` vocabulary, read from plan/issues/SCHEMA.md (#6799).
//
// SCHEMA.md is the single source of truth: its "Required Fields" section lists
//
//   - `status`
//     - One of:
//       - `backlog`
//       - ...
//
// and `check:issues` (scripts/update-issues.mjs --check) rejects any frontmatter
// status outside that list. Adding a status is a reviewed edit to SCHEMA.md and
// nothing else. Kept in its own module because update-issues.mjs runs its whole
// pipeline at import time.

/**
 * @param {string} schemaText contents of plan/issues/SCHEMA.md
 * @returns {string[]} the allowed statuses, in document order; [] if the list
 *   cannot be found (callers must treat that as a failure, not as "anything").
 */
export function parseSchemaStatuses(schemaText) {
  const lines = schemaText.split("\n");
  const start = lines.findIndex((l) => /^- `status`\s*$/.test(l));
  if (start < 0) return [];
  const statuses = [];
  for (const line of lines.slice(start + 1)) {
    if (/^- /.test(line)) break; // next top-level field
    const m = line.match(/^\s{4,}- `([a-z][a-z-]*)`/);
    if (m) statuses.push(m[1]);
  }
  return statuses;
}
