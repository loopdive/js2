---
id: 5331
title: "Required ECMAScript syntax editions and filtering for npm compatibility"
status: done
created: 2026-09-05
updated: 2026-09-05
priority: medium
feasibility: easy
area: website
task_type: feature
---

## Request

Show the required ES edition for each npm package and add an edition slider at the top, resembling the landing page.

## Implementation

Measure the minimum syntax edition across the pinned tarball's published JavaScript files, excluding test/fixture directories and test files. Include alternative distributed builds. Keep syntax requirements distinct from runtime API and dependency requirements. Unparseable, missing, mismatched, or empty source evidence is Unknown, never a low edition.

Use cumulative edition filtering, include unknown packages explicitly, and update group and metric counts without replacing the slider or performance controls.

## Acceptance

- [x] Every package card shows its syntax edition or Unknown with scope explained.
- [x] Slider filters cumulatively with an explicit unknown checkbox and empty state.
- [x] Counts reflect visible packages; slider focus and performance selections persist.
- [x] Report refresh retains independently reproducible syntax metadata.

## Validation

- Twelve targeted syntax tests pass, including ES3, ES5, module context, optional chaining, top-level await, invalid syntax, missing pins, and real pinned clsx metadata.
- Independent jsdom interaction checks verify cumulative filtering, unknown toggle, visible counts, input identity and focus, empty state, and retained performance selections.
- 24/24 pinned packages have measured syntax metadata in both report copies; compiler, correctness, performance, and measurement timestamps are unchanged.
- Targeted Prettier and whitespace checks pass.
