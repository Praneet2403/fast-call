---
type: adr
status: proposed
date: 2026-10-30
---
# ADR-003: Monorepo vs multiple repos

## Context
We have several deployables (api, dispatcher, simulator, dashboard, later ml) that share types like `Agent` and `Request`.

## Options considered
| Option                        | Pros | Cons |
| ----------------------------- | ---- | ---- |
| Monorepo with pnpm workspaces | ✍️   | ✍️   |
| Monorepo with Turborepo / Nx  | ✍️   | ✍️   |
| One repo per service          | ✍️   | ✍️   |

## Decision
> [!todo] ✍️ Fill this after you research and/or build a small spike. Write "We will use X because …".

## Consequences
> [!todo] ✍️ What gets easier? What gets harder? What would make you revisit this?
