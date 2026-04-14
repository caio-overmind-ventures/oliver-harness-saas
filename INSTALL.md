# Install Oliver in this project

> **For LLM coding agents** (Claude Code, Codex, Cursor, Cline, etc.) to read and execute.
> Human readers should follow [README.md → Getting started](./README.md#getting-started).

You are installing `oliver-agent` into the user's existing Next.js + Drizzle + Postgres SaaS. Execute the steps below in order. **Do not skip steps. Do not improvise file paths.** If a verification fails, STOP and tell the user.

---

## Prerequisites — verify before starting

Run all four checks. If any fails, STOP and report which are missing — do not attempt to install missing tooling on the user's behalf.

```bash
# 1. Inside a Next.js 15+ project
cat package.json | grep -E '"next":\s*"\^?1[5-9]'

# 2. Drizzle ORM is installed
cat package.json | grep -E '"drizzle-orm"'

# 3. drizzle.config.ts or drizzle.config.js exists
[ -f drizzle.config.ts ] || [ -f drizzle.config.js ] && echo "OK"

# 4. DATABASE_URL is configured
grep -h "DATABASE_URL" .env .env.local .env.development 2>/dev/null | head -1
```

If all four pass, proceed. If any fail, output:

> "Oliver requires Next.js 15+, Drizzle ORM, and a Postgres `DATABASE_URL`. The following prerequisites are missing: [list]. Install those first, then re-run this install."

---

## Step 1 — Install the package and its peer requirements

Detect the package manager (look for `pnpm-lock.yaml`, `bun.lock`, `yarn.lock`, or fall back to `npm`). Then run the equivalent of:

```bash
pnpm add oliver-agent ai zod server-only
pnpm add @ai-sdk/openai      # or @ai-sdk/anthropic, @ai-sdk/google, etc.
```

`oliver-agent` doesn't bundle `ai` or `zod` so the consumer's versions take precedence. `server-only` is used by `lib/oliver.ts` to assert the agent never gets imported into client bundles. The model-provider package is your choice.

Verify:

```bash
cat package.json | grep -E '"(oliver-agent|ai|zod|server-only)"'
```

---

## Step 2 — Add Oliver's schema to Drizzle config

Open `drizzle.config.ts` (or `.js`). The `schema` field is either a string or an array. Convert to array form and append Oliver's schema path.

**If the file currently has:**
```ts
schema: "./src/db/schema.ts"
```

**Change to:**
```ts
schema: [
  "./src/db/schema.ts",
  "./node_modules/oliver-agent/src/db/schema.ts",
]
```

**If it's already an array,** just append the Oliver path. The user's project schema path may be different (e.g. `./db/schema.ts`, `./lib/db/schema.ts`) — preserve whatever they had and ADD Oliver's path.

Verify:

```bash
cat drizzle.config.* | grep "oliver-agent/src/db/schema"
```

---

## Step 3 — Generate and apply the migration

```bash
pnpm drizzle-kit generate
pnpm drizzle-kit migrate
```

This creates two new tables in a dedicated `oliver` Postgres schema:

- `oliver.pending_tools` — HITL state machine
- `oliver.audit_log` — invocation log

Verify by inspecting the generated SQL or by querying the database:

```bash
psql "$DATABASE_URL" -c "\dt oliver.*"
```

If migration fails because the `oliver` schema doesn't exist, run:

```sql
CREATE SCHEMA IF NOT EXISTS oliver;
```

then retry the migrate command.

---

## Step 4 — Detect existing project conventions

Before generating files, detect these so you place files in the right paths:

Run each detection independently — do NOT chain with `&&` (a "no match" result is normal information, not failure):

| Detection | How |
|---|---|
| Source root (`src/` or root) | `[ -d src/app ] && echo "src" \|\| echo "root"` |
| Auth library | `cat package.json \| grep -E "better-auth\|@clerk\|next-auth\|@supabase/auth"` |
| Drizzle instance file | `grep -rl "drizzle(" src/db lib/db db 2>/dev/null \| head -1` |
| Database client | `cat package.json \| grep -E "@neondatabase/serverless\|\"pg\":"` |

Use the detected source root for all paths below. If `src/app` exists, prefix with `src/`. Otherwise place at root.

If auth library is **not** one of the four above, ASK USER:

> "Which auth library are you using? Oliver needs `userId` and an org/tenant identifier from the session. Common: better-auth, Clerk, NextAuth, Supabase Auth."

---

## Step 5 — Create `lib/oliver.ts`

Create the file at `<src>/lib/oliver.ts` (use the source root from Step 4):

```ts
import "server-only";
import { createAgent, loadInstructions } from "oliver-agent";
import { headers } from "next/headers";
import path from "node:path";
import { database } from "@/db";              // ← adjust to your Drizzle instance import
import { auth } from "@/lib/auth";            // ← adjust to your auth import
import { allTools } from "@/tools";

const instructions = await loadInstructions(
  path.join(process.cwd(), "instructions"),
);

export const oliver = createAgent({
  tools: allTools,
  instructions,
  db: database,
  resolveServerActionContext: async (override) => {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) throw new Error("Not authenticated");

    return {
      orgId: session.user.activeOrgId ?? session.user.id,
      userId: session.user.id,
      source: "ui",
      ...(override ?? {}),
    };
  },
});
```

`override` is for **caller-known extension context** (e.g., a `slug` from URL params), not for replacing base fields like `orgId` / `userId` — those always come from auth. If you need to extend the context with custom fields, define a type and pass it explicitly:

```ts
import type { ToolContext } from "oliver-agent";

type AppCtxExt = { slug?: string };
type AppCtx = ToolContext<AppCtxExt>;

export const oliver = createAgent<AppCtxExt>({ /* ... */ });
```

**Adapt this file to the user's auth lib:**

- **better-auth**: keep as-is (matches snippet)
- **Clerk**: replace `auth.api.getSession({...})` with `auth()` from `@clerk/nextjs/server`; use `userId` from there
- **NextAuth**: use `getServerSession(authOptions)`; map `session.user.id`
- **Supabase**: use `createServerClient(...)` and `supabase.auth.getUser()`

Pull `orgId` from whatever the user's app uses for tenant scoping. If they have no multi-tenancy, use `session.user.id` as `orgId` (single-user mode).

---

## Step 6 — Create the `tools/` directory with one sample tool

Create `<src>/tools/createCustomer.ts`:

```ts
import { defineTool } from "oliver-agent";
import { z } from "zod";
import { database } from "@/db";
// IMPORTANT: replace `customers` with whatever table the user actually has.
// If they don't have a customers table, generate the tool against the most
// obvious "creatable entity" in their schema (users? items? contacts?).
import { customers } from "@/db/schema";
import { revalidatePath } from "next/cache";

const inputSchema = z.object({
  name: z.string().min(1).max(256),
  email: z.string().email().optional(),
});

export const createCustomer = defineTool({
  name: "createCustomer",
  description: "Create a new customer record in the current organization.",
  input: inputSchema,
  execute: async ({ input, ctx }) => {
    const id = crypto.randomUUID();        // ← use the user's ID convention if they have one
    await database.insert(customers).values({
      id,
      organizationId: ctx.orgId,           // ← drop if single-tenant
      name: input.name,
      email: input.email ?? null,
    });
    revalidatePath("/customers");
    return { id, name: input.name };
  },
});
```

**Critical adaptations:**

- If the user has no `customers` table, pick the most obvious creatable entity from their schema and adapt the example. Tell the user what you picked and why.
- If they don't have multi-tenancy, drop the `organizationId` line and the `ctx.orgId` reference.
- If they have a custom ID generator (`generateId.customer()`, `nanoid()`, etc.), use it instead of `crypto.randomUUID()`.

Create `<src>/tools/index.ts`:

```ts
import { createCustomer } from "./createCustomer";

export const allTools = [createCustomer] as const;
export { createCustomer };
```

---

## Step 7 — Create the chat route

Create `<src>/app/api/chat/route.ts`:

```ts
import { headers } from "next/headers";
import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";   // or @ai-sdk/anthropic, etc.
import { auth } from "@/lib/auth";
import { oliver } from "@/lib/oliver";

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { messages } = await req.json();

  const oliverSession = oliver.assembleSession({
    ctx: {
      orgId: session.user.activeOrgId ?? session.user.id,
      userId: session.user.id,
      source: "agent",
    },
  });

  const result = streamText({
    model: openai("gpt-5.1"),                        // ← swap to your model
    system: oliverSession.systemPrompt,
    tools: oliverSession.tools,
    messages: await convertToModelMessages(messages), // UIMessage → ModelMessage (async in ai@6)
    stopWhen: stepCountIs(25),                       // multi-step tool loop
  });

  return result.toUIMessageStreamResponse();
}
```

Adapt the auth import + the model provider import to whatever the user has installed. The `ai` SDK API above is for `ai@6.x` — earlier versions used `maxSteps` and `toDataStreamResponse()` instead.

If the user already has a chat route at `/api/chat`, ASK USER:

> "You already have an `/api/chat` route. Should I (a) replace it with the Oliver-wired version above, (b) merge — keeping your existing logic but adding Oliver's tools, or (c) put the new route at a different path like `/api/oliver-chat`?"

---

## Step 8 — Create the instructions directory

Create four placeholder files at `<project_root>/instructions/`:

`SOUL.md`:
```markdown
# Agent voice

You are the AI assistant inside this product. Be concise and direct. Always respond in the user's language.

(Replace this with your product's voice, boundaries, and non-negotiable rules.)
```

`domain.md`:
```markdown
# Domain knowledge

(Describe your product's core entities, vocabulary, and key invariants here.)
```

`playbook.md`:
```markdown
# Workflows

(Describe step-by-step protocols the agent should follow for common requests.)
```

`lessons.md`:
```markdown
# Lessons learned

(Empty initially. Append corrections from real conversations here.)
```

---

## Step 9 — Verify the install

Run typecheck and any existing tests:

```bash
pnpm typecheck
pnpm test 2>/dev/null || echo "No tests configured — that's fine."
```

Start the dev server and test the chat route from a client:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: <user's auth cookie>" \
  -d '{"messages":[{"role":"user","content":"create a customer named Test Co"}]}'
```

Expected: streaming response that includes a tool call to `createCustomer` and a confirmation message.

---

## What you DID NOT install

Tell the user the following are NOT included and they need to add them separately:

1. **Chat UI** — Oliver doesn't ship a chat panel. Recommend [assistant-ui](https://www.assistant-ui.com/) or [Shadcn chat](https://shadcn-chat.vercel.app/).
2. **Approval card component** — only needed when shipping a HITL tool (`requiresApproval: true`). Reference implementation is ~120 LOC of headless React; pattern in [README.md → Getting started step 8](./README.md#8-approval-card-when-you-ship-a-hitl-tool).
3. **More tools** — `createCustomer` is one example. Add more under `tools/` and register them in `tools/index.ts`.

---

## Final report to user

After executing all steps, tell the user EXACTLY this (substituting the bracketed bits):

> "Oliver is installed.
>
> **Files created:**
> - `lib/oliver.ts` (agent instance)
> - `tools/createCustomer.ts` (sample tool — [adaptation note if you swapped the entity])
> - `tools/index.ts` (tool registry)
> - `app/api/chat/route.ts` (chat endpoint)
> - `instructions/SOUL.md`, `domain.md`, `playbook.md`, `lessons.md` (placeholders)
>
> **Files modified:**
> - `drizzle.config.ts` (added Oliver schema path)
> - `package.json` (added `oliver-agent` dep)
>
> **Database changes:**
> - Created `oliver.pending_tools` and `oliver.audit_log`
>
> **What's left for you to do:**
> 1. Add a chat UI (recommend assistant-ui or Shadcn chat)
> 2. Customize `instructions/SOUL.md` and `domain.md` for your product
> 3. Add real tools under `tools/` for your domain operations
> 4. When you ship a HITL tool, add an approval card component (see README)
>
> Test it: open your chat UI and ask the agent to create a customer."

---

## If something fails mid-install

Common failure modes and recovery:

| Failure | Cause | Recovery |
|---|---|---|
| `drizzle-kit migrate` fails with "schema oliver does not exist" | Postgres needs the schema created first | Run `CREATE SCHEMA IF NOT EXISTS oliver` and retry |
| Typecheck errors in `lib/oliver.ts` | Import paths don't match user's project | Re-detect Step 4, fix imports manually |
| `auth.api.getSession is not a function` | User has Clerk/NextAuth, not better-auth | Re-do Step 5 with the correct auth lib's API |
| Tools file imports an `customers` table that doesn't exist | User's schema is different | Pick a different sample table or generate a stub `customers` table |

If a step fails and you can't recover within 2 attempts, STOP and ask the user for help. Do NOT silently skip steps or fabricate workarounds.
