---
id: 3995
title: "npm-compat: pin and adapt original upstream test suites for catalog packages"
status: ready
sprint: Backlog
created: 2026-07-30
updated: 2026-08-01
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
language_feature: n/a
goal: dogfood
related: []
---

# npm-compat: pin and adapt original upstream test suites for catalog packages

## Problem

The catalog package tarballs do not ship their original unit suites. The npm-compat page correctly reports upstream suite not shipped; adapter pending, but this needs a tracked path to genuine validation.

Pin matching source revisions and provide adapters for: hono, lodash, axios, react-dom, webpack, uuid, typescript, redux, jest, styled-components, moment, stylelint, three, lit, tailwindcss, and cookie. Keep upstream-suite validation distinct from compile checks, synthetic differential vectors, and benchmark harnesses.

Start with React DOM, Jest, and Lit, which already compile and validate their entry artifacts.

## Provenance

Migrated on 2026-08-01 from a GitHub issue on `loopdive/js2` (opened 2026-07-30)
that was created by an agent in error — this project tracks work as markdown
under `plan/issues/`, not as GitHub issues. The GitHub issue has been closed and
points here. **No content was dropped:** the Problem section above is the
original issue body verbatim.

Metadata below the title is newly assigned and is a **starting estimate, not a
measurement** — `priority`, `horizon` and `feasibility` were not stated in the
original and have not been validated against the corpus. Re-derive before
scheduling.
