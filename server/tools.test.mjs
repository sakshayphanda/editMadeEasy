import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createToolsHandler } from './tools.mjs';

test('tool API validates uploads, returns downloads, cleans up, and reports unavailable tools', async () => {
  let calls = 0,
    directory;
  const handle = createToolsHandler({
    getCapabilities: async () => ({
      'audio/reverse': { available: true, reason: '' },
      'pdf/split': { available: false, reason: 'Install PDF dependencies.' },
    }),
    process: async (tool, files, settings, dir) => {
      calls++;
      directory = dir;
      assert.equal(files.length, 1);
      assert.equal(settings.format, 'mp3');
      const output = join(dir, 'result.mp3');
      await writeFile(output, 'test audio');
      return { path: output, format: 'mp3' };
    },
  });
  const server = createServer(async (req, res) => {
    if (!(await handle(req, res))) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/tools/`;
  try {
    const form = () => {
      const data = new FormData();
      data.set('settings', JSON.stringify({ format: 'mp3' }));
      data.set('files', new File(['source'], 'source.wav'));
      return data;
    };
    assert.equal(
      (await fetch(base + 'missing/tool', { method: 'POST', body: form() })).status,
      404,
    );
    assert.equal((await fetch(base + 'pdf/split', { method: 'POST', body: form() })).status, 503);
    assert.equal(
      (await fetch(base + 'audio/reverse', { method: 'POST', body: 'bad' })).status,
      415,
    );
    const bad = form();
    bad.set('settings', 'not-json');
    assert.equal((await fetch(base + 'audio/reverse', { method: 'POST', body: bad })).status, 400);
    const empty = form();
    empty.set('files', new File([], 'empty.wav'));
    assert.equal(
      (await fetch(base + 'audio/reverse', { method: 'POST', body: empty })).status,
      400,
    );
    assert.equal(calls, 0);
    const response = await fetch(base + 'audio/reverse', { method: 'POST', body: form() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await response.text(), 'test audio');
    // Wait for the server's response-close cleanup, rather than asserting on a race.
    for (let i = 0; i < 50; i++) {
      if (
        !(await access(directory)
          .then(() => true)
          .catch(() => false))
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(access(directory));
    const foreign = await fetch(base + 'audio/reverse', {
      method: 'POST',
      body: form(),
      headers: { Origin: 'https://other.example' },
    });
    assert.equal(foreign.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
