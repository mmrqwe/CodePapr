import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyImageDataToMessages,
  chatImageDisplaySrc,
  collectUnresolvedImagePaths,
  hydrateImageMessages,
  loadChatImageData,
  normalizeChatImageRef,
} from './chatImageStore';

const { invokeMock, convertFileSrcMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
  convertFileSrcMock: vi.fn((path: string) => `asset://localhost/${path}`),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: convertFileSrcMock,
}));

beforeEach(() => {
  invokeMock.mockClear();
});

describe('collectUnresolvedImagePaths', () => {
  it('collects paths of images without data', () => {
    const messages = [
      { images: [{ mediaType: 'image/png', data: '', path: '.CodePapr/chat-images/a.png' }] },
      { images: [{ mediaType: 'image/png', data: 'AAAA' }] },
      { content: 'no images' },
      { images: [{ mediaType: 'image/jpeg', data: '', path: '.CodePapr/chat-images/b.jpg' }, { mediaType: 'image/gif', data: '', path: '.CodePapr/chat-images/a.png' }] },
    ];
    expect(collectUnresolvedImagePaths(messages)).toEqual([
      '.CodePapr/chat-images/a.png',
      '.CodePapr/chat-images/b.jpg',
    ]);
  });
});

describe('applyImageDataToMessages', () => {
  it('fills data only for matching paths and keeps others intact', () => {
    const messages = [
      {
        id: 'u1',
        images: [
          { mediaType: 'image/png', data: '', path: '.CodePapr/chat-images/a.png' },
          { mediaType: 'image/jpeg', data: 'BBBB' },
        ],
      },
      { id: 'u2', content: 'plain' },
    ];
    const next = applyImageDataToMessages(messages, new Map([
      ['.CodePapr/chat-images/a.png', { mediaType: 'image/png', data: 'FILLED' }],
    ]));
    expect(next[0].images?.[0].data).toBe('FILLED');
    expect(next[0].images?.[1].data).toBe('BBBB');
    expect(next[1]).toBe(messages[1]);
  });

  it('returns the same array when nothing to fill', () => {
    const messages = [{ id: 'u1', images: [{ mediaType: 'image/png', data: 'AAAA' }] }];
    expect(applyImageDataToMessages(messages, new Map())).toBe(messages);
  });
});

describe('hydrateImageMessages', () => {
  it('skips invoke when no unresolved paths', async () => {
    const messages = [{ images: [{ mediaType: 'image/png', data: 'AAAA' }] }];
    const next = await hydrateImageMessages('/ws', messages);
    expect(next).toBe(messages);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('loads disk data and merges it back', async () => {
    invokeMock.mockResolvedValueOnce({
      images: [{ path: '.CodePapr/chat-images/a.png', mediaType: 'image/png', data: 'DISK' }],
    });
    const messages = [{
      id: 'u1',
      images: [{ mediaType: 'image/png', data: '', path: '.CodePapr/chat-images/a.png' }],
    }];
    const next = await hydrateImageMessages('/ws', messages);
    expect(invokeMock).toHaveBeenCalledWith('load_chat_images', {
      workspacePath: '/ws',
      paths: ['.CodePapr/chat-images/a.png'],
    });
    expect(next[0].images?.[0].data).toBe('DISK');
  });

  it('keeps messages intact when the backend fails', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom'));
    const messages = [{
      id: 'u1',
      images: [{ mediaType: 'image/png', data: '', path: '.CodePapr/chat-images/a.png' }],
    }];
    const next = await hydrateImageMessages('/ws', messages);
    expect(next[0].images?.[0].data).toBe('');
  });
});

describe('normalizeChatImageRef', () => {
  it('normalizes slashes, bare prefixes, and basenames', () => {
    expect(normalizeChatImageRef('.CodePapr/chat-images/a.png')).toBe('.CodePapr/chat-images/a.png');
    expect(normalizeChatImageRef('chat-images/a.png')).toBe('.CodePapr/chat-images/a.png');
    expect(normalizeChatImageRef('.CodePapr\\chat-images\\a.png')).toBe('.CodePapr/chat-images/a.png');
  });
});

describe('chatImageDisplaySrc', () => {
  it('prefers in-memory data, then falls back to the asset protocol path', () => {
    expect(chatImageDisplaySrc('/ws', { mediaType: 'image/png', data: 'AAAA' })).toBe(
      'data:image/png;base64,AAAA'
    );
    expect(
      chatImageDisplaySrc('/ws', {
        mediaType: 'image/png',
        data: '',
        path: '.CodePapr/chat-images/a.png',
      })
    ).toBe('asset://localhost//ws/.CodePapr/chat-images/a.png');
  });
});

describe('hydrateImageMessages extra shapes', () => {
  it('fills data when the backend returns snake_case fields', async () => {
    invokeMock.mockResolvedValueOnce({
      images: [{ path: '.CodePapr/chat-images/a.png', media_type: 'image/png', data: 'DISK' }],
    });
    const messages = [{
      id: 'u1',
      images: [{ mediaType: 'image/png', data: '', path: '.CodePapr/chat-images/a.png' }],
    }];
    const next = await hydrateImageMessages('/ws', messages);
    expect(next[0].images?.[0].data).toBe('DISK');
  });
});

describe('loadChatImageData', () => {
  it('batches paths beyond a single backend call limit', async () => {
    const paths = Array.from({ length: 100 }, (_, i) => `.CodePapr/chat-images/f${i}.png`);
    invokeMock.mockResolvedValue({ images: [] });
    await loadChatImageData('/ws', paths);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect((invokeMock.mock.calls[0][1] as { paths: string[] }).paths).toHaveLength(96);
    expect((invokeMock.mock.calls[1][1] as { paths: string[] }).paths).toHaveLength(4);
  });
});
