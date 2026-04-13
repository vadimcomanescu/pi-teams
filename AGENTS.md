# AGENTS.md

Repo-local overrides for `pi-teams`.

## Model availability

- Do **not** use Anthropic models in this repo by default.
- Anthropic usage is currently exhausted and teammate/review/audit runs will fail immediately with quota errors.
- Prefer non-Anthropic models for teammates and review work, especially `openai/gpt-5.3-codex`.
- Only use an Anthropic model here if the user explicitly asks for it and accepts likely failure.

## Team UI contract

- There is **one** team surface.
- Do **not** reintroduce or expose any separate async/background teams surface.
- Any legacy `Async teams` widget/state is a bug and must be cleared/removed.
- Live team UI should show only current relevant teammates, stay stable, and avoid stale failed rows in the compact surface unless the user explicitly asks for history.

## Interaction hints

- Do not show interaction hints for controls that are not actually wired.
- Do not expose raw tool syntax in user-facing team UI unless the user explicitly asked for low-level tool details.
