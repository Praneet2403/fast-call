---
type: guide
---
# Engineering Conventions

## Task IDs
`DE-###` (Dispatch Engine). Use them in branch names, commits and docs.

## Git workflow (trunk-based)
- `main` always works.
- Short-lived branches: `feat/DE-013-ingest-ws`, `fix/DE-021-double-assign`, `docs/DE-001-prd`.
- Merge through a Pull Request, **even when working solo.** Self-review the diff before merging.

## Commit messages ([Conventional Commits](https://www.conventionalcommits.org))
```
feat(dispatcher): lock agent before sending offer (DE-020)
fix(ingest): drop pings older than last known (DE-024)
docs(adr): accept ADR-001 live location store
```
Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `chore`.

## PR checklist
- [ ] Linked task ID
- [ ] Tests added or updated
- [ ] Docs / ADR updated if behaviour or architecture changed
- [ ] I can explain every line without AI

## Definition of Done
A task is done when it's merged, tested, documented, and the board card has moved to Done.
