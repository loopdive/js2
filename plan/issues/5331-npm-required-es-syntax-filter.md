---
id: 5331
title: "Required ECMAScript editions and filtering for npm compatibility"
status: done
created: 2026-09-05
updated: 2026-09-10
priority: medium
feasibility: easy
area: website
task_type: feature
---

## Request

Show the required ES edition for every npm package and add an edition slider at the top, resembling the landing page.

## Current scope

PR #5500 supplied the package module-graph syntax and library requirement classifier, per-package badges, and corpus edition strip. The older syntax-only implementation from PR #5611 was superseded. This change completes the remaining slider using the published `esEdition.required` metadata; it does not change classifier or benchmark artifacts.

The slider filters cumulatively through ES3, ES5, annual editions, and ESNext. Unknown requirements have an explicit inclusion checkbox; default All includes the complete corpus. Card groups and metrics follow visible packages. The existing edition strip explicitly describes all packages.

## Acceptance

- [x] Slider filters cumulative package requirements, with explicit ESNext and Unknown handling.
- [x] Group and summary counts reflect visible packages; empty results are explained.
- [x] Slider focus and performance choices survive filter changes.
- [x] Existing classification evidence and CI-owned benchmark artifacts remain intact.

## Validation

Four focused jsdom tests pass: cumulative filtering, published-versus-ESNext handling, explicit unknown inclusion, summary/group counts, focus retention, retained performance settings, and empty states. Independent checks against the current 24-package report pass at every one of the 16 slider positions. JavaScript syntax and whitespace checks pass.
