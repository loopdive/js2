// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";

interface ForwardSpan {
  id: string;
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
}
interface ForwardFixture {
  schema: string;
  spans: ForwardSpan[];
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Only independently committed spans may be inverted. The caller still applies
// its unchanged historical full-source/declaration receipt to the result.
export function inversePreparedSourceForward(source: string, fixtureText: string, fixtureHash: string): string {
  if (sha(fixtureText) !== fixtureHash) throw new Error("prepared forward fixture digest mismatch");
  const fixture = JSON.parse(fixtureText) as ForwardFixture;
  if (fixture.schema !== "prepared-source-forward-v1" || !Array.isArray(fixture.spans) || !fixture.spans.length)
    throw new Error("prepared forward fixture population mismatch");
  const ids = new Set<string>();
  let previousEnd = -1;
  const replacements = fixture.spans.map((span) => {
    if (
      !span.id ||
      ids.has(span.id) ||
      !span.before ||
      !span.after ||
      span.before === span.after ||
      sha(span.before) !== span.beforeSha256 ||
      sha(span.after) !== span.afterSha256
    )
      throw new Error("prepared forward span authentication mismatch");
    ids.add(span.id);
    const start = source.indexOf(span.after);
    if (start < 0 || source.indexOf(span.after, start + span.after.length) !== -1)
      throw new Error(`prepared forward span missing or duplicated: ${span.id}`);
    if (start < previousEnd) throw new Error(`prepared forward span order mismatch: ${span.id}`);
    previousEnd = start + span.after.length;
    return { start, end: previousEnd, before: span.before };
  });
  for (const span of replacements.reverse())
    source = source.slice(0, span.start) + span.before + source.slice(span.end);
  return source;
}
