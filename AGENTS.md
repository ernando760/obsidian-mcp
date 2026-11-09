# Repository instructions

## Commit messages

Every commit created or edited by an AI agent must contain:

1. A short, objective title describing the change.
2. A body explaining what changed and, when relevant, why.
3. A `Co-authored-by:` trailer identifying the actual AI agent.

Separate the title, body and trailer block with one blank line. Do not invent
email addresses or replace the human author's identity. For Codex, use:

```text
fix: preserve installer settings

Preserve existing credentials and note permissions during updates.

Co-authored-by: Codex <noreply@openai.com>
```

This Codex identity is verifiable in the official repository:
https://github.com/openai/codex/blob/8f5d68f9d25237d0e52ebb8bdd9e7ada01d586c9/docs/config.md#commit-attribution

Other AI agents must use their own independently verifiable identity. If a
valid identity is unavailable, stop before committing and report the limitation.

## First release preparation

Do not publish a release, push release tags or change the project version unless
the user explicitly authorizes it. Record actual CI results separately from
configured workflows; a local platform simulation is not a native CI run.
