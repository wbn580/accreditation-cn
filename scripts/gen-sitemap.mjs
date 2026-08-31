// Regenerate the sitemap static base before every build.
//
// Why: this site has no sitemap integration — public/sitemap.xml was a hand-made
// static file, last touched 2026-08-02, and every article published after that
// date was missing from it. On 2026-08-18 that failed the search-growth public
// readback for five live GEO articles (writing-rules
// geo_article_placement.sitemap_required), even though all five served 200.
//
// 2026-08-31 根因A修复：src/pages/[...slug].astro 已改为去掉 .md 扩展名的干净
// slug（老式 type:'content' 集合在 astro 5 下 entry.id 带 .md，之前 500+ 篇全
// 部落在 /xxx.md/，站内干净链接全 404）。本脚本同步：新增条目用干净 URL，
// 读入的既有 `.md/` 条目原地迁移为干净形态。这不是 R116 意义上的 URL 缩减：
// 旧 /xxx.md/ 地址由 worker/index.ts 301 到同一篇的干净地址，一条不丢。
//
// Existing <loc> entries are always kept (after the `.md/` -> `/` migration):
// this only ever adds, so a sitemap regeneration can never shrink the published
// URL set (R116).
//
// 2026-08-22 R254 remediation: once d1_runtime_scaffold converts this site,
// public/sitemap.xml is renamed to public/sitemap-base.xml and MUST stay gone —
// the Worker composes the live /sitemap.xml at request time from that static
// base + D1. Regenerating public/sitemap.xml here would resurrect the exact
// file postbuild-d1-runtime.mjs's revival gate rejects (real incident: cloud
// build 20260822-153938, "public/sitemap.xml 不应存在"). Prefer
// sitemap-base.xml when it exists (post-conversion); fall back to the legacy
// sitemap.xml name so this script is a no-op change before conversion lands.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://accreditation.cn';
// fileURLToPath, not .pathname: the workspace path contains a space and
// .pathname hands back the percent-encoded form, which fs cannot open.
const ARTICLES = fileURLToPath(new URL('../src/content/articles/', import.meta.url));
const SITEMAP_BASE = fileURLToPath(new URL('../public/sitemap-base.xml', import.meta.url));
const SITEMAP_LEGACY = fileURLToPath(new URL('../public/sitemap.xml', import.meta.url));
const SITEMAP = existsSync(SITEMAP_BASE) ? SITEMAP_BASE : SITEMAP_LEGACY;

const existing = (() => {
  try {
    const xml = readFileSync(SITEMAP, 'utf8');
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
      .map(m => m[1].replace(/\.mdx?\/$/, '/'));
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
for (const id of walk(ARTICLES)) urls.add(`${SITE}/${id.replace(/\.mdx?$/, '')}/`);

const body = [...urls].sort()
  .map(url => `  <url><loc>${url}</loc></url>`).join('\n');
writeFileSync(SITEMAP,
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
  'utf8');
console.log(`[gen-sitemap] ${existing.length} → ${urls.size} URLs`);
