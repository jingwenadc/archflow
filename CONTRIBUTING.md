# Contributing

## Branches

Create a branch from the current default branch. Use a short lowercase description after the prefix.

| Change | Branch pattern | Example |
| --- | --- | --- |
| Feature | `feature/` | `feature/add-bid-skill` |
| Bug fix | `fix/` | `fix/score-total-validation` |
| Documentation | `docs/` | `docs/update-skill-guide` |
| Maintenance | `chore/` | `chore/refresh-examples` |
| Refactor | `refactor/` | `refactor/pdf-extraction` |
| Tests | `test/` | `test/bid-plan-validator` |
| CI or build | `ci/`, `build/` | `ci/validate-skills` |
| Release or urgent patch | `release/`, `hotfix/` | `hotfix/broken-skill-path` |

Branch prefixes are a repository convention. Commit types follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## Commits

Use the form:

```text
<type>(optional-scope): concise imperative summary
```

Use `feat:` for a user-visible capability and `fix:` for a bug fix. Common additional types are `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `build:`, `perf:`, `style:`, and `revert:`. A feature branch therefore normally uses `feature/...`, while its feature commit uses `feat:`, not `feature:`.

Examples:

```text
feat(skills): add technical bid authoring workflow
fix(validator): reject mismatched score totals
docs: explain skill invocation
chore: refresh packaged examples
```

## Pull requests

Before opening a Pull Request:

1. Rebase or merge the latest default branch when needed.
2. Review the staged diff for credentials and unrelated files.
3. Run checks appropriate to the change.
4. Use a concise Conventional Commit-style title.
5. Explain the outcome, verification, and any known limitations.
