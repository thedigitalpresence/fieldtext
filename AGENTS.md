# V1 Agent Instructions

These instructions apply to this repository.

## Default Workflow

Before editing:
- Read the Linear issue, linked spec, and relevant existing files.
- Identify the acceptance criteria and non-goals.
- Check current implementation patterns before adding new ones.
- Inspect current git status so unrelated work is not disturbed.

While editing:
- Implement only the stated acceptance criteria.
- Do not change unrelated files.
- Do not refactor opportunistically.
- Preserve existing behavior unless the issue explicitly changes it.
- Follow existing code style, architecture, naming, and UI conventions.
- Add or update tests when the change affects logic, data flow, permissions, integrations, or user-visible behavior.

Before opening a PR:
- Run the relevant checks for the files touched.
- Review the diff for unrelated changes.
- Confirm the PR description follows `.github/pull_request_template.md`.

## PR Standard

Every PR should explain:
- What changed
- Why
- Linear issue
- Acceptance criteria checked
- Screenshots, Loom, or preview URL when relevant
- Risk
- How to test
- What was intentionally not done
- Agent involvement
- Follow-up issues created

## PR Review Standard

Review against the linked Linear issue only. Look for acceptance criteria gaps, bugs, broken data flow, unnecessary scope expansion, security issues, bad abstractions, missing loading/error states, and code that will be hard for future agents to modify.

Do not suggest unrelated improvements unless they are severe.

Return review feedback in three groups:
1. Must fix before merge
2. Should fix soon
3. Safe to merge

## Verification

Use the narrowest useful verification command for the task. If a broad check is already known to have unrelated failures, say that plainly in the PR and include the more targeted checks that passed.
