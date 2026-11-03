import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const catalog = JSON.parse(
  await readFile(join(root, 'src/app/features/suite/tools.json'), 'utf8'),
);
const python = process.env['TOOLS_PYTHON'] || join(root, '.venv/bin/python');
const office =
  process.env['TOOLS_OFFICE'] ||
  (existsSync(join(root, '.tools/LibreOffice.app'))
    ? join(root, '.tools/LibreOffice.app/Contents/MacOS/soffice')
    : null) ||
  (process.platform === 'darwin'
    ? '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    : 'libreoffice');
const ebook =
  process.env['TOOLS_EBOOK'] ||
  (existsSync(join(root, '.tools/calibre.app'))
    ? join(root, '.tools/calibre.app/Contents/MacOS/ebook-convert')
    : null) ||
  (process.platform === 'darwin'
    ? '/Applications/calibre.app/Contents/MacOS/ebook-convert'
    : 'ebook-convert');
const archive =
  process.env['TOOLS_ARCHIVE'] ||
  (existsSync(join(root, '.tools/7zip/7zz')) ? join(root, '.tools/7zip/7zz') : '7zz');
const speech =
  process.env['TOOLS_SPEECH'] || (process.platform === 'darwin' ? '/usr/bin/say' : 'espeak');

export function run(command, args, { signal, cwd, env, maxOutput = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.length > maxOutput) {
        child.kill('SIGTERM');
        reject(new Error('The file generated too much processing output.'));
      }
    });
    child.stderr.on('data', (data) => {
      if (stderr.length < 65536) stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.slice(-2000) || 'The file could not be processed.')),
    );
  });
}

let capabilityPromise;
export function capabilities() {
  return (capabilityPromise ??= (async () => {
    const checks = await Promise.all([
      access(ffmpeg)
        .then(() => true)
        .catch(() => false),
      run(python, ['-c', 'import pypdf, fitz, PIL, fontTools.ttLib, docx, openpyxl, brotli'], {
        signal: AbortSignal.timeout(15000),
      })
        .then(() => true)
        .catch(() => false),
      run(office, ['--version'], { signal: AbortSignal.timeout(15000) })
        .then(() => true)
        .catch(() => false),
      run(ebook, ['--version'], { signal: AbortSignal.timeout(15000) })
        .then(() => true)
        .catch(() => false),
      run(archive, ['i'], { signal: AbortSignal.timeout(15000) })
        .then(() => true)
        .catch(() => false),
      run(speech, process.platform === 'darwin' ? ['-v', '?'] : ['--version'], {
        signal: AbortSignal.timeout(15000),
      })
        .then(() => true)
        .catch(() => false),
    ]);
    const status = Object.fromEntries(
      ['ffmpeg', 'python', 'office', 'ebook', 'archive', 'speech'].map((engine, i) => [
        engine,
        checks[i],
      ]),
    );
    const instructions = {
      ffmpeg: 'FFmpeg is missing. Run npm ci and restart the server.',
      python:
        'File-processing dependencies are missing. Follow the Python setup in README.md and restart the server.',
      office:
        'LibreOffice is required on the processing server. Install it or set TOOLS_OFFICE, then restart the server.',
      ebook:
        'Calibre is required on the processing server. Install it or set TOOLS_EBOOK, then restart the server.',
      archive:
        '7-Zip and the Python processing dependencies are required on the server. Install 7zz or set TOOLS_ARCHIVE, then restart.',
      speech:
        'A speech engine is required on the server: say on macOS or espeak on Linux. Set TOOLS_SPEECH if needed.',
    };
    return Object.fromEntries(
      catalog.map((tool) => {
        const available =
          tool.engine === 'browser' ||
          (status[tool.engine] && (tool.engine !== 'archive' || status['python']));
        return [
          `${tool.group}/${tool.id}`,
          { available: !!available, reason: available ? '' : instructions[tool.engine] },
        ];
      }),
    );
  })());
}

function num(settings, key, fallback, min, max) {
  const value = settings[key] === undefined ? fallback : settings[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`Choose a valid ${key} between ${min} and ${max}.`);
  return value;
}
function range(s, ringtone = false) {
  const start = num(s, 'start', 0, 0, 5400);
  const end = num(s, 'end', 10, 0.01, 5400);
  if (end <= start || (ringtone && end - start > 40))
    throw new Error(
      ringtone ? 'Select a ringtone range of up to 40 seconds.' : 'End must be after start.',
    );
  return { start, duration: end - start };
}
const atempo = (value) => {
  const filters = [];
  while (value < 0.5) {
    filters.push('atempo=0.5');
    value /= 0.5;
  }
  while (value > 2) {
    filters.push('atempo=2');
    value /= 2;
  }
  filters.push(`atempo=${value}`);
  return filters;
};
const audioCodec = (format) =>
  ({
    mp3: ['-c:a', 'libmp3lame', '-b:a', '192k'],
    wav: ['-c:a', 'pcm_s16le'],
    flac: ['-c:a', 'flac'],
    ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
    m4a: ['-c:a', 'aac', '-b:a', '192k'],
    m4r: ['-c:a', 'aac', '-b:a', '128k', '-f', 'ipod'],
  })[format];
const videoCodec = (format) =>
  format === 'webm'
    ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '5', '-c:a', 'libopus']
    : [
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        ...(format === 'mp4' || format === 'mov' ? ['-movflags', '+faststart'] : []),
      ];
const videoScale = (s) =>
  `scale=${num(s, 'width', 640, 2, 3840)}:${num(s, 'height', 360, 2, 2160)}:force_original_aspect_ratio=decrease,pad=${s.width ?? 640}:${s.height ?? 360}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
const rotation = (s) => {
  const value = num(s, 'rotation', 90, 0, 270);
  if (![0, 90, 180, 270].includes(value)) throw new Error('Choose a supported rotation.');
  return value === 90
    ? ['transpose=1']
    : value === 180
      ? ['hflip', 'vflip']
      : value === 270
        ? ['transpose=2']
        : [];
};

async function hasAudio(file, signal) {
  try {
    await run(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        'mov,matroska,webm,avi,mp3,wav,flac,ogg,aac,aiff,asf,mpeg,mpegts,ac3,amr',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-t',
        '0.01',
        '-f',
        'null',
        '-',
      ],
      { signal },
    );
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

async function media(tool, files, s, directory, signal) {
  const format = s.format;
  const output = join(directory, `result.${format}`);
  const base = [
    '-nostdin',
    '-hide_banner',
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-filter_threads',
    '1',
    '-filter_complex_threads',
    '1',
  ];
  const demuxers =
    'mov,matroska,webm,avi,mp3,wav,flac,ogg,aac,aiff,asf,mpeg,mpegts,ac3,amr,png_pipe,jpeg_pipe,webp_pipe,gif,bmp_pipe,tiff_pipe';
  const sourceInput = (path) => [
    '-protocol_whitelist',
    'file,pipe',
    '-format_whitelist',
    demuxers,
    '-i',
    path,
  ];
  let input = sourceInput(files[0].path);
  const af = [],
    vf = [];
  let mapping = [];
  const id = tool.id;
  const isAudio = tool.group === 'audio' || (tool.group === 'convert' && id === 'audio');
  const trimming = ['editor', 'trim', 'ringtone'].includes(id);
  if (trimming) {
    const selected = range(s, id === 'ringtone');
    af.push(`atrim=start=${selected.start}:duration=${selected.duration}`, 'asetpts=PTS-STARTPTS');
    vf.push(`trim=start=${selected.start}:duration=${selected.duration}`, 'setpts=PTS-STARTPTS');
  }
  if (id === 'loop') input = ['-stream_loop', String(num(s, 'loops', 2, 2, 10) - 1), ...input];
  if (['speed', 'editor'].includes(id)) {
    const speed = num(s, 'speed', 1, 0.25, 4);
    af.push(...atempo(speed));
    vf.push(`setpts=PTS/${speed}`);
  }
  if (['volume', 'editor'].includes(id))
    af.push(`volume=${num(s, 'volume', 100, 0, 300) / 100}`, 'alimiter=limit=0.95:level=0');
  if (isAudio && ['pitch', 'editor'].includes(id)) {
    const ratio = 2 ** (num(s, 'pitch', 0, -12, 12) / 12);
    af.push(
      'aresample=44100',
      `asetrate=${Math.round(44100 * ratio)}`,
      'aresample=44100',
      ...atempo(1 / ratio),
    );
  }
  if (isAudio && ['editor', 'ringtone'].includes(id)) {
    const length =
      range(s, id === 'ringtone').duration / (id === 'editor' ? num(s, 'speed', 1, 0.25, 4) : 1);
    const fadeIn = num(s, 'fadeIn', 0, 0, 30),
      fadeOut = num(s, 'fadeOut', 0, 0, 30);
    if (fadeIn > length || fadeOut > length)
      throw new Error('Fades must fit inside the selected audio.');
    if (fadeIn) af.push(`afade=t=in:d=${fadeIn}`);
    if (fadeOut) af.push(`afade=t=out:st=${Math.max(0, length - fadeOut)}:d=${fadeOut}`);
  }
  if (id === 'equalizer')
    for (const [key, freq] of [
      ['bass', 100],
      ['mid', 1000],
      ['treble', 8000],
    ])
      af.push(`equalizer=f=${freq}:t=o:w=2:g=${num(s, key, 0, -20, 20)}`);
  if (id === 'reverse') af.push('areverse');
  if (!isAudio && ['editor', 'resize'].includes(id)) vf.push(videoScale(s));
  if (!isAudio && ['editor', 'rotate'].includes(id)) vf.push(...rotation(s));
  if (id === 'flip') {
    if (!['horizontal', 'vertical'].includes(s.direction))
      throw new Error('Choose a flip direction.');
    vf.push(s.direction === 'vertical' ? 'vflip' : 'hflip');
  }
  if (id === 'crop' || id === 'remove-logo') {
    const x = num(s, 'x', 0, 0, 7680),
      y = num(s, 'y', 0, 0, 4320),
      w = num(s, 'width', 640, 2, 3840),
      h = num(s, 'height', 360, 2, 2160);
    vf.push(id === 'crop' ? `crop=${w}:${h}:${x}:${y}` : `delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
  }
  if (id === 'stabilize') vf.push('deshake');
  if (id === 'add-text') {
    if (typeof s.text !== 'string' || !s.text.trim() || s.text.length > 5000)
      throw new Error('Enter up to 5,000 characters of text.');
    await writeFile(join(directory, 'caption.txt'), s.text);
    vf.push(
      `drawtext=textfile=caption.txt:expansion=none:fontsize=${num(s, 'fontSize', 36, 8, 160)}:fontcolor=white:box=1:boxcolor=black@0.5:x=${num(s, 'x', 0, 0, 7680)}:y=${num(s, 'y', 0, 0, 4320)}`,
    );
  }
  if (id === 'add-audio' || id === 'add-image') {
    if (files.length !== 2)
      throw new Error(
        `Choose exactly two files: the video first, then the ${id === 'add-audio' ? 'audio' : 'image'}.`,
      );
    input.push(...(id === 'add-image' ? ['-loop', '1'] : []), ...sourceInput(files[1].path));
    if (id === 'add-audio') mapping = ['-map', '0:v:0', '-map', '1:a:0', '-shortest'];
    else {
      const overlay = `[1:v]scale=${num(s, 'overlayWidth', 200, 2, 1920)}:-2[image];[0:v][image]overlay=${num(s, 'x', 0, 0, 7680)}:${num(s, 'y', 0, 0, 4320)}:shortest=1,scale=trunc(iw/2)*2:trunc(ih/2)*2[v]`;
      mapping = ['-filter_complex', overlay, '-map', '[v]', '-map', '0:a?', '-shortest'];
    }
  }
  if (id === 'merge' || id === 'joiner') {
    if (files.length < 2) throw new Error('Choose at least two files to join.');
    input = files.flatMap((file) => sourceInput(file.path));
    if (id === 'joiner') {
      const graph =
        files
          .map(
            (_, i) =>
              `[${i}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`,
          )
          .join(';') +
        ';' +
        files.map((_, i) => `[a${i}]`).join('') +
        `concat=n=${files.length}:v=0:a=1[a]`;
      mapping = ['-filter_complex', graph, '-map', '[a]'];
    } else {
      // Normalize each input in a separate pass so silent tracks end with the video.
      const normalized = [];
      for (let i = 0; i < files.length; i++) {
        const path = join(directory, `segment-${i}.mp4`);
        const audio = await hasAudio(files[i].path, signal);
        await run(
          ffmpeg,
          [
            ...base,
            ...sourceInput(files[i].path),
            ...(!audio ? ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'] : []),
            '-map',
            '0:v:0',
            '-map',
            audio ? '0:a:0' : '1:a:0',
            '-vf',
            `${videoScale(s)},fps=30`,
            '-af',
            'aresample=44100,aformat=channel_layouts=stereo',
            '-t',
            '5400',
            '-fs',
            '262144000',
            '-shortest',
            ...videoCodec('mp4'),
            '-y',
            path,
          ],
          { signal, cwd: directory },
        );
        normalized.push(path);
      }
      await writeFile(
        join(directory, 'join.txt'),
        normalized.map((path) => `file '${path}'`).join('\n'),
      );
      input = ['-f', 'concat', '-safe', '0', '-i', join(directory, 'join.txt')];
      mapping = [];
    }
  }
  if (isAudio) {
    if (!mapping.length) mapping = ['-map', '0:a:0'];
    await run(
      ffmpeg,
      [
        ...base,
        ...input,
        ...mapping,
        '-vn',
        ...(af.length ? ['-af', af.join(',')] : []),
        '-t',
        '5400',
        '-fs',
        '262144000',
        '-map_metadata',
        '-1',
        ...audioCodec(format),
        '-y',
        output,
      ],
      { signal, cwd: directory },
    );
  } else {
    const audio = await hasAudio(files[0].path, signal);
    if (!mapping.length) mapping = ['-map', '0:v:0', '-map', '0:a?'];
    vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    await run(
      ffmpeg,
      [
        ...base,
        ...input,
        ...mapping,
        ...(vf.length && id !== 'add-image' && format !== 'gif' ? ['-vf', vf.join(',')] : []),
        ...(af.length && audio ? ['-af', af.join(',')] : []),
        '-t',
        '5400',
        '-fs',
        '262144000',
        '-map_metadata',
        '-1',
        ...(format === 'gif'
          ? ['-an', '-vf', 'fps=12,scale=640:-1:flags=lanczos']
          : videoCodec(format)),
        '-y',
        output,
      ],
      { signal, cwd: directory },
    );
  }
  return { path: output, format };
}

export async function processTool(tool, files, s, directory, signal) {
  if (!tool.formats.includes(s.format)) throw new Error('Choose a supported output format.');
  for (const field of tool.fields) {
    if (field.type === 'number') num(s, field.key, field.default, field.min, field.max);
    else if (field.type === 'select') {
      if (!field.choices.includes(s[field.key])) throw new Error(`Choose a valid ${field.label}.`);
    } else if (typeof s[field.key] !== 'string' || s[field.key].length > 5000)
      throw new Error(`Enter a valid ${field.label}.`);
  }
  if (tool.engine === 'ffmpeg') return media(tool, files, s, directory, signal);
  const output = join(directory, `result.${s.format}`);
  if (tool.engine === 'office') {
    const extension = files[0].extension;
    if (
      ![
        'doc',
        'docx',
        'odt',
        'rtf',
        'txt',
        'html',
        'xls',
        'xlsx',
        'ods',
        'ppt',
        'pptx',
        'odp',
      ].includes(extension)
    )
      throw new Error('Choose a supported office document.');
    // Each conversion has an isolated profile to avoid attaching to a desktop session.
    await run(
      office,
      [
        `-env:UserInstallation=${new URL(`file://${directory}/office-profile`).href}`,
        '--headless',
        '--convert-to',
        s.format,
        '--outdir',
        join(directory, 'converted'),
        files[0].path,
      ],
      { signal },
    );
    const outputs = await readdir(join(directory, 'converted'));
    const name = outputs.find((name) => name.endsWith(`.${s.format}`));
    if (!name) throw new Error('This document cannot be converted to the selected format.');
    if (s.format === 'html') {
      const htmlPath = join(directory, 'converted', name);
      const assets = new Map();
      for (const asset of outputs) {
        const type = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          svg: 'image/svg+xml',
        }[asset.split('.').pop().toLowerCase()];
        if (type)
          assets.set(
            asset,
            `data:${type};base64,${(await readFile(join(directory, 'converted', asset))).toString('base64')}`,
          );
      }
      const html = await readFile(htmlPath, 'utf8');
      await writeFile(
        htmlPath,
        html.replace(/\bsrc=(["'])([^"']+)\1/gi, (match, quote, source) =>
          assets.has(source) ? `src=${quote}${assets.get(source)}${quote}` : match,
        ),
      );
    }
    return { path: join(directory, 'converted', name), format: s.format };
  }
  if (tool.engine === 'ebook') {
    if (!['epub', 'mobi', 'azw3', 'fb2', 'txt', 'html'].includes(files[0].extension))
      throw new Error('Choose a supported ebook.');
    await run(ebook, [files[0].path, output], {
      signal,
      env: { ...process.env, CALIBRE_CONFIG_DIRECTORY: join(directory, 'calibre-profile') },
    });
    return { path: output, format: s.format };
  }
  if (tool.engine === 'speech') {
    if (!s.text.trim()) throw new Error('Enter some text to speak.');
    const textPath = join(directory, 'speech.txt');
    await writeFile(textPath, s.text);
    if (process.platform === 'darwin') {
      const intermediate = join(directory, 'speech.aiff');
      await run(speech, ['-f', textPath, '-o', intermediate], { signal });
      await run(ffmpeg, ['-nostdin', '-v', 'error', '-i', intermediate, '-y', output], { signal });
    } else await run(speech, ['-f', textPath, '-w', output], { signal });
    return { path: output, format: 'wav' };
  }
  if (tool.engine === 'archive') {
    // Read entries before extraction; reject path traversal, links and encryption.
    const listing = await run(archive, ['l', '-slt', '-p', files[0].path], {
      signal,
      maxOutput: 1024 * 1024,
    });
    const entries = listing.split('----------')[1] ?? '';
    if (
      !entries ||
      /(?:Symbolic Link|Hard Link) =|Encrypted = \+|^Attributes =.*\bl[rwx-]/m.test(entries)
    )
      throw new Error('Encrypted archives and links are not supported.');
    for (const match of entries.matchAll(/^Path = (.+)$/gm))
      if (/^(?:\/|\\|[a-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(match[1]))
        throw new Error('Archive contains unsafe file paths.');
    const sizes = [...entries.matchAll(/^Size = (\d+)$/gm)].map((m) => Number(m[1]));
    if (sizes.length > 1000 || sizes.reduce((a, b) => a + b, 0) > 200 * 1024 * 1024)
      throw new Error('Archive expands beyond the 200 MB / 1,000 file limit.');
    const extracted = join(directory, 'extracted');
    await run(archive, ['x', '-y', '-p', `-o${extracted}`, files[0].path], { signal });
    await writeFile(
      join(directory, 'job.json'),
      JSON.stringify({
        group: 'convert',
        id: 'pack-directory',
        files: [extracted],
        settings: { format: 'zip' },
        output,
      }),
    );
  } else
    await writeFile(
      join(directory, 'job.json'),
      JSON.stringify({
        group: tool.group,
        id: tool.id,
        files: files.map((f) => f.path),
        settings: s,
        output,
      }),
    );
  const result = await run(
    python,
    [join(root, 'server/file-tools.py'), join(directory, 'job.json')],
    { signal, cwd: directory },
  );
  const metadata = JSON.parse(result.trim().split('\n').at(-1));
  return { path: metadata.path, format: metadata.format };
}
