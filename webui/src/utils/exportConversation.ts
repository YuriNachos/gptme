import type { Message } from '@/types/conversation';
import { isKnownTool } from './toolCallParser';

export interface ExportMarkdownOptions {
  includeSystem?: boolean;
  includeTimestamps?: boolean;
  /** Include <thinking>/<think> reasoning blocks in assistant messages. Default: false. */
  includeThinking?: boolean;
  /** Include tool messages (tool calls + results). Default: true. */
  includeTools?: boolean;
}

export interface ImportedConversationData {
  name: string;
  messages: Message[];
}

const importableRoles = new Set<Message['role']>(['system', 'user', 'assistant']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip <thinking> / <think> blocks from assistant message content.
 * Matches the same pattern used by the TTS pipeline and markdown renderer.
 */
function stripThinkingBlocks(content: string): string {
  return content
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '')
    .replace(/^\n+/, '')
    .trim();
}

/**
 * Strip fenced tool-call codeblocks (e.g. ```shell, ```patch) from assistant
 * message content. gptme tool invocations are embedded directly in the
 * assistant's message body as ```<tool-name>\n...\n``` fences rather than a
 * separate structured field, so excluding "tool details" has to strip these
 * blocks too — otherwise the invocation survives even with includeTools=false.
 * Uses the same tool-name allowlist as toolCallParser so detection stays
 * consistent with how the chat UI renders these blocks as rich tool calls.
 */
function stripToolCallBlocks(content: string): string {
  return content
    .replace(/```(\w+)(?:\s+[^\n]*)?\n[\s\S]*?```/g, (match, tool: string) =>
      isKnownTool(tool) ? '' : match
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Returns true if a message is a directly-tagged tool system message —
 * either via metadata.tool or a recognisable content pattern.
 */
function isTaggedToolSystemMessage(msg: Message): boolean {
  return (
    msg.role === 'system' &&
    (!!msg.metadata?.tool ||
      (!!msg.content &&
        (msg.content.includes('[Tool:') ||
          msg.content.includes('```tool') ||
          msg.content.includes('<tool'))))
  );
}

/**
 * Build the set of indices that represent tool-related system messages.
 *
 * Tools can emit multiple consecutive system-role messages per invocation;
 * only the final (or last) one typically carries `metadata.tool`. Intermediate
 * outputs (e.g. shellcheck diagnostics, partial stdout) appear immediately
 * before the tagged message without any tool marker. To avoid silently dropping
 * them when `includeSystem=false`, we expand coverage backwards: every run of
 * consecutive system messages that terminates in a tagged message is considered
 * a single tool-result block.
 *
 * We walk backward from each tagged tool message and include consecutive system
 * messages, stopping when we hit a non-system message (which separates different
 * message blocks and ensures we don't accidentally include unrelated system prompts
 * from earlier in the conversation).
 */
function buildToolSystemSet(messages: Message[]): Set<number> {
  const result = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (isTaggedToolSystemMessage(messages[i])) {
      result.add(i);
      // Walk backwards over adjacent system messages that are part of the tool output block
      // The walk stops naturally when we encounter a non-system message, which prevents
      // accidentally including unrelated system messages from earlier in the conversation
      for (let j = i - 1; j >= 0 && messages[j].role === 'system'; j--) {
        result.add(j);
      }
    }
  }
  return result;
}

export function getExportableMessages(
  messages: Message[],
  options?: Pick<ExportMarkdownOptions, 'includeSystem' | 'includeTools'>
): Message[] {
  const { includeSystem = false, includeTools = true } = options ?? {};

  // Pre-compute which system-message indices belong to tool runs, including
  // intermediate messages that lack metadata.tool.
  const toolSystemSet = buildToolSystemSet(messages);

  return messages.filter((msg, i) => {
    if (msg.hide) return false;

    const isToolMsg = msg.role === 'tool' || msg.role === 'tool_result' || toolSystemSet.has(i);

    // Filter tool-related messages when tools are excluded
    if (!includeTools && isToolMsg) return false;

    // Filter regular system messages (those not part of a tool run)
    if (!includeSystem && msg.role === 'system' && !toolSystemSet.has(i)) return false;

    return true;
  });
}

function getImportableMessages(messages: Message[]): Message[] {
  return getExportableMessages(messages, { includeSystem: true }).filter((msg) =>
    importableRoles.has(msg.role)
  );
}

/**
 * Format a conversation's messages as a Markdown document.
 */
export function formatConversationAsMarkdown(
  name: string,
  messages: Message[],
  options?: ExportMarkdownOptions
): string {
  const {
    includeTimestamps = true,
    includeThinking = false,
    includeSystem = false,
    includeTools = true,
  } = options ?? {};

  const lines: string[] = [`# ${name}`, ''];

  for (const msg of getExportableMessages(messages, { includeSystem, includeTools })) {
    const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
    let header = `## ${roleLabel}`;
    if (includeTimestamps && msg.timestamp) {
      header += `  \n*${msg.timestamp}*`;
    }
    lines.push(header, '');

    let content = msg.content;
    if (msg.role === 'assistant') {
      if (!includeThinking) content = stripThinkingBlocks(content);
      if (!includeTools) content = stripToolCallBlocks(content);
    }

    lines.push(content, '');
  }

  return lines.join('\n');
}

/**
 * Copy a conversation's messages to the clipboard as Markdown.
 * Returns a promise that resolves when the content is in the clipboard.
 *
 * Note: This copies only the currently loaded messages. For large conversations
 * with pagination/virtual scrolling, older messages that haven't been loaded yet
 * will not be included. Call from ConversationSettings after ensuring all messages
 * have been loaded (or check hasMoreBefore in the conversation state).
 */
export async function copyConversationToClipboard(
  name: string,
  messages: Message[],
  options?: ExportMarkdownOptions
): Promise<void> {
  const markdown = formatConversationAsMarkdown(name, messages, options);
  await navigator.clipboard.writeText(markdown);
}

/**
 * Trigger a file download in the browser.
 */
export function downloadAsFile(content: string, filename: string, mimeType = 'text/markdown') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export a conversation as a Markdown file download.
 */
export function exportConversationAsMarkdown(
  conversationId: string,
  name: string,
  messages: Message[],
  options?: ExportMarkdownOptions
) {
  const markdown = formatConversationAsMarkdown(name, messages, options);
  // Sanitize filename: replace unsafe characters with dashes
  const safeName = (name || conversationId)
    .replace(/[^a-zA-Z0-9_\-. ]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
  downloadAsFile(markdown, `${safeName}.md`);
}

/**
 * Export a conversation as a JSON file download.
 */
export function exportConversationAsJSON(
  conversationId: string,
  name: string,
  messages: Message[]
) {
  const data = {
    id: conversationId,
    name,
    exported_at: new Date().toISOString(),
    messages: getImportableMessages(messages),
  };
  const json = JSON.stringify(data, null, 2);
  const safeName = (name || conversationId)
    .replace(/[^a-zA-Z0-9_\-. ]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
  downloadAsFile(json, `${safeName}.json`, 'application/json');
}

export function parseConversationImportJSON(json: string): ImportedConversationData {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON file');
  }

  if (!isRecord(parsed)) {
    throw new Error('Conversation import must be a JSON object');
  }

  if ('name' in parsed && parsed.name != null && typeof parsed.name !== 'string') {
    throw new Error('Conversation import name must be a string');
  }

  if ('id' in parsed && parsed.id != null && typeof parsed.id !== 'string') {
    throw new Error('Conversation import id must be a string');
  }

  if (!Array.isArray(parsed.messages)) {
    throw new Error('Conversation import must include a messages array');
  }

  const messages = parsed.messages.map((message, index) => {
    if (!isRecord(message)) {
      throw new Error(`Imported message ${index + 1} must be an object`);
    }

    const { role, content, timestamp } = message;

    if (role === 'tool') {
      return null;
    }

    if (typeof role !== 'string' || !importableRoles.has(role as Message['role'])) {
      const roleLabel = typeof role === 'string' ? `"${role}"` : 'a valid role';
      throw new Error(
        `Imported message ${index + 1} has unsupported role ${roleLabel}. Only system, user, and assistant messages can be restored.`
      );
    }

    if (typeof content !== 'string') {
      throw new Error(`Imported message ${index + 1} is missing a string content field`);
    }

    if (timestamp !== undefined && typeof timestamp !== 'string') {
      throw new Error(`Imported message ${index + 1} has an invalid timestamp`);
    }

    return {
      role: role as Message['role'],
      content,
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
  });

  return {
    name:
      typeof parsed.name === 'string'
        ? parsed.name
        : typeof parsed.id === 'string'
          ? parsed.id
          : '',
    messages: messages.filter((message): message is Message => message !== null),
  };
}
