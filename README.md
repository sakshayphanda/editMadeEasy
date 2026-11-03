# Edit Made Easy

An Angular application for everyday utilities, starting with audio compression, volume increase, and trimming.

Audio is processed on-device and exported as MP3. Input support depends on the browser. Files are limited to 100 MB, 1 hour 30 minutes, and mono/stereo. Compression can produce larger files for already compressed inputs. Volume boosts use a shared peak-based gain limit with encoding headroom to avoid PCM clipping; already-loud files may receive little or no boost. Existing background noise is amplified along with the audio.

## Development

Use Node.js 24.15.0 or newer in the Node.js 24 release line and npm.

```sh
npm ci
npm start
```

Open `http://localhost:4200/`.

`npm start` runs Angular and the YouTube audio API together. The API listens on
`127.0.0.1:3001`; Angular proxies `/api` requests to it. FFmpeg is installed by
`ffmpeg-static` during `npm ci` (requires access to its binary download).

### YouTube audio downloads

`/audio/youtube` uses [Samplecut](https://samplecut.app/guides/free-audio-api)
without an API key. Video links leave the device; existing file editors remain local.
The free provider allows videos up to 60 minutes and 10 requests per 10 minutes
per server IP, with best-effort availability. The API permits one active download
and limits incoming audio to 160 MB. Cancellation does not refund provider quota.

MP3 options: 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 192,
224, 256, and 320 kbps. The provider's 320 kbps file passes through; other rates
are transcoded with FFmpeg. 8–24 kbps uses mono; low rates use a lower sample rate.
Higher output bitrates cannot improve source quality. Temporary server files are
removed after each request.

For hosting, run `npm run start:api` alongside the static Angular build and proxy
same-origin `/api/` traffic to it with a timeout of at least 300 seconds. The API
binds to loopback; `PORT` changes its port. It requires a Node server, not static
hosting alone. Apply your hosting's access controls if publishing for private use.

## Checks

```sh
npm run build
npm test -- --watch=false
npm run test:api
```

## Structure

```text
src/app/
  core/       Application-wide services and infrastructure
  features/   Feature pages and tools
    home/     Initial home page
    audio/    Shared audio editor, processing service, and MP3 worker
  shared/     Reusable UI components, directives, and pipes
```

Routes live in `src/app/app.routes.ts`. Keep feature-specific code inside its feature folder and add shared abstractions only when needed.

## Video, PDF, recording, and conversion suite

The home page has searchable video, audio, PDF, and converter groups. Existing
`/audio/compressor`, `/audio/volume`, `/audio/trimmer`, `/audio/converter`, and
`/audio/denoise` routes retain their on-device processing. The advanced audio
workspace is `/audio/editor`; it supports waveform selection, fades, tempo,
pitch, volume, MP3/WAV/FLAC/OGG/M4A export, and a separate M4R ringtone preset.

The new server tools share `/api/tools/:group/:id`. Uploads are limited to 20
files and 100 MiB total, media exports to 90 minutes, and processing to four
minutes per request. One suite request processes at a time. Temporary inputs
and outputs are deleted after completion, cancellation, or failure. Screen,
camera, and voice recordings use browser permissions and stay on-device;
they download in the browser's supported WebM or MP4 format.

Install Python 3.10+ and the project-local file libraries:

```sh
npm run setup:tools
```

For the full suite on an Apple Silicon Mac, this additionally downloads
LibreOffice, Calibre, and 7-Zip into ignored `.tools/` (about 650 MB of downloads;
several GB unpacked). No system-wide installation is performed:

```sh
npm run setup:tools -- --mac-engines
```

On other macOS/Linux servers, install [LibreOffice](https://www.libreoffice.org/download/),
[Calibre](https://calibre-ebook.com/download), and [7-Zip](https://www.7-zip.org/download.html).
The API uses `.tools/` installations when present, otherwise standard macOS app
paths or Linux commands. Override with `TOOLS_OFFICE`, `TOOLS_EBOOK`, or
`TOOLS_ARCHIVE` executable paths. `TOOLS_PYTHON` overrides `.venv/bin/python`.
Text to speech uses macOS `say` or Linux `espeak` (`TOOLS_SPEECH` override).
Restart the API after installing engines; `/api/tools/capabilities` reports
availability and the workspace explains any missing dependencies.

PDF limits: 500 pages (100 for image export), with password-required decryption.
PDF to Word extracts editable text rather than reproducing complex layout;
PDF to Excel extracts detected tables. Scanned documents need OCR beforehand.
PDF compression optimizes streams; a smaller result is not guaranteed. Image
conversions support raster inputs under 40 megapixels; animated inputs become
still images. Font conversion preserves outlines and changes the font container.
Archive conversion handles ZIP and TAR inputs; extraction also accepts 7-Zip/RAR,
rejecting encrypted entries, links, unsafe paths, and expansion beyond 1,000
files / 200 MiB. Media input support depends on FFmpeg's bundled codecs.

This is an independently implemented utility suite. The video editor combines
single-clip adjustments; it does not yet have a multitrack timeline. Cloud drive
imports, user accounts, subscriptions, AI media tools, and OCR are not included.
