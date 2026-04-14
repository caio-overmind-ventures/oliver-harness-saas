# Oliver

> 🇧🇷 [**Versão em português**](#versão-em-português) (rola pro fim)

Oliver is a TypeScript harness for embedding LLM-powered agents inside multi-tenant SaaS products. You define a tool once; Oliver routes it to your UI buttons (as a Next.js server action) and to your chat agent (as a Vercel AI SDK tool). Approval gates, audit log, domain invariant checks, and per-resource concurrency control come included.

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

That single definition ships through both channels, enforces the "published quote is read-only" invariant at every step, blocks races on the same quote, shows a before/after card in the chat, runs only after a human click, and double-checks the DB after.

---

## Install

Two paths to the same end-state. Pick what fits your workflow.

### Option A — AI coding agent (~2 min)

If you already work with Claude Code, Codex, or Cursor, tell your agent:

> "Install Oliver in this project — follow the instructions at https://raw.githubusercontent.com/caio-overmind-ventures/oliver-harness-saas/main/INSTALL.md"

Your agent reads [INSTALL.md](./INSTALL.md), detects your stack (auth lib, ORM setup, project layout), generates the files, runs the migration, and reports back.

### Option B — Manual (~15 min)

8 steps you run yourself. See [Manual install](#manual-install) further down.

---

## Background

Oliver was built after studying a set of agent harnesses across two scopes.

**Coding agents (most public references):**
- [Codex](https://github.com/openai/codex) — OpenAI's terminal coding agent (Rust)
- [Claude Code](https://www.anthropic.com/engineering/harness-design-long-running-apps) — Anthropic's coding CLI; closed source but heavily documented
- [OpenClaude](https://github.com/Gitlawb/openclaude) — TypeScript Claude Code clone
- [walkinglabs / learn-harness-engineering](https://github.com/walkinglabs/learn-harness-engineering) — the verification-first principle

**Generalist personal-AI harnesses (Pi → OpenClaw → Hermes lineage):**
- [Pi](https://github.com/badlogic/pi-mono) — Mario Zechner's minimal coding-agent harness
- [OpenClaw](https://github.com/openclaw/openclaw) — embeds Pi, adds bootstrap files (SOUL/AGENTS/USER/IDENTITY/TOOLS) + multi-channel
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research's successor to OpenClaw

**Plus:** [Manus](https://manus.im/) on prefix-cache economics (~10x cost reduction with stable system-prompt prefix).

### What we borrowed (with attribution)

| Pattern | Source | Where it lives in Oliver |
|---|---|---|
| Verification-first ("only passing verify counts as done") | walkinglabs | `verify` hook with 5s timeout |
| Stable prefix + mutable suffix for KV-cache | Manus | `Context` system-prompt assembly |
| Layered markdown instructions (`SOUL.md`, `AGENTS.md`-style) | OpenClaw / Hermes | `Instructions` component (SOUL/domain/playbook/lessons) |
| Subagent isolation with own tool allowlist | Claude Code | Roadmap v0.1 candidate |
| Hooks pipeline (Pre/PostToolUse) for extensibility | Claude Code / Pi / OpenClaude | Roadmap v0.1 candidate |
| Tool interface split (validate vs permission gate) | OpenClaude | Implicit in `precondition` + execute |
| Approval × capability as orthogonal axes | Codex | Roadmap v0.1 candidate (richer than current binary `requiresApproval`) |
| Tool discoverability tools (`tool_search`) | Codex / OpenClaude | Roadmap, kicks in when tools >30 |
| Progressive disclosure of skills | Pi / OpenClaude / Codex | Roadmap |

### What's Oliver-original

None of the studied harnesses target multi-tenant SaaS with first-class B2B concerns. So:

- **Audit log as a primitive** — none of them have one. Oliver writes every lifecycle event (`invoked`, `approved`, `succeeded`, `verified`, etc.) to `oliver.audit_log` with non-throwing writes and a pluggable `onAuditFailure` handler.
- **Multi-tenancy by design** — `orgId` / `userId` flow through every tool call from the start. Cross-tenant calls are impossible by construction.
- **Dual-channel Gateway** — same `defineTool` definition routes to a Next.js server action (UI buttons) AND a Vercel AI SDK tool (chat agent). No duplicated business logic.
- **DB-backed HITL state machine** — `oliver.pending_tools` table with re-invocation guard (LLM proposing the same action twice in flight returns the existing card, not a duplicate).
- **`precondition` hook at every divergence point** — runs before preview, before execute, before pending insert, AND again at approve time. Catches the classic "stale state between propose and approve" race.
- **`concurrencyKey` mutex** — process-level FIFO queue per key. Two LLM calls hitting the same `quote:abc` resource serialize at execute time without the builder writing any locking code.

---

## Architecture

Oliver is six components, each with a focused job:

| Component | What it does |
|---|---|
| **Tools** | Atomic operations defined via `defineTool()` with Zod schemas. |
| **Gateway** | Routes one tool to multiple channels: Next.js server action, Vercel AI SDK tool, MCP (v0.1). |
| **Context** | Assembles the system prompt from instructions + tool list. KV-cache-friendly stable prefix. |
| **Approval Gates** | DB-backed state machine for tools marked `requiresApproval: true`. |
| **Audit** | Every lifecycle event written to `oliver.audit_log` with non-throwing writes. |
| **Instructions** | Layered markdown (SOUL → domain → playbook → lessons) loaded once at boot. |

How they fit together:

```
defineTool() ─┐
              ├─► Gateway ──► Server Action  (UI buttons)
Instructions ─┤            └► Agent Tool      (chat LLM)
              │            └► MCP             (v0.1)
   ┌──────────┴────────┐
   ▼                   ▼
Context              Approval Gates ──► Audit
(system prompt)      (HITL state)       (oliver.audit_log)
```

The builder writes tools and instructions. Oliver does the rest: builds the system prompt, routes each invocation to the right channel, intercepts HITL tools through the approval state machine, and records every step. Reads/writes share the same Postgres database as your app via the dedicated `oliver` schema, so cross-schema transactions work.

What Oliver is **not**: a workflow engine, a chat UI library, an auth solution, or a model-routing layer. It's the harness between *your* domain logic and *the LLM*.

---

## Manual install

The 8-step path. Same end-state as the AI install above; pick this if you don't have an AI coding agent in your workflow or want to drive each step yourself. ~15 minutes. Assumes you have a Next.js 15+ app with Drizzle + Postgres.

### 1. Install

```bash
pnpm add oliver-agent ai zod drizzle-orm
```

### 2. Schema

Add Oliver's tables to `drizzle.config.ts`:

```ts
schema: [
  "./src/db/schema.ts",
  "./node_modules/oliver-agent/src/db/schema.ts",
],
```

Then `pnpm drizzle-kit generate && pnpm drizzle-kit migrate`. Creates `oliver.pending_tools` + `oliver.audit_log` in a separate Postgres schema.

### 3. Create the agent

```ts
// lib/oliver.ts
import "server-only";
import { createAgent, loadInstructions } from "oliver-agent";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { database } from "@/db";
import { allTools } from "@/tools";

const instructions = await loadInstructions("./instructions");

export const oliver = createAgent({
  tools: allTools,
  instructions,
  db: database,
  resolveServerActionContext: async (override) => {
    const session = await auth.getSession({ headers: await headers() });
    if (!session) throw new Error("Not authenticated");
    return {
      orgId: await resolveOrgId(override?.slug),
      userId: session.user.id,
      source: "ui",
      slug: override?.slug,
    };
  },
});
```

`ctx` is fully typed — extend with anything your tools need (`db`, `logger`, flags, etc.).

### 4. Define your first tool

```ts
// tools/createCustomer.ts
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
    const id = generateId.customer();
    await database.insert(customers).values({
      id, organizationId: ctx.orgId, name: input.name, email: input.email ?? null,
    });
    return { id, name: input.name };
  },
});
```

```ts
// tools/index.ts
import { createCustomer } from "./createCustomer";
export const allTools = [createCustomer] as const;
export { createCustomer };
```

### 5. Expose as a server action

```ts
// actions/customers.ts
"use server";
import { oliver } from "@/lib/oliver";
import { createCustomer } from "@/tools";
export const createCustomerAction = oliver.serverAction(createCustomer);
```

Call from any client component: `await createCustomerAction({ name: "Acme" }, { slug })`.

### 6. Wire the chat route

```ts
// app/api/chat/route.ts
import { ToolLoopAgent, createAgentUIStreamResponse, stepCountIs } from "@repo/ai";
import { oliver } from "@/lib/oliver";

export async function POST(req: Request) {
  const session = await auth.getSession({ headers: await headers() });
  const { messages, context } = await req.json();

  const oliverSession = oliver.assembleSession({
    ctx: { orgId: await resolveOrgId(context.orgSlug), userId: session.user.id, source: "agent", slug: context.orgSlug },
    pageContext: { route: context.page },
  });

  const agent = new ToolLoopAgent({
    model: models.chat,
    instructions: oliverSession.systemPrompt,
    tools: oliverSession.tools,
    stopWhen: stepCountIs(25),
  });

  return createAgentUIStreamResponse({ agent, uiMessages: messages });
}
```

### 7. Chat UI

Oliver doesn't ship a chat UI. Pick one: [assistant-ui](https://www.assistant-ui.com/), [Shadcn chat](https://shadcn-chat.vercel.app/), or roll your own with `useChat` from `@ai-sdk/react`.

### 8. Approval card (when you ship a HITL tool)

When a tool has `requiresApproval: true`, its result becomes `{ status: "awaiting_approval", pendingToolId, ... }`. Two pieces:

```ts
// actions/oliver-approvals.ts
"use server";
import { oliver } from "@/lib/oliver";

export async function approvePendingToolAction(input, ctx) {
  return oliver.approvePendingTool(input, ctx);
}
export async function rejectPendingToolAction(input, ctx) {
  return oliver.rejectPendingTool(input, ctx);
}
```

Plus a component that detects the shape and renders Approve/Reject buttons. Reference implementation: ~120 LOC headless React.

That's it. Each new tool ships through both channels, gets audit + HITL + concurrency for free.

---

## What you bring

| Concern | Pick |
|---|---|
| Chat UI | assistant-ui, Shadcn chat, custom |
| Authentication | better-auth, Clerk, NextAuth, Supabase Auth |
| Database + ORM | Drizzle + Postgres (Neon recommended) |
| LLM model config | [Vercel AI SDK](https://sdk.vercel.ai) + provider key |
| Approval card UI | One ~120 LOC component |

A future `create-oliver-app` template will pre-cable an opinionated stack (see Roadmap).

---

## Component deep-dive

### Tools

```ts
defineTool<typeof inputSchema, OutputType, ContextExt>({
  name, description, input,
  execute: async ({ input, ctx }) => ...,
  // optional:
  precondition, concurrencyKey, requiresApproval, previewChange, verify,
});
```

Sub-features layered on a tool:

- **`precondition`** — domain invariant check at every divergence point. Throws `ToolError` to block. Catches "stale state between propose and approve" races.
- **`concurrencyKey`** — `({ input }) => "quote:" + input.id` serializes same-key `execute()` calls process-wide. FIFO queue per key, deadlock-safe.
- **`verify`** — runs after execute to confirm DB matches. 5s timeout. Logged to audit (`verified` / `failed_verification` / `verification_skipped`).
- **`previewChange`** — only invoked for HITL; produces the before/after diff on the approval card.

### Gateway

Three entry points off `agent`:

- **`agent.serverAction(tool)`** — `(input, ctxOverride?) => Promise<ActionResult>`. Wrap in `"use server"`.
- **`agent.agentTools({ ctx })`** — Vercel AI SDK tool record bound to session context.
- **`agent.assembleSession({ ctx, pageContext? })`** — `{ systemPrompt, tools }` together. Recommended for chat routes.

### Context

`ToolContext<TContextExt>` is type-parameterized. Oliver provides the base (`orgId`, `userId`, `source`); the builder extends. System prompt = stable prefix (instructions + tool list + tenant) cached by providers + mutable suffix (page context, pending approvals) per turn. ~10x cost reduction on long sessions (Manus-pattern).

### Approval Gates (HITL)

When the agent calls a `requiresApproval: true` tool:

1. Compute preview (best-effort).
2. Insert row in `oliver.pending_tools` with status `pending_approval`.
3. Return `awaiting_approval` + `pendingToolId` to the LLM.

UI queries `agent.listPendingTools(orgId)`, renders cards. Approve → re-checks precondition → runs execute → updates pending row → audits full lifecycle. Re-invocation guard: same action while pending returns the existing `pendingToolId`.

### Audit

| Status | When |
|---|---|
| `invoked` | execute() starts |
| `pending_approval` | HITL card inserted |
| `approved` / `rejected` | User clicked |
| `succeeded` / `failed` | execute() returned |
| `verified` / `failed_verification` / `verification_skipped` | After verify hook |

Rows grouped by `traceId` (non-HITL) or linked via `pendingToolId` (HITL). Writes are non-throwing — failed insert falls through to `onAuditFailure` (default: `console.error`).

### Instructions

Layered markdown loaded once at module init (SOUL.md naming inspired by OpenClaw/Hermes, structure adapted for SaaS):

- `SOUL.md` — voice, boundaries, non-negotiable rules
- `domain.md` — concepts, entities, vocabulary
- `playbook.md` — workflows (DISCOVER → SUMMARIZE → EXECUTE)
- `lessons.md` — learned corrections across sessions

Edits require dev server restart — reading per turn would invalidate KV-cache.

---

## Database

Tables in a dedicated `oliver` Postgres schema (not `public`):

```sql
oliver.pending_tools    -- HITL state machine
oliver.audit_log         -- invocation + verification log
```

Same database as your app — cross-schema transactional atomicity available.

---

## Testing

```bash
pnpm test             # 97 tests
pnpm demo:mutex       # CLI proof of concurrencyKey serialization
pnpm typecheck
```

---

## Roadmap

Full detail in [ROADMAP.md](./ROADMAP.md). Quick view:

**v0.1 candidates** (likely):
- **Subagent primitive** — a tool spawns a scoped LLM loop with a subset of tools. Atomic compound flows, isolated context. (Claude Code Task pattern.)
- **Hooks pipeline** — Pre/PostToolUse extensibility seam. Approval Gates becomes one hook implementation among many. (Claude Code / OpenClaude / Pi pattern.)
- **MCP channel** — expose tools as Model Context Protocol endpoints for external agents (Claude Desktop, Cursor, etc.).
- **DB advisory locks** — replace process-level `concurrencyKey` mutex with `pg_advisory_xact_lock` for multi-instance deployments.
- **Approval card React component** — headless, ship the ~120 LOC pattern as a reusable primitive.
- **`create-oliver-app` template** — opinionated Next.js + Drizzle + assistant-ui starter.

**v0.2 exploratory:**
- Granular permission policy (allow/ask/deny per tool, source-attributed) — richer than binary `requiresApproval`. (Codex / OpenClaude pattern.)
- Tool discoverability tools (`tool_search`, `tool_suggest`) — kicks in when tools >30. (Codex / OpenClaude pattern.)
- Pending approval expiration cron.
- User modeling (Honcho-style dialectic).

**Explicit non-goals:** workflow engine (use Temporal/Inngest), chat UI library, auth solution, hosted control plane, generic CRUD generation.

---

## License

MIT. See [LICENSE](./LICENSE).

---

<a id="versão-em-português"></a>

# 🇧🇷 Versão em português

> [↑ English version](#oliver)

Oliver é um harness em TypeScript para embedar agentes LLM dentro de produtos SaaS multi-tenant. Você define uma tool uma vez; Oliver entrega ela como server action do Next.js (pros botões da UI) e como tool do Vercel AI SDK (pro chat agent). Approval gates, audit log, checagem de invariantes de domínio e controle de concorrência por recurso vêm inclusos.

```ts
defineTool({
  name: "applyDiscount",
  description: "Aplica desconto percentual em uma cotação.",
  input: z.object({ quoteNumber: z.string(), percent: z.number() }),
  requiresApproval: true,
  precondition: async ({ input }) => assertDraft(input.quoteNumber),
  concurrencyKey: ({ input }) => `quote:${input.quoteNumber}`,
  previewChange: async ({ input }) => buildDiff(input),
  execute: async ({ input }) => applyDiscountToDB(input),
  verify: async ({ input, result }) => checkDBMatches(result),
});
```

Essa única definição roda nos dois canais, garante a invariante "cotação publicada é read-only" em todo passo, bloqueia race em chamadas paralelas na mesma cotação, mostra um card before/after no chat, só executa depois do clique humano, e confere o DB depois.

## Instalação

Dois caminhos pro mesmo end-state. Escolhe o que combina com seu workflow.

### Opção A — Coding agent (~2 min)

Se você já trabalha com Claude Code, Codex ou Cursor, fala pro seu agent:

> "Instala o Oliver nesse projeto — segue as instruções em https://raw.githubusercontent.com/caio-overmind-ventures/oliver-harness-saas/main/INSTALL.md"

Seu agent lê [INSTALL.md](./INSTALL.md), detecta seu stack (lib de auth, setup do ORM, layout do projeto), gera os arquivos, roda a migration, e te reporta.

### Opção B — Manual (~15 min)

8 passos que você executa. Veja [Install manual](#install-manual) mais abaixo.

## Background

Oliver foi construído depois de estudar um conjunto de harnesses de agente em dois escopos.

**Coding agents (mais referência pública):**
- [Codex](https://github.com/openai/codex) — coding agent terminal da OpenAI (Rust)
- [Claude Code](https://www.anthropic.com/engineering/harness-design-long-running-apps) — CLI da Anthropic; closed source mas amplamente documentado
- [OpenClaude](https://github.com/Gitlawb/openclaude) — clone TypeScript do Claude Code
- [walkinglabs / learn-harness-engineering](https://github.com/walkinglabs/learn-harness-engineering) — princípio verification-first

**Generalist personal-AI harnesses (lineage Pi → OpenClaw → Hermes):**
- [Pi](https://github.com/badlogic/pi-mono) — harness minimal de coding agent do Mario Zechner
- [OpenClaw](https://github.com/openclaw/openclaw) — embeda Pi, adiciona bootstrap files (SOUL/AGENTS/USER/IDENTITY/TOOLS) + multi-canal
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — sucessor da Nous Research pro OpenClaw

**Mais:** [Manus](https://manus.im/) sobre economia de prefix-cache (~10x redução de custo com prefixo de system prompt estável).

### O que pegamos emprestado (com atribuição)

| Padrão | Fonte | Onde vive no Oliver |
|---|---|---|
| Verification-first ("only passing verify counts as done") | walkinglabs | Hook `verify` com timeout 5s |
| Prefixo estável + sufixo mutável pro KV-cache | Manus | Montagem do system prompt no `Context` |
| Layered markdown instructions (`SOUL.md`, estilo `AGENTS.md`) | OpenClaw / Hermes | Componente `Instructions` (SOUL/domain/playbook/lessons) |
| Subagent isolado com tool allowlist próprio | Claude Code | Candidato no Roadmap v0.1 |
| Hooks pipeline (Pre/PostToolUse) pra extensibilidade | Claude Code / Pi / OpenClaude | Candidato no Roadmap v0.1 |
| Tool interface split (validate vs permission gate) | OpenClaude | Implícito em `precondition` + execute |
| Approval × capability como eixos ortogonais | Codex | Candidato no Roadmap v0.1 (mais rico que o binário `requiresApproval`) |
| Tool discoverability tools (`tool_search`) | Codex / OpenClaude | Roadmap, ativa quando tools >30 |
| Progressive disclosure de skills | Pi / OpenClaude / Codex | Roadmap |

### O que é Oliver-original

Nenhum dos harnesses estudados mira SaaS multi-tenant com concerns B2B first-class. Então:

- **Audit log como primitivo** — nenhum tem. Oliver escreve todo evento de lifecycle (`invoked`, `approved`, `succeeded`, `verified`, etc.) em `oliver.audit_log` com writes non-throwing e handler `onAuditFailure` plugável.
- **Multi-tenancy by design** — `orgId` / `userId` fluem por toda tool call desde o início. Chamadas cross-tenant são impossíveis por construção.
- **Dual-channel Gateway** — mesma definição `defineTool` roteia pra server action Next.js (botões UI) E tool Vercel AI SDK (chat). Sem lógica duplicada.
- **State machine HITL no DB** — tabela `oliver.pending_tools` com re-invocation guard (LLM propondo a mesma ação duas vezes em voo retorna o card existente, não duplicado).
- **Hook `precondition` em todo divergence point** — roda antes de preview, antes de execute, antes de pending insert, E DE NOVO no approve. Pega o race clássico "estado mudou entre propose e approve".
- **Mutex `concurrencyKey`** — FIFO queue por key no nível do processo. Duas chamadas LLM no mesmo `quote:abc` serializam no execute sem o builder escrever locking.

## Arquitetura

Seis componentes:

| Componente | O que faz |
|---|---|
| **Tools** | Operações atômicas via `defineTool()` com schemas Zod. |
| **Gateway** | Roteia uma tool pra múltiplos canais: server action Next.js, tool Vercel AI SDK, MCP (v0.1). |
| **Context** | Monta o system prompt das instructions + lista de tools. Prefixo estável KV-cache-friendly. |
| **Approval Gates** | State machine no DB pra tools com `requiresApproval: true`. |
| **Audit** | Todo evento de lifecycle escrito em `oliver.audit_log` com writes non-throwing. |
| **Instructions** | Markdown em camadas (SOUL → domain → playbook → lessons) carregado uma vez no boot. |

Como se conectam:

```
defineTool() ─┐
              ├─► Gateway ──► Server Action  (botões UI)
Instructions ─┤            └► Agent Tool      (chat LLM)
              │            └► MCP             (v0.1)
   ┌──────────┴────────┐
   ▼                   ▼
Context              Approval Gates ──► Audit
(system prompt)      (state HITL)       (oliver.audit_log)
```

O builder escreve tools e instructions. Oliver faz o resto: monta o system prompt, roteia cada invocação pro canal certo, intercepta tools HITL pelo state machine, registra cada passo. Reads/writes compartilham o mesmo Postgres da app pelo schema dedicado `oliver`, então transações cross-schema funcionam.

O que Oliver **não é**: workflow engine, biblioteca de chat UI, solução de auth, camada de routing de modelo.

## Install manual

O caminho de 8 passos. Mesmo end-state que o install com AI acima; escolhe esse se você não tem coding agent no workflow ou prefere dirigir cada passo. ~15 minutos. Assume Next.js 15+ com Drizzle + Postgres.

### 1. Instalar

```bash
pnpm add oliver-agent ai zod drizzle-orm
```

### 2. Schema

```ts
// drizzle.config.ts
schema: [
  "./src/db/schema.ts",
  "./node_modules/oliver-agent/src/db/schema.ts",
],
```

`pnpm drizzle-kit generate && pnpm drizzle-kit migrate`. Cria `oliver.pending_tools` + `oliver.audit_log`.

### 3. Criar o agent

```ts
// lib/oliver.ts
import "server-only";
import { createAgent, loadInstructions } from "oliver-agent";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { database } from "@/db";
import { allTools } from "@/tools";

const instructions = await loadInstructions("./instructions");

export const oliver = createAgent({
  tools: allTools,
  instructions,
  db: database,
  resolveServerActionContext: async (override) => {
    const session = await auth.getSession({ headers: await headers() });
    if (!session) throw new Error("Não autenticado");
    return {
      orgId: await resolveOrgId(override?.slug),
      userId: session.user.id,
      source: "ui",
      slug: override?.slug,
    };
  },
});
```

### 4. Definir sua primeira tool

```ts
// tools/createCustomer.ts
import { defineTool } from "oliver-agent";
import { z } from "zod";

export const createCustomer = defineTool({
  name: "createCustomer",
  description: "Cria um novo cliente na organização atual.",
  input: z.object({
    name: z.string().min(1).max(256),
    email: z.string().email().optional(),
  }),
  execute: async ({ input, ctx }) => {
    const id = generateId.customer();
    await database.insert(customers).values({
      id, organizationId: ctx.orgId, name: input.name, email: input.email ?? null,
    });
    return { id, name: input.name };
  },
});
```

```ts
// tools/index.ts
import { createCustomer } from "./createCustomer";
export const allTools = [createCustomer] as const;
export { createCustomer };
```

### 5. Expor como server action

```ts
// actions/customers.ts
"use server";
import { oliver } from "@/lib/oliver";
import { createCustomer } from "@/tools";
export const createCustomerAction = oliver.serverAction(createCustomer);
```

Chama de qualquer client component: `await createCustomerAction({ name: "Acme" }, { slug })`.

### 6. Wire da rota de chat

```ts
// app/api/chat/route.ts
import { ToolLoopAgent, createAgentUIStreamResponse, stepCountIs } from "@repo/ai";
import { oliver } from "@/lib/oliver";

export async function POST(req: Request) {
  const session = await auth.getSession({ headers: await headers() });
  const { messages, context } = await req.json();

  const oliverSession = oliver.assembleSession({
    ctx: { orgId: await resolveOrgId(context.orgSlug), userId: session.user.id, source: "agent", slug: context.orgSlug },
    pageContext: { route: context.page },
  });

  const agent = new ToolLoopAgent({
    model: models.chat,
    instructions: oliverSession.systemPrompt,
    tools: oliverSession.tools,
    stopWhen: stepCountIs(25),
  });

  return createAgentUIStreamResponse({ agent, uiMessages: messages });
}
```

### 7. Chat UI

Oliver não traz chat UI. Escolha: [assistant-ui](https://www.assistant-ui.com/), [Shadcn chat](https://shadcn-chat.vercel.app/), ou faz o seu com `useChat` de `@ai-sdk/react`.

### 8. Approval card (quando entregar uma tool HITL)

Quando uma tool tem `requiresApproval: true`, o resultado vira `{ status: "awaiting_approval", pendingToolId, ... }`. Duas peças:

```ts
// actions/oliver-approvals.ts
"use server";
import { oliver } from "@/lib/oliver";

export async function approvePendingToolAction(input, ctx) {
  return oliver.approvePendingTool(input, ctx);
}
export async function rejectPendingToolAction(input, ctx) {
  return oliver.rejectPendingTool(input, ctx);
}
```

E um componente que detecta a shape e renderiza botões Approve/Reject. Implementação de referência: ~120 LOC de React headless.

Pronto. Cada nova tool entrega nos dois canais, ganha audit + HITL + concurrency de graça.

## O que você traz

| Concern | Escolha |
|---|---|
| Chat UI | assistant-ui, Shadcn chat, custom |
| Autenticação | better-auth, Clerk, NextAuth, Supabase Auth |
| Database + ORM | Drizzle + Postgres (Neon recomendado) |
| Config do modelo LLM | [Vercel AI SDK](https://sdk.vercel.ai) + chave do provider |
| Approval card UI | Um componente de ~120 LOC |

Um futuro template `create-oliver-app` vai pré-cabear um stack opinativo (ver Roadmap).

## Mergulho nos componentes

### Tools

```ts
defineTool<typeof inputSchema, OutputType, ContextExt>({
  name, description, input,
  execute: async ({ input, ctx }) => ...,
  // opcionais:
  precondition, concurrencyKey, requiresApproval, previewChange, verify,
});
```

Sub-features que se sobrepõem na tool:

- **`precondition`** — checagem de invariante de domínio em todo divergence point. Joga `ToolError` pra bloquear. Pega o race "estado mudou entre propose e approve".
- **`concurrencyKey`** — `({ input }) => "quote:" + input.id` serializa chamadas com mesma key no `execute()`. FIFO queue por key, deadlock-safe.
- **`verify`** — roda depois do execute pra confirmar DB. 5s timeout. Vai pro audit (`verified` / `failed_verification` / `verification_skipped`).
- **`previewChange`** — só invocado em HITL; produz o diff before/after no card.

### Gateway

Três pontos de entrada em `agent`:

- **`agent.serverAction(tool)`** — `(input, ctxOverride?) => Promise<ActionResult>`. Embrulha em `"use server"`.
- **`agent.agentTools({ ctx })`** — record de tools Vercel AI SDK ligado ao contexto da sessão.
- **`agent.assembleSession({ ctx, pageContext? })`** — `{ systemPrompt, tools }` juntos. Recomendado pra rotas de chat.

### Context

`ToolContext<TContextExt>` é parametrizado por tipo. Oliver fornece a base (`orgId`, `userId`, `source`); o builder estende. System prompt = prefixo estável (instructions + tools + tenant) cacheado pelos providers + sufixo mutável (page context, pending approvals) por turn. ~10x redução de custo em sessões longas (padrão Manus).

### Approval Gates (HITL)

Quando o agent chama tool com `requiresApproval: true`:

1. Computa preview (best-effort).
2. Insere row em `oliver.pending_tools` com status `pending_approval`.
3. Retorna `awaiting_approval` + `pendingToolId` pro LLM.

UI consulta `agent.listPendingTools(orgId)`, renderiza cards. Approve → re-checa precondition → roda execute → atualiza pending row → loga lifecycle no audit. Re-invocation guard: mesma ação enquanto pending retorna o `pendingToolId` existente.

### Audit

| Status | Quando |
|---|---|
| `invoked` | execute() começa |
| `pending_approval` | Card HITL inserido |
| `approved` / `rejected` | Usuário clicou |
| `succeeded` / `failed` | execute() retornou |
| `verified` / `failed_verification` / `verification_skipped` | Após verify |

Rows agrupados por `traceId` (não-HITL) ou linkados via `pendingToolId` (HITL). Writes non-throwing — insert que falha cai em `onAuditFailure` (default: `console.error`).

### Instructions

Markdown em camadas carregado uma vez no module init (naming SOUL.md inspirado em OpenClaw/Hermes, estrutura adaptada pra SaaS):

- `SOUL.md` — voz, boundaries, regras não-negociáveis
- `domain.md` — conceitos, entidades, vocabulário
- `playbook.md` — workflows (DISCOVER → SUMMARIZE → EXECUTE)
- `lessons.md` — correções aprendidas entre sessões

Edits exigem restart do dev server — leitura por turn invalidaria o KV-cache.

## Database

Tabelas em schema Postgres dedicado `oliver` (não `public`):

```sql
oliver.pending_tools    -- state machine HITL
oliver.audit_log         -- log de invocação + verificação
```

Mesmo banco da app — atomicidade transacional cross-schema disponível.

## Testing

```bash
pnpm test             # 97 testes
pnpm demo:mutex       # prova CLI de serialização do concurrencyKey
pnpm typecheck
```

## Roadmap

Detalhe completo em [ROADMAP.md](./ROADMAP.md). Resumo:

**Candidatos v0.1** (prováveis):
- **Primitivo de subagent** — uma tool spawna um loop LLM com escopo de tools restrito. Compound flows atômicos, contexto isolado. (Padrão Task do Claude Code.)
- **Hooks pipeline** — seam de extensibilidade Pre/PostToolUse. Approval Gates vira uma implementação de hook entre várias. (Padrão Claude Code / OpenClaude / Pi.)
- **Canal MCP** — expor tools como endpoints Model Context Protocol pra agentes externos (Claude Desktop, Cursor, etc.).
- **DB advisory locks** — substituir mutex `concurrencyKey` process-level por `pg_advisory_xact_lock` pra deployments multi-instância.
- **Componente React de approval card** — headless, entregar o pattern de ~120 LOC como primitivo reutilizável.
- **Template `create-oliver-app`** — starter Next.js + Drizzle + assistant-ui pré-cabeado.

**v0.2 exploratório:**
- Permission policy granular (allow/ask/deny por tool, com source attribution) — mais rico que `requiresApproval` binário. (Padrão Codex / OpenClaude.)
- Tool discoverability tools (`tool_search`, `tool_suggest`) — ativa quando tools >30. (Padrão Codex / OpenClaude.)
- Cron de expiração de pending approvals.
- User modeling (Honcho-style dialectic).

**Non-goals explícitos:** workflow engine (use Temporal/Inngest), biblioteca de chat UI, solução de auth, control plane hosted, geração CRUD genérica.

## Licença

MIT. Veja [LICENSE](./LICENSE).
