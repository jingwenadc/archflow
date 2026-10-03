# Repository instructions

These instructions apply across the repository. Apply each area section only when changing that directory. The task prompt supplies requirements and scale targets; do not invent them.

## Repository

- Follow existing patterns and keep changes focused. Choose the simplest design that meets the requirements. Add services, data stores, queues, caches, dependencies, or abstractions only for a concrete need.
- In feedback loops, determine whether an example represents a broader rule. When it does, implement the rule at the shared boundary and cover adjacent cases; avoid hard-coded exceptions and duplicated logic.
- Preserve public APIs and data contracts. Plan compatible rollouts and migrations when they change.
- For architecture-affecting work, surface requirements that matter, such as scale, latency, failure behavior, data ownership, and security. State assumptions, recommend a design, and explain tradeoffs. Ask only when a missing answer changes a costly-to-reverse decision.
- Use architecture, database, and deployment docs when relevant; update them for material changes.
- Verify affected behavior with focused checks and tests of important failure paths. Report what changed, what was verified, and any material uncertainty.

## Frontend (`apps/web/`)

- Reuse the existing design system, component patterns, API client, and i18n setup where present. Avoid parallel styling or state systems.
- Cover loading, empty, error, and success states for changed async flows. Handle duplicate submissions and stale responses where they matter.
- Use semantic controls, labels, keyboard and focus support, and responsive layouts.
- Treat browser code and exposed environment variables as public. Sanitize untrusted HTML; rely on the backend for authorization.
- For visual changes, inspect the running UI at narrow and wide viewport sizes when practical.

## Backend (`services/api/` and `services/agent/`)

- Enforce authorization server-side for protected resources. In multi-user code, derive project scope from authenticated identity; never trust an unchecked project ID.
- Protect write invariants with appropriate transactions and constraints. Migrate schemas compatibly with deployed code; do not rewrite applied migrations.
- Give remote calls timeouts. Bound retries and use them only when side effects are safe to repeat; make redelivered jobs and events idempotent.
- Bound potentially large queries and concurrency. Add indexes or caching based on access patterns or measurements.
- Keep secrets and sensitive data out of logs; follow existing tracing and metrics conventions.
- Test changed contracts and relevant failure paths.

## Infrastructure (`deploy/`, `compose.yaml`, and Dockerfiles)

- Treat infrastructure as code and the existing deployment workflow as the source of truth. Keep environment differences explicit and follow established version pinning.
- Use least privilege, private network defaults, and approved secret references. Keep secrets out of code, logs, and plan output.
- Validate and inspect plans or diffs. For material changes, report resources replaced or destroyed, affected environments, data risk, recurring cost, and rollback path.
- Protect stateful resources and backup or retention controls. Destructive changes require explicit authorization.
- Editing infrastructure files does not authorize deployment. Apply only when deployment is in the task scope and follow existing approval controls.

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
