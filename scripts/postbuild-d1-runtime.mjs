// D1 运行时渲染站（R254）的构建收尾：sitemap/llms 静态正本化 + 复活闸。
//
// 由 d1_runtime_scaffold.py 从模板生成；模板正本：
// cowork-cloud-tools/scripts/templates/d1-runtime/postbuild-d1-runtime.mjs.tmpl
//
// 对外的 /sitemap.xml 与 /llms.txt 由 Worker 用静态正本 + D1 现合成，因此它们
// **不能**作为构建产物存在：云构建等价闸对 dist 里每个文件逐字节核 sha256，
// 一旦它们进了 dist，要么被静态直出（新文章消失），要么哈希对不上（部署被拒）。
//
//   1. 闸：public/sitemap.xml 或 public/llms.txt 复活 → 构建直接失败并提示。
//   2. 构建生成进 dist 的 sitemap.xml / llms.txt → 改名为 *-base 静态正本。
//   3. 验收：dist 里不得再有 sitemap.xml / llms.txt，正本必须存在。
//
// --verify：只做闸和验收，不改名（接在云构建 build_command 的最后防线）。
import { existsSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const SITEMAP_MODE = "public"; // rename | index | public | none
const SITEMAP_BASE_FILE = "sitemap-base.xml"; // e.g. sitemap-base.xml / sitemap-0.xml
const REQUIRE_LLMS = true;
const verifyOnly = process.argv.includes("--verify");

function die(msg) {
  console.error(`\n❌ [postbuild-d1-runtime] ${msg}\n`);
  process.exit(1);
}

// 1. 复活闸：正本必须叫 *-base，写回旧名会盖掉 Worker 运行时合成的版本
for (const [bad, good] of [
  ["public/sitemap.xml", "public/sitemap-base.xml"],
  ["public/llms.txt", "public/llms-base.txt"],
]) {
  if (existsSync(bad)) {
    die(`${bad} 不应存在——它会盖掉 Worker 运行时合成的版本，让新文章从索引里消失。` +
        `请把内容并进 ${good} 后删除 ${bad}。详见站内 AGENTS.md。`);
  }
}

// 2. 构建生成的 dist 索引文件改名为静态正本
if (!verifyOnly) {
  if (SITEMAP_MODE === "rename" && existsSync(join(DIST, "sitemap.xml"))) {
    renameSync(join(DIST, "sitemap.xml"), join(DIST, "sitemap-base.xml"));
    console.log("[postbuild-d1-runtime] dist/sitemap.xml -> dist/sitemap-base.xml");
    // 2026-08-21 R254 实测发现（liuxue-diy）：部分 astro 站的 @astrojs/sitemap
    // 同时产出 sitemap.xml（真正 urlset）与 sitemap-index.xml（只有一条
    // <sitemap><loc>.../sitemap.xml</loc></sitemap> 的包装索引）。上面这行
    // 只重命名了前者，sitemap-index.xml 仍原样躺在 dist 里、内容还指着已经
    // 不存在的旧文件名——wrangler_deploy.py 的 sitemap_artifact_gate（生产
    // 通用闸，不限 R254）逐条核对 sitemapindex 的 <loc> 必须对应磁盘上真实
    // 文件，命中就 fail closed（liuxue-diy 实测触发云构建 EquivalenceError，
    // 脚本自身回滚逻辑已正确兜住，生产未受影响）。修法：把这份孤儿索引里
    // 指向旧文件名的条目原地改写成新文件名——sitemap-index.xml 是普通静态
    // 文件，不经 Worker 处理，改写后它指向 sitemap-base.xml（一份不含最新
    // D1 文章、但内容真实存在的合法 urlset，仍可被爬虫正常访问，只是不含
    // 运行时才现合成的最新增量，可接受）。
    const indexPath = join(DIST, "sitemap-index.xml");
    if (existsSync(indexPath)) {
      const text = readFileSync(indexPath, "utf8");
      const fixed = text.split("/sitemap.xml<").join("/sitemap-base.xml<");
      if (fixed !== text) {
        writeFileSync(indexPath, fixed, "utf8");
        console.log("[postbuild-d1-runtime] dist/sitemap-index.xml 内 /sitemap.xml 引用改写为 /sitemap-base.xml");
      }
    }
  }
  if (existsSync(join(DIST, "llms.txt"))) {
    renameSync(join(DIST, "llms.txt"), join(DIST, "llms-base.txt"));
    console.log("[postbuild-d1-runtime] dist/llms.txt -> dist/llms-base.txt");
  }
}

// 3. 验收（fail closed）
if (existsSync(join(DIST, "sitemap.xml"))) die(`${DIST}/sitemap.xml 仍存在（应只有 ${SITEMAP_BASE_FILE} 静态正本）`);
if (existsSync(join(DIST, "llms.txt"))) die(`${DIST}/llms.txt 仍存在（应只有 llms-base.txt 静态正本）`);
if (SITEMAP_MODE !== "none" && !existsSync(join(DIST, SITEMAP_BASE_FILE))) {
  die(`${DIST}/${SITEMAP_BASE_FILE} 缺失——Worker 合成 /sitemap.xml 需要它`);
}
if (REQUIRE_LLMS && !existsSync(join(DIST, "llms-base.txt"))) {
  die(`${DIST}/llms-base.txt 缺失——Worker 合成 /llms.txt 需要它`);
}
console.log(`[postbuild-d1-runtime] ok (${verifyOnly ? "verify" : "apply"})`);
