// 把一篇文章写进 D1，立即上线，不经过 build & deploy。
//
// 由 d1_runtime_scaffold.py 从模板生成；模板正本：
// cowork-cloud-tools/scripts/templates/d1-runtime/publish-article.mjs.tmpl
// 参照实现：site-builds/course-org-cn/scripts/publish-article.mjs
//
//   node scripts/publish-article.mjs <article.json>            # 写线上库
//   node scripts/publish-article.mjs <article.json> --local    # 写本地库（调试用）
//   node scripts/publish-article.mjs <article.json> --dry-run  # 只打印 SQL
//
// article.json 字段：
//   slug          必填，URL 片段，落在 //<slug>/（root 布局无前缀，
//                 落在 /<slug>/，root 布局下不能用站点保留路径名当 slug）
//   title         必填
//   body_html     必填，正文 HTML 片段（不含站点外壳，外壳由 Worker 套）
//   description   建议填，进 meta description / og:description
//   category      可选，留空则不显示
//   published_at  可选，YYYY-MM-DD，默认今天
//   status        可选，published（默认）| draft，draft 不对外可见
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import os from "node:os";

// 2026-08-22 事故防复发（R254 存量改造 failed/failed_smoke 批次修复）：裸
// `npx wrangler`（未钉版本）每次都要向 npm registry 解析 latest + 可能冷下载，
// 和 wrangler_deploy.py 里记录的"171 站 × 冷下载吃光 4h 窗口"是同一根因——
// 冒烟测试的 publish 步骤在此处反复撞上 TimeoutExpired/IncompleteRead，误判成
// 站点级 bug。改成优先复用 wrangler_deploy.py 已经装好的共享 bin
// （~/.cache/unilink-wrangler/<version>/node_modules/.bin/wrangler，只读，
// 不在这里触发安装）；找不到才退回原来的 npx 形式，不改变任何行为语义。
function resolveWranglerCmd() {
  const cacheRoot = join(os.homedir(), ".cache", "unilink-wrangler");
  try {
    const versions = readdirSync(cacheRoot).sort().reverse();
    for (const v of versions) {
      const bin = join(cacheRoot, v, "node_modules", ".bin", "wrangler");
      if (existsSync(bin)) return { cmd: bin, prefixArgs: [] };
    }
  } catch {
    // 目录不存在等：静默退回 npx，不影响原有行为
  }
  return { cmd: "npx", prefixArgs: ["wrangler"] };
}

const DB = "accreditation-cn-content";
const ORIGIN = "https://accreditation.cn";
const SEG = "";
// R254 Phase 1（root 布局，无前缀根级文章）：SEG="" 时 SEG_SEGMENTS 为空
// 数组，SEG_PREFIX 直接是空串，与 worker-index.ts.tmpl / worker-body.pages
// .js.tmpl 里的 articlePath() 逐字同构，改一处务必改另一处。
const SEG_SEGMENTS = SEG.split("/").filter(Boolean); // [] = root 布局
const SEG_PREFIX = SEG_SEGMENTS.length ? "/" + SEG_SEGMENTS.join("/") : "";
// root 布局安全网（与 Worker 侧同一份保留字表，见 d1_runtime_scaffold.py
// RESERVED_ROOT_SLUGS）：即使发布时手滑用了站点保留路径名当 slug，这里
// 直接拒绝，不让它写进 D1。flat 布局有 seg 前缀天然隔离，不需要这层校验。
const RESERVED_ROOT_SLUGS = new Set(["404", "_astro", "about", "assets", "categories", "category", "contact", "css", "disclaimer", "en", "favicon", "favicon.ico", "fonts", "images", "img", "js", "llms.txt", "offline", "page", "pages", "privacy", "robots", "robots.txt", "search", "sitemap", "sitemap.xml", "static", "tag", "tags", "tw", "zh", "zh-cn", "zh-tw"]);

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const local = args.includes("--local");
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error("用法: node scripts/publish-article.mjs <article.json> [--local] [--dry-run]");
  process.exit(2);
}

const a = JSON.parse(readFileSync(file, "utf8"));

for (const k of ["slug", "title", "body_html"]) {
  if (!a[k] || typeof a[k] !== "string" || !a[k].trim()) {
    console.error(`字段 ${k} 必填且不能为空`);
    process.exit(2);
  }
}
// slug 直接进 URL，也进 Worker 的路由正则，收紧到和正则一致的字符集
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.slug)) {
  console.error(`slug 只能是字母数字和 . _ -，且以字母数字开头：${a.slug}`);
  process.exit(2);
}
if (SEG_SEGMENTS.length === 0 && RESERVED_ROOT_SLUGS.has(a.slug)) {
  console.error(`root 布局（无前缀）下 slug 不能是站点保留路径名：${a.slug}`);
  process.exit(2);
}
// 用北京时间而不是 UTC：中文站傍晚发的文章按 UTC 算会显示成前一天。
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const published_at = a.published_at || today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(published_at)) {
  console.error(`published_at 必须是 YYYY-MM-DD：${published_at}`);
  process.exit(2);
}
const status = a.status || "published";
if (!["published", "draft"].includes(status)) {
  console.error(`status 只能是 published 或 draft：${status}`);
  process.exit(2);
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql =
  `INSERT INTO articles (slug, title, description, category, body_html, published_at, updated_at, status)
   VALUES (${q(a.slug)}, ${q(a.title)}, ${q(a.description || "")}, ${q(a.category || "")},
           ${q(a.body_html)}, ${q(published_at)}, ${q(today)}, ${q(status)})
   ON CONFLICT(slug) DO UPDATE SET
     title=excluded.title, description=excluded.description, category=excluded.category,
     body_html=excluded.body_html, published_at=excluded.published_at,
     updated_at=excluded.updated_at, status=excluded.status;`;

if (dryRun) {
  console.log(sql);
  process.exit(0);
}

const { cmd, prefixArgs } = resolveWranglerCmd();
execFileSync(
  cmd,
  [...prefixArgs, "d1", "execute", DB, local ? "--local" : "--remote", "--command", sql, "-y"],
  { stdio: "inherit", env: { ...process.env, WRANGLER_HTTP_PROXY: "direct" } },
);

console.log(`\n✅ ${a.slug} 已${status === "draft" ? "存为草稿" : "发布"}`);
if (status === "published" && !local) {
  console.log(`   ${ORIGIN}${SEG_PREFIX}/${a.slug}/`);
  console.log(`   已自动进入 /sitemap.xml 与 /llms.txt（Worker 实时合成，无需部署）`);
}
