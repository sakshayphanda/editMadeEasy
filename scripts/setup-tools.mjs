import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
await run('python3', ['-m', 'venv', '.venv']);
await run(join(root, '.venv/bin/python'), [
  '-m',
  'pip',
  'install',
  '-r',
  'server/requirements.txt',
]);
if (process.argv.includes('--mac-engines')) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('--mac-engines requires an Apple Silicon Mac. See README for other systems.');
  const tools = join(root, '.tools');
  await mkdir(tools, { recursive: true });
  async function installApp(name, url) {
    if (
      await access(join(tools, name))
        .then(() => true)
        .catch(() => false)
    )
      return;
    const staging = await mkdtemp(join(tools, 'install-'));
    const image = join(staging, 'download.dmg'),
      mount = join(staging, 'mount');
    let attached = false;
    try {
      await run('curl', ['--fail', '--location', '--retry', '2', '--output', image, url]);
      await mkdir(mount);
      await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, image]);
      attached = true;
      await run('ditto', [join(mount, name), join(tools, name)]);
    } finally {
      if (attached) await run('hdiutil', ['detach', mount]);
      await rm(staging, { recursive: true, force: true });
    }
  }
  await installApp(
    'LibreOffice.app',
    'https://download.documentfoundation.org/libreoffice/stable/26.8.2/mac/aarch64/LibreOffice_26.8.2_MacOS_aarch64.dmg',
  );
  await installApp(
    'calibre.app',
    'https://github.com/kovidgoyal/calibre/releases/download/v9.17.0/calibre-9.17.0.dmg',
  );
  const archive = join(tools, '7zip');
  if (
    !(await access(join(archive, '7zz'))
      .then(() => true)
      .catch(() => false))
  ) {
    await mkdir(archive, { recursive: true });
    const file = join(archive, '7zip.tar.xz');
    await run('curl', [
      '--fail',
      '--location',
      '--retry',
      '2',
      '--output',
      file,
      'https://github.com/ip7z/7zip/releases/download/26.05/7z2605-mac.tar.xz',
    ]);
    await run('tar', ['-xf', file, '-C', archive]);
    await rm(file);
  }
}
console.log('File tool dependencies installed. Restart npm start.');
