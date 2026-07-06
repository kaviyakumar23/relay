import { describe, expect, it, vi } from 'vitest';
import { buildCanvasDocument, type CanvasWriteClient, writeCanvas } from '../../src/surfaces/canvas';
import { context, divider, header, section } from '../../src/surfaces/primitives';

// The defensive Canvas writer (F7). buildCanvasDocument is pure and fully tested; the API
// path is smoke-tested — its contract is "never throw, return null on any failure" because
// the exact canvases.* payload shapes are UNVERIFIED and the message/markdown is the
// primary output.

describe('buildCanvasDocument (pure)', () => {
  it('wraps a markdown string as a { type: markdown } document_content', () => {
    expect(buildCanvasDocument('# Report\n\nhello')).toEqual({ type: 'markdown', markdown: '# Report\n\nhello' });
  });

  it('flattens a Block Kit block array to markdown', () => {
    const doc = buildCanvasDocument([header('Sitrep'), section('12 needs open'), divider, context('as of 10:00')]);
    expect(doc.type).toBe('markdown');
    expect(doc.markdown).toBe('# Sitrep\n\n12 needs open\n\n---\n\n_as of 10:00_');
  });
});

describe('writeCanvas (best-effort API path)', () => {
  it('returns the canvas id when canvases.create succeeds', async () => {
    const create = vi.fn().mockResolvedValue({ canvas_id: 'C123' });
    const edit = vi.fn().mockResolvedValue({ ok: true });
    const client: CanvasWriteClient = { canvases: { create, edit } };

    const res = await writeCanvas(client, { channelId: 'CHQ', title: 'Report', markdown: '# Report' });
    expect(res).toEqual({ canvasId: 'C123' });
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]?.[0] as { title: string; document_content: unknown };
    expect(arg.title).toBe('Report');
    expect(arg.document_content).toEqual({ type: 'markdown', markdown: '# Report' });
  });

  it('returns null and never throws when the client throws', async () => {
    const throwing: CanvasWriteClient = {
      canvases: {
        create: () => {
          throw new Error('boom');
        },
      },
    };
    await expect(writeCanvas(throwing, { channelId: 'C', title: 't', markdown: 'm' })).resolves.toBeNull();
  });

  it('returns null when canvases.create rejects', async () => {
    const client: CanvasWriteClient = { canvases: { create: vi.fn().mockRejectedValue(new Error('api down')) } };
    await expect(writeCanvas(client, { channelId: 'C', title: 't', markdown: 'm' })).resolves.toBeNull();
  });

  it('returns null when the client lacks canvases support', async () => {
    await expect(writeCanvas({}, { channelId: 'C', title: 't', markdown: 'm' })).resolves.toBeNull();
    await expect(writeCanvas(null, { channelId: 'C', title: 't', markdown: 'm' })).resolves.toBeNull();
  });

  it('returns null when create yields no canvas id, but does not throw', async () => {
    const client: CanvasWriteClient = { canvases: { create: vi.fn().mockResolvedValue({ ok: true }) } };
    await expect(writeCanvas(client, { channelId: 'C', title: 't', markdown: 'm' })).resolves.toBeNull();
  });

  it('still returns the canvas id even if the best-effort edit fails', async () => {
    const client: CanvasWriteClient = {
      canvases: {
        create: vi.fn().mockResolvedValue({ canvas_id: 'C9' }),
        edit: vi.fn().mockRejectedValue(new Error('edit shape mismatch')),
      },
    };
    await expect(writeCanvas(client, { channelId: 'C', title: 't', markdown: 'm' })).resolves.toEqual({
      canvasId: 'C9',
    });
  });
});
