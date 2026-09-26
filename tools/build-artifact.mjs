/**
 * Package the production build (dist/) as a claude.ai Artifact:
 *  - writes dist-artifact/index.html (page body only: the host adds the document skeleton)
 *  - writes dist-artifact/files.json: { "<published path>": "<source path>" } for every asset
 *  - inlines the HUD font as a data: URI (the artifact CSP only allows fonts from data: / Google Fonts)
 * Usage: npx vite build && node tools/build-artifact.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const dist = 'dist';
const out = 'dist-artifact';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const head = html.match(/<head>([\s\S]*)<\/head>/)[1];
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
const style = head.match(/<style>[\s\S]*?<\/style>/)[0];
const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
const scripts = [...head.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]);
const preloads = [...head.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]);
const css = [...head.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]);

// Copy assets, inlining the font into whichever JS references it.
const files = {};
const assetsDir = path.join(dist, 'assets');
const fontFile = fs.readdirSync(assetsDir).find((f) => f.endsWith('.ttf'));
const fontData = fontFile ? `data:font/ttf;base64,${fs.readFileSync(path.join(assetsDir, fontFile)).toString('base64')}` : null;
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else {
      const rel = path.relative(dist, p).split(path.sep).join('/');
      if (rel === 'index.html' || rel === 'sw.js' || rel.endsWith('.ttf')) continue;
      let src = p;
      if (rel.endsWith('.js')) {
        const js = fs.readFileSync(p, 'utf8');
        let patched = js;
        if (fontData && js.includes(fontFile)) {
          patched = patched.replace(new RegExp(`(["'\`])[^"'\`]*${fontFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g'), JSON.stringify(fontData));
        }
        // Service workers can't run in an artifact frame: drop the registration entirely.
        patched = patched.replace(/[`'"]serviceWorker[`'"]\s*in\s*navigator/g, 'false');
        if (patched !== js) {
          src = path.join(out, 'patched', rel);
          fs.mkdirSync(path.dirname(src), { recursive: true });
          fs.writeFileSync(src, patched);
        }
      }
      files[rel] = src;
    }
  }
}
walk(dist);

const page = `<title>F35-A</title>
<meta name="theme-color" content="#05080c">
${style}
${css.map((h) => `<link rel="stylesheet" href="${h}">`).join('\n')}
${preloads.map((h) => `<link rel="modulepreload" crossorigin href="${h}">`).join('\n')}
${body.trim()}
${scripts.map((s) => `<script type="module" crossorigin src="${s}"></script>`).join('\n')}
`;
fs.writeFileSync(path.join(out, 'index.html'), page);
fs.writeFileSync(path.join(out, 'files.json'), JSON.stringify(files, null, 1));
console.log(`page ${page.length} B, ${Object.keys(files).length} files`);
