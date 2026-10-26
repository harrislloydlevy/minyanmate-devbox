<!-- minyanmate-dev:feature-specs -->
## Feature specs

Every story has a spec at `features/<story-id>-<slug>.md`. It is the contract.

- Read the spec before any code change. Do not start from grep.
- `## Acceptance Criteria` is immutable. Never edit, reword, or delete an item.
  If it looks wrong, stop and report it.
- When your change alters behaviour, data, API, config, or commands, update the
  spec in the same commit:
  - Append `### Follow-up (YYYY-MM-DD): <topic>` under `## Implementation Notes`,
    describing what changed and how to verify it.
  - Change `## Goal` or `## Acceptance Criteria` only with the story owner's approval.
- Tick `## Definition of Done` only for things you actually verified.
- Commit the spec with the code. A branch is not done while spec and code disagree.
- If you cannot update the spec, say so in the final report; never leave it silently stale.
