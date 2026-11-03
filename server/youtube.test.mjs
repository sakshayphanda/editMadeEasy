import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ffmpeg from 'ffmpeg-static';
import { bitrates, createYoutubeServer, transcode, youtubeUrl } from './youtube.mjs';

test('only accepts and normalizes supported YouTube video links', () => {
  for (const url of [
    'https://youtu.be/jNQXAC9IVRw?t=2',
    'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=abc',
    'https://m.youtube.com/shorts/jNQXAC9IVRw',
  ]) {
    assert.equal(youtubeUrl(url), 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  }
  for (const url of [
    'https://youtube.com.evil.test/watch?v=jNQXAC9IVRw',
    'http://127.0.0.1',
    'file:///tmp/a',
    'https://youtube.com/playlist?list=abc',
    'https://user@youtube.com/watch?v=jNQXAC9IVRw',
    'https://youtu.be/invalid',
  ])
    assert.equal(youtubeUrl(url), null);
});

async function withApi(options, run) {
  const server = createYoutubeServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const request = (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/youtube/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    await run(request);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('rejects invalid settings before calling the provider and transcodes the chosen rate', async () => {
  let calls = 0;
  let encodedRate;
  await withApi(
    {
      fetchAudio: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.samplecut.app/v1/downloads');
        assert.deepEqual(JSON.parse(options.body), {
          url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
          format: 'mp3',
          response: 'file',
        });
        return new Response('test audio', { headers: { 'Content-Type': 'audio/mpeg' } });
      },
      encode: async (source, output, rate) => {
        encodedRate = rate;
        await copyFile(source, output);
      },
    },
    async (request) => {
      assert.equal((await request({ url: 'http://localhost', bitrate: 128 })).status, 400);
      assert.equal(
        (await request({ url: 'https://youtu.be/jNQXAC9IVRw', bitrate: 999 })).status,
        400,
      );
      assert.equal(calls, 0);
      const response = await request({ url: 'https://youtu.be/jNQXAC9IVRw', bitrate: 64 });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'audio/mpeg');
      assert.equal(await response.text(), 'test audio');
      assert.equal(encodedRate, 64);
      const direct = await request({ url: 'https://youtu.be/jNQXAC9IVRw', bitrate: 320 });
      assert.equal(await direct.text(), 'test audio');
      assert.equal(encodedRate, 64);
    },
  );
});

test('returns provider errors and retry delay', async () => {
  await withApi(
    {
      fetchAudio: async () =>
        new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Please wait.' } }), {
          status: 429,
          headers: { 'Retry-After': '60' },
        }),
    },
    async (request) => {
      const response = await request({ url: 'https://youtu.be/jNQXAC9IVRw', bitrate: 128 });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.deepEqual(await response.json(), { error: 'Please wait.' });
    },
  );
});

test('recovers after a provider network failure', async () => {
  let calls = 0;
  await withApi(
    {
      fetchAudio: async () => {
        if (++calls === 1) throw new Error('Connection failed');
        return new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } });
      },
    },
    async (request) => {
      const body = { url: 'https://youtu.be/jNQXAC9IVRw', bitrate: 320 };
      assert.equal((await request(body)).status, 502);
      assert.equal((await request(body)).status, 200);
    },
  );
});

test('every selectable bitrate produces audible MP3 with the requested bitrate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-encode-test-'));
  try {
    const source = join(directory, 'source.wav');
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-ac',
      '2',
      source,
    ]);
    for (const rate of bitrates) {
      const output = join(directory, `${rate}.mp3`);
      await transcode(source, output, rate, new AbortController().signal);
      const mp3 = await readFile(output);
      // Skip the ID3 tag, then read the first MPEG audio frame's bitrate index.
      let offset = 0;
      if (mp3.toString('ascii', 0, 3) === 'ID3')
        offset =
          10 +
          ((mp3[6] & 127) << 21) +
          ((mp3[7] & 127) << 14) +
          ((mp3[8] & 127) << 7) +
          (mp3[9] & 127);
      assert.equal(mp3[offset], 255, `${rate}: MPEG frame`);
      const mpeg1 = ((mp3[offset + 1] >> 3) & 3) === 3;
      const table = mpeg1
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      // FFmpeg's first frame holds Xing metadata and may use a larger bitrate.
      const sampleRate = [44100, 48000, 32000][(mp3[offset + 2] >> 2) & 3] / (mpeg1 ? 1 : 2);
      const firstRate = table[mp3[offset + 2] >> 4];
      offset +=
        Math.floor(((mpeg1 ? 144000 : 72000) * firstRate) / sampleRate) +
        ((mp3[offset + 2] >> 1) & 1);
      assert.equal(mp3[offset], 255, `${rate}: audio frame`);
      assert.equal(table[mp3[offset + 2] >> 4], rate);
      const pcm = execFileSync(ffmpeg, [
        '-v',
        'error',
        '-i',
        output,
        '-f',
        's16le',
        '-ac',
        '1',
        'pipe:1',
      ]);
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
      assert.ok(Math.sqrt(energy / (pcm.length / 2)) > 100, `${rate}: output must not be silent`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
