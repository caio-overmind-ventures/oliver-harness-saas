# @repo/oliver

**Oliver — the AI agent harness for Next.js SaaS.**

Define your business operations once. Get a chat agent with approval gates, audit log, and multi-tenancy built in.

> This package lives inside `kotte-cpq-v2` as a workspace package during v0 development. It will be spun off to a standalone repo (`github.com/caioreina/oliver`) post-v0 via `git subtree split --prefix=packages/oliver`.

## Status

v0 in active development. See:
- `~/.gstack/projects/caio-overmind-ventures-kotte-cpq-v2/oliver-v0-implementation-brief.md` — implementation guide
- `~/.gstack/projects/caio-overmind-ventures-kotte-cpq-v2/caior-master-design-20260408-144217.md` — design doc
- `~/.gstack/projects/caio-overmind-ventures-kotte-cpq-v2/oliver-roadmap.md` — waves v0 → v2+

## Stack (opinionated for v0)

- TypeScript + Next.js + Drizzle + Postgres + Vercel AI SDK

## Boundary

This package has an ESLint rule (`.eslintrc.cjs`) that blocks imports from `apps/*`. This is intentional — it enforces the boundary that makes spin-off possible later.

## License

MIT (will be published when spun off).
