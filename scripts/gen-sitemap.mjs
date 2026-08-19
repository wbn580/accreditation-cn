// Regenerate public/sitemap.xml before every build.
//
// Why: this site has no sitemap integration — public/sitemap.xml was a hand-made
// static file, last touched 2026-08-02, and every article published after that
// date was missing from it. On 2026-08-18 that failed the search-growth public
// readback for five live GEO articles (writing-rules
// geo_article_placement.sitemap_required), even though all five served 200.
//
// Article URLs are `/{collection id}/` and the id keeps its `.md` extension,
// because src/pages/[...slug].astro uses `params: { slug: a.id }`. 500+ URLs are
// already indexed in that shape, so it is reproduced here rather than "fixed".
//
// Existing <loc> entries are always kept: this only ever adds, so a sitemap
// regeneration can never shrink the published URL set (R116).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://accreditation.cn';
// fileURLToPath, not .pathname: the workspace path contains a space and
// .pathname hands back the percent-encoded form, which fs cannot open.
const ARTICLES = fileURLToPath(new URL('../src/content/articles/', import.meta.url));
const SITEMAP = fileURLToPath(new URL('../public/sitemap.xml', import.meta.url));

const existing = (() => {
  try {
    const xml = readFileSync(SITEMAP, 'utf8');
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
  } catch {
    return [`${SITE}/`];
  }
})();

const walk = dir => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...walk(full)); continue; }
    if (!/\.mdx?$/.test(name) || name.startsWith('_')) continue;
    // Backups and quarantine copies are not published pages.
    if (/\.(bak|no-image-quarantine)/.test(name)) continue;
    const text = readFileSync(full, 'utf8').slice(0, 2000);
    if (/^\s*draft:\s*true/m.test(text)) continue;
    out.push(relative(ARTICLES, full).split(sep).join('/'));
  }
  return out;
};

const urls = new Set(existing);
for (const id of walk(ARTICLES)) urls.add(`${SITE}/${id}/`);

const body = [...urls].sort()
  .map(url => `  <url><loc>${url}</loc></url>`).join('\n');
writeFileSync(SITEMAP,
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
  'utf8');
console.log(`[gen-sitemap] ${existing.length} → ${urls.size} URLs`);
