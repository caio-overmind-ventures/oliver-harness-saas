# Oliver

> Opinionated agent harness for Next.js + Drizzle + Postgres SaaS.

Oliver is the glue between your domain operations and an LLM. You define a tool once; Oliver exposes it as a Next.js server action **and** a Vercel AI SDK tool for the chat agent. You get HITL approval gates, audit logging, domain precondition checks, and per-resource concurrency control without writing any of it yourself.

```ts
defineTool({
  name: "applyDiscount",
  description: "Apply a percentage discount to a quote.",
  input: z.object({ quoteNumber: z.string(), percent: z.number() }),
  requiresApproval: true,
  precondition: async ({ input }) => assertDraft(input.quoteNumber),
  concurrencyKey: ({ input }) => `quote:${input.quoteNumber}`,
  previewChange: async ({ input }) => buildDiff(input),
  execute: async ({ input }) => applyDiscountToDB(input),
  verify: async ({ input, result }) => checkDBMatches(result),
});
```

That single definition ships through two channels, enforces the "published quote is read-only" invariant, blocks races on the same quote, shows a before/after card in the chat, runs only after a human click, and double-checks the DB after.

---

## Why Oliver?

Most "AI harness" libraries are either too generic (yet another OpenAI wrapper) or too framework-heavy (bring your own cluster). Oliver is small and opinionated:

- **One tool, many channels.** Don't duplicate business logic between your server actions and your agent. Write once, route everywhere.
- **HITL built in.** `requiresApproval: true` → DB-backed state machine, approval-card UX pattern, generic approve/reject server actions. No hand-rolling.
- **Safe by design.** `precondition` runs before preview, before execute, and before approve. `concurrencyKey` serializes same-resource calls. `verify` confirms the DB matches after the tool claims success.
- **Drizzle-native.** Oliver's tables live in a dedicated `oliver` Postgres schema. Same database as your app, same transactions possible, zero cross-schema ceremony.
- **KV-cache friendly.** System prompt is split into a stable prefix and a mutable suffix. Providers cache the prefix automatically. Manus measured ~10x cost reduction on equivalent workloads.

---

## Quick start

**1. Define a tool**

```ts
import { defineTool } from "oliver-agent";
import { z } from "zod";

export const createCustomer = defineTool({
  name: "createCustomer",
  description: "Create a new customer in the current organization.",
  input: z.object({
    name: z.string().min(1).max(256),
    email: z.string().email().optional(),
  }),
  execute: async ({ input, ctx }) => {
    const id = generateId();
    await database.insert(customers).values({
      id,
      organizationId: ctx.orgId,
      name: input.name,
      email: input.email ?? null,
    });
    return { id, name: input.name };
  },
});
```

**2. Wire up the agent**

```ts
// app/lib/oliver.ts
import "server-only";
import { createAgent, loadInstructions } from "oliver-agent";
import { database } from "@/db";
import { headers } from "next/headers";

const instructions = await loadInstructions("./instructions");

export const oliver = createAgent({
  tools: [createCustomer /* ...rest */],
  instructions,
  db: database,
  resolveServerActionContext: async (override) => {
    const session = await getSession({ headers: await headers() });
    return {
      orgId: await resolveOrgId(override?.slug),
      userId: session.user.id,
      source: "ui",
      slug: override?.slug,
    };
  },
});
```

**3. Expose through both channels**

```ts
// app/actions/oliver.ts — server action for the UI
"use server";
import { oliver } from "@/lib/oliver";
import { createCustomer } from "@/tools/createCustomer";
export const createCustomerAction = oliver.serverAction(createCustomer);

// app/api/chat/route.ts — agent channel
import { ToolLoopAgent, stepCountIs } from "@repo/ai";
const session = oliver.assembleSession({ ctx: { orgId, userId, slug } });
const agent = new ToolLoopAgent({
  model,
  instructions: session.systemPrompt,
  tools: session.tools,
  stopWhen: stepCountIs(25),
});
```

That's it. Same tool, two channels.

---

## Primitives

### Tool

The atomic unit. Defined once via `defineTool()`, with a Zod input schema. Type inference flows through to every consumer.

```ts
defineTool<typeof inputSchema, OutputType, ContextExt>({
  name, description, input,
  execute: async ({ input, ctx }) => ...,
});
```

### Gateway

- `agent.serverAction(tool)` — returns a `(input, ctxOverride?) => Promise<ActionResult>` function. Builder wraps in a `"use server"` file.
- `agent.agentTools({ ctx })` — returns a Vercel AI SDK tool record.
- `agent.assembleSession({ ctx, pageContext? })` — returns `{ systemPrompt, tools }` ready for `streamText` / `ToolLoopAgent`.

### Context

Type-parameterized `ToolContext<TContextExt>`. Oliver provides the base (`orgId`, `userId`, `source`). Builder extends with anything else (`slug`, `db`, `logger`, whatever). Fully typed end-to-end.

### HITL (Human-in-the-loop)

```ts
defineTool({
  requiresApproval: true,
  previewChange: async ({ input, ctx }) => ({
    before: { total: 100 },
    after: { total: 90 },
  }),
  execute: async ({ input, ctx }) => { /* runs ONLY after Approve click */ },
});
```

When the agent calls the tool, Oliver:
1. Computes preview (best-effort — preview failure doesn't block the card).
2. Inserts a row in `oliver.pending_tools` with status `pending_approval`.
3. Returns `awaiting_approval` + `pendingToolId` to the LLM.

Your UI queries `agent.listPendingTools(orgId)` and renders cards. Generic approve/reject server actions are exposed:

```ts
"use server";
export const approvePendingToolAction = (input, ctx) =>
  oliver.approvePendingTool(input, ctx);
export const rejectPendingToolAction = (input, ctx) =>
  oliver.rejectPendingTool(input, ctx);
```

Approve → Oliver re-checks precondition, runs execute, updates pending row, audits the full lifecycle.

Re-invocation guard (DB level): if the LLM proposes the same action again while a pending row is still active, Oliver returns the existing `pendingToolId` instead of creating a duplicate card.

### Precondition

Domain-invariant check that runs at every point state could diverge: before preview, before execute (non-HITL), before insert into pending_tools (HITL propose), and again at approve time.

```ts
precondition: async ({ input, ctx }) => {
  const quote = await loadQuote(input.quoteId, ctx.orgId);
  if (quote.status !== "draft") {
    throw new ToolError({
      code: "conflict",
      toolName: "applyDiscount",
      message: "Quote is not in draft; create a new version first.",
    });
  }
},
```

Throwing `ToolError` blocks the call. No approval card is rendered for a blocked HITL proposal. Re-checks at approve time catch the classic race: user proposes at 10:00, another tab publishes the quote at 10:05, user clicks Approve at 10:10 and the stale call is blocked cleanly.

### Concurrency

```ts
concurrencyKey: ({ input }) => `quote:${input.quoteId}`,
```

Calls deriving the same key serialize at execute time. Different keys stay parallel. Module-level mutex, FIFO queue per key. Errors release the lock (no deadlock).

Process-level scope — each Node process has its own registry. In Vercel serverless that's per-request isolation; the mutex catches the LLM calling the same tool twice in parallel within one turn. Multi-instance production against shared state needs DB advisory locks; tracked as v0.1.

### Verify

```ts
verify: async ({ input, result, ctx }) => {
  const [row] = await ctx.db.select()...
  return row.status === "expected";
},
```

Runs AFTER execute. `true` → audit records `verified`. `false` → `failed_verification`. 5s hard timeout → `verification_skipped` (not counted as failure). Never throws.

### Audit

Every lifecycle event is written to `oliver.audit_log`:

| Status | When |
|---|---|
| `invoked` | execute() starts |
| `pending_approval` | HITL card inserted |
| `approved` / `rejected` | User clicked |
| `succeeded` / `failed` | execute() returned |
| `verified` / `failed_verification` / `verification_skipped` | After verify hook |

Rows are grouped by `traceId` (non-HITL) or linked via `pendingToolId` (HITL). Writes are non-throwing — a failed audit insert falls through to `onAuditFailure` (default: `console.error`). Losing business state to save audit state would be worse.

### Session dedup

Inside one `buildAgentTools()` call, a `Map<toolName:inputHash, result>` caches the first response. If the LLM calls the same tool with the same input twice in one turn, the second call returns the cached result without touching the DB. Catches the "let me confirm by calling again" failure mode from cheaper models.

---

## Instructions

Oliver loads layered markdown files from a directory and splits them into a stable system-prompt prefix. Four files, progressive disclosure:

- `SOUL.md` — voice, boundaries, non-negotiable rules
- `domain.md` — concepts, entities, vocabulary
- `playbook.md` — workflows, protocols (DISCOVER → SUMMARIZE → EXECUTE, etc.)
- `lessons.md` — learned corrections across sessions

Loaded once at module init. Dev server restart picks up edits (reading files per turn would invalidate KV-cache).

```ts
const instructions = await loadInstructions(path.join(process.cwd(), "instructions"));
```

---

## Database schema

Oliver's tables live in a dedicated `oliver` Postgres schema (not `public`):

```sql
oliver.pending_tools    -- HITL state machine
oliver.audit_log         -- invocation + verification log
```

Both exported from `oliver-agent` as Drizzle tables. Add to your `drizzle.config.ts` schema paths, run `drizzle-kit generate` + `migrate`, done.

Same database as your app — you get cross-schema transactional atomicity for free (business write + audit write in one commit if you want).

---

## Live example

Oliver was built alongside **Kotte CPQ** (a B2B monetization SaaS). The Kotte codebase in this monorepo is the reference adopter:

- `apps/app/tools/` — 12 production tools covering reads, writes, HITL, precondition, concurrencyKey, verify
- `apps/app/app/actions/oliver-approvals.ts` — approve/reject server actions (thin async wrappers)
- `apps/app/components/approval-card.tsx` — HITL card UI (styled for midday.ai brutalist-minimal)
- `apps/app/instructions/` — SOUL/domain/playbook/lessons for the Kotte agent

---

## Testing

```bash
pnpm test             # 97 tests (unit + integration)
pnpm demo:mutex       # CLI proof of concurrencyKey serialization
pnpm typecheck
```

---

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for v0.1 candidates (subagent primitive, MCP channel, DB advisory locks, approval card React component, etc.) and explicit non-goals.

---

## License

Part of the Kotte monorepo during v0 development. MIT license planned at spin-off. Open-source intent from day 1 — schema, API surface, and file layout all designed for a clean `git subtree split` into a standalone repo.
