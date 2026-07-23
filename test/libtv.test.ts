import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import {
  assertLibTvResultUrl,
  inspectLibTvUpload,
  LibTvClient,
} from '../src/providers/libtv.js';

function config(root: string): AppConfig {
  return {
    projectsRoot: root,
    dryRun: false,
    noOpen: true,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    minimaxApiBase: 'https://api.minimaxi.com',
    minimaxTtsModel: 'speech-2.8-hd',
    minimaxVideoModel: 'MiniMax-Hailuo-2.3',
    libtvAccessKey: 'test-key',
    libtvApiBase: 'https://im.liblib.tv',
    studioHost: '127.0.0.1',
    studioPort: 4317,
    studioDatabase: path.join(root, '.studio', 'studio.db'),
  };
}

test('LibTV result URL policy blocks sibling hosts, ports and credentials', () => {
  assert.equal(
    assertLibTvResultUrl('https://libtv-res.liblib.art/path/result.png').hostname,
    'libtv-res.liblib.art',
  );
  assert.throws(
    () => assertLibTvResultUrl('https://libtv-res.liblib.art.evil.test/result.png'),
    /拒绝/,
  );
  assert.throws(
    () => assertLibTvResultUrl('https://libtv-res.liblib.art:8443/result.png'),
    /拒绝/,
  );
  assert.throws(
    () => assertLibTvResultUrl('https://user@libtv-res.liblib.art/result.png'),
    /拒绝/,
  );
});

test('LibTV upload inspection uses file signatures instead of extensions', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-libtv-file-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = path.join(root, 'reference.txt');
  fs.writeFileSync(
    png,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(inspectLibTvUpload(png).mimeType, 'image/png');

  const disguised = path.join(root, 'fake.png');
  fs.writeFileSync(disguised, 'not an image');
  assert.throws(() => inspectLibTvUpload(disguised), /无法确认参考素材类型/);
});

test('LibTV client pins the API host and sends incremental authenticated queries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-libtv-client-'));
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
    });
    return new Response(
      JSON.stringify({
        data: {
          messages: [{ id: 'm-1', seq: 8, role: 'assistant', content: 'done' }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const client = new LibTvClient(config(root), fetcher);
  const messages = await client.querySession('session/unsafe value', 7);
  assert.equal(messages[0]?.id, 'm-1');
  assert.equal(calls[0]?.authorization, 'Bearer test-key');
  assert.equal(
    calls[0]?.url,
    'https://im.liblib.tv/openapi/session/session%2Funsafe%20value?afterSeq=7',
  );

  const unsafe = config(root);
  unsafe.libtvApiBase = 'https://attacker.example';
  await assert.rejects(
    () => new LibTvClient(unsafe, fetcher).querySession('session', 0),
    /安全校验/,
  );
});
