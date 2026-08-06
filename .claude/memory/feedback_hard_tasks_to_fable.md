# Hard tasks go to Fable-model agents

**Rule (project lead, 2026-08-04):** when spawning agents for HARD tasks —
`feasibility: hard`, `reasoning_effort: max`, core-codegen/dispatch changes,
anything with a documented prior regression — run them on **Fable**
(`model: "fable"` on the Agent spawn, or omit `model` when the main loop is
already Fable so the agent inherits it). Do not default hard work to Opus.

Routine/mechanical agent work (sweeps, doc moves, well-templated fixes) may
still use Opus/Sonnet tiers.

This matches the existing issue-frontmatter convention (`model: fable` +
`fable_role` on #743 and other max-effort issues) — the spawn should honor
what the issue file already declares.

Context: on 2026-08-04 the #4155 Phase 2 agent (member-dispatch fast path —
exactly the place #1712 once regressed) was spawned on Opus out of habit from
two earlier Opus successes; the lead corrected that hard tasks belong on
Fable. Applied from then on.
