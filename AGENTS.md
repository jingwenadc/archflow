# Repository instructions

## Git workflow

- Do not commit feature work directly to the default branch.
- Use a short lowercase branch name with one of these prefixes: `feature/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`, `ci/`, `build/`, `release/`, or `hotfix/`.
- Use Conventional Commits. Common types are `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `build:`, `perf:`, `style:`, and `revert:`.
- Keep commit subjects concise and imperative. Use an optional scope when it adds useful context, for example `feat(skills): add bid plan validation`.
- Inspect the staged diff and run checks appropriate to the change before committing.
- Push the branch and open a GitHub Pull Request. Do not merge it unless the user explicitly asks.
- Do not rewrite shared or protected branch history without explicit approval.

## Skill checks

- For Python skill scripts, run `python -m py_compile` and the included example or validation command.
- Keep source examples free of credentials, private certificates, bid pricing, and personal data.
- When changing a skill, keep `SKILL.md`, `agents/openai.yaml`, referenced resources, and executable scripts consistent.
