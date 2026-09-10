# Historical records preserved for dependency-first landing

These four documents are copied verbatim from held PRs #5739 and #5741. They
retain original evidence and planning provenance before either PR can be
considered absorbed. Historical dispatch instructions, ownership statements and
pending-publication language are not current authorization or queue status.
No new implementation, test result, gate exemption or ownership release follows
from this archival copy. Neither older PR is closed by this change.

- [ABI integration evidence](./3518-program-abi-integration-evidence-2026-09-08.md):
  original #5739 blob `67bafba82b31fb498a66239ec79406f772bead7e`.
  Retains the measured historical populations and artifact hashes; these are
  not a fresh current-main validation result.
- [ABI reachability proposal](./3518-program-abi-reachability-plan-2026-09-08.md):
  original #5739 blob `b1ec444284a39cfecd2cc3d3acb8a2e1694d2ecd`.
  Remains a proposal. The fixed 30-target obligation and missing rooted
  `planningSealed` witness are not waived; copying does not activate an auditor.
- [Startup extraction specification](./3518-startup-contract-plan-2026-09-08.md):
  original #5741 blob `441b55b686df1f0d6f3389ae701e78dacd6e0ad1`.
  Historical scope for an extraction already composed into this branch;
  prescribed measurements are not themselves proof those measurements ran.
- [Core-types advisory](./3518-core-types-next-plan-2026-09-08.md):
  original #5741 blob `dd59898e827bd7daa8143ac6c109c95179526cff`.
  Superseded by the [implemented core-types contract](./3518-core-types-checkpoint-plan-2026-09-08.md).
  Retained for rationale, not a new dispatch or current ownership clearance.

The ABI/startup implementation was incorporated through
`e90f2a14aa263084cf94449b706b3df07bf30d71`, rather than by merging the original
PR heads. Closure requires actual content verification on `loopdive/js2/main`,
including later intentional changes. Generic lowering #5738 remains separate.

Queue-drain mode pauses new migration scope. The coordinator alone refreshes,
validates and submits existing PRs in dependency order, one queue entry at a time
with verified baseline provenance. Stack-only merges are not main delivery.
