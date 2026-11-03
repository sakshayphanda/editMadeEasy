import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { catalog, processTool, run, capabilities } from './tool-processors.mjs';

test(
  'media tools produce decodable output, including silent-video joins and alternate formats',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'suite-media-test-'));
    const signal = AbortSignal.timeout(115000);
    try {
      const video = join(root, 'video.mp4'),
        silent = join(root, 'silent.mp4'),
        audio = join(root, 'audio.wav'),
        image = join(root, 'image.png');
      await run(
        ffmpeg,
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x240:rate=15',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=44100',
          '-t',
          '1',
          '-c:v',
          'libx264',
          '-c:a',
          'aac',
          '-y',
          video,
        ],
        { signal },
      );
      await run(ffmpeg, ['-v', 'error', '-i', video, '-an', '-c:v', 'copy', '-y', silent], {
        signal,
      });
      await run(ffmpeg, ['-v', 'error', '-i', video, '-vn', '-y', audio], { signal });
      await run(ffmpeg, ['-v', 'error', '-i', video, '-frames:v', '1', '-y', image], { signal });
      const file = (path) => ({ path, extension: path.split('.').pop() });
      for (const tool of catalog.filter((tool) => tool.engine === 'ffmpeg')) {
        await t.test(`${tool.group}/${tool.id}`, async () => {
          const directory = join(root, `${tool.group}-${tool.id}`);
          await mkdir(directory);
          const settings = Object.fromEntries(tool.fields.map((f) => [f.key, f.default]));
          Object.assign(settings, {
            format: tool.formats[0],
            width: 160,
            height: 120,
            end: 0.8,
            fadeOut: 0.1,
            text: 'Test: 100% [caption]',
            x: 10,
            y: 10,
          });
          const isAudio =
            tool.group === 'audio' || (tool.group === 'convert' && tool.id === 'audio');
          let files = [file(isAudio ? audio : video)];
          if (tool.id === 'merge') files = [file(video), file(silent)];
          if (tool.id === 'joiner') files = [file(audio), file(audio)];
          if (tool.id === 'add-audio') files = [file(video), file(audio)];
          if (tool.id === 'add-image') files = [file(video), file(image)];
          const result = await processTool(tool, files, settings, directory, signal);
          assert.ok((await stat(result.path)).size > 100);
          await run(ffmpeg, ['-v', 'error', '-i', result.path, '-f', 'null', '-'], { signal });
        });
      }
      const tool = catalog.find((tool) => tool.group === 'convert' && tool.id === 'audio');
      for (const format of tool.formats.slice(1))
        await t.test(`audio output ${format}`, async () => {
          const result = await processTool(tool, [file(audio)], { format }, root, signal);
          assert.ok((await stat(result.path)).size > 100);
          await run(ffmpeg, ['-v', 'error', '-i', result.path, '-f', 'null', '-'], { signal });
        });
      const converter = catalog.find((tool) => tool.group === 'convert' && tool.id === 'video');
      for (const format of converter.formats.slice(1))
        await t.test(`video output ${format}`, async () => {
          const result = await processTool(converter, [file(video)], { format }, root, signal);
          assert.ok((await stat(result.path)).size > 100);
          await run(ffmpeg, ['-v', 'error', '-i', result.path, '-f', 'null', '-'], { signal });
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'PDF, image, archive and font tools preserve readable data and reject unsafe archives',
  { timeout: 120000 },
  async (t) => {
    const caps = await capabilities();
    if (!caps['pdf/split'].available) return t.skip('Python dependencies are not installed.');
    const root = await mkdtemp(join(tmpdir(), 'suite-files-test-'));
    const python = process.env['TOOLS_PYTHON'] || '.venv/bin/python';
    const signal = AbortSignal.timeout(115000);
    try {
      await run(
        python,
        [
          '-c',
          `
import fitz, zipfile
from PIL import Image
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
root=Path(r'${root}')
doc=fitz.open()
for i in range(2):
 p=doc.new_page();p.insert_text((40,40),'Test document '+str(i+1))
 for x in [50,150,250]: p.draw_line((x,100),(x,200))
 for y in [100,150,200]: p.draw_line((50,y),(250,y))
 p.insert_text((60,125),'Name');p.insert_text((160,125),'Value');p.insert_text((60,175),'Audio');p.insert_text((160,175),'42')
doc.save(root/'sample.pdf')
Image.new('RGB',(80,60),'blue').save(root/'sample.png')
Image.new('RGB',(80,60),'red').save(root/'sample.jpg')
with zipfile.ZipFile(root/'sample.zip','w') as z:z.writestr('folder/file.txt','hello')
with zipfile.ZipFile(root/'unsafe.zip','w') as z:z.writestr('../file.txt','bad')
font=FontBuilder(1000,isTTF=True);font.setupGlyphOrder(['.notdef','space']);font.setupCharacterMap({32:'space'})
pen=TTGlyphPen(None);glyph=pen.glyph();font.setupGlyf({'.notdef':glyph,'space':glyph});font.setupHorizontalMetrics({'.notdef':(500,0),'space':(500,0)});font.setupHorizontalHeader(ascent=800,descent=-200);font.setupNameTable({'familyName':'Test','styleName':'Regular','uniqueFontIdentifier':'Test Regular','fullName':'Test Regular','psName':'Test-Regular'});font.setupOS2();font.setupPost();font.save(root/'sample.ttf')
`,
        ],
        { signal },
      );
      const file = (name) => ({ path: join(root, name), extension: name.split('.').pop() });
      for (const tool of catalog.filter((tool) => tool.engine === 'python'))
        await t.test(`${tool.group}/${tool.id}`, async () => {
          const directory = join(root, `${tool.group}-${tool.id}`);
          await mkdir(directory);
          const settings = {
            ...Object.fromEntries(tool.fields.map((f) => [f.key, f.default])),
            format: tool.formats[0],
            password: 'secret',
            pages: '1',
          };
          let files = [file('sample.pdf')];
          if (tool.id === 'merge') files.push(file('sample.pdf'));
          if (tool.id === 'jpg-to-pdf') files = [file('sample.jpg')];
          if (tool.id === 'png-to-pdf' || tool.id === 'image') files = [file('sample.png')];
          if (tool.id === 'font') files = [file('sample.ttf')];
          if (tool.id === 'archive') files = [file('sample.zip')];
          const result = await processTool(tool, files, settings, directory, signal);
          assert.ok((await stat(result.path)).size > 10);
          if (result.format === 'pdf') {
            const pageCount = await run(
              python,
              [
                '-c',
                `from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); r.decrypt('secret') if r.is_encrypted else None; print(len(r.pages))`,
                result.path,
              ],
              { signal },
            );
            assert.equal(
              Number(pageCount),
              tool.id === 'merge'
                ? 4
                : tool.id === 'split' || ['jpg-to-pdf', 'png-to-pdf'].includes(tool.id)
                  ? 1
                  : 2,
            );
          }
        });
      const archive = catalog.find((tool) => tool.id === 'archive');
      await assert.rejects(
        processTool(archive, [file('unsafe.zip')], { format: 'zip' }, root, signal),
        /unsafe paths/,
      );
      const font = catalog.find((tool) => tool.id === 'font');
      for (const format of ['woff2', 'native']) {
        const result = await processTool(font, [file('sample.ttf')], { format }, root, signal);
        assert.ok((await stat(result.path)).size > 10);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'installed Office, ebook, archive and speech engines produce usable downloads',
  { timeout: 180000 },
  async (t) => {
    const caps = await capabilities();
    const root = await mkdtemp(join(tmpdir(), 'suite-engines-test-'));
    const signal = AbortSignal.timeout(170000);
    const python = process.env['TOOLS_PYTHON'] || '.venv/bin/python';
    try {
      await run(
        python,
        [
          '-c',
          `
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from PIL import Image
import zipfile
root=Path(r'${root}')
Image.new('RGB',(50,50),'blue').save(root/'sample.png')
doc=Document();doc.add_paragraph('Conversion test');doc.add_picture(str(root/'sample.png'));doc.save(root/'sample.docx')
book=Workbook();book.active.append(['Name','Value']);book.active.append(['Audio',42]);book.save(root/'sample.xlsx')
(root/'sample.txt').write_text('Conversion test. An ebook with some text.')
with zipfile.ZipFile(root/'sample.zip','w') as z:z.writestr('folder/test.txt','archive contents')
content='''<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.2"><office:body><office:presentation><draw:page draw:name="Slide 1"><draw:frame><draw:text-box><text:p>Presentation test</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>'''
manifest='''<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>'''
with zipfile.ZipFile(root/'sample.odp','w') as z:
 z.writestr('mimetype','application/vnd.oasis.opendocument.presentation');z.writestr('content.xml',content);z.writestr('META-INF/manifest.xml',manifest)
`,
        ],
        { signal },
      );
      const cases = [
        ['pdf', 'word-to-pdf', 'sample.docx'],
        ['pdf', 'excel-to-pdf', 'sample.xlsx'],
        ['pdf', 'ppt-to-pdf', 'sample.odp'],
        ['convert', 'document', 'sample.docx'],
        ['convert', 'ebook', 'sample.txt'],
        ['convert', 'extract', 'sample.zip'],
        ['video', 'text-to-speech', null],
      ];
      for (const [group, id, input] of cases)
        await t.test(`${group}/${id}`, async (t) => {
          if (!caps[`${group}/${id}`].available) return t.skip('Optional engine is not installed.');
          const tool = catalog.find((tool) => tool.group === group && tool.id === id);
          const directory = join(root, `${group}-${id}`);
          await mkdir(directory);
          const settings = {
            ...Object.fromEntries(tool.fields.map((f) => [f.key, f.default])),
            format: tool.formats[0],
            text: 'Hello from Edit Made Easy.',
          };
          const files = input
            ? [{ path: join(root, input), extension: input.split('.').pop() }]
            : [];
          const result = await processTool(tool, files, settings, directory, signal);
          assert.ok((await stat(result.path)).size > 20);
          if (result.format === 'pdf') {
            const resultText = await run(
              python,
              ['-c', 'import fitz,sys; d=fitz.open(sys.argv[1]); print(len(d))', result.path],
              { signal },
            );
            assert.ok(Number(resultText.trim().split('\n').at(-1)) > 0);
          }
          if (id === 'document' || id === 'ebook') {
            for (const format of tool.formats.slice(1)) {
              const destination = join(directory, format);
              await mkdir(destination);
              const alternate = await processTool(
                tool,
                files,
                { ...settings, format },
                destination,
                signal,
              );
              assert.ok((await stat(alternate.path)).size > 10, `${id} ${format} is non-empty`);
              if (id === 'document' && format === 'html')
                assert.match(await readFile(alternate.path, 'utf8'), /src=["']data:image\//i);
            }
          }
          if (id === 'text-to-speech')
            await run(ffmpeg, ['-v', 'error', '-i', result.path, '-f', 'null', '-'], { signal });
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
