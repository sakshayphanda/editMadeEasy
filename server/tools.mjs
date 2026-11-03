import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { catalog, capabilities, processTool } from './tool-processors.mjs';

const mime = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  m4r: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  zip: 'application/zip',
  tar: 'application/x-tar',
  html: 'text/html',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  epub: 'application/epub+zip',
};
export function createToolsHandler({ getCapabilities = capabilities, process = processTool } = {}) {
  let active = false;
  return async function handleTools(req, res) {
    if (!req.url?.startsWith('/api/tools/')) return false;
    const json = (status, data) => {
      if (!res.destroyed && !res.headersSent)
        res
          .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(data));
    };
    if (req.url === '/api/tools/capabilities' && req.method === 'GET') {
      json(200, await getCapabilities());
      return true;
    }
    if (req.method !== 'POST') {
      json(405, { error: 'Use POST.' });
      return true;
    }
    const origin = req.headers.origin;
    let sameOrigin = !origin;
    try {
      if (origin) sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      /* Invalid origin. */
    }
    if (!sameOrigin) {
      json(403, { error: 'Use the app on this server to process files.' });
      return true;
    }
    const key = req.url.slice('/api/tools/'.length);
    const tool = catalog.find(
      (tool) => `${tool.group}/${tool.id}` === key && tool.mode === 'server',
    );
    if (!tool) {
      json(404, { error: 'Unknown tool.' });
      return true;
    }
    const status = (await getCapabilities())[key];
    if (!status?.available) {
      json(503, { error: status?.reason || 'Tool unavailable.' });
      return true;
    }
    if (active) {
      json(503, { error: 'Another file is processing. Please try again shortly.' });
      return true;
    }
    if (!req.headers['content-type']?.startsWith('multipart/form-data;')) {
      json(415, { error: 'Upload files as form data.' });
      return true;
    }
    active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
    res.on('close', () => controller.abort());
    req.on('aborted', () => controller.abort());
    let directory;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 102 * 1024 * 1024) {
          json(413, { error: 'Upload no more than 100 MB of files.' });
          return true;
        }
        chunks.push(chunk);
        if (controller.signal.aborted) throw new Error('Upload cancelled.');
      }
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': req.headers['content-type'] },
        body: Buffer.concat(chunks),
      });
      let form, settings;
      try {
        form = await request.formData();
        const raw = form.get('settings');
        if (typeof raw !== 'string' || raw.length > 16000) throw new Error();
        settings = JSON.parse(raw);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error();
      } catch {
        json(400, { error: 'Send valid files and settings.' });
        return true;
      }
      const uploads = form.getAll('files');
      if (
        uploads.length > 20 ||
        uploads.some((file) => typeof file === 'string' || !file.size) ||
        uploads.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024 ||
        (tool.id !== 'text-to-speech' && !uploads.length) ||
        (!tool.multiple && uploads.length > 1)
      ) {
        json(400, {
          error: 'Choose the required non-empty files, up to 20 files and 100 MB total.',
        });
        return true;
      }
      directory = await mkdtemp(join(tmpdir(), 'editmadeeasy-tools-'));
      const files = [];
      for (let i = 0; i < uploads.length; i++) {
        const extension = extname(uploads[i].name).slice(1).toLowerCase();
        if (!/^[a-z0-9]{1,8}$/.test(extension))
          throw new Error('Choose a file with a supported filename extension.');
        const path = join(directory, `input-${i}.${extension}`);
        await writeFile(path, Buffer.from(await uploads[i].arrayBuffer()));
        files.push({ path, extension });
      }
      const output = await process(tool, files, settings, directory, controller.signal);
      const info = await stat(output.path);
      if (!info.size || info.size > 250 * 1024 * 1024)
        throw new Error(
          'The output is empty or exceeds the 250 MB limit. Choose smaller files or a shorter range.',
        );
      if (controller.signal.aborted) throw new Error('Processing timed out.');
      res.writeHead(200, {
        'Content-Type': mime[output.format] || 'application/octet-stream',
        'Content-Length': info.size,
        'Content-Disposition': `attachment; filename="${tool.group}-${tool.id}.${output.format}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      await pipeline(createReadStream(output.path), res, { signal: controller.signal });
    } catch (error) {
      json(controller.signal.aborted ? 504 : 422, {
        error: controller.signal.aborted
          ? 'Processing timed out or was cancelled. Try a smaller file.'
          : friendlyError(error),
      });
    } finally {
      clearTimeout(timeout);
      if (directory) await rm(directory, { recursive: true, force: true });
      active = false;
    }
    return true;
  };
}
function friendlyError(error) {
  const message = error instanceof Error ? error.message : 'Unable to process this file.';
  if (
    /^Choose |^Select |^Enter |^End |^Fades |^Archive |^Encrypted |^This document|^No tables|^PDF |^Scanned|^The output/.test(
      message,
    )
  )
    return message;
  return 'This file could not be processed with these settings. Check its format, time range, dimensions, and password, then try again.';
}
