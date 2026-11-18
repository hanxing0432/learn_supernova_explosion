import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'extension');
const output = join(root, '_dist', '学习通插件-Firefox');
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));

// Firefox uses an event page. Keep the Chromium manifest and its Chrome 111 minimum.
const worker = manifest.background.service_worker;
manifest.background = { scripts: ['shared/config.js', 'shared/glyphdict.js', worker], persistent: false };
delete manifest.minimum_chrome_version;
manifest.browser_specific_settings = {
  gecko: { id: 'chaoxing-helper@local', strict_min_version: '128.0' }
};

mkdirSync(output, { recursive: true });
cpSync(source, output, {
  recursive: true,
  filter: (path) => basename(path) !== 'manifest.json' && !/\.bak(?:[-.]|$)/i.test(basename(path))
});
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(join(output, 'manifest.json'));
