// Streamed replies as providers' APIs send them, each from the model it names and with a million
// tokens in and out, so a call's cost is the sum of its per-million rates.

const sse = (frames: object[], named = false) =>
  new Response(
    `${frames
      .map(
        (frame) =>
          `${named ? `event: ${(frame as { type: string }).type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`,
      )
      .join("")}${named ? "" : "data: [DONE]\n\n"}`,
    { headers: { "content-type": "text/event-stream" } },
  );

/** Fireworks' Messages API, answering as the router named in the call. */
export const messagesReply = (model: string) =>
  sse(
    [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1_000_000 },
      },
      { type: "message_stop" },
    ],
    true,
  );

/** Baseten's Chat Completions, answering from `model` (a Grid auto route names its pick). */
export const completionsReply = (model: string) => {
  const chunk = (fields: object) => ({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model,
    ...fields,
  });
  return sse([
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({
      choices: [],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
    }),
  ]);
};

/** A Grid auto route's Responses API, answering from the model its classifier picked. */
export const responsesReply = (model: string) => {
  const response = {
    id: "resp_1",
    object: "response",
    model,
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
  };
  return sse(
    [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      {
        type: "response.content_part.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "OK",
      },
      { type: "response.completed", response },
    ],
    true,
  );
};
