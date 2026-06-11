# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Ongrid is an ops AI agent (root-cause analysis, observability, remote execution via Slack/Telegram). Go backend + React frontend, shipped as two binaries: `ongrid` (cloud manager) and `ongrid-edge` (host agent that dials out — no inbound ports).

**Read `AGENTS.md` first** — it carries the project's hard constraints (gospec): layering rules, error handling, API/proto workflow, security red lines, and the frontend UI conventions (zinc/indigo palette, component reuse, restraint, light/dark, i18n via `tr('中文','English')`). Default output language for comments, docs, and commit messages is **Chinese**; commits follow Conventional Commits (`type(scope): desc`).

## Commands

Make is the only build/test entry point (don't run bare `go build` / `docker build` for anything CI-shaped).

```bash
make build                # build ongrid + ongrid-edge into bin/
make test                 # unit tests (fast, no Docker)
make test-race            # unit tests with -race (CI enforces this)
make test-integration     # build tag: integration
make test-e2e             # build tag: e2e, needs Docker; uses fakes, no secrets
make test-e2e-live        # e2e against real external services (tests/e2e/secrets.local.env)
make lint                 # golangci-lint
make arch-lint            # go-arch-lint — enforces BC/layer boundaries
make proto                # regenerate from api/*.proto (buf, falls back to protoc)
make compose-up           # full local stack (manager + Prometheus/Loki/Tempo/Grafana); compose-down to stop
make run-ongrid           # go run ./cmd/ongrid
```

Single Go test: `go test ./internal/manager/biz/alert/... -run TestName`. E2E tests are excluded from `make test` via the `e2e` build tag; each implements an item from `docs/test/e2e-catalog.md`.

Frontend (in `web/`): `npm run dev`, `npm run build` (tsc + vite), `npm run test` (vitest; single test: `npx vitest run src/path/foo.test.tsx`), `npm run lint`, `npm run typecheck`. Run `npm run build` before PRs that touch the UI; visual changes must be verified with headless-Chrome screenshots (light + dark if theme-related).

## Architecture

Three bounded contexts under `internal/`, **forbidden from importing each other** (enforced by `.go-arch-lint.yml`, run `make arch-lint`):

- `internal/iam` — users/auth (data layer is SQLite)
- `internal/manager` — the cloud brain: alert, aiops (RCA), topology, knowledge (RAG), monitor, edge, imbridge (IM channels), webshell, skill, report, marketplace…
- `internal/edgeagent` — the host-side agent

Each BC is layered `server → service → biz → data → model` with a strict rule: **service may not import data directly** — it must go through biz (interfaces are defined on the consumer side). `internal/pkg/` is business-free shared code (llm, prom/logquery/tracequery, tunnel, embedding, notify, …) and may not import any BC. `internal/skill/` is a separate top-level package.

Assembly happens in `cmd/`: `cmd/ongrid/main.go` wires iam + manager (this file is very large — it is the DI root); `cmd/ongrid-edge` wires edgeagent only and must never import iam/manager.

API contracts live in `api/*.proto` (single source of truth — change the proto first, never edit generated code in `api/gen/`). REST routes are hand-written chi handlers in `internal/*/server/` against the generated types; responses use `{code, message, data}` and handlers need Swagger annotations.

Edge connectivity uses the upstream `singchia/frontier` broker (edge dials out; browser SSH is a reverse tunnel). Agent behavior is prompt-driven: `agents/*.md` are the coordinator/specialist/investigator prompts, `skills/` holds the built-in agent skills (bash, host-files, restart-service).

Frontend (`web/`): React 18 + TypeScript + Vite + Tailwind + zustand, pages in `web/src/pages/`, shared UI primitives in `web/src/components/ui/` (use them — `Card`/`Chip`/`Button`/`PageHeader`/`EmptyState`), API clients in `web/src/api/`. Light theme is implemented as `html.light` overrides in `web/src/styles/index.css`.

## Docs

README is minimal and maintained in 9 languages — don't add docs there; they go under `docs/` (`docs/install/` for ops guides). Requirement docs follow the table in AGENTS.md (Issue / RFC / PRD / Epic).
