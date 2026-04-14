/**
 * Render a slash command's text result as a UI message stream Response,
 * matching the format `streamText().toUIMessageStreamResponse()` returns.
 *
 * The chat UI receives this just like any other assistant message — no
 * special-casing required on the client side. Slash commands look like
 * the agent answered, but no LLM was called.
 *
 * Format: AI SDK v5/v6 UIMessage stream protocol over Server-Sent Events.
 * Spec: https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol
 */

/**
 * Build a Response with one assistant message containing `text`.
 * Use from your chat route after a slash command matches:
 *
 * @example
 * const slashText = await oliver.handleSlashCommand(messages, ctx);
 * if (slashText !== null) return oliver.respondWithText(slashText);
 */
export function respondWithText(text: string): Response {
  const messageId = `msg_${Date.now().toString(36)}`;
  const textPartId = `txt_${Date.now().toString(36)}`;

  const events = [
    { type: "start", messageId },
    { type: "text-start", id: textPartId },
    { type: "text-delta", id: textPartId, delta: text },
    { type: "text-end", id: textPartId },
    { type: "finish" },
  ];

  // Each event is a single SSE `data:` line, separated by blank lines.
  // The terminating `data: [DONE]` mirrors what the AI SDK emits.
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tells the AI SDK client this is the v1 UI message protocol.
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
