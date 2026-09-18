import path from "node:path";
import { applyMarkdownCoverFromGeneratedFile } from "../lib/markdown-cover-service.ts";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "create-cover";
export const description = t("toolDef.createCover.description");

export const promptGuidelines = [
  "Use beautify_create-cover only after an image already exists on disk.",
  "The image must come from the built-in cover gallery or a user-selected local image.",
  "This tool does not read articles, call a language model, or generate images.",
  "When the user asks to create or replace a Markdown cover, use an existing local image and pass its absolute path as generatedFilePath.",
  "If the target Markdown file path is not explicit and cannot be inferred from attached file metadata, ask the user to confirm the path before calling this tool.",
  "When called from an editor button, the file path is explicit; use it directly.",
].join("\n");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const sessionPermission = {
  kind: "review",
  describeSideEffect: (input: any = {}) => ({
    kind: "workspace_write",
    summary: `Apply a generated cover image to Markdown file ${input.targetFilePath || input.filePath || "unknown"}.`,
    ruleId: "beautify-markdown-cover-write",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    targetFilePath: { type: "string", description: t("toolDef.createCover.targetFilePathDesc") },
    filePath: { type: "string", description: t("toolDef.createCover.filePathDesc") },
    generatedFilePath: { type: "string", description: t("toolDef.createCover.generatedFilePathDesc") },
    imageFilePath: { type: "string", description: t("toolDef.createCover.imageFilePathDesc") },
    pixelWidth: { type: "number", description: t("toolDef.createCover.pixelWidthDesc") },
    pixelHeight: { type: "number", description: t("toolDef.createCover.pixelHeightDesc") },
  },
  required: ["targetFilePath", "generatedFilePath"],
};

function resolveTargetFilePath(input) {
  return input.targetFilePath || input.filePath || input.target?.filePath || null;
}

function resolveGeneratedFilePath(input) {
  return input.generatedFilePath || input.imageFilePath || input.generated?.filePath || input.sessionFile?.filePath || null;
}

function textResult(text, details = undefined) {
  return {
    content: [{ type: "text", text }],
    ...(details ? { details } : {}),
  };
}

export async function execute(input, ctx) {
  const targetFilePath = resolveTargetFilePath(input);
  if (!targetFilePath || !path.isAbsolute(targetFilePath)) {
    return textResult(t("toolDef.createCover.targetFilePathRequired"));
  }
  if (path.extname(targetFilePath).toLowerCase() !== ".md") {
    return textResult(t("toolDef.createCover.mustBeMarkdown"));
  }

  const generatedFilePath = resolveGeneratedFilePath(input);
  if (!generatedFilePath || !path.isAbsolute(generatedFilePath)) {
    return textResult(t("toolDef.createCover.generatedFilePathRequired"));
  }

  try {
    const result = await applyMarkdownCoverFromGeneratedFile({
      markdownFilePath: targetFilePath,
      generatedFilePath,
      pixelWidth: input.pixelWidth,
      pixelHeight: input.pixelHeight,
      resourceIO: ctx?.resources,
      operationContext: {
        source: "plugin",
        reason: "plugin:beautify:create-cover",
        sessionId: ctx?.sessionId || null,
        sessionPath: ctx?.sessionPath || null,
        principal: {
          kind: "plugin",
          pluginId: ctx?.pluginId || "beautify",
          userId: ctx?.userId || null,
          studioId: ctx?.studioId || null,
          sessionId: ctx?.sessionId || null,
          sessionPath: ctx?.sessionPath || null,
          connectionKind: ctx?.connectionKind || null,
          credentialKind: ctx?.credentialKind || null,
        },
      },
    });
    return textResult(t("toolDef.createCover.applied"), {
      beautifyCover: result,
    });
  } catch (err) {
    return textResult(t("toolDef.createCover.failed", { error: err?.message || err }));
  }
}
