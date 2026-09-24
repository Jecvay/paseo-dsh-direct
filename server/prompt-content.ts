import type { ProviderContent } from "@getpaseo/plugin/server/provider";
import type { PromptPart } from "../shared/bridge-protocol.js";

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

/** Map Paseo prompt content to bridge parts; context attachments become text as in Paseo's own providers. */
export function toPromptParts(content: readonly ProviderContent[]): PromptPart[] {
  return content.map((part): PromptPart => {
    switch (part.type) {
      case "text":
        // Also covers Paseo text attachments, which share the `text` shape.
        return { type: "text", text: part.text };
      case "image":
        return { type: "image", mediaType: part.mimeType, data: part.data };
      case "uploaded_file":
        return { type: "file", path: part.path, name: part.fileName };
      default:
        return { type: "text", text: attachmentText(part) };
    }
  });
}

/** Text shown in the Paseo user bubble for a submitted prompt. */
export function displayText(parts: readonly PromptPart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : attachmentLabel(part.type, part.name)))
    .filter(Boolean)
    .join("\n");
}

/** Bubble marker for a non-text block; shared by live prompts and replayed history. */
export function attachmentLabel(type: "image" | "file", name?: string): string {
  return type === "image" ? "[image]" : `[file: ${name ?? "attachment"}]`;
}

type ContextAttachment = Exclude<
  ProviderContent,
  { type: "text" } | { type: "image" } | { type: "uploaded_file" }
>;

function attachmentText(part: ContextAttachment): string {
  switch (part.type) {
    case "forge_change_request":
      return changeRequestText({ ...part, forge: part.forge ?? "github" });
    case "github_pr":
      return changeRequestText({ ...part, forge: "github" });
    case "forge_issue":
      return issueText({ ...part, forge: part.forge ?? "github" });
    case "github_issue":
      return issueText({ ...part, forge: "github" });
    case "review": {
      const lines = [`Paseo review attachment (${part.mode})`, `CWD: ${part.cwd}`];
      if (part.baseRef) lines.push(`Base: ${part.baseRef}`);
      part.comments.forEach((comment, index) => {
        lines.push(
          "",
          `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
          comment.body,
          comment.context.hunkHeader,
        );
        const target = comment.context.targetLine;
        for (const line of comment.context.lines) {
          const isTarget =
            line.oldLineNumber === target.oldLineNumber &&
            line.newLineNumber === target.newLineNumber &&
            line.type === target.type &&
            line.content === target.content;
          lines.push(
            `${isTarget ? "> " : "  "}${pad(line.oldLineNumber)} ${pad(line.newLineNumber)} ${REVIEW_LINE_MARKERS[line.type]}${line.content}`,
          );
        }
      });
      return lines.join("\n");
    }
  }
}

function changeRequestText(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
  baseRefName?: string | null;
  headRefName?: string | null;
}): string {
  const gitlab = input.forge === "gitlab";
  const lines = [
    `${forgeLabel(input.forge)} ${gitlab ? "MR" : "PR"} ${gitlab ? "!" : "#"}${input.number}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) lines.push(`Project: ${input.projectPath}`);
  if (input.baseRefName) lines.push(`Base: ${input.baseRefName}`);
  if (input.headRefName) lines.push(`Head: ${input.headRefName}`);
  if (input.body) lines.push("", input.body);
  return lines.join("\n");
}

function issueText(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
}): string {
  const lines = [`${forgeLabel(input.forge)} Issue #${input.number}: ${input.title}`, input.url];
  if (input.projectPath) lines.push(`Project: ${input.projectPath}`);
  if (input.body) lines.push("", input.body);
  return lines.join("\n");
}

function forgeLabel(forge: string): string {
  return forge === "gitlab" ? "GitLab" : forge === "github" ? "GitHub" : forge;
}

function pad(lineNumber: number | null): string {
  return (lineNumber === null ? "" : String(lineNumber)).padStart(4, " ");
}
