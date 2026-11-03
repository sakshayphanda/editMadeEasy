import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { createToolsHandler } from './tools.mjs';

export const bitrates = [
  8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 192, 224, 256, 320,
];
const endpoint = 'https://api.samplecut.app/v1/downloads';

export function youtubeUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
      return null;
    const host = url.hostname;
    let id;
    if (host === 'youtu.be') id = url.pathname.slice(1);
    else if (
      ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)
    ) {
      id =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:shorts|embed|live)\/([^/]+)$/.exec(url.pathname)?.[1];
    }
    return /^[\w-]{11}$/.test(id ?? '') ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch {
    return null;
  }
}

export async function transcode(input, output, bitrate, signal) {
  const sampleRate = bitrate < 32 ? 16000 : bitrate < 96 || bitrate === 144 ? 22050 : 44100;
  await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        input,
        '-vn',
        '-map_metadata',
        '-1',
        '-c:a',
        'libmp3lame',
        '-ar',
        String(sampleRate),
        '-ac',
        bitrate < 32 ? '1' : '2',
        '-b:a',
        `${bitrate}k`,
        '-y',
        output,
      ],
      { signal, stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Audio conversion failed. Please try again.')),
    );
  });
}

export function createYoutubeServer({ fetchAudio = fetch, encode = transcode } = {}) {
  const handleTools = createToolsHandler();
  let active = false;
  let requests = [];
  return createServer(async (req, res) => {
    const sendError = (status, message) => {
      if (!res.destroyed)
        res
          .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify({ error: message }));
    };
    if (await handleTools(req, res)) return;
    if (req.url !== '/api/youtube/audio') return sendError(404, 'Not found.');
    if (req.method !== 'POST') return sendError(405, 'Use POST.');
    if (!req.headers['content-type']?.startsWith('application/json'))
      return sendError(415, 'Send JSON.');
    let input;
    try {
      let body = '';
      for await (const part of req) {
        body += part;
        if (Buffer.byteLength(body) > 4096) return sendError(413, 'Request is too large.');
      }
      input = JSON.parse(body);
    } catch {
      return sendError(400, 'Enter a valid YouTube video URL and bitrate.');
    }
    const url = youtubeUrl(input?.url);
    if (!url || !bitrates.includes(input?.bitrate))
      return sendError(400, 'Enter a valid YouTube video URL and supported bitrate.');
    requests = requests.filter((time) => Date.now() - time < 600_000);
    if (requests.length >= 10) {
      res.setHeader('Retry-After', String(Math.ceil((requests[0] + 600_000 - Date.now()) / 1000)));
      return sendError(429, 'Free download limit reached. Please try again later.');
    }
    if (active) return sendError(503, 'Another download is processing. Please try again shortly.');
    active = true;
    requests.push(Date.now());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
    res.on('close', () => controller.abort());
    let directory;
    try {
      const upstream = await fetchAudio(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Name': 'Edit Made Easy' },
        body: JSON.stringify({ url, format: 'mp3', response: 'file' }),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const problem = await upstream.json().catch(() => null);
        const retry = upstream.headers.get('retry-after');
        if (retry && /^\d+$/.test(retry)) res.setHeader('Retry-After', retry);
        return sendError(
          [400, 422, 429, 503].includes(upstream.status) ? upstream.status : 502,
          problem?.error?.message ||
            'The download provider is unavailable. Please try again later.',
        );
      }
      if (!upstream.body || !upstream.headers.get('content-type')?.includes('audio/mpeg'))
        throw new Error('The provider returned an invalid audio file.');
      directory = await mkdtemp(join(tmpdir(), 'editmadeeasy-youtube-'));
      const source = join(directory, 'source.mp3');
      const output = join(directory, 'output.mp3');
      let size = 0;
      const limit = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(
            size > 160 * 1024 * 1024 ? new Error('Audio exceeds the 160 MB download limit.') : null,
            chunk,
          );
        },
      });
      await pipeline(upstream.body, limit, createWriteStream(source), {
        signal: controller.signal,
      });
      if (!size) throw new Error('The provider returned an empty audio file.');
      if (input.bitrate !== 320) await encode(source, output, input.bitrate, controller.signal);
      const audio = await readFile(input.bitrate === 320 ? source : output);
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
      res
        .writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audio.length,
          'Content-Disposition': `attachment; filename="youtube-${input.bitrate}kbps.mp3"`,
          'Cache-Control': 'no-store',
        })
        .end(audio);
    } catch (error) {
      sendError(
        controller.signal.aborted ? 504 : 502,
        controller.signal.aborted
          ? 'The download timed out. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Unable to download audio.',
      );
    } finally {
      clearTimeout(timeout);
      if (directory) await rm(directory, { recursive: true, force: true });
      active = false;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env['PORT'] || 3001);
  createYoutubeServer().listen(port, '127.0.0.1', () =>
    console.log(`File tools API: http://127.0.0.1:${port}`),
  );
}
