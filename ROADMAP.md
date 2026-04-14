# Oliver Roadmap

## v0 — shipped

The core primitives for building an agent-powered SaaS:

- **Tool** primitive with Zod input schemas and strongly-typed context
- **Server action channel** (Next.js) with caller-known `ctxOverride` pattern
- **Agent channel** (Vercel AI SDK) with per-session tool binding
- **HITL state machine** (`oliver.pending_tools`): propose → approve/reject → execute → verify, with DB-level re-invocation guard
- **Audit log** (`oliver.audit_log`) covering every lifecycle event, non-throwing writes, pluggable `onAuditFailure`
- **Precondition hook** enforcing domain invariants at every divergence point (propose, execute, approve)
- **Concurrency mutex** via `concurrencyKey` (process-level, FIFO queue per key, deadlock-safe)
- **Verify hook** with 5s hard timeout (`verified` / `failed_verification` / `verification_skipped`)
- **Session dedup** — same-turn Map cache prevents "retry to confirm" duplicates
- **Context assembly** — stable system-prompt prefix + mutable suffix for KV-cache friendliness
- **Instructions** — progressive-disclosure `.md` files (SOUL / domain / playbook / lessons) loaded once at module init

97 tests, typecheck clean, live-exercised end-to-end in a real B2B SaaS.

---

## v0.1 — likely candidates

### Subagent primitive

A tool can spawn a scoped LLM loop with a subset of tools. Pattern Anthropic adopted in their Agent SDK and Claude Code uses with its `Task` tool.

```ts
defineTool({
  name: "createQuoteFromPlan",
  subagent: {
    tools: [createCustomer, listProducts, addProductToQuote, ...],
    prompt: "You orchestrate quote creation. Given the plan, ...",
    outputSchema: z.object({ quoteId: z.string(), itemCount: z.number() }),
    maxSteps: 30,
  },
});
```

Use cases that a pure ReAct loop handles poorly:
- **Context isolation** — child LLM doesn't see the parent's prompt-injection surface
- **Scope restriction** — "this sub-workflow can only use these 3 tools" is a hard guarantee, not a prompt suggestion
- **Context-window relief** — 50+ tool calls inside the child don't pollute the parent's history
- **Parallelism** — N independent subagents in parallel

Not a replacement for small tools + ReAct, which remains the generic default.

### MCP channel

Expose tools as Model Context Protocol endpoints. External agents (Claude Desktop, Cursor, ChatGPT Desktop, etc.) can consume them over stdio or HTTP. Reuses existing `defineTool` definitions — no duplication.

Implementation plan: add `agent.mcpHandler()` returning a JSON-RPC handler that routes method names to tools, reusing the same gateway pipeline (input parse → precondition → concurrency → execute → verify → audit).

### DB advisory locks for distributed deployments

The current `concurrencyKey` mutex is process-level. Multi-instance production against shared state needs `pg_advisory_xact_lock` (or Redis SETNX, etc.). Same API (`concurrencyKey` stays unchanged), pluggable backend.

Likely shape: `createAgent({ mutexBackend: "postgres" | "memory" | ... })`. Default stays memory.

### Approval card React component

Adopters currently hand-roll the approval card (~120 LOC). Ship a headless component:

```tsx
import { OliverApprovalCard } from "oliver-agent/ui";

<OliverApprovalCard
  data={result}
  onApproved={(result) => toast("Applied")}
  onRejected={() => toast("Cancelled")}
  render={({ data, onApprove, onReject }) => /* your UI */}
/>
```

### Pending approval expiration

Currently passive — `findActive` / `listActive` filter by `expires_at > now()`. Stale rows accumulate.

Add an optional cron/scheduled job that flips expired rows to `timed_out` and emits an audit event. Useful for dashboards showing "N expired approvals this week".

### Auto-append to `lessons.md`

When the user corrects the agent mid-conversation ("no, always do X"), the agent detects the correction shape and offers: "Save this as a lesson so I remember next time?" On yes, Oliver appends to `lessons.md` with timestamp + scope. Loaded next session.

---

## v0.2 — exploratory

### User modeling (Hermes-style)

Dialectic user profile in `oliver.user_profile`. Agent builds a model of the user's preferences, expertise, communication style, recurring patterns. Persists across sessions. Enables real personalization beyond "remember their name".

Risk: easy to build something creepy. Opt-in with clear data boundaries.

### Multi-agent handoff

Multiple named agents in one app, each with distinct tool sets and prompts. Handoff protocol: agent A calls `handoff(to: "agentB", context: {...})`. Similar to OpenAI Swarm.

### Cost/latency telemetry

Log token counts, model IDs, latency per invocation. Builder gets a per-tool dashboard (hottest tools, slowest tools, token-heaviest flows). Hooks into audit log.

### Streaming tool outputs

Today tools return fully-buffered results. For long-running ops, stream partial output back to the LLM and UI (e.g., "processed 100/500 rows").

---

## Explicit non-goals

- **Full workflow engine.** If you need Temporal, Inngest, or Windmill, use those. Oliver is ReAct + HITL, not durable execution. Its state machine covers the proposal/approval boundary, nothing more.
- **Prompt library / agent zoo.** The harness stays small. Builders write prompts for their domain — that's where the leverage lives.
- **Model routing.** Use Vercel AI SDK for that. Oliver works with any model that speaks the SDK.
- **Hosted control plane.** Oliver is OSS, BYO database. No "Oliver Cloud" product planned.
- **Generic CRUD generation.** Oliver doesn't scaffold tools from your schema. Builders write `defineTool` calls by hand — that's where domain judgment goes (precondition rules, HITL gates, preview shapes).

---

## How to contribute (post-spin-off)

Planned once spun off:
- Public repo with issues + PRs
- Contributing guide
- Decision log (ADR-style) for API changes
- Semantic versioning from v0.1+

Pre-spin-off: Oliver is developed alongside a real adopter. Suggestions welcome via issues, but no external PRs yet.
