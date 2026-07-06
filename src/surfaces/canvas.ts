// A DEFENSIVE Slack Canvas writer (F7, and the first thing on the cut line after message
// sitreps — see CLAUDE.md cut order). The durable, user-visible artifact is a Canvas of
// the report; the message + downloadable Markdown are the PRIMARY output and always
// present, so this writer is strictly best-effort.
//
// Ported in spirit from ../impactlens/src/render/canvasRecord.js, but that donor's exact
// canvases.create / canvases.edit payload shapes are UNVERIFIED (marked TODO-VERIFY there;
// there is no live Slack here to confirm against). So EVERY API call is wrapped: any error,
// missing capability, or shape mismatch returns null and logs a single warn — writeCanvas
// NEVER throws. The caller keeps its message/markdown fallback regardless.
//
// buildCanvasDocument is PURE and fully tested; the API path is smoke-tested only.

import { logger } from '../lib/logger';
import type { SlackBlock } from './primitives';

/** The document_content payload Slack's canvases.* methods take. TODO-VERIFY: confirm the
 * exact shape ({ type:'markdown', markdown }) against a live workspace before relying on it. */
export interface CanvasContent {
  type: 'markdown';
  markdown: string;
}

/** The narrow slice of a Slack WebClient this writer touches. Structural + all-optional so
 * a partial stub (or a client on an SDK version without canvases) degrades to null. */
interface CanvasApi {
  create?: (args: Record<string, unknown>) => Promise<unknown>;
  edit?: (args: Record<string, unknown>) => Promise<unknown>;
}
export interface CanvasWriteClient {
  canvases?: CanvasApi;
}

export interface WriteCanvasOptions {
  channelId: string;
  title: string;
  markdown: string;
}

/** Best-effort text extraction from a Block Kit block for the blocks→markdown path. */
function blockToMarkdown(block: SlackBlock): string {
  const type = typeof block.type === 'string' ? block.type : '';
  if (type === 'divider') return '---';
  const text = block.text as { text?: unknown } | undefined;
  const headerOrSection = typeof text?.text === 'string' ? text.text : '';
  if (type === 'header') return headerOrSection ? `# ${headerOrSection}` : '';
  if (type === 'section') return headerOrSection;
  if (type === 'context') {
    const elements = Array.isArray(block.elements) ? (block.elements as Array<{ text?: unknown }>) : [];
    const joined = elements
      .map((e) => (typeof e.text === 'string' ? e.text : ''))
      .filter((s) => s.length > 0)
      .join(' ');
    return joined ? `_${joined}_` : '';
  }
  return headerOrSection;
}

/**
 * Build the Canvas document_content payload. Accepts a ready Markdown string (the report
 * renderer's output — the common case) or a Block Kit block array (best-effort flattened
 * to Markdown). PURE.
 */
export function buildCanvasDocument(input: string | SlackBlock[]): CanvasContent {
  const markdown = Array.isArray(input)
    ? input
        .map(blockToMarkdown)
        .filter((line) => line.length > 0)
        .join('\n\n')
    : input;
  return { type: 'markdown', markdown };
}

/** Pull a canvas id out of whatever shape canvases.create returned (UNVERIFIED field name). */
function extractCanvasId(resp: unknown): string | null {
  if (!resp || typeof resp !== 'object') return null;
  const r = resp as Record<string, unknown>;
  if (typeof r.canvas_id === 'string' && r.canvas_id) return r.canvas_id;
  if (typeof r.canvasId === 'string' && r.canvasId) return r.canvasId;
  const canvas = r.canvas as { id?: unknown } | undefined;
  if (canvas && typeof canvas.id === 'string' && canvas.id) return canvas.id;
  return null;
}

/** A short, PII-free error code for logging — never the message body. */
function errCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return err instanceof Error ? err.name : 'CANVAS_ERROR';
}

/**
 * Create a durable Canvas for the report and return its id, or null on ANY failure. Never
 * throws. The `channelId` is carried for the (TODO-VERIFY) channel-association step and for
 * log context; the returned canvas is standalone until that step is confirmed.
 */
export async function writeCanvas(
  client: CanvasWriteClient | null | undefined,
  opts: WriteCanvasOptions,
): Promise<{ canvasId: string } | null> {
  try {
    const canvases = client?.canvases;
    if (!canvases || typeof canvases.create !== 'function') {
      logger.warn({ surface: 'canvas', channelId: opts.channelId }, 'canvas.write.unsupported');
      return null;
    }

    const document_content = buildCanvasDocument(opts.markdown);
    // canvases.create — TODO-VERIFY: confirm the { title, document_content } arg shape and
    // whether a channel canvas needs channel_id here vs. a follow-up access/share call.
    const created = await canvases.create({ title: opts.title, document_content });
    const canvasId = extractCanvasId(created);
    if (!canvasId) {
      logger.warn({ surface: 'canvas', channelId: opts.channelId }, 'canvas.write.no_id');
      return null;
    }

    // canvases.edit — best-effort footer append demonstrating the edit path. A shape
    // mismatch here does NOT invalidate the created canvas, so we swallow it separately.
    // TODO-VERIFY: the changes/operation payload shape.
    if (typeof canvases.edit === 'function') {
      try {
        await canvases.edit({
          canvas_id: canvasId,
          changes: [
            {
              operation: 'insert_at_end',
              document_content: {
                type: 'markdown',
                markdown: '\n\n---\n_Generated by Relay. Every figure above is tied to a ledger event._',
              },
            },
          ],
        });
      } catch (err) {
        logger.warn({ surface: 'canvas', code: errCode(err) }, 'canvas.edit.failed');
      }
    }

    return { canvasId };
  } catch (err) {
    logger.warn({ surface: 'canvas', channelId: opts.channelId, code: errCode(err) }, 'canvas.write.failed');
    return null;
  }
}
