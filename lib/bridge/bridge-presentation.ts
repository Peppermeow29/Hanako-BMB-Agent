export const FEISHU_CARDKIT_STREAM_ELEMENT_ID = "hana_stream_markdown";

export type BridgePresentation = {
  kind: "bridge_presentation";
  format: "markdown";
  markdown: string;
};

type FeishuCardKitCardOptions = {
  elementId?: string;
};

function normalizeMarkdown(text: unknown) {
  return String(text || "").replace(/\r\n?/g, "\n").trim();
}

export function createBridgePresentation(text: unknown): BridgePresentation {
  return {
    kind: "bridge_presentation",
    format: "markdown",
    markdown: normalizeMarkdown(text),
  };
}

function asPresentation(input: BridgePresentation | unknown): BridgePresentation {
  if (
    input &&
    typeof input === "object" &&
    (input as BridgePresentation).kind === "bridge_presentation" &&
    (input as BridgePresentation).format === "markdown"
  ) {
    return input as BridgePresentation;
  }
  return createBridgePresentation(input);
}

export function renderFeishuCardKitCard(input: BridgePresentation | unknown, options: FeishuCardKitCardOptions = {}) {
  const presentation = asPresentation(input);
  const elementId = options.elementId || FEISHU_CARDKIT_STREAM_ELEMENT_ID;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
    },
    body: {
      elements: [{
        tag: "markdown",
        element_id: elementId,
        content: presentation.markdown || " ",
      }],
    },
  };
}

export function renderFeishuCardKitSettings(streamingMode: boolean) {
  return JSON.stringify({
    config: {
      streaming_mode: Boolean(streamingMode),
    },
  });
}
