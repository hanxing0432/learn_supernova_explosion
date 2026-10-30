/* 生成测试版扩展：仅把匹配域名放宽到本地测试服务，其余与原扩展一致 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'extension');
const DST = path.join(ROOT, '_test-build');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(DST, { recursive: true, force: true });
copyDir(SRC, DST);

const mfPath = path.join(DST, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
const testMatches = ['http://127.0.0.1/*', 'http://localhost/*'];
mf.host_permissions = ['*://*.chaoxing.com/*', 'http://*/*', 'https://*/*'];
mf.content_scripts.forEach((cs) => {
  cs.matches = testMatches.concat(cs.matches.filter((m) => !testMatches.includes(m)));
});
/* 2026-10-31：WAR 也要一起放宽。以前只放宽了 content_scripts，导致测试台上
 * chrome.runtime.getURL('data/glyphdesc.bin.gz') 被挡（实测 data:blocked），
 * 字形字典永远取不到 —— 字体还原链路在测试台里从没真正跑过，字形表的 bug 就是这么漏掉的。 */
mf.web_accessible_resources.forEach((w) => {
  w.matches = testMatches.concat(w.matches.filter((m) => !testMatches.includes(m)));
});
mf.name = mf.name + '（测试版）';
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf8');

console.log('test build ->', DST);
