// 从一篇已构建好的静态文章页反推出运行时渲染模板（worker/template.ts）。
//
// 由 d1_runtime_scaffold.py 从模板生成；模板正本：
// cowork-cloud-tools/scripts/templates/d1-runtime/gen-article-template.mjs.tmpl
// 参照实现：site-builds/course-org-cn/scripts/gen-article-template.mjs
//
// 站点外壳（head/meta/nav/footer）由构建产出，手抄一份到 Worker 里迟早跑偏。
// 这里以真实产物为唯一正本切出 HEAD/TAIL 两段，中间留占位符，运行时只把
// D1 里的字段填进去 —— 动态文章和静态文章长得一模一样。
//
// 外壳改版后重跑本脚本即可：node scripts/gen-article-template.mjs
// 任何一步定位/替换失败都直接 throw（fail closed），绝不硬切。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const REF = "dist/university-equis-accredited_list/index.html"; // 参考页（已构建产物里的一篇真实文章页）
const SEG = "";
const DEFAULT_OG = "https://accreditation.cn/og-images/default.jpg"; // 站点默认 og 图（绝对 URL，可为空串）
const OUT = "worker/template.ts";

let html = readFileSync(REF, "utf8");

// ── 1. 从参考页自提取元数据（不手抄，保证与产物一致） ──────────────
function extractCanonical(h) {
  const m =
    /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(h) ||
    /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(h);
  if (!m) throw new Error("参考页找不到 canonical");
  return m[1];
}
function extractDesc(h) {
  const m =
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(h) ||
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i.exec(h);
  if (!m) throw new Error("参考页找不到 meta description");
  return m[1];
}
function extractTitle(h) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h);
  if (!m) throw new Error("参考页找不到 <h1>");
  const text = m[1].replace(/<[^>]+>/g, "").trim();
  if (!text) throw new Error("参考页 <h1> 为空");
  return text;
}
function extractDateIso(h) {
  let m = /<meta[^>]*property=["']article:published_time["'][^>]*content=["'](\d{4}-\d{2}-\d{2})/i.exec(h);
  if (m) return m[1];
  m = /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(h);
  if (m) return m[1];
  m = /<div class="text-sm mb-3"[^>]*>\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(h);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  // 2026-09-26 WS-I（fudan-help 实测）：没有任何日期元数据、只在标题旁边写着可见日期
  // 的站，取紧挨标题 <h1> 前后的第一个日期，供后面把它换成 {{DATE}}。
  const h1At = h.search(/<h1\b/i);
  if (h1At >= 0) {
    const near = h.slice(Math.max(0, h1At - 800), h1At + 1200).replace(/<[^>]+>/g, " ");
    m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(near) || /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(near);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    const en = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\b/.exec(near);
    if (en) {
      const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(en[1].toLowerCase()) + 1;
      return `${en[3]}-${String(mi).padStart(2, "0")}-${String(en[2]).padStart(2, "0")}`;
    }
  }
  return "";
}

// 2026-08-22 事故防复发（airfare-cn 实测）：同一个 URL 在页面不同位置可能
// 一处百分号编码、一处原样（未编码，含中文）——字面量替换只灭得掉命中的那种
// 形态，另一种编码形态照样把 REF_SLUG 焼死在 HEAD 里。这两个帮手把"编码/
// 解码失败"（畸形转义序列）当作"这条路走不通"，返回 null 让调用方跳过，
// 不拖垮主流程。
function decodeSafely(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}
function encodeSafely(s) {
  try { return encodeURI(s); } catch { return null; }
}

const REF_CANONICAL = extractCanonical(html);
let REF_TITLE = extractTitle(html);
const REF_DESC = extractDesc(html);
const REF_DATE_ISO = extractDateIso(html);
const CANONICAL_BASE = REF_CANONICAL.replace(/\/+$/, "");
const REF_SLUG = CANONICAL_BASE.split("/").pop();
if (!REF_SLUG) throw new Error(`canonical 解析不出 slug：${REF_CANONICAL}`);

// 2026-08-22 事故防复发（faq-tools 实测）：extractTitle 默认认 <h1> 是
// SEO title 的权威来源，多数家族里 <h1> 与 <title>/og:title 共享同一段
// 文案（<title> 只是多带一截 " | 站名" 后缀），这个假设成立。但"工具型"
// 页面常见另一种结构：<h1> 是一段跟 SEO <title> 完全不相干的营销 tagline
// （faq-tools 实测 h1="Build schema from what readers can actually see."，
// title="FAQPage schema builder | FAQ Tools"，两者毫无交集）——继续拿 h1
// 当 REF_TITLE，<title>/og:title 等 head 字段里的真实标题文案永远匹配不上，
// {{TITLE}} 占位符插不进 head，直接 fail closed（好过硬切，但漏掉了本可以
// 处理的家族）。用 <title> 标签内容做自检：h1 文案不是 <title> 的子串时，
// 改用从 <title> 里按常见"标题 | 站名"分隔符切出的前段作为 REF_TITLE——
// 同一逻辑保护了本来就能过的家族：h1 是子串时完全走原逻辑，行为不变，
// 零回归风险（这条分支原本必定导致下游 fail closed，现在才有机会兜底）。
const titleTagMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
const rawTitleTag = titleTagMatch ? titleTagMatch[1].trim() : "";
if (rawTitleTag && !rawTitleTag.includes(REF_TITLE)) {
  const sepMatch = /^([\s\S]+?)\s*[|\-—·]\s*[^|\-—·]+$/.exec(rawTitleTag);
  const fallbackTitle = (sepMatch ? sepMatch[1] : rawTitleTag).trim();
  if (fallbackTitle) REF_TITLE = fallbackTitle;
}

// ── 2. 定位正文容器（优先 prose，其次 <article>，再次 <main>） ─────
// 返回 [容器开标签结束位置, 容器闭标签开始位置]，闭标签用同名标签深度扫描配对。
function matchClose(h, tagName, fromIdx) {
  const re = new RegExp(`<${tagName}\\b|</${tagName}>`, "gi");
  re.lastIndex = fromIdx;
  let depth = 1;
  let m;
  while ((m = re.exec(h)) !== null) {
    if (m[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return m.index;
    } else {
      depth += 1;
    }
  }
  throw new Error(`容器 <${tagName}> 找不到配对的闭标签`);
}

function locateContainer(h) {
  const proseAttr = h.indexOf('class="prose');
  if (proseAttr >= 0) {
    const tagStart = h.lastIndexOf("<", proseAttr);
    const tagName = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(h.slice(tagStart))?.[1];
    if (!tagName) throw new Error("prose 容器开标签解析失败");
    const openEnd = h.indexOf(">", proseAttr) + 1;
    if (openEnd <= 0) throw new Error("prose 容器开标签未闭合");
    return { openEnd, closeStart: matchClose(h, tagName, openEnd), via: "prose" };
  }
  for (const tagName of ["article", "main"]) {
    const tagRe = new RegExp(`<${tagName}\\b`, "gi");
    let m;
    while ((m = tagRe.exec(h)) !== null) {
      const openEnd = h.indexOf(">", m.index) + 1;
      if (openEnd <= 0) continue;
      let closeStart;
      try {
        closeStart = matchClose(h, tagName, openEnd);
      } catch {
        continue;
      }
      // 2026-08-22 事故防复发（wollongong-help 实测）：第一个命中的
      // <article>/<main> 不一定是正文容器——该站页面结构是
      // `<article class="header-spacer"></article><article class="article-page">...`，
      // 一个纯装饰用的空 <article> 排在真正正文之前，取第一个命中会把
      // openEnd/closeStart 锁死在同一个位置（空容器），下游"正文边界推断
      // 失败"必然触发。跳过空容器，继续找同名标签的下一次出现，直到找到
      // 真正有内容的正文容器；只有一个命中且非空的家族（原来能过的家族）
      // 第一轮就返回，行为不变。
      if (openEnd < closeStart) return { openEnd, closeStart, via: tagName };
      tagRe.lastIndex = closeStart;
    }
  }
  throw new Error("参考页找不到正文容器（prose/<article>/<main> 都没有）");
}

// Preserve global shell bytes before any article URL/text substitution. A fixed
// navigation link can legitimately point at the reference article itself.
const fixedShell = [];
function protectGlobalShell(source) {
  const tokens = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?([a-z][\w-]*)\b[^>]*>/gi;
  const stack = [];
  const ranges = [];
  let match;
  while ((match = tokens.exec(source))) {
    const tag = match[2]?.toLowerCase();
    if (!tag) continue;
    if (match[0].startsWith("</")) {
      const index = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (index < 0) continue;
      const entry = stack[index];
      if (entry.fixed) ranges.push([entry.start, tokens.lastIndex]);
      stack.length = index;
      continue;
    }
    const articleContext = stack.some((entry) => ["main", "article"].includes(entry.tag));
    const contextual = /breadcrumb|article[-_ ]|post[-_ ]|entry[-_ ]|byline/i.test(match[0]);
    const fixed = ["header", "nav", "footer"].includes(tag) && !articleContext && !contextual &&
      !stack.some((entry) => entry.fixed);
    if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag) &&
        !match[0].endsWith("/>")) stack.push({ tag, start: match.index, fixed });
  }
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    const token = `<!--D1_FIXED_SHELL_${fixedShell.length}-->`;
    if (source.includes(token)) throw new Error("fixed shell token collision");
    fixedShell.push([token, source.slice(start, end)]);
    source = source.slice(0, start) + token + source.slice(end);
  }
  return source;
}
html = protectGlobalShell(html);

// ── 2a. 标题块并入 HEAD（2026-09-26 WS-I 事故防复发） ─────────────────
// D1 行的 body_html 不含标题：d1_runtime_article_bridge.strip_initial_h1 会剥掉
// 正文开头的 <h1>。所以标题（以及日期/作者行）必须由模板 HEAD 提供。原先只认
// 「容器一开头就是 <h1>」这一种形态；bijia.help 这类站的 <article> 里先是
// <header>（h1 + <time> + 标签），再是 <div class="article-body">——按 <article>
// 切会把整个 header 切进正文区，于是 179 个站的 D1 文章页没有 h1、没有日期
// （help 矩阵 35 站、settlement.hk、liuxue.help 等线上实测 h1=0）。这里通用处理：
// 在正文容器里找到标题 <h1>，逐层下钻到「包含标题、但不包含正文主体」的那个
// 直接子节点作为标题块，连同紧跟其后的日期/作者/导语行一起并进 HEAD；标题块之后
// 如果有一个装着绝大部分正文的包裹元素（如 div.article-body），就把正文插入点
// 改到它里面，保证 D1 正文沿用静态页同一套排版样式。
const TITLE_BLOCK_VOID = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
const TITLE_META_HINT = /(?:meta|byline|date|time|author|info|tags?\b|categor|reading|subtitle|breadcrumb|crumbs?|posted|published|updated)/i;
const TITLE_LEDE_HINT = /(?:lead|lede|excerpt|summary|dek|deck|intro|standfirst|subtitle|description|abstract)/i;
function titleBlockText(fragment) {
  return fragment
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ").trim();
}
// 容器 [from, to) 内的直接子元素（注释、script/style 原样跳过）。
function titleBlockChildren(h, from, to) {
  const tokenRe = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/gi;
  tokenRe.lastIndex = from;
  const children = [];
  const stack = [];
  let m;
  while ((m = tokenRe.exec(h)) !== null && m.index < to) {
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      if (!stack.length) children.push({ tag: m[1].toLowerCase(), start: m.index, openEnd: m.index + m[0].indexOf(">") + 1, closeStart: tokenRe.lastIndex - `</${m[1]}>`.length, end: tokenRe.lastIndex, openTag: m[0].slice(0, m[0].indexOf(">") + 1) });
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[0].startsWith("</")) {
      const idx = stack.map((e) => e.tag).lastIndexOf(tag);
      if (idx < 0) continue;
      const entry = stack[idx];
      stack.length = idx;
      if (!stack.length) {
        entry.closeStart = m.index; entry.end = tokenRe.lastIndex;
        children.push(entry);
      }
      continue;
    }
    const selfClosed = TITLE_BLOCK_VOID.test(tag) || m[0].endsWith("/>");
    const node = { tag, start: m.index, openEnd: tokenRe.lastIndex, closeStart: tokenRe.lastIndex, end: tokenRe.lastIndex, openTag: m[0] };
    if (selfClosed) { if (!stack.length) children.push(node); continue; }
    stack.push(node);
  }
  if (stack.length) return null; // 容器内结构不闭合：不猜，交给原逻辑
  return children;
}
function titleBlockHasRefDate(text) {
  if (!REF_DATE_ISO) return false;
  const [y, mo, d] = REF_DATE_ISO.split("-").map(Number);
  const p2 = (n) => String(n).padStart(2, "0");
  return [
    `${y}-${p2(mo)}-${p2(d)}`, `${y}/${p2(mo)}/${p2(d)}`, `${y}/${mo}/${d}`, `${y}年${mo}月${d}日`,
    `${y}.${p2(mo)}.${p2(d)}`, `${p2(d)}/${p2(mo)}/${y}`,
    ...(() => {
      const mon = ["January", "February", "March", "April", "May", "June", "July", "August",
        "September", "October", "November", "December"][mo - 1] || "";
      return mon ? [`${mon} ${d}, ${y}`, `${d} ${mon} ${y}`, `${mon.slice(0, 3)} ${d}, ${y}`, `${d} ${mon.slice(0, 3)} ${y}`] : [];
    })(),
  ].some((form) => text.includes(form));
}
function findTitleH1(h, from, to, refTitle) {
  const re = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi;
  re.lastIndex = from;
  const want = refTitle ? titleBlockText(refTitle) : "";
  let m;
  let first = null;
  while ((m = re.exec(h)) !== null && m.index < to) {
    const hit = { start: m.index, end: re.lastIndex, text: titleBlockText(m[1]) };
    if (!hit.text) continue;
    if (!first) first = hit;
    if (want && (hit.text.includes(want) || want.includes(hit.text))) return hit;
  }
  return want ? null : first;
}
// 返回 { headParts: [[s,e],...], tailParts: [[s,e],...] } 或 null（无法处理，走原逻辑）。
function splitTitleBlock(h, openEnd, closeStart, h1) {
  if (!h1) return null;
  let from = openEnd;
  let to = closeStart;
  const levels = [];
  for (let depth = 0; depth < 12; depth += 1) {
    const children = titleBlockChildren(h, from, to);
    if (!children || !children.length) return null;
    const idx = children.findIndex((c) => c.start <= h1.start && c.end >= h1.end);
    if (idx < 0) return null;
    const child = children[idx];
    const insideAfter = child.tag === "h1" ? 0 : titleBlockText(h.slice(h1.end, child.closeStart)).length;
    const outsideAfter = titleBlockText(h.slice(child.end, to)).length;
    if (child.tag !== "h1" && insideAfter > outsideAfter) {
      // 标题和正文主体同在这个子节点里：下钻一层。
      levels.push(child);
      from = child.openEnd; to = child.closeStart;
      continue;
    }
    // 标题块 = child，再并入紧跟其后的日期/作者/导语行。
    let titleEnd = child.end;
    let next = idx + 1;
    const rest = children.slice(idx + 1);
    const restText = titleBlockText(h.slice(child.end, to)).length;
    // 装着绝大部分正文的包裹元素（div.article-body 这类）。
    let bodyEl = null;
    for (const c of rest) {
      if (!/^(?:div|section|article|main)$/.test(c.tag) || c.openEnd === c.end) continue;
      const len = titleBlockText(h.slice(c.openEnd, c.closeStart)).length;
      if (restText > 0 && len >= restText * 0.6) { bodyEl = c; break; }
    }
    const refDesc = titleBlockText(REF_DESC);
    while (next < children.length && children[next] !== bodyEl) {
      const c = children[next];
      const inner = h.slice(c.start, c.end);
      const text = titleBlockText(inner);
      const attrs = c.openTag.replace(/\sstyle\s*=\s*(["'])[\s\S]*?\1/gi, "");
      // 只并入确实是「这篇文章的日期行」的兄弟节点：带 <time>，或文字里就是参考页
      // 发布日期。仅凭 class 像 meta/subtitle 的块（地址、专业名、工具说明）是参考页
      // 自己的内容，并进来会出现在每篇 D1 文章上（findstay-org / westernsydney-help 实测）。
      const isMeta = (/<time\b/i.test(inner) || titleBlockHasRefDate(text)) && text.length <= 240 && !/<h[1-3]\b/i.test(inner);
      const isLede = (bodyEl || TITLE_LEDE_HINT.test(attrs)) && refDesc.length >= 12 && text === refDesc;
      if (!isMeta && !isLede) break;
      titleEnd = c.end;
      next += 1;
    }
    // 正文区里正文之外的块（相关文章、上下篇、分享、标签）与原来一样整体丢弃：
    // TAIL 只保留逐层闭合标签，结构平衡，不引入新的参考文章上下文。
    const closers = levels.slice().reverse().map((l) => [l.closeStart, l.end]);
    // 标题块内部：与 h1 同层、排在 h1 之后的兄弟节点里，导语（class 像 dek/intro/
    // subtitle）换成 {{DESC}}，日期行保留，其余成段文字（「简短回答」框、参考页
    // 自己的说明）是参考文章内容，删掉（oceanian-net / offeruni-com 实测）。
    const edits = [];
    if (child.tag !== "h1") {
      let pFrom = child.openEnd;
      let pTo = child.closeStart;
      for (let guard = 0; guard < 12; guard += 1) {
        const kids = titleBlockChildren(h, pFrom, pTo);
        if (!kids) break;
        const k = kids.findIndex((c) => c.start <= h1.start && c.end >= h1.end);
        if (k < 0) break;
        if (kids[k].tag !== "h1") { pFrom = kids[k].openEnd; pTo = kids[k].closeStart; continue; }
        for (const sib of kids.slice(k + 1)) {
          if (sib.openEnd === sib.end) continue;
          const inner = h.slice(sib.start, sib.end);
          const text = titleBlockText(inner);
          const attrs = sib.openTag.replace(/\sstyle\s*=\s*(["'])[\s\S]*?\1/gi, "");
          if (/<time\b/i.test(inner) || titleBlockHasRefDate(text)) continue;
          // 标题旁的语言切换（<a hreflang>，offeruni-com 实测）指向参考文章的译文页，
          // 译文 slug 与原文不同，slug 残留闸抓不到；D1 文章没有对应译文，删掉。
          if (sib.tag === "a" && /\bhreflang\s*=/i.test(sib.openTag)) { edits.push([sib.start, sib.end, ""]); continue; }
          const refDescText = titleBlockText(REF_DESC);
          if ((TITLE_LEDE_HINT.test(attrs) || (refDescText.length >= 12 && text === refDescText)) &&
              !/<(?:h[1-6]|ul|ol|table|section)\b/i.test(inner)) {
            edits.push([sib.openEnd, sib.closeStart, "{{DESC}}"]);
          } else if (text.length >= 40) {
            edits.push([sib.start, sib.end, ""]);
          }
        }
        break;
      }
    }
    const withEdits = (s0, e0) => {
      let out = "";
      let cur = s0;
      for (const [a, b, rep] of edits.filter(([a, b]) => a >= s0 && b <= e0).sort((x, y) => x[0] - y[0])) {
        out += h.slice(cur, a) + rep;
        cur = b;
      }
      return out + h.slice(cur, e0);
    };
    if (bodyEl) {
      return {
        headText: withEdits(0, titleEnd) + h.slice(bodyEl.start, bodyEl.openEnd),
        headParts: [[0, titleEnd], [bodyEl.start, bodyEl.openEnd]],
        tailParts: [[bodyEl.closeStart, bodyEl.end], ...closers, [closeStart, h.length]],
        via: `title-block+${bodyEl.tag}`,
      };
    }
    return { headText: withEdits(0, titleEnd), headParts: [[0, titleEnd]], tailParts: [...closers, [closeStart, h.length]], via: "title-block" };
  }
  return null;
}
// 容器里要并进 HEAD 的标题 <h1>：HEAD 里已有标题 h1 时返回 null。
function containerTitleH1(fragmentHead, h, openEnd, closeStart, refTitle) {
  const bodyAt = Math.max(0, fragmentHead.search(/<body\b/i));
  if (findTitleH1(fragmentHead, bodyAt, fragmentHead.length, refTitle)) return null;
  const hit = findTitleH1(h, openEnd, closeStart, refTitle);
  if (hit) return hit;
  // 标题文案对不上（<title> 截断、工具页 tagline）：HEAD 里一个 h1 都没有时，
  // 才退到容器里的第一个 h1。
  if (findTitleH1(fragmentHead, bodyAt, fragmentHead.length, null)) return null;
  return findTitleH1(h, openEnd, closeStart, null);
}


const { openEnd, closeStart, via } = locateContainer(html);
if (!(openEnd < closeStart)) throw new Error("正文边界推断失败");

// 容器一开头如果就是 <h1>（简单模板家族：标题在容器内），把它并进 HEAD，
// 因为 body_html 与 course-org-cn 一致约定不含 <h1>。
let bodyStart = openEnd;
const afterOpen = html.slice(openEnd);
const wsLen = afterOpen.length - afterOpen.replace(/^\s+/, "").length;
if (/^<h1\b/i.test(afterOpen.slice(wsLen))) {
  const h1Close = html.indexOf("</h1>", openEnd);
  if (h1Close < 0) throw new Error("容器内 <h1> 未闭合");
  bodyStart = h1Close + "</h1>".length;
}

let head = html.slice(0, bodyStart);
let tail = html.slice(closeStart);
let cutVia = via;
// 标题不在 HEAD 里（容器开头不是 <h1>）：把标题块并进 HEAD，见 2a 节。
{
  const split = splitTitleBlock(html, openEnd, closeStart, containerTitleH1(head, html, openEnd, closeStart, REF_TITLE));
  if (split) {
    head = split.headText;
    tail = split.tailParts.map(([s, e]) => html.slice(s, e)).join("");
    cutVia = `${via}/${split.via}`;
  }
}

// ── 3. 占位符替换（顺序敏感：长串先替换，避免子串误伤） ────────────
// 2026-08-22 事故防复发（ovhc-cn 实测）：原来这一整段只处理 head，TAIL
// 原样直出（worker/index.ts 里 `head + body_html + TAIL` 从不对 TAIL 做
// 任何占位符替换）。但很多站的分享按钮 / 相关文章 / 底部导航等"自我引用"
// 元素长在正文容器闭合之后（TAIL 区间），不是每个站都像 estate-sydney
// 那样长在容器开始之前——ovhc-cn 的分享按钮（X/Facebook/LinkedIn/
// WhatsApp/Telegram/邮件 + 站内 go.ovhc.cn 短链）整组都在 </article>
// 之后。这类站转换成功后，TAIL 会把参考文章自己的 URL/slug 原样焼死在
// 模板里，让*所有*动态文章的分享按钮和相关链接都指向参考文章——不会被
// 第 4 节的 head-only fail-closed 检查拦下（那是本次改造前唯一的验收
// 点，只查 head），是比 HEAD 残留更隐蔽的静默 bug（不挡转换、不挡部署、
// 不挡冒烟，只在人工点开分享按钮或校验相关链接时才会发现）。审计存量
// 已转换站发现这不是个例：242 个已转换站里 52 个（约 21%）TAIL 含参考
// 文章残留，多数正是分享按钮的 data-share-url / 分享意图链接。修法：把
// 这一整套"自我引用 URL 占位符化"逻辑抽成函数，head 和 tail 都跑一遍
// ——对 head 而言这是纯重构（顺序、结果与改造前逐字一致，course-org-cn/
// estate-sydney 重新切模板验证过 head 字节数不变）；对 tail 而言这是新
// 增覆盖，把同一类残留一并清掉。
function stripSelfReferenceUrls(str) {
  // D1 行只代表当前 canonical 语言，没有“译文已存在”字段。参考静态页里的
  // hreflang/语言切换镜像若直接换成动态 slug，会凭空制造 404 译文。
  // 只移除 URL 路径本身含参考 slug、且路径不同于 canonical 的镜像链接；
  // 分享链接把文章 URL 放在 query 里，路径本身不含 slug，不会被误删。
  const refUrl = (() => {
    try { return new URL(CANONICAL_BASE); }
    catch { return null; }
  })();
  const refPath = refUrl ? decodeURI(refUrl.pathname).replace(/\/+$/, "") : "";
  const isUnprovenMirrorHref = (href) => {
    try {
      const decoded = decodeURI(href);
      const absolute = href.startsWith("http") ? new URL(href) : null;
      const path = absolute ? decodeURI(absolute.pathname) : decoded.split(/[?#]/, 1)[0];
      const normalized = path.replace(/\/+$/, "");
      const otherOrigin = absolute && refUrl && absolute.origin !== refUrl.origin;
      return normalized.includes(`/${REF_SLUG}`) && (normalized !== refPath || otherOrigin);
    } catch {
      return false;
    }
  };
  const stripMirrorTag = (tag) => {
    const m = /\shref=["']([^"']+)["']/i.exec(tag);
    return m && isUnprovenMirrorHref(m[1]) ? "" : tag;
  };
  str = str.replace(/<link\b[^>]*\brel=["']alternate["'][^>]*>/gi, stripMirrorTag);
  str = str.replace(/<a\b[^>]*\shref=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi, stripMirrorTag);

  // canonical：带尾斜杠的实例先替换成 "{{CANONICAL}}/"，这样原页面的
  // 尾斜杠习惯被逐字保留，Worker 只需要填不带尾斜杠的 base。
  let s = str.split(CANONICAL_BASE + "/").join("{{CANONICAL}}/");
  s = s.split(CANONICAL_BASE).join("{{CANONICAL}}");

  // 2026-08-21 事故防复发（estate-sydney 实测）：分享按钮（微博/QQ/X/邮件）
  // 把 canonical 做了 URL 百分号编码塞进 query string
  // （如 url=https%3A%2F%2F...%2Fen-sydney-upfront-costs%2F），裸字符串替换
  // 抓不到这种形态——参考文章 slug 就这样残留，验收 fail closed。
  // 编码后的完整 URL 是唯一值，不会跟别的内容误撞，直接整体换成占位符；
  // 只处理带尾斜杠这一种编码形态（分享链接里目前只见过这种），足够覆盖
  // 目前踩到的家族，不做过度设计。
  s = s.split(encodeURIComponent(CANONICAL_BASE + "/")).join("{{CANONICAL_ENC}}");

  // 2026-08-21 事故防复发（liuxueai-org 实测）：部分站点嵌了一个繁简/
  // 多语言切换菜单，每个选项是一条完整 URL，直接写死了参考文章的
  // slug——但落在跟 canonical 不同的 host 上（如 liuxueai.org.cn vs
  // liuxueai.org），上面两条 CANONICAL_BASE split/join 只认 canonical 自己
  // 的 host，抓不到跨域这种形态，REF_SLUG 就残留在里面触发第 4 节
  // fail closed。REF_SLUG 是这篇参考页自己的 slug——head/tail 里任何形如
  // "{seg}/{REF_SLUG}/" 的完整 URL，不管 host 是谁，语义上都只能是"这篇
  // 文章自己的另一份拷贝"（语言镜像/AMP 版之类），不可能是"引用了另一篇
  // 不同的文章"，因为不同文章不会跟参考页共享同一个 slug。只替换 slug
  // 那一段，host/协议/SEG 原样保留，用 {{SLUG}} 占位，运行时用当前动态
  // 文章自己的 slug 填回去，链接就跟着动态文章走，不再钉死在参考文章上。
  // 对没有这种镜像链接的站点，下面这段正则找不到匹配，完全是空操作，
  // 不影响任何已转换成功的站（该站当年能转换成功就已经证明 head 里此时
  // 不含 REF_SLUG 了；tail 是本次新增覆盖，不构成"之前成功过"的既有事实）。
  {
    // 2026-08-21 三次修正（immicor-com 实测）：hreflang 备用链接的 URL 结构
    // 经常跟 canonical/nav 不是同一套 scheme——immicor-com 的 canonical 是
    // /post/{slug}/，但 hreflang="en"/"x-default" 却是裸 /{slug}/（不带
    // "post" 段），hreflang="zh-CN"/"zh-Hant-HK" 是 /{locale}/{slug}/（同样
    // 不带 "post"），可见文语言切换菜单里 zh/zh-hk 选项又是
    // /{locale}/post/{slug}/（locale 在 segPath 前面，跟 cleanerinsurance-au
    // 的"segPath 后面插 locale"顺序相反）。逐一枚举这些 URL 结构的组合爆炸
    // 没有尽头，改成不依赖具体路径结构的通用形态：REF_SLUG 只要是某个引号
    // 属性值（href=".../" 或 content=".../" 这类）里的**最后一段路径**
    // （即紧跟在 REF_SLUG 后面、到闭合引号之间只允许一个可选的尾斜杠或它的
    // URL 百分号编码形式 %2F/%2f——2026-08-22 ovhc-cn 实测新增：站内短链
    // go.ovhc.cn/?p=%2Fposts%2F{REF_SLUG}%2F 只对 pathname 整体编码，不是
    // 上面 CANONICAL_ENC 认的"整条绝对 URL 编码"，尾部是编码后的斜杠而不是
    // 裸 "/"，原来的 (/?)\1 抓不住，直接把 REF_SLUG 后面的可选尾分隔符从
    // "/" 扩成"/ 或 %2F/%2f"，其余不变），前面不管是 host+协议、locale 段、
    // segPath 段、query string 里的编码路径，还是它们的任意组合，一律保留
    // 原样只替换 slug 本身。这个假设在 head/tail 范围内总是成立——它们分别
    // 是正文容器前后的站点外壳，不会出现"引用了另一篇不同文章"这种情况
    // （不同文章不共享同一个 slug），任何以 REF_SLUG 收尾的引号属性值语义上
    // 只能是"这篇文章自己的另一种表示"（canonical 变体/语言镜像/AMP 版/
    // 分享链接/站内短链之类）。合并替代原先分别处理"跨域绝对 URL"
    // （liuxueai-org 实测）和"同源相对 URL、segPath 后可选插一段语言码"
    // （carpenterinsurance-au/cleanerinsurance-au 实测）的两条正则——那两条
    // 都是本条的特例，用一条通用正则一并覆盖，不必再对每种新排列组合单独打
    // 补丁。D1 运行时文章目前只有默认语言/默认 URL 结构的正文，非默认语言或
    // 非 canonical 结构的这几条链接换完后可能指向不存在的对应版本（404）——
    // 这是刻意的已知限制，不是本次改造引入的新回归（参考文章本来就是这些
    // 结构各自独立发布的静态页，动态新文章暂无对应版本可链接；对存量静态页
    // 零影响，它们不经过这段模板）。
    // 2026-08-22 事故防复发（oshc-cn 实测）：原来第 3 组只认"斜杠或它的编码"
    // 这一种收尾——但 hreflang 语言切换链接常是 REF_SLUG 后面还带查询串
    // （如 .../{REF_SLUG}/?lang=en"），斜杠后面还有 "?lang=en" 才到闭合引号，
    // 原正则要求收尾紧跟闭合引号，这类链接匹配不上，slug 原样残留。上面的
    // 函数级注释已经论证了这个不变式：head/tail 范围内任何含 REF_SLUG 的
    // 完整引号属性值，语义上只能是"这篇文章自己的另一种表示"——不局限于
    // "slug 后只有一个可选分隔符"这一种形态，把第 3 组从"斜杠或其编码"放宽
    // 成"到闭合引号前的任意剩余内容"，是同一不变式的严格推广：原来能匹配的
    // （纯斜杠/纯编码斜杠/空）现在原样照旧匹配，新增覆盖的只是以前漏网的
    // "斜杠+查询串"这类收尾更长的形态。
    const escRe = (rs) => rs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const anyMirrorRe = new RegExp(
      `(["'])([^"']*?)${escRe(REF_SLUG)}(?![A-Za-z0-9._-])([^"']*)\\1`,
      "g",
    );
    s = s.replace(
      anyMirrorRe,
      (_all, quote, prefix, trailingSuffix) => `${quote}${prefix}{{SLUG}}${trailingSuffix || ""}${quote}`,
    );
  }

  // 2026-08-22 事故防复发（nz-edu-pl 实测）：Astro View Transitions 会给
  // 正文容器上没有显式 transition:name 的元素自动生成一个 CSS custom-ident
  // 当 view-transition-name——取的是元素可见文本（这里是 <h1> 全文，含
  // REF_SLUG 出现在标题里的情况），按 CSS 转义规则把每个字符编成
  // "\XXXX"（中文）或原样保留（ASCII 字母/数字/连字符不需要转义，REF_SLUG
  // 因此原样露在外面）。这段落在独立的 <style> 块里，同一个转义串会重复
  // 出现在 view-transition-name 属性值和 4 个 ::view-transition-old/new
  // (…) 伪元素函数参数里（前进/后退各一对），不是引号属性值，上面的
  // anyMirrorRe（要求 ["']…["']）抓不到它。它纯粹是同名跨页面转场动画的
  // 挂钩，不是链接也不携带内容——所有动态文章共享这一个写死的标识符，
  // 后果只是转场动画认不出跨页元素退化成普通切换，不会指向错误内容或
  // 产生死链，属于比 URL 自引用轻得多的问题，直接把这个标识符换成固定的
  // 占位符即可安全复用。
  const vtMatch = /view-transition-name:\s*([^;{}]+);/.exec(s);
  if (vtMatch) {
    const vtIdent = vtMatch[1].trim();
    if (vtIdent.includes(REF_SLUG)) {
      s = s.split(vtIdent).join("d1rt-shared-transition");
    }
  }

  return s;
}

head = stripSelfReferenceUrls(head);

// D1_CONTEXT_SANITIZER_BEGIN
// D1_HEAD_CONTEXT_SANITIZER_BEGIN
// ── 3a. 清理正文前“文章壳”里只属于参考文章的上下文 ───────────────
//
// HEAD 不全是全局站点外壳：许多 Astro 主题把 breadcrumb、分类/标签、阅读
// 时长和 Article/BreadcrumbList JSON-LD 放在正文容器之前。只替换 canonical
// 和标题会让这些构建期值继续串到每篇 D1 文章。这里分两条窄通道处理：
// ① 可见 HTML 只触碰正文插入点所在 article 的前缀；若正文容器本身就是
// article（或根本没有外层 article），才退到 main 路径，并仅纳入紧邻的强
// 语义 breadcrumb/header/meta sibling。② <head> 只删没有 D1 字段可重建的
// article meta/JSON-LD 字段。固定导航锚点逐字保护，任何结构不确定都 fail
// closed；绝不新增 CATEGORY_SLUG，也不会碰已有的 {{CATEGORY...}} 动态逻辑。
const HEAD_CONTEXT_VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);
const HEAD_SHELL_HINT = /(?:breadcrumb|bread-crumb|crumbs?|article[-_ ]?(?:header|hero|meta|info)|post[-_ ]?(?:header|hero|meta|info)|entry[-_ ]?(?:header|hero|meta|info)|byline|publication[-_ ]?meta|文章(?:头部|信息|元数据)|麵包屑|面包屑)/i;
const HEAD_TAG_GROUP_HINT = /(?:^|[\s_-])(?:article[-_ ]?|post[-_ ]?)?(?:tags?|categories?)(?:$|[\s_-])|(?:标签|標籤|分类|分類)/i;
const HEAD_CATEGORY_LEAF_HINT = /(?:^|[\s_-])(?:article[-_ ]?|post[-_ ]?)?(?:cat(?:egory)?[-_ ]?(?:badge|chip|pill)?|category[-_ ]?(?:badge|chip|pill))(?:$|[\s_-])/i;
const HEAD_TAG_LEAF_HINT = /(?:^|[\s_-])tag[-_ ]?(?:badge|chip|pill)(?:$|[\s_-])/i;
const HEAD_READING_HINT = /(?:\bread(?:ing)?[-_ ]?(?:time|minutes?)\b|\bmin(?:ute)?s?\s+read\b|(?:阅读|閱讀).{0,8}(?:分钟|分鐘)|約?\s*\d+\s*(?:分钟|分鐘))/i;
const HEAD_BREADCRUMB_HINT = /(?:breadcrumb|bread-crumb|crumbs?|麵包屑|面包屑)/i;

function parseHeadContextFragment(fragment) {
  const nodes = [];
  const stack = [];
  const tokenRe = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/gi;
  let match;
  while ((match = tokenRe.exec(fragment)) !== null) {
    const token = match[0];
    if (token.startsWith("<!--") || /^<(?:script|style)\b/i.test(token)) continue;
    const name = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    if (/^<\//.test(token)) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== name) index -= 1;
      if (index < 0) continue; // HEAD 可从更早打开的文档节点中间开始/结束。
      for (let i = stack.length - 1; i >= index; i -= 1) {
        stack[i].closeStart = match.index;
        stack[i].end = tokenRe.lastIndex;
        stack[i].closed = true;
      }
      stack.length = index;
      continue;
    }
    const selfClosed = HEAD_CONTEXT_VOID_TAGS.has(name) || /\/>$/.test(token);
    const node = {
      tag: name, start: match.index, openEnd: tokenRe.lastIndex,
      closeStart: tokenRe.lastIndex, end: selfClosed ? tokenRe.lastIndex : fragment.length,
      closed: selfClosed,
      openTag: token, parent: stack.length ? stack[stack.length - 1] : null,
    };
    nodes.push(node);
    if (!selfClosed) stack.push(node);
  }
  return { nodes, openPath: [...stack] };
}

function headNodeText(fragment, node) {
  return fragment.slice(node.openEnd, node.closeStart)
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ").replace(/\s+/g, " ").trim();
}

function headNodeAttrs(node) {
  return [...node.openTag.matchAll(/\b(?:class|id|role|aria-label)\s*=\s*(["'])([\s\S]*?)\1/gi)]
    .map((match) => match[2]).join(" ");
}

function headNodeContains(outer, inner) {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function headInRanges(node, ranges) {
  return node.closed && ranges.some((range) => node.start >= range.start && node.end <= range.end);
}

function headGapIsIgnorable(fragment, from, to) {
  return fragment.slice(from, to)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*\btype\s*=\s*(["'])application\/ld\+json\1[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .trim() === "";
}

function deriveArticleShellRanges(fragment, parsed) {
  const path = parsed.openPath;
  if (!path.length) throw new Error("HEAD article-context sanitizer cannot locate the body insertion path");
  const selected = path[path.length - 1];
  let article = null;
  if (selected.tag !== "article") {
    for (let i = path.length - 1; i >= 0; i -= 1) {
      if (path[i].tag === "article") { article = path[i]; break; }
    }
  }
  if (article) {
    const ranges = [{ start: article.openEnd, end: fragment.length }];
    // oshc-net-au 家族把 breadcrumb 放成 <main> 内、<article> 前的紧邻
    // sibling。它仍是文章壳的一部分；只纳入强语义且字节上紧邻的节点，
    // 更早的全局 nav 一律在遇到第一个普通 sibling 时停止。
    if (article.parent?.tag === "main") {
      const siblings = parsed.nodes
        .filter((node) => node.parent === article.parent && node.closed && node.end <= article.start)
        .sort((a, b) => a.start - b.start);
      let cursor = article.start;
      for (let i = siblings.length - 1; i >= 0; i -= 1) {
        const sibling = siblings[i];
        if (!headGapIsIgnorable(fragment, sibling.end, cursor)) break;
        const preview = `${headNodeAttrs(sibling)} ${headNodeText(fragment, sibling).slice(0, 180)}`;
        if (!HEAD_SHELL_HINT.test(preview)) break;
        ranges.push({ start: sibling.start, end: sibling.end });
        cursor = sibling.start;
      }
    }
    return ranges;
  }

  let mainIndex = -1;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i].tag === "main") { mainIndex = i; break; }
  }
  if (mainIndex < 0) {
    // 某些极简主题没有 main，但正文容器本身仍是 article/prose；只取其内部
    // 已折入 HEAD 的前缀，不向前猜测页面级兄弟节点。
    return [{ start: selected.openEnd, end: fragment.length }];
  }
  const main = path[mainIndex];
  const pathChild = path[mainIndex + 1] || main;
  const ranges = [{ start: pathChild.openEnd, end: fragment.length }];
  if (pathChild === main) return ranges;

  // selected=article/no outer article 时，breadcrumb 常是 main 里的前一个 sibling。
  // 只从紧邻处向前收强语义节点，一碰到普通内容或非空文本即停止。
  const siblings = parsed.nodes
    .filter((node) => node.parent === main && node.closed && node.end <= pathChild.start)
    .sort((a, b) => a.start - b.start);
  let cursor = pathChild.start;
  for (let i = siblings.length - 1; i >= 0; i -= 1) {
    const sibling = siblings[i];
    if (!headGapIsIgnorable(fragment, sibling.end, cursor)) break;
    const preview = `${headNodeAttrs(sibling)} ${headNodeText(fragment, sibling).slice(0, 180)}`;
    if (!HEAD_SHELL_HINT.test(preview)) break;
    ranges.push({ start: sibling.start, end: sibling.end });
    cursor = sibling.start;
  }
  return ranges;
}

function headHrefPath(rawHref) {
  if (!rawHref || rawHref.includes("{{")) return "";
  try {
    const base = new URL(CANONICAL_BASE);
    const target = new URL(rawHref.replace(/&amp;/g, "&"), `${base.origin}/`);
    return target.origin === base.origin ? decodePathSafely(target.pathname) : "";
  } catch { return ""; }
}

function headIsTaxonomyHref(rawHref) {
  const path = headHrefPath(rawHref);
  return /\/(?:tag|tags|category|categories)\/[^/]+\/?$/i.test(path);
}

function headIsSeparator(fragment, node) {
  const text = headNodeText(fragment, node);
  return !!text && /^[\/›»>→·|—–-]+$/.test(text);
}

function applyHeadReplacements(fragment, replacements) {
  const ordered = [...replacements]
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const outer = [];
  for (const replacement of ordered) {
    if (outer.some((item) => item.start <= replacement.start && item.end >= replacement.end)) continue;
    const overlap = outer.find((item) => replacement.start < item.end && replacement.end > item.start);
    if (overlap) {
      // 两个相邻叶都要删除时可能共享同一个分隔符，形成部分重叠区间；并成
      // 一个连续删除区间仍只覆盖这两个已批准叶与分隔符，且避免顺序依赖。
      if (overlap.value === "" && replacement.value === "") {
        overlap.start = Math.min(overlap.start, replacement.start);
        overlap.end = Math.max(overlap.end, replacement.end);
        continue;
      }
      throw new Error(
        `HEAD article-context sanitizer produced overlapping mutations: ` +
        `${JSON.stringify(overlap)} vs ${JSON.stringify(replacement)}`,
      );
    }
    outer.push(replacement);
  }
  let output = fragment;
  for (const replacement of outer.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  }
  return output;
}

function htmlBalanceSignature(fragment) {
  const counts = new Map();
  const tokenRe = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/gi;
  let match;
  while ((match = tokenRe.exec(fragment)) !== null) {
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (HEAD_CONTEXT_VOID_TAGS.has(tag) || /\/>$/.test(match[0])) continue;
    counts.set(tag, (counts.get(tag) || 0) + (/^<\//.test(match[0]) ? -1 : 1));
  }
  return JSON.stringify([...counts].filter(([, count]) => count !== 0).sort());
}

function sanitizeVisibleArticleShell(fragment) {
  const parsed = parseHeadContextFragment(fragment);
  const ranges = deriveArticleShellRanges(fragment, parsed);
  const eligible = parsed.nodes.filter((node) => headInRanges(node, ranges));
  const replacements = [];
  const removedAnchors = new Set();
  const parentChildren = (parent) => parsed.nodes
    .filter((node) => node.parent === parent && node.closed).sort((a, b) => a.start - b.start);
  const removeWithSeparator = (node) => {
    let target = node;
    if (["a", "span"].includes(node.tag) && node.parent && node.parent.tag === "li") {
      const siblings = parentChildren(node.parent);
      if (siblings.length === 1 && headNodeText(fragment, node.parent) === headNodeText(fragment, node)) {
        target = node.parent;
      }
    }
    replacements.push({ start: target.start, end: target.end, value: "" });
    if (node.tag === "a") removedAnchors.add(node.start);
    if (!target.parent) return;
    const siblings = parentChildren(target.parent);
    const index = siblings.indexOf(target);
    const separator = siblings[index + 1] && headIsSeparator(fragment, siblings[index + 1])
      ? siblings[index + 1]
      : (siblings[index - 1] && headIsSeparator(fragment, siblings[index - 1]) ? siblings[index - 1] : null);
    if (separator) replacements.push({ start: separator.start, end: separator.end, value: "" });
  };

  const breadcrumbs = eligible.filter((node) =>
    ["nav", "ol", "ul", "div"].includes(node.tag) &&
    HEAD_BREADCRUMB_HINT.test(`${headNodeAttrs(node)} ${node.openTag}`));
  for (const breadcrumb of breadcrumbs) {
    const inside = eligible.filter((node) => headNodeContains(breadcrumb, node));
    for (const anchor of inside.filter((node) => node.tag === "a")) {
      const href = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec(anchor.openTag)?.[2] || "";
      if (headIsTaxonomyHref(href)) removeWithSeparator(anchor);
    }
    const currentLeaves = inside.filter((node) => ["li", "span"].includes(node.tag) &&
      (/\baria-current\s*=\s*["'](?:page|true)["']/i.test(node.openTag) || (() => {
        const text = headNodeText(fragment, node).replace(/[.…]+$/, "").trim();
        return text.length >= 8 && (REF_TITLE.startsWith(text) || text.startsWith(REF_TITLE));
      })()));
    for (const leaf of currentLeaves) {
      replacements.push({ start: leaf.openEnd, end: leaf.closeStart, value: "{{TITLE}}" });
    }
  }

  // 文章壳内任何硬编码 taxonomy href 都是参考文章上下文；全局 nav 不在
  // eligible range 内，已有 {{CATEGORY...}} 动态实现必须保留。
  for (const node of eligible) {
    if (node.tag !== "a") continue;
    const href = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec(node.openTag)?.[2] || "";
    if (!headIsTaxonomyHref(href)) continue;
    const raw = fragment.slice(node.start, node.end);
    if (/\{\{CATEGORY(?:_SLUG|_SUFFIX)?\}\}/.test(raw)) continue;
    removeWithSeparator(node);
  }

  // 分类 badge/chip 是参考文章字段；已有 {{CATEGORY...}} 的动态实现必须保留。
  for (const node of eligible) {
    if (!["a", "span"].includes(node.tag)) continue;
    const attrs = headNodeAttrs(node);
    if (!HEAD_CATEGORY_LEAF_HINT.test(attrs)) continue;
    const raw = fragment.slice(node.start, node.end);
    if (/\{\{CATEGORY(?:_SLUG|_SUFFIX)?\}\}/.test(raw)) continue;
    removeWithSeparator(node);
  }

  // 纯标签组整块删除；没有语义容器时，只在文章壳内删除 tag-pill/chip 叶。
  for (const node of eligible) {
    if (!["div", "ul", "ol", "section", "p"].includes(node.tag)) continue;
    const attrs = headNodeAttrs(node);
    const inside = eligible.filter((child) => child !== node && headNodeContains(node, child));
    const tagLeaves = inside.filter((child) => ["a", "span", "li"].includes(child.tag) &&
      HEAD_TAG_LEAF_HINT.test(headNodeAttrs(child)));
    if (HEAD_TAG_GROUP_HINT.test(attrs) || tagLeaves.length >= 2) {
      const forbidden = /<(?:h1|time)\b/i.test(fragment.slice(node.openEnd, node.closeStart));
      if (!forbidden && (tagLeaves.length || HEAD_TAG_GROUP_HINT.test(attrs))) {
        replacements.push({ start: node.start, end: node.end, value: "" });
        for (const anchor of inside.filter((child) => child.tag === "a")) removedAnchors.add(anchor.start);
      }
    }
  }
  for (const node of eligible) {
    if (!["a", "span"].includes(node.tag) || !HEAD_TAG_LEAF_HINT.test(headNodeAttrs(node))) continue;
    if (/\{\{CATEGORY/.test(fragment.slice(node.start, node.end))) continue;
    removeWithSeparator(node);
  }

  // 阅读时长没有 D1 字段，按最小叶节点删除并带走紧邻的点号/斜杠分隔符。
  for (const node of eligible) {
    if (!["span", "small", "p", "div"].includes(node.tag)) continue;
    const text = headNodeText(fragment, node);
    if (!HEAD_READING_HINT.test(`${headNodeAttrs(node)} ${text}`)) continue;
    // 阅读时长在子节点里（fudan-help：div.article-meta > span.article-readtime）时只删
    // 那个子节点；否则整行 meta（连同日期）会被当成「阅读时长」一起删掉。
    if (eligible.some((child) => child.parent === node &&
      HEAD_READING_HINT.test(`${headNodeAttrs(child)} ${headNodeText(fragment, child)}`))) continue;
    const hasBlockChild = eligible.some((child) => child.parent === node &&
      !["span", "small", "time", "a"].includes(child.tag));
    if (!hasBlockChild && text.length <= 80) removeWithSeparator(node);
  }

  // article H1 必须精确等于运行时标题；参考页 title 截断时尤其不能保留 suffix。
  const h1s = eligible.filter((node) => node.tag === "h1").sort((a, b) => a.start - b.start);
  if (h1s.length) {
    const h1 = h1s[h1s.length - 1];
    if (fragment.slice(h1.openEnd, h1.closeStart).trim() !== "{{TITLE}}") {
      replacements.push({ start: h1.openEnd, end: h1.closeStart, value: "{{TITLE}}" });
    }
  }

  // 日期只在文章壳 cone 内换成已有 token；不能对整个 HEAD 盲替换，避免同日
  // 的站点级公告、活动栏等固定内容被误认成文章日期。
  if (REF_DATE_ISO) {
    const [year, month, day] = REF_DATE_ISO.split("-").map(Number);
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
      "September", "October", "November", "December"];
    const mon = MONTHS[month - 1] || "";
    for (const value of [
      `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`,
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      `${year}年${month}月${day}日`,
      // 英文站可见日期（help-roaming 实测 "Published: June 27, 2026"）
      ...(mon ? [`${mon} ${day}, ${year}`, `${day} ${mon} ${year}`, `${mon.slice(0, 3)} ${day}, ${year}`,
        `${day} ${mon.slice(0, 3)} ${year}`] : []),
    ]) {
      let start = 0;
      while ((start = fragment.indexOf(value, start)) >= 0) {
        const end = start + value.length;
        if (ranges.some((range) => start >= range.start && end <= range.end)) {
          replacements.push({ start, end, value: "{{DATE}}" });
        }
        start = end;
      }
    }
  }

  const count = (haystack, needle) => needle ? haystack.split(needle).length - 1 : 0;
  const allAnchors = parsed.nodes.filter((node) => node.tag === "a" && node.closed);
  const intentionallyRemoved = (node) => removedAnchors.has(node.start) || replacements.some(
    (replacement) => replacement.value === "" &&
      replacement.start <= node.start && replacement.end >= node.end,
  );
  // 同一段锚点 HTML 可能同时出现在全局导航和待删除的文章标签里。按“原总数-
  // 明确删除数”保护，而不是逐节点要求原总数不变；hkbu-help 正好有这种重复。
  const protectedCountsMap = new Map();
  for (const node of allAnchors) {
    const raw = fragment.slice(node.start, node.end);
    if (!protectedCountsMap.has(raw)) protectedCountsMap.set(raw, count(fragment, raw));
    if (intentionallyRemoved(node)) protectedCountsMap.set(raw, protectedCountsMap.get(raw) - 1);
  }
  const protectedCounts = [...protectedCountsMap.entries()];
  if (replacements.some((item) => !ranges.some(
    (range) => item.start >= range.start && item.end <= range.end,
  ))) {
    throw new Error("HEAD article-context sanitizer attempted a mutation outside the article shell cone");
  }
  const balanceBefore = htmlBalanceSignature(fragment);
  const output = applyHeadReplacements(fragment, replacements);
  for (const [fixed, expected] of protectedCounts) {
    if (count(output, fixed) !== expected) {
      throw new Error("HEAD article-context sanitizer changed protected fixed navigation");
    }
  }
  if (htmlBalanceSignature(output) !== balanceBefore) {
    throw new Error("HEAD article-context sanitizer changed HTML balance");
  }
  return { html: output, mutations: replacements.length, ranges };
}

function sanitizeHeadArticleMetadata(fragment) {
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const jsonLdTypes = (node) => (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]])
    .filter(Boolean)
    .map((type) => String(type).split("/").pop().toLowerCase());
  const containsReferenceContext = (value) => {
    if (typeof value === "string") {
      return [REF_SLUG, CANONICAL_BASE, REF_CANONICAL, REF_TITLE].filter(Boolean)
        .some((needle) => value.includes(needle));
    }
    if (Array.isArray(value)) return value.some(containsReferenceContext);
    if (value && typeof value === "object") return Object.values(value).some(containsReferenceContext);
    return false;
  };
  const hasRuntimeToken = (value) => {
    if (typeof value === "string") return /\{\{[A-Z][A-Z0-9_]*\}\}/.test(value);
    if (Array.isArray(value)) return value.some(hasRuntimeToken);
    if (value && typeof value === "object") return Object.values(value).some(hasRuntimeToken);
    return false;
  };
  const hasHardTaxonomyHref = (value) => {
    if (typeof value === "string") return !value.includes("{{") && headIsTaxonomyHref(value);
    if (Array.isArray(value)) return value.some(hasHardTaxonomyHref);
    if (value && typeof value === "object") return Object.values(value).some(hasHardTaxonomyHref);
    return false;
  };
  const safeJsonLd = (value) => JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  let removedMeta = 0;
  let output = fragment.replace(/<meta\b[^>]*>/gi, (tag) => {
    const key = /\b(?:name|property)\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2]?.toLowerCase() || "";
    const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2] || "";
    const articleMeta = ["article:tag", "article:section"].includes(key);
    const referenceKeywords = key === "keywords" && containsReferenceContext(content);
    if (!(articleMeta || referenceKeywords) || content.includes("{{")) return tag;
    removedMeta += 1;
    return "";
  });
  let removedJsonNodes = 0;
  output = output.replace(
    /<script\b([^>]*\btype\s*=\s*(["'])application\/ld\+json\2[^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (whole, attrs, _quote, rawJson) => {
      const hasArticleSignal = /(?:Article|BlogPosting|NewsArticle|BreadcrumbList|FAQPage|QAPage|articleSection|"keywords"|"citation"|"about"|"author")/.test(rawJson);
      if (!hasArticleSignal) return whole;
      let data;
      try { data = JSON.parse(rawJson); }
      catch (error) { throw new Error(`HEAD article JSON-LD is not valid JSON: ${error.message}`); }
      const cleanNode = (node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return node;
        const types = jsonLdTypes(node);
        if (types.some((type) => type === "breadcrumblist")) {
          if (hasRuntimeToken(node) && !hasHardTaxonomyHref(node)) return node;
          removedJsonNodes += 1;
          return null;
        }
        if (types.some((type) => type === "faqpage" || type === "qapage")) {
          removedJsonNodes += 1;
          return null;
        }
        if (types.some((type) => /^(?:article|analysisnewsarticle|blogposting|newsarticle|report|review|scholarlyarticle|socialmediaposting|techarticle|webpage)$/.test(type))) {
          for (const key of ["keywords", "articleSection", "about", "citation", "mentions", "mainEntity"]) {
            if (hasOwn(node, key)) delete node[key];
          }
          for (const key of ["image", "thumbnailUrl"]) {
            if (!hasOwn(node, key)) continue;
            if (containsReferenceContext(node[key])) {
              if (DEFAULT_OG) node[key] = DEFAULT_OG;
              else delete node[key];
            }
          }
          if (hasOwn(node, "author") && containsReferenceContext(node.author)) {
            delete node.author;
          }
          node.headline = "{{TITLE}}";
          if (hasOwn(node, "description")) node.description = "{{DESC}}";
        }
        if (Array.isArray(node["@graph"])) node["@graph"] = node["@graph"].map(cleanNode).filter(Boolean);
        return node;
      };
      if (Array.isArray(data)) data = data.map(cleanNode).filter(Boolean);
      else data = cleanNode(data);
      if (!data || (Array.isArray(data) && !data.length) ||
          (data["@graph"] && Array.isArray(data["@graph"]) && !data["@graph"].length)) {
        return "";
      }
      const serialized = safeJsonLd(data);
      JSON.parse(serialized); // 修改后再验一次，禁止半截 JSON 上线。
      return `<script${attrs}>${serialized}</script>`;
    },
  );
  return { html: output, removedMeta, removedJsonNodes };
}

// ── 3b. 跨页面精确叶证据：不猜字段名，只清“参考页独有值” ─────────
// 结构提示覆盖不了所有主题。生成时再读取最多 8 篇同路由、结构相似度 >=0.70
// 的静态文章：只有模板叶值与参考页逐值相等、没有运行时 token、且至少一篇
// 同键替代页给出不同值时，才允许中和该叶。节点键由完整祖先链的
// tag/id/排序 class/aria/role/同形 sibling ordinal 组成；全局导航、固定 taxonomy
// anchor 和 cone 外字节都有独立保护。算法与 scan_d1_runtime_tail_context.py 的
// cross_page_exact_leaf_evidence/sanitize_head 保持同一合同。
const {
  readdirSync: crossLeafReaddirSync,
} = await import("node:fs");
const {
  dirname: crossLeafDirname,
  join: crossLeafJoin,
  resolve: crossLeafResolve,
  sep: crossLeafPathSeparator,
} = await import("node:path");
const CROSS_LEAF_ATTR_RE = /\b(href|src|srcset|datetime|content|alt|title|data-[A-Za-z0-9_.:-]+)\s*=\s*(["'])([\s\S]*?)\2/gi;
const CROSS_LEAF_DATE_RE = /^(?:\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)$/;
const CROSS_LEAF_ARTICLE_SCHEMA_TYPES = new Set([
  "article", "analysisnewsarticle", "blogposting", "newsarticle", "report", "review", "scholarlyarticle",
  "socialmediaposting", "techarticle", "webpage",
]);
const CROSS_LEAF_PROTECTED_SCHEMA_TYPES = new Set([
  "website", "organization", "educationalorganization", "collegeoruniversity",
]);
const CROSS_LEAF_RESERVED_ROOTS = new Set([
  "404", "_astro", "about", "articles", "assets", "blog", "calculator", "calculators",
  "categories", "category", "contact", "css", "disclaimer", "en", "favicon", "favicon.ico",
  "fonts", "guides", "images", "img", "index", "js", "llms.txt", "news", "offline",
  "page", "pages", "posts", "privacy", "resources", "robots", "robots.txt", "search",
  "sitemap", "sitemap.xml", "sources", "static", "tag", "tags", "terms", "tool", "tools",
  "tw", "zh", "zh-cn", "zh-hant", "zh-tw",
]);

function crossLeafRuntimeToken(value) {
  if (typeof value === "string") return value.includes("{{") && value.includes("}}");
  if (Array.isArray(value)) return value.some(crossLeafRuntimeToken);
  if (value && typeof value === "object") return Object.values(value).some(crossLeafRuntimeToken);
  return false;
}

function crossLeafValueEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function crossLeafCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(crossLeafCanonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, crossLeafCanonicalJson(value[key])]));
  }
  return value;
}

function crossLeafNodeAttrs(node) {
  const values = {};
  const attrRe = /\b([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  let match;
  while ((match = attrRe.exec(node.openTag)) !== null) values[match[1].toLowerCase()] = match[3];
  return values;
}

function crossLeafNodeShape(node) {
  const attrs = crossLeafNodeAttrs(node);
  const classes = (attrs.class || "").split(/\s+/).filter(Boolean).sort();
  const aria = Object.entries(attrs).filter(([name]) => name.startsWith("aria-"))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return JSON.stringify({
    aria, class: classes, id: attrs.id || "", role: attrs.role || "", tag: node.tag,
  });
}

function crossLeafAncestorNodes(node) {
  const result = [];
  for (let current = node.parent; current; current = current.parent) result.push(current);
  return result;
}

function crossLeafPrefixCone(fragment, parsed) {
  const nodes = parsed.nodes;
  const active = nodes.filter((node) => !node.closed);
  if (!active.length) return { nodes: new Set(), path: [], root: null, selected: null };
  const selected = [...active].sort((left, right) => left.start - right.start).at(-1);
  const path = [selected, ...crossLeafAncestorNodes(selected)].reverse();
  let rootPosition = -1;
  for (let i = 0; i < path.length; i += 1) if (path[i].tag === "main") rootPosition = i;
  if (rootPosition < 0) {
    for (let i = 0; i < path.length; i += 1) if (path[i].tag === "article") rootPosition = i;
  }
  if (rootPosition < 0) rootPosition = path.length - 1;
  const scopedPath = path.slice(rootPosition);
  const included = new Set();
  const includeSubtree = (root) => {
    for (const candidate of nodes) {
      if (candidate.closed && headNodeContains(root, candidate)) included.add(candidate);
    }
  };
  for (let i = 0; i < scopedPath.length - 1; i += 1) {
    const parent = scopedPath[i];
    const child = scopedPath[i + 1];
    for (const sibling of nodes) {
      if (sibling.parent === parent && sibling.closed && sibling.end <= child.start) includeSubtree(sibling);
    }
  }
  for (const candidate of nodes) {
    if (candidate.closed && crossLeafAncestorNodes(candidate).includes(selected)) included.add(candidate);
  }
  return { nodes: included, path: scopedPath, root: scopedPath[0] || selected, selected };
}

function crossLeafNodeKeys(parsed) {
  const nodes = parsed.nodes;
  const shapes = new Map(nodes.map((node) => [node, crossLeafNodeShape(node)]));
  const ordinals = new Map();
  for (const node of nodes) {
    const siblings = nodes.filter((item) => item.parent === node.parent && shapes.get(item) === shapes.get(node))
      .sort((left, right) => left.start - right.start);
    ordinals.set(node, siblings.indexOf(node));
  }
  const keys = new Map();
  for (const node of nodes) {
    const chain = [node, ...crossLeafAncestorNodes(node)].reverse();
    keys.set(node, JSON.stringify(chain.map((item) => ({
      ordinal: ordinals.get(item), shape: JSON.parse(shapes.get(item)),
    }))));
  }
  return keys;
}

function crossLeafDirectTextSpans(fragment, parsed, node) {
  if (HEAD_CONTEXT_VOID_TAGS.has(node.tag)) return [];
  const children = parsed.nodes.filter((candidate) => candidate.parent === node && candidate.closed)
    .sort((left, right) => left.start - right.start);
  const gaps = [];
  let cursor = node.openEnd;
  for (const child of children) {
    if (cursor < child.start) gaps.push([cursor, child.start]);
    cursor = Math.max(cursor, child.end);
  }
  if (cursor < node.closeStart) gaps.push([cursor, node.closeStart]);
  const spans = [];
  for (const [start, end] of gaps) {
    const raw = fragment.slice(start, end);
    const ignored = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>/gi;
    let relative = 0;
    const pieces = [];
    let match;
    while ((match = ignored.exec(raw)) !== null) {
      if (relative < match.index) pieces.push([relative, match.index]);
      relative = ignored.lastIndex;
    }
    if (relative < raw.length) pieces.push([relative, raw.length]);
    for (const [pieceStart, pieceEnd] of pieces) {
      const piece = raw.slice(pieceStart, pieceEnd);
      const leading = piece.search(/\S/);
      if (leading < 0) continue;
      const trailing = piece.length - piece.trimEnd().length;
      const absoluteStart = start + pieceStart + leading;
      const absoluteEnd = start + pieceEnd - trailing;
      const value = fragment.slice(absoluteStart, absoluteEnd);
      if (value.includes("<") && value.includes(">")) continue;
      spans.push({ start: absoluteStart, end: absoluteEnd, value });
    }
  }
  return spans;
}

function crossLeafJsonScripts(fragment) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = re.exec(fragment)) !== null) {
    if (!/\btype\s*=\s*(["'])application\/ld\+json\1/i.test(match[1])) continue;
    const bodyOffset = match[0].indexOf(">") + 1;
    try {
      scripts.push({
        start: match.index, end: re.lastIndex,
        bodyStart: match.index + bodyOffset, bodyEnd: match.index + bodyOffset + match[2].length,
        // <script> is an HTML raw-text element: character references inside
        // JSON-LD are literal bytes and must not be entity-decoded.
        value: JSON.parse(match[2].trim()), error: null,
      });
    } catch (error) {
      scripts.push({ start: match.index, end: re.lastIndex, value: null, error: error.message });
    }
  }
  return scripts;
}

function extractCrossPageExactLeaves(fragment) {
  const parsed = parseHeadContextFragment(fragment);
  const cone = crossLeafPrefixCone(fragment, parsed);
  const keys = crossLeafNodeKeys(parsed);
  const visible = new Map();
  for (const node of [...cone.nodes].sort((left, right) => left.start - right.start)) {
    const nodeKey = keys.get(node);
    let textOrdinal = 0;
    for (const span of crossLeafDirectTextSpans(fragment, parsed, node)) {
      const key = `${nodeKey}#text[${textOrdinal}]`;
      visible.set(key, {
        lane: "visible", key, field: "text", value: span.value,
        valueStart: span.start, valueEnd: span.end,
        attributeStart: null, attributeEnd: null,
        nodeStart: node.start, nodeEnd: node.end, nodeTag: node.tag, node,
      });
      textOrdinal += 1;
    }
    CROSS_LEAF_ATTR_RE.lastIndex = 0;
    let match;
    while ((match = CROSS_LEAF_ATTR_RE.exec(node.openTag)) !== null) {
      const quoteAt = match[0].indexOf(match[2], match[0].indexOf("=") + 1);
      const valueStart = node.start + match.index + quoteAt + 1;
      const key = `${nodeKey}@${match[1].toLowerCase()}`;
      visible.set(key, {
        lane: "visible", key, field: match[1].toLowerCase(), value: match[3],
        valueStart, valueEnd: valueStart + match[3].length,
        attributeStart: node.start + match.index,
        attributeEnd: node.start + match.index + match[0].length,
        nodeStart: node.start, nodeEnd: node.end, nodeTag: node.tag, node,
      });
    }
  }
  const jsonld = new Map();
  const scripts = crossLeafJsonScripts(fragment);
  const flatten = (value, scriptIndex, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => flatten(item, scriptIndex, [...path, index]));
    } else if (value && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) flatten(item, scriptIndex, [...path, name]);
    } else {
      const key = JSON.stringify({ path, script: scriptIndex });
      jsonld.set(key, { lane: "jsonld", key, field: "jsonld", value, scriptIndex, jsonPath: path });
    }
  };
  scripts.forEach((script, index) => { if (!script.error) flatten(script.value, index, []); });
  return {
    parsed, cone, visible, jsonld, scripts,
    jsonldErrors: scripts.filter((script) => script.error).map((script) => script.error),
  };
}

function crossLeafShapeCounter(fragment) {
  const counter = new Map();
  for (const node of parseHeadContextFragment(fragment).nodes) {
    const attrs = crossLeafNodeAttrs(node);
    const key = `${node.tag}|${(attrs.class || "").split(/\s+/).filter(Boolean).sort().join(" ")}`;
    counter.set(key, (counter.get(key) || 0) + 1);
  }
  return counter;
}

function crossLeafSimilarity(left, right) {
  const keys = new Set([...left.keys(), ...right.keys()]);
  let numerator = 0;
  let denominator = 0;
  for (const key of keys) {
    numerator += Math.min(left.get(key) || 0, right.get(key) || 0);
    denominator += Math.max(left.get(key) || 0, right.get(key) || 0);
  }
  return denominator ? numerator / denominator : 1;
}

function crossLeafPythonRound(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (Math.abs(fraction - 0.5) < Number.EPSILON * 8) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}

function crossLeafPathCompare(left, right) {
  const leftParts = left.split(crossLeafPathSeparator);
  const rightParts = right.split(crossLeafPathSeparator);
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return leftParts.length - rightParts.length;
}

function cutCrossPageHead(source, refTitle = null) {
  let selected = null;
  const prose = /\bclass\s*=\s*(["'])prose/i.exec(source);
  if (prose) {
    const tagStart = source.lastIndexOf("<", prose.index);
    const tag = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(source.slice(tagStart))?.[1];
    const openEnd = source.indexOf(">", prose.index + prose[0].length) + 1;
    if (tag && openEnd > 0) selected = { openEnd, closeStart: matchClose(source, tag, openEnd) };
  }
  if (!selected) {
    for (const tag of ["article", "main"]) {
      const re = new RegExp(`<${tag}\\b`, "gi");
      let match;
      while ((match = re.exec(source)) !== null) {
        const openEnd = source.indexOf(">", match.index) + 1;
        if (openEnd <= 0) continue;
        try {
          const closeStart = matchClose(source, tag, openEnd);
          if (openEnd < closeStart) { selected = { openEnd, closeStart }; break; }
        } catch { /* try the next candidate container */ }
      }
      if (selected) break;
    }
  }
  if (!selected) throw new Error("alternate static article has no reusable prose/article/main container");
  let bodyStart = selected.openEnd;
  const after = source.slice(selected.openEnd);
  const whitespace = after.length - after.trimStart().length;
  if (/^<h1\b/i.test(after.slice(whitespace))) {
    const close = source.indexOf("</h1>", selected.openEnd);
    if (close < 0 || close > selected.closeStart) throw new Error("alternate article H1 has no close tag");
    bodyStart = close + "</h1>".length;
  }
  const cut = source.slice(0, bodyStart);
  // 与主切法同一套标题块规则（2a 节），否则参考页与对照页的 HEAD 形状对不上。
  // 本段会被 remediate_tail_leak 单独拼进旧版站内生成器，那些生成器没有 2a 节的
  // 标题块函数：没有就维持原切法。
  if (typeof splitTitleBlock !== "function" || typeof containerTitleH1 !== "function") return cut;
  const split = splitTitleBlock(source, selected.openEnd, selected.closeStart,
    containerTitleH1(cut, source, selected.openEnd, selected.closeStart, refTitle));
  return split ? split.headText : cut;
}

function crossLeafWalkIndexes(root) {
  const result = [];
  const walk = (directory) => {
    let entries;
    try { entries = crossLeafReaddirSync(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = crossLeafJoin(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === "index.html") result.push(path);
    }
  };
  walk(root);
  return result;
}

function crossLeafCandidatePaths() {
  const reference = crossLeafResolve(REF);
  const segmentParts = SEG.split("/").filter(Boolean);
  let candidates = [];
  if (segmentParts.length) {
    let articleRoot = crossLeafDirname(reference);
    while (true) {
      const parts = articleRoot.split(crossLeafPathSeparator).filter(Boolean);
      const tail = parts.slice(-segmentParts.length);
      if (tail.length === segmentParts.length && tail.every((part, index) => part === segmentParts[index])) break;
      const parent = crossLeafDirname(articleRoot);
      if (parent === articleRoot) { articleRoot = crossLeafDirname(crossLeafDirname(reference)); break; }
      articleRoot = parent;
    }
    candidates = crossLeafWalkIndexes(articleRoot);
  } else {
    const outputRoot = crossLeafDirname(crossLeafDirname(reference));
    let entries = [];
    try { entries = crossLeafReaddirSync(outputRoot, { withFileTypes: true }); }
    catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || CROSS_LEAF_RESERVED_ROOTS.has(entry.name.toLowerCase())) continue;
      const path = crossLeafJoin(outputRoot, entry.name, "index.html");
      try { readFileSync(path, "utf8"); candidates.push(path); } catch { /* not an article */ }
    }
  }
  candidates = [...new Set(candidates)].filter((path) => crossLeafResolve(path) !== reference)
    .sort(crossLeafPathCompare);
  if (candidates.length <= 16) return candidates;
  const last = candidates.length - 1;
  const indexes = new Set();
  for (let index = 0; index < 16; index += 1) indexes.add(crossLeafPythonRound(index * last / 15));
  return [...indexes].sort((left, right) => left - right).map((index) => candidates[index]);
}

function collectCrossPageAlternates(referenceHead) {
  const referenceShape = crossLeafShapeCounter(referenceHead);
  const ranked = [];
  const candidatePaths = crossLeafCandidatePaths();
  if (process.env.D1_CONTEXT_EXACT_DEBUG === "1") {
    console.error(JSON.stringify({ event: "d1_context_exact_candidate_paths", paths: candidatePaths }));
  }
  for (const path of candidatePaths) {
    try {
      const candidateHead = cutCrossPageHead(readFileSync(path, "utf8"));
      const similarity = crossLeafSimilarity(referenceShape, crossLeafShapeCounter(candidateHead));
      if (similarity >= 0.70) ranked.push({ path, similarity, head: candidateHead });
    } catch { /* malformed/non-article candidates are not evidence */ }
  }
  ranked.sort((left, right) => right.similarity - left.similarity ||
    crossLeafPathCompare(left.path, right.path));
  return ranked.slice(0, 8);
}

function crossPageExactEvidence(templateHead, referenceHead, alternateHeads) {
  const template = extractCrossPageExactLeaves(templateHead);
  const reference = extractCrossPageExactLeaves(referenceHead);
  const alternates = alternateHeads.slice(0, 8).map(extractCrossPageExactLeaves);
  const errors = [...template.jsonldErrors, ...reference.jsonldErrors,
    ...alternates.flatMap((item) => item.jsonldErrors)];
  if (errors.length) throw new Error(`cross-page exact-leaf JSON-LD parse error: ${errors.slice(0, 3).join("; ")}`);
  const evidence = { visible: [], jsonld: [], jsonldSafeDefaultImage: [] };
  const deferredRuntimeField = (lane, item) => {
    // This exact-evidence pass runs before the established TITLE/DESC/date
    // placeholder pass.  A raw reference value that is about to become a
    // runtime token is not removable article context: deleting it here would
    // erase the breadcrumb leaf/lede/JSON-LD field before the later pass can
    // bind it (oshcquote and compareoshc-au production fixtures).  Model only
    // those already-established transformations; all other varying leaves
    // remain eligible for exact removal.
    const containsTitle = typeof item.value === "string" &&
      REF_TITLE && item.value.includes(REF_TITLE);
    const containsDesc = typeof item.value === "string" &&
      REF_DESC && item.value.includes(REF_DESC);
    if (lane === "visible") {
      // The later placeholder pass can distinguish TITLE from DESC only in
      // semantic fields.  When both source strings are identical, a generic
      // paragraph/JSON-LD `name` is *not* proven to become a runtime token:
      // the global split fallback is deliberately disabled in that case.
      // Defer H1 (the authoritative TITLE field), or any literal covered by
      // the generic fallback when the two values are distinct.  All other
      // exact cross-page leaves stay eligible for removal.
      if ((containsTitle && item.node?.tag === "h1") ||
          ((containsTitle || containsDesc) && REF_TITLE !== REF_DESC)) return true;
      const inTime = item.node?.tag === "time" ||
        crossLeafAncestorNodes(item.node).some((node) => node.tag === "time");
      // Only generators that already own the later visible-time placeholder
      // pass may defer this leaf.  Older themes without that pass intentionally
      // let exact evidence remove the reference-only <time> unit.
      if (inTime && typeof replaceVisibleTimes === "function") return true;
      return false;
    }
    if (lane === "jsonld") {
      const field = item.jsonPath.at(-1);
      if ((field === "headline" && containsTitle) ||
          (field === "description" && containsDesc) ||
          ((containsTitle || containsDesc) && REF_TITLE !== REF_DESC)) return true;
      return ["datePublished", "dateModified"].includes(field);
    }
    return false;
  };
  for (const lane of ["visible", "jsonld"]) {
    for (const [key, templateItem] of template[lane]) {
      const referenceItem = reference[lane].get(key);
      if (!referenceItem || !crossLeafValueEqual(templateItem.value, referenceItem.value) ||
          crossLeafRuntimeToken(templateItem.value) ||
          deferredRuntimeField(lane, templateItem)) continue;
      if (lane === "jsonld" && ["@context", "@type"].includes(templateItem.jsonPath.at(-1))) continue;
      const differing = alternates.some((item) => item[lane].has(key) &&
        !crossLeafValueEqual(item[lane].get(key).value, templateItem.value));
      if (!differing) continue;
      const proof = { ...templateItem, expectedValue: templateItem.value };
      if (lane === "jsonld") {
        const script = template.scripts[templateItem.scriptIndex];
        if (script && !script.error) {
          const authorPath = crossLeafArticleFieldPath(script.value, templateItem.jsonPath, new Set(["author"]));
          const imagePath = crossLeafContextImageFieldPath(script.value, templateItem.jsonPath);
          if (crossLeafProtectedSchemaPath(script.value, templateItem.jsonPath) && !authorPath && !imagePath) continue;
          if (imagePath && DEFAULT_OG && crossLeafValueEqual(templateItem.value, DEFAULT_OG) &&
              (crossLeafValueEqual(templateItem.jsonPath, imagePath) ||
               ["url", "contentUrl"].includes(templateItem.jsonPath.at(-1)))) {
            evidence.jsonldSafeDefaultImage.push(proof);
            continue;
          }
        }
      }
      evidence[lane].push(proof);
    }
  }
  return { ...evidence, alternateCount: alternateHeads.slice(0, 8).length };
}

function crossLeafSeparatorRange(fragment, parsed, node) {
  const siblings = parsed.nodes.filter((item) => item.parent === node.parent && item.closed)
    .sort((left, right) => left.start - right.start);
  const index = siblings.indexOf(node);
  const separator = (candidate) => candidate?.tag === "span" && /^[\/›»>→·|]+$/.test(headNodeText(fragment, candidate));
  if (separator(siblings[index + 1])) return [node.start, siblings[index + 1].end];
  if (separator(siblings[index - 1])) return [siblings[index - 1].start, node.end];
  return [node.start, node.end];
}

function crossLeafCompositeTextReplacements(fragment, parsed, item) {
  const node = item.node;
  const children = parsed.nodes.filter((candidate) => candidate.parent === node && candidate.closed)
    .sort((left, right) => left.start - right.start);
  const composite = children.length > 0 || [
    "nav", "ol", "ul", "div", "section", "header", "footer", "article", "main",
  ].includes(node.tag);
  if (!composite) {
    const [start, end] = crossLeafSeparatorRange(fragment, parsed, node);
    return [{ start, end, value: "" }];
  }

  // direct-text proof 只授权这个文本 span；复合容器及其中 Home/Articles 等
  // 固定锚点不在授权范围。最多向前带走同一 gap 或前一个 <span> 里的纯
  // 分隔符，绝不扩到另一个内容节点。
  const previous = [...children].reverse().find((child) => child.end <= item.valueStart);
  if (previous?.tag === "span" && headIsSeparator(fragment, previous) &&
      fragment.slice(previous.end, item.valueStart).trim() === "") {
    return [{ start: previous.start, end: item.valueEnd, value: "" }];
  }
  // 只检查当前 direct-text gap。若从容器 openEnd 回看，HTML closing tag
  // 里的 "/"/">" 会被误认成面包屑分隔符，曾因此吃掉前一个固定 anchor
  // 的 </a> 尾部。
  const lowerBound = previous?.end ?? node.openEnd;
  const prefix = fragment.slice(lowerBound, item.valueStart);
  const separator = /(?:\s*(?:\/|›|»|>|→|·|\||—|–|-)\s*)$/.exec(prefix);
  return [{
    start: separator ? lowerBound + separator.index : item.valueStart,
    end: item.valueEnd,
    value: "",
  }];
}

function crossLeafDeleteJsonPath(value, path) {
  if (!path.length) return false;
  let current = value;
  for (const part of path.slice(0, -1)) {
    if (typeof part === "number" && Array.isArray(current) && part >= 0 && part < current.length) current = current[part];
    else if (typeof part === "string" && current && typeof current === "object" && part in current) current = current[part];
    else return false;
  }
  const leaf = path.at(-1);
  if (typeof leaf === "number" && Array.isArray(current) && leaf >= 0 && leaf < current.length) {
    current.splice(leaf, 1); return true;
  }
  if (typeof leaf === "string" && current && typeof current === "object" && leaf in current) {
    delete current[leaf]; return true;
  }
  return false;
}

function crossLeafJsonPathValue(value, path) {
  let current = value;
  for (const part of path) {
    if (typeof part === "number" && Array.isArray(current) && part >= 0 && part < current.length) current = current[part];
    else if (typeof part === "string" && current && typeof current === "object" && part in current) current = current[part];
    else return { exists: false, value: undefined };
  }
  return { exists: true, value: current };
}

function crossLeafSetJsonPath(value, path, replacement) {
  if (!path.length) return false;
  let current = value;
  for (const part of path.slice(0, -1)) {
    if (typeof part === "number" && Array.isArray(current) && part >= 0 && part < current.length) current = current[part];
    else if (typeof part === "string" && current && typeof current === "object" && part in current) current = current[part];
    else return false;
  }
  const leaf = path.at(-1);
  if (typeof leaf === "number" && Array.isArray(current) && leaf >= 0 && leaf < current.length) {
    current[leaf] = replacement; return true;
  }
  if (typeof leaf === "string" && current && typeof current === "object" && leaf in current) {
    current[leaf] = replacement; return true;
  }
  return false;
}

function crossLeafArticleFieldPath(value, path, fields) {
  let current = value;
  for (let index = 0; index < path.length; index += 1) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const types = (Array.isArray(current["@type"]) ? current["@type"] : [current["@type"]])
        .filter(Boolean).map((type) => String(type).split("/").pop().toLowerCase());
      if (types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type)) &&
          typeof path[index] === "string" && fields.has(path[index])) {
        return path.slice(0, index + 1);
      }
    }
    const part = path[index];
    if (typeof part === "number" && Array.isArray(current) && part >= 0 && part < current.length) current = current[part];
    else if (typeof part === "string" && current && typeof current === "object" && part in current) current = current[part];
    else break;
  }
  return null;
}

function crossLeafProtectedSchemaPath(value, path) {
  let current = value;
  for (let index = 0; index <= path.length; index += 1) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const types = (Array.isArray(current["@type"]) ? current["@type"] : [current["@type"]])
        .filter(Boolean).map((type) => String(type).split("/").pop().toLowerCase());
      if (types.some((type) => CROSS_LEAF_PROTECTED_SCHEMA_TYPES.has(type)) &&
          !types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type))) return true;
    }
    if (index === path.length) break;
    const part = path[index];
    if (typeof part === "number" && Array.isArray(current) && part >= 0 && part < current.length) current = current[part];
    else if (typeof part === "string" && current && typeof current === "object" && part in current) current = current[part];
    else break;
  }
  return false;
}

function crossLeafContextImageFieldPath(value, path) {
  if (crossLeafProtectedSchemaPath(value, path)) return null;
  let current = value;
  for (let index = 0; index < path.length; index += 1) {
    if (current && typeof current === "object" && !Array.isArray(current) &&
        typeof path[index] === "string" && ["image", "thumbnailUrl"].includes(path[index])) {
      return path.slice(0, index + 1);
    }
    const part = path[index];
    if (typeof part === "number" && Array.isArray(current) && part >= 0 && part < current.length) current = current[part];
    else if (typeof part === "string" && current && typeof current === "object" && part in current) current = current[part];
    else break;
  }
  return null;
}

function crossLeafProtectedSchemaSignatures(fragment) {
  const signatures = [];
  const walk = (value, articleOwnedField = false) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, articleOwnedField);
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = (Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]])
      .filter(Boolean).map((type) => String(type).split("/").pop().toLowerCase());
    const article = types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type));
    if (!articleOwnedField && !article &&
        types.some((type) => CROSS_LEAF_PROTECTED_SCHEMA_TYPES.has(type))) {
      signatures.push(JSON.stringify(crossLeafCanonicalJson(value)));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      walk(item, articleOwnedField || (article && ["author", "image", "thumbnailUrl"].includes(key)));
    }
  };
  for (const script of crossLeafJsonScripts(fragment)) if (!script.error) walk(script.value);
  return signatures.sort();
}

function crossLeafPruneJson(value) {
  if (Array.isArray(value)) return value.map(crossLeafPruneJson)
    .filter((item) => item !== null && !(Array.isArray(item) && !item.length) &&
      !(item && typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length));
  if (value && typeof value === "object") {
    const types = (Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]])
      .filter(Boolean).map((type) => String(type).split("/").pop().toLowerCase());
    // WebSite/Organization are site identity, not article context. They are
    // excluded from exact evidence and must survive byte-for-byte even when a
    // sibling Article mutation causes the enclosing JSON script to be rewritten.
    if (types.some((type) => CROSS_LEAF_PROTECTED_SCHEMA_TYPES.has(type)) &&
        !types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type))) return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = crossLeafPruneJson(item);
      if (cleaned === null || (Array.isArray(cleaned) && !cleaned.length) ||
          (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) && !Object.keys(cleaned).length)) continue;
      output[key] = cleaned;
    }
    return output;
  }
  return value;
}

function crossLeafSafeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003C").replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function crossLeafGlobalShell(fragment, exact) {
  const selected = [];
  for (const node of exact.parsed.nodes) {
    if (!node.closed || !["header", "nav"].includes(node.tag) || exact.cone.nodes.has(node)) continue;
    if (selected.some((outer) => headNodeContains(outer, node))) continue;
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (headNodeContains(node, selected[index])) selected.splice(index, 1);
    }
    selected.push(node);
  }
  return selected.map((node) => fragment.slice(node.start, node.end)).sort();
}

function crossLeafProtectedTaxonomy(fragment, item) {
  let anchor = item.nodeTag === "a" ? item.node : null;
  if (!anchor) anchor = crossLeafAncestorNodes(item.node).find((node) => node.tag === "a") || null;
  if (!anchor) return false;
  const href = crossLeafNodeAttrs(anchor).href || "";
  if (!headIsTaxonomyHref(href)) return false;
  // 跨页值变化本身已经证明 generic chip 是文章字段（liuxue-net-au）；不能仅
  // 因 class 没写 category 就把它当固定导航。唯一无条件保护的是明确的
  // site/global/primary 导航祖先，文章 header/breadcrumb 不属于这一类。
  return [anchor, ...crossLeafAncestorNodes(anchor)].some((node) => {
    if (!["header", "nav"].includes(node.tag)) return false;
    const descriptor = headNodeAttrs(node);
    if (HEAD_BREADCRUMB_HINT.test(descriptor) ||
        /(?:article|post|entry)[-_ ]?(?:header|meta|info)/i.test(descriptor)) return false;
    return /(?:^|[\s_-])(?:site|global|primary|main)[-_ ]?(?:header|nav|navigation)?(?:$|[\s_-])|navbar/i.test(descriptor);
  });
}

function sanitizeCrossPageExactLeaves(fragment, referenceHead, alternateHeads) {
  if (!alternateHeads.length) return {
    html: fragment, visibleApplied: 0, jsonldApplied: 0,
    jsonldSafeDefaultImage: 0, alternateCount: 0,
  };
  const evidence = crossPageExactEvidence(fragment, referenceHead, alternateHeads);
  const current = extractCrossPageExactLeaves(fragment);
  const globalBefore = crossLeafGlobalShell(fragment, current);
  const protectedSchemaBefore = crossLeafProtectedSchemaSignatures(fragment);
  const replacements = [];
  let visibleApplied = 0;
  for (const proof of evidence.visible) {
    const actual = current.visible.get(proof.key);
    if (!actual || !crossLeafValueEqual(actual.value, proof.expectedValue)) {
      throw new Error(`cross-page exact visible evidence drifted: ${proof.key}`);
    }
    if (crossLeafProtectedTaxonomy(fragment, actual)) continue;
    const node = actual.node;
    const affectedAnchor = node.tag === "a" ? node :
      crossLeafAncestorNodes(node).find((candidate) => candidate.tag === "a") || null;
    if (process.env.D1_CONTEXT_EXACT_DEBUG === "1") {
      console.error(JSON.stringify({
        event: "d1_context_exact_visible_proof", key: actual.key, field: actual.field,
        value: actual.value, valueRange: [actual.valueStart, actual.valueEnd],
        node: [node.tag, node.start, node.end], affectedAnchor: affectedAnchor?.start ?? null,
      }));
    }
    const replacementOffset = replacements.length;
    if (actual.field === "text") {
      const normalized = String(actual.value).replace(/\s+/g, " ").trim();
      if (node.tag === "h1") replacements.push({ start: actual.valueStart, end: actual.valueEnd, value: "{{TITLE}}" });
      else if (CROSS_LEAF_DATE_RE.test(normalized)) replacements.push({ start: actual.valueStart, end: actual.valueEnd, value: "{{DATE}}" });
      else replacements.push(...crossLeafCompositeTextReplacements(fragment, current.parsed, actual));
    } else if (actual.field === "href") {
      const [start, end] = crossLeafSeparatorRange(fragment, current.parsed, node);
      replacements.push({ start, end, value: "" });
    } else if (["src", "srcset"].includes(actual.field)) {
      if (DEFAULT_OG) replacements.push({ start: actual.valueStart, end: actual.valueEnd, value: DEFAULT_OG });
      else if (["img", "source", "picture"].includes(node.tag)) replacements.push({ start: node.start, end: node.end, value: "" });
      else replacements.push({ start: actual.attributeStart, end: actual.attributeEnd, value: "" });
    } else if (actual.field === "datetime") {
      replacements.push({ start: actual.valueStart, end: actual.valueEnd, value: "{{DATE_ISO_FULL}}" });
    } else {
      let start = actual.attributeStart;
      while (start > node.start && /\s/.test(fragment[start - 1])) start -= 1;
      replacements.push({ start, end: actual.attributeEnd, value: "" });
    }
    for (const replacement of replacements.slice(replacementOffset)) {
      replacement.proofKey = proof.key;
      replacement.sourceNodeStart = node.start;
      replacement.sourceNodeTag = node.tag;
      replacement.approvedAnchorStart = affectedAnchor?.start ?? null;
    }
    visibleApplied += 1;
  }

  const jsonByScript = new Map();
  for (const proof of evidence.jsonld) {
    if (!jsonByScript.has(proof.scriptIndex)) jsonByScript.set(proof.scriptIndex, []);
    jsonByScript.get(proof.scriptIndex).push(proof);
  }
  let jsonldApplied = 0;
  for (const [scriptIndex, proofs] of jsonByScript) {
    const script = current.scripts[scriptIndex];
    if (!script || script.error) throw new Error(`cross-page exact JSON-LD script missing: ${scriptIndex}`);
    const value = structuredClone(script.value);
    for (const proof of proofs) {
      const actual = crossLeafJsonPathValue(value, proof.jsonPath);
      if (!actual.exists || !crossLeafValueEqual(actual.value, proof.expectedValue)) {
        throw new Error(`cross-page exact JSON-LD evidence drifted: ${proof.key}`);
      }
    }

    // author/image are compound Article fields.  Removing only the proven leaf
    // can leave {"@type":"Person"} authors or empty ImageObject shells.  Promote
    // any descendant proof to the whole Article field; the site-wide fallback
    // image is a safe current-page value, while no equivalent author default is
    // available in the generator contract.
    const specialPaths = new Map();
    for (const proof of proofs) {
      const authorPath = crossLeafArticleFieldPath(value, proof.jsonPath, new Set(["author"]));
      const imagePath = crossLeafContextImageFieldPath(value, proof.jsonPath);
      const path = authorPath || imagePath;
      if (!path) continue;
      const key = JSON.stringify(path);
      specialPaths.set(key, { path, kind: authorPath ? "author" : "image" });
    }
    const underSpecialPath = (path) => [...specialPaths.values()].some((special) =>
      special.path.length <= path.length && special.path.every((part, index) => part === path[index]));

    proofs.sort((left, right) => {
      const a = left.jsonPath, b = right.jsonPath;
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if (a[index] === b[index]) continue;
        const aType = typeof a[index] === "number" ? 1 : 0;
        const bType = typeof b[index] === "number" ? 1 : 0;
        if (aType !== bType) return bType - aType;
        if (typeof a[index] === "number" && typeof b[index] === "number") return b[index] - a[index];
        const aText = String(a[index] ?? ""), bText = String(b[index] ?? "");
        return bText < aText ? -1 : bText > aText ? 1 : 0;
      }
      return b.length - a.length;
    });
    for (const [, special] of [...specialPaths.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)) {
      const changed = special.kind === "image" && DEFAULT_OG ?
        crossLeafSetJsonPath(value, special.path, DEFAULT_OG) :
        crossLeafDeleteJsonPath(value, special.path);
      if (!changed) throw new Error(`cross-page exact JSON-LD compound field drifted: ${JSON.stringify(special.path)}`);
    }
    for (const proof of proofs) {
      if (!underSpecialPath(proof.jsonPath) && !crossLeafDeleteJsonPath(value, proof.jsonPath)) {
        throw new Error(`cross-page exact JSON-LD path could not be removed: ${proof.key}`);
      }
      jsonldApplied += 1;
    }
    const cleaned = crossLeafPruneJson(value);
    const empty = cleaned === null || (Array.isArray(cleaned) && !cleaned.length) ||
      (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) && !Object.keys(cleaned).length);
    if (empty) replacements.push({ start: script.start, end: script.end, value: "" });
    else replacements.push({ start: script.bodyStart, end: script.bodyEnd, value: crossLeafSafeJson(cleaned) });
  }

  const count = (haystack, needle) => needle ? haystack.split(needle).length - 1 : 0;
  const anchors = current.parsed.nodes.filter((node) => node.closed && node.tag === "a");
  const expectedAnchors = new Map();
  for (const anchor of anchors) {
    const raw = fragment.slice(anchor.start, anchor.end);
    if (!expectedAnchors.has(raw)) expectedAnchors.set(raw, count(fragment, raw));
    const overlapping = replacements.filter((item) => item.start < anchor.end && item.end > anchor.start);
    if (overlapping.length) {
      if (overlapping.some((item) => item.approvedAnchorStart !== anchor.start)) {
        throw new Error(
          `cross-page exact sanitizer attempted to change an unapproved fixed anchor at ${anchor.start}: ` +
          JSON.stringify({
            replacements: overlapping.map((item) => ({
              range: [item.start, item.end], source: [item.sourceNodeTag, item.sourceNodeStart],
              approvedAnchorStart: item.approvedAnchorStart,
            })),
            anchor: fragment.slice(anchor.start, anchor.end).slice(0, 180),
          }),
        );
      }
      expectedAnchors.set(raw, expectedAnchors.get(raw) - 1);
    }
  }
  const balanceBefore = htmlBalanceSignature(fragment);
  const output = applyHeadReplacements(fragment, replacements);
  const afterExact = extractCrossPageExactLeaves(output);
  if (afterExact.jsonldErrors.length) throw new Error("cross-page exact sanitizer produced invalid JSON-LD");
  if (JSON.stringify(crossLeafGlobalShell(output, afterExact)) !== JSON.stringify(globalBefore)) {
    throw new Error("cross-page exact sanitizer changed protected global header/navigation HTML");
  }
  if (JSON.stringify(crossLeafProtectedSchemaSignatures(output)) !== JSON.stringify(protectedSchemaBefore)) {
    throw new Error("cross-page exact sanitizer changed protected WebSite/Organization JSON-LD");
  }
  for (const [raw, expected] of expectedAnchors) {
    if (count(output, raw) !== expected) throw new Error("cross-page exact sanitizer changed an unapproved fixed anchor");
  }
  if (htmlBalanceSignature(output) !== balanceBefore) {
    throw new Error("cross-page exact sanitizer changed HTML balance");
  }
  const remaining = extractCrossPageExactLeaves(output);
  for (const proof of [...evidence.visible, ...evidence.jsonld]) {
    const lane = proof.lane === "jsonld" ? remaining.jsonld : remaining.visible;
    const actual = lane.get(proof.key);
    if (!actual || !crossLeafValueEqual(actual.value, proof.expectedValue)) continue;
    if (proof.lane === "jsonld") {
      const sourceScript = current.scripts[proof.scriptIndex];
      const imagePath = sourceScript && !sourceScript.error ?
        crossLeafContextImageFieldPath(sourceScript.value, proof.jsonPath) : null;
      // A reference article can already use the site-wide fallback. Rewriting
      // the whole Article image field to that same DEFAULT_OG is still a fully
      // consumed proof, even though the literal happens to remain equal.
      if (imagePath && DEFAULT_OG && crossLeafValueEqual(actual.value, DEFAULT_OG)) continue;
      throw new Error(`cross-page exact sanitizer left proven reference JSON-LD leaf: ${proof.key}`);
    }
    if (["src", "srcset"].includes(actual.field) && DEFAULT_OG && actual.value === DEFAULT_OG) continue;
    if (!crossLeafProtectedTaxonomy(output, actual)) {
      throw new Error(`cross-page exact sanitizer left proven reference leaf: ${proof.key}`);
    }
  }
  return {
    html: output, visibleApplied, jsonldApplied,
    jsonldSafeDefaultImage: evidence.jsonldSafeDefaultImage.length,
    alternateCount: alternateHeads.length,
  };
}

const CROSS_LEAF_HEAD_IMAGE_META_KEYS = new Set([
  "og:image", "og:image:url", "twitter:image", "twitter:image:src",
]);

function crossLeafHeadImageMeta(fragment) {
  const result = new Map();
  const headOpen = /<head\b[^>]*>/i.exec(fragment);
  if (!headOpen) return result;
  const lower = headOpen.index + headOpen[0].length;
  const closeRelative = fragment.slice(lower).search(/<\/head\s*>/i);
  if (closeRelative < 0) return result;
  const upper = lower + closeRelative;
  const counts = new Map();
  const re = /<meta\b[^>]*>/gi;
  re.lastIndex = lower;
  let match;
  while ((match = re.exec(fragment)) !== null && match.index < upper) {
    if (re.lastIndex > upper) break;
    const tag = match[0];
    const keyMatch = /\b(?:name|property)\s*=\s*(["'])([^"']+)\1/i.exec(tag);
    const key = keyMatch?.[2]?.toLowerCase() || "";
    if (!CROSS_LEAF_HEAD_IMAGE_META_KEYS.has(key)) continue;
    const contentRe = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i;
    const contentMatch = contentRe.exec(tag);
    if (!contentMatch) continue;
    const ordinal = counts.get(key) || 0;
    counts.set(key, ordinal + 1);
    const quoteOffset = contentMatch[0].indexOf(contentMatch[1], "content".length);
    const contentOffset = contentMatch.index + quoteOffset + 1;
    result.set(`${key}#${ordinal}`, {
      key, ordinal, value: contentMatch[2],
      start: match.index, end: re.lastIndex,
      valueStart: match.index + contentOffset,
      valueEnd: match.index + contentOffset + contentMatch[2].length,
    });
  }
  return result;
}

function sanitizeCrossPageHeadImageMeta(fragment, referenceHead, alternateHeads) {
  const template = crossLeafHeadImageMeta(fragment);
  const reference = crossLeafHeadImageMeta(referenceHead);
  const alternates = alternateHeads.slice(0, 8).map(crossLeafHeadImageMeta);
  const proofs = [];
  for (const [key, item] of template) {
    const referenceItem = reference.get(key);
    if (!referenceItem || item.value !== referenceItem.value || crossLeafRuntimeToken(item.value)) continue;
    if (!alternates.some((alternate) => alternate.has(key) && alternate.get(key).value !== item.value)) continue;
    proofs.push({ key, expectedValue: item.value });
  }
  const replacements = [];
  let defaulted = 0;
  let removed = 0;
  let safeDefault = 0;
  for (const proof of proofs) {
    const actual = template.get(proof.key);
    if (!actual || actual.value !== proof.expectedValue) {
      throw new Error(`cross-page HEAD image-meta evidence drifted: ${proof.key}`);
    }
    if (DEFAULT_OG) {
      if (actual.value === DEFAULT_OG) safeDefault += 1;
      else {
        replacements.push({ start: actual.valueStart, end: actual.valueEnd, value: DEFAULT_OG });
        defaulted += 1;
      }
    } else {
      replacements.push({ start: actual.start, end: actual.end, value: "" });
      removed += 1;
    }
  }
  const output = applyHeadReplacements(fragment, replacements);
  const after = crossLeafHeadImageMeta(output);
  if (DEFAULT_OG) {
    for (const proof of proofs) {
      const item = after.get(proof.key);
      // Removing an earlier duplicate changes later ordinals only in the
      // no-default lane.  With a fallback every proven tag remains in place.
      if (!item || item.value !== DEFAULT_OG) {
        throw new Error(`cross-page HEAD image-meta sanitizer left unsafe value: ${proof.key}`);
      }
    }
  } else {
    const removedByKey = new Map();
    for (const proof of proofs) {
      const key = template.get(proof.key).key;
      removedByKey.set(key, (removedByKey.get(key) || 0) + 1);
    }
    for (const [key, count] of removedByKey) {
      const beforeCount = [...template.values()].filter((item) => item.key === key).length;
      const afterCount = [...after.values()].filter((item) => item.key === key).length;
      if (afterCount !== beforeCount - count) {
        throw new Error(`cross-page HEAD image-meta sanitizer did not remove exact proven tags: ${key}`);
      }
    }
  }
  return { html: output, proofCount: proofs.length, defaulted, removed, safeDefault };
}

const crossLeafReferenceHead = cutCrossPageHead(html, REF_TITLE);
const crossLeafAlternates = collectCrossPageAlternates(crossLeafReferenceHead);
if (process.env.D1_CONTEXT_EXACT_DEBUG === "1") {
  console.error(JSON.stringify({
    event: "d1_context_exact_samples",
    reference: crossLeafResolve(REF),
    alternates: crossLeafAlternates.map((item) => ({ path: item.path, similarity: item.similarity })),
  }));
}
const crossPageExactContext = sanitizeCrossPageExactLeaves(
  head, crossLeafReferenceHead, crossLeafAlternates.map((item) => item.head),
);
if (process.env.D1_CONTEXT_EXACT_DEBUG === "1") {
  console.error(JSON.stringify({
    event: "d1_context_exact_result",
    visibleApplied: crossPageExactContext.visibleApplied,
    jsonldApplied: crossPageExactContext.jsonldApplied,
    jsonldSafeDefaultImage: crossPageExactContext.jsonldSafeDefaultImage,
    alternateCount: crossPageExactContext.alternateCount,
  }));
}
head = crossPageExactContext.html;
const crossPageHeadImageMeta = sanitizeCrossPageHeadImageMeta(
  head, crossLeafReferenceHead, crossLeafAlternates.map((item) => item.head),
);
if (process.env.D1_CONTEXT_EXACT_DEBUG === "1") {
  console.error(JSON.stringify({
    event: "d1_context_exact_head_image_meta",
    proofCount: crossPageHeadImageMeta.proofCount,
    defaulted: crossPageHeadImageMeta.defaulted,
    removed: crossPageHeadImageMeta.removed,
    safeDefault: crossPageHeadImageMeta.safeDefault,
  }));
}
head = crossPageHeadImageMeta.html;

const headVisibleContext = sanitizeVisibleArticleShell(head);
head = headVisibleContext.html;
const headMetadataContext = sanitizeHeadArticleMetadata(head);
head = headMetadataContext.html;
const unknownHeadTokens = [...head.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)]
  .map((match) => match[1]).filter((name) => !new Set([
    "CANONICAL", "CANONICAL_ENC", "SLUG", "TITLE", "DESC", "DATE", "DATE_ISO",
    "DATE_ISO_FULL", "CATEGORY", "CATEGORY_SLUG", "CATEGORY_SUFFIX",
  ]).has(name));
if (unknownHeadTokens.length) {
  throw new Error(`HEAD article-context sanitizer found unsupported runtime tokens: ${[...new Set(unknownHeadTokens)].join(", ")}`);
}
// D1_HEAD_CONTEXT_SANITIZER_END

// ── 3a. 移除只属于参考文章的标签/相关文章/上下篇组件 ─────────────
//
// Astro 会在构建参考页时把 tags、related entries、previous/next 的真实链接、
// 标题和简介全部算好后写进 HTML。这些组件通常位于正文容器闭合后的 TAIL；
// 若原样进入模板，每一篇 D1 动态文章都会继承参考文章当年的邻居。它们不能
// 像 canonical 那样只替换一个 slug：相关文章有多条不同 slug，D1 行也没有
// 足够的标签/排序数据在服务端重算。最低风险的正确行为是从动态页外壳直接
// 摘掉整个参考文章上下文组件。静态文章页完全不经过这段逻辑，原有相关文章/
// 上下篇仍保持不变；直接删 HTML 也不要求不同年代的 Workers、Pages 或共享
// Worker 同时认识一个新占位符，避免字面占位符泄到线上。
//
// 识别不能靠单一 class 名：站群里至少有 Tailwind 通用 class、related-grid、
// prev-next/pn、自定义中英繁简标题等多个家族。这里用“站内具体文章/标签链接
// + HTML 结构”双重判据：只看 TAIL、排除 <footer>、只删明确的 section/nav/
// aside 或纯链接 list；普通 div 还必须有 related/prev/next/tags 语义提示。
// /about、/privacy、/posts/ 这类固定页/集合首页不属于“具体目标”，不会命中。
const D1_CONTEXT_SLOT = "";
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);
const TAG_ROUTE_SEGMENTS = new Set(["tag", "tags", "category", "categories"]);
const RESERVED_ROOT_ROUTES = new Set([
  "404", "_astro", "about", "articles", "assets", "blog", "calculator", "calculators", "categories",
  "category", "contact", "css", "disclaimer", "en", "favicon", "favicon.ico",
  "fonts", "guides", "images", "img", "index", "js", "llms.txt", "news",
  "offline", "page", "pages", "posts", "privacy", "resources", "robots",
  "robots.txt", "search", "sitemap", "sitemap.xml", "sources", "static", "tag", "tags",
  "terms", "tool", "tools", "tw", "zh", "zh-cn", "zh-hant", "zh-tw",
]);
const ARTICLE_COLLECTION_SEGMENTS = new Set([
  "article", "articles", "blog", "blogs", "entry", "entries", "guide", "guides",
  "insight", "insights", "news", "post", "posts",
]);
const CONTEXT_WIDGET_HINT = /(?:\brelated\b|\brecommended\b|\bprevious\b|\bnext\b|\bprev[-_ ]?next\b|\bback[-_ ]?nav\b|\bmore in\b|\badjacent\b|\bolder\b|\bnewer\b|\btags?\b|\bcategories?\b|\btopics?\b|相关文章|相关(?:攻略|问答|阅读|文章)|相關(?:攻略|問答|閱讀|文章)|相关推荐|相關推薦|延伸(?:阅读|閱讀)|上一篇|下一篇|上一页|下一页|前一篇|后一篇|後一篇|标签|標籤|分类|分類|主题|主題)/i;
const MIXED_BACK_NAV_HINT = /(?:back[-_ ]?nav|article[-_ ]?back|return[-_ ]?nav)/i;
const CONTEXT_TEMPLATE_TOKEN = /\{\{(?:SLUG|CANONICAL|CANONICAL_ENC)(?:_[A-Z0-9]+)?\}\}/;
const NON_CONTEXT_INTERACTIVE = /(?:<(?:button|form|input|select|textarea|iframe)\b|\bonclick\s*=)/i;
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;

function parseTailFragment(fragment) {
  const nodes = [];
  const stack = [];
  // script/style 里可能有字符串字面量 "<div>" / "<a href=...>"；它们不是
  // HTML 结构，必须整体原子跳过，否则会污染栈并把后续真实组件边界算错。
  const tokenRe = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/gi;
  let match;
  while ((match = tokenRe.exec(fragment)) !== null) {
    const token = match[0];
    if (token.startsWith("<!--") || /^<(?:script|style)\b/i.test(token)) continue;
    const close = /^<\//.test(token);
    const tagMatch = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(token);
    if (!tagMatch) continue;
    const tag = tagMatch[1].toLowerCase();
    if (close) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== tag) index -= 1;
      if (index < 0) continue; // TAIL 常以 HEAD 中打开的容器闭标签开头，合法。
      for (let i = stack.length - 1; i >= index; i -= 1) {
        const node = stack[i];
        node.closeStart = match.index;
        node.end = tokenRe.lastIndex;
      }
      stack.length = index;
      continue;
    }
    const parent = stack.length ? stack[stack.length - 1] : null;
    const node = {
      tag,
      start: match.index,
      openEnd: tokenRe.lastIndex,
      closeStart: tokenRe.lastIndex,
      end: tokenRe.lastIndex,
      openTag: token,
      parent,
    };
    nodes.push(node);
    if (!VOID_TAGS.has(tag) && !/\/>$/.test(token)) stack.push(node);
  }
  for (const node of stack) {
    node.closeStart = fragment.length;
    node.end = fragment.length;
  }
  return nodes;
}

function isFooterLike(node) {
  if (node.tag === "footer" || node.tag.endsWith("footer")) return true;
  if (/\brole\s*=\s*(["'])contentinfo\1/i.test(node.openTag)) return true;
  const attrs = [...node.openTag.matchAll(/\b(?:class|id)\s*=\s*(["'])([\s\S]*?)\1/gi)]
    .map((match) => match[2]).join(" ");
  return /(?:^|[\s_-])foot(?:er)?(?:$|[\s_-])/i.test(attrs);
}

function hasFooterAncestor(node) {
  for (let current = node; current; current = current.parent) {
    if (isFooterLike(current)) return true;
  }
  return false;
}

function footerSubtrees(fragment) {
  const nodes = parseTailFragment(fragment);
  return nodes
    .filter((node) => {
      if (!isFooterLike(node)) return false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (isFooterLike(parent)) return false;
      }
      return true;
    })
    .map((node) => fragment.slice(node.start, node.end));
}

function decodePathSafely(pathname) {
  let value = pathname;
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value;
}

function classifyContextHref(rawHref) {
  if (!rawHref || rawHref.includes("{{") || /^(?:#|mailto:|tel:|javascript:|data:)/i.test(rawHref)) {
    return null;
  }
  let refUrl;
  let url;
  try {
    refUrl = new URL(CANONICAL_BASE);
    url = new URL(rawHref.replace(/&amp;/g, "&"), `${refUrl.origin}/`);
  } catch {
    return null;
  }
  if (url.origin !== refUrl.origin) return null;
  const path = decodePathSafely(url.pathname);
  const segments = path.split("/").filter(Boolean);
  const lowered = segments.map((part) => part.toLowerCase());
  for (let i = 0; i < lowered.length - 1; i += 1) {
    if (TAG_ROUTE_SEGMENTS.has(lowered[i])) return { kind: "tag", path };
  }

  const segParts = SEG.split("/").filter(Boolean).map((part) => part.toLowerCase());
  const routeStarts = [];
  if (segParts.length) {
    for (let i = 0; i <= lowered.length - segParts.length; i += 1) {
      if (segParts.every((part, offset) => lowered[i + offset] === part)) {
        routeStarts.push([i, segParts.length]);
      }
    }
  }
  for (const [start, width] of routeStarts) {
    let remainder = segments.slice(start + width);
    while (remainder.length && LOCALE_SEGMENT.test(remainder[0])) remainder = remainder.slice(1);
    if (remainder.length && !RESERVED_ROOT_ROUTES.has(remainder[remainder.length - 1].toLowerCase())) {
      return { kind: "article", path };
    }
  }
  if (!segParts.length) {
    let remainder = segments.slice();
    while (remainder.length && LOCALE_SEGMENT.test(remainder[0])) remainder = remainder.slice(1);
    if (remainder.length === 1 && !RESERVED_ROOT_ROUTES.has(remainder[0].toLowerCase())) {
      return { kind: "article", path };
    }
  }
  return null;
}

function contextualAnchors(fragment, nodes) {
  const anchors = [];
  for (const node of nodes) {
    if (node.tag !== "a") continue;
    const hrefMatch = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec(node.openTag);
    if (!hrefMatch) continue;
    const classified = classifyContextHref(hrefMatch[2]);
    anchors.push({
      node,
      href: hrefMatch[2],
      classified,
      inFooter: hasFooterAncestor(node),
    });
  }
  return anchors;
}

function nodeContains(outer, inner) {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function localWidgetHint(fragment, node) {
  // 只看开标签、紧邻前文注释和组件开头；不能扫完整 node，否则一个很大的
  // 页面 wrapper 会因为深层 related 文案而被误判成组件、整块删掉。
  const before = fragment.slice(Math.max(0, node.start - 220), node.start);
  const after = fragment.slice(node.openEnd, Math.min(fragment.length, node.openEnd + 360));
  return CONTEXT_WIDGET_HINT.test(`${before} ${node.openTag} ${after}`);
}

function explicitDivWidgetHint(fragment, node) {
  const before = fragment.slice(Math.max(0, node.start - 220), node.start);
  const comment = /(<!--[\s\S]*?-->)\s*$/.exec(before)?.[1] || "";
  return CONTEXT_WIDGET_HINT.test(`${comment} ${node.openTag}`);
}

function componentAuxiliaryReason(rawHref) {
  if (CONTEXT_TEMPLATE_TOKEN.test(rawHref)) return "context_template_token";
  const segParts = SEG.split("/").filter(Boolean);
  try {
    const refUrl = new URL(CANONICAL_BASE);
    const url = new URL(rawHref.replace(/&amp;/g, "&"), `${refUrl.origin}/`);
    if (url.origin !== refUrl.origin) return null;
    if (url.search || url.hash) return null;
    const normalized = decodePathSafely(url.pathname).replace(/\/+$/, "");
    if (segParts.length && normalized === `/${segParts.join("/")}`) {
      return "article_collection_root";
    }
    const pathParts = normalized.split("/").filter(Boolean).map((part) => part.toLowerCase());
    if (pathParts.length === 1 && ARTICLE_COLLECTION_SEGMENTS.has(pathParts[0])) {
      return "article_collection_root";
    }
  } catch {
    return null;
  }
  return null;
}

function chooseContextBlocks(fragment) {
  const nodes = parseTailFragment(fragment);
  const anchors = contextualAnchors(fragment, nodes);
  const blocks = [];
  for (const node of nodes) {
    if (!["section", "nav", "aside", "ul", "ol", "div"].includes(node.tag)) continue;
    if (hasFooterAncestor(node)) continue;
    const allLinks = anchors.filter((anchor) => nodeContains(node, anchor.node));
    const contextLinks = allLinks.filter((anchor) => anchor.classified && !anchor.inFooter);
    if (!contextLinks.length) continue;
    const articleCount = contextLinks.filter((anchor) => anchor.classified.kind === "article").length;
    const tagCount = contextLinks.filter((anchor) => anchor.classified.kind === "tag").length;
    const allLinksAreContext = allLinks.length === contextLinks.length;
    const hint = localWidgetHint(fragment, node);
    const strongHint = explicitDivWidgetHint(fragment, node);
    let matches = false;
    if (node.tag === "section" || node.tag === "aside") {
      matches = articleCount >= 2 || (hint && contextLinks.length >= 1) ||
        (tagCount >= 1 && articleCount === 0 && allLinksAreContext);
    } else if (node.tag === "nav") {
      matches = (hint && contextLinks.length >= 1) || (articleCount >= 2 && allLinksAreContext);
    } else if (node.tag === "ul" || node.tag === "ol") {
      matches = allLinksAreContext && (articleCount >= 2 || (tagCount >= 1 && articleCount === 0));
    } else if (node.tag === "div") {
      // div 家族常没有语义 class，只是一组纯文章卡；2 条以上且全部都是
      // 内容链接时足以证明它不是普通固定导航。语义 hint 对 div 只看开标签
      // 与紧邻前置注释，不能看整个/开头正文，避免外层 wrapper 因深层 h2
      // 出现 "Related" 而被整块删除。
      matches = (explicitDivWidgetHint(fragment, node) && contextLinks.length >= 1) ||
        (articleCount >= 2 && allLinksAreContext) ||
        (tagCount >= 1 && articleCount === 0 && allLinksAreContext);
    }
    if (matches) {
      const nonContextLinks = allLinks.filter((anchor) => !contextLinks.includes(anchor));
      const allowedAuxiliaryLinks = nonContextLinks
        .map((anchor) => ({ anchor, reason: componentAuxiliaryReason(anchor.href) }))
        .filter((item) => item.reason);
      let unsafeNonContext = nonContextLinks.filter(
        (anchor) => !allowedAuxiliaryLinks.some((item) => item.anchor === anchor),
      );
      const directContextAnchors = contextLinks.every((anchor) => anchor.node.parent === node);
      const mixedBackNavigation = nonContextLinks.length > 0 && ["nav", "div"].includes(node.tag) &&
        MIXED_BACK_NAV_HINT.test(node.openTag) && directContextAnchors;
      if (nonContextLinks.length && !strongHint && !mixedBackNavigation) {
        unsafeNonContext = nonContextLinks;
      }
      blocks.push({
        node,
        hint,
        strongHint,
        contextLinks,
        allLinks,
        nonContextLinks,
        allowedAuxiliaryLinks,
        protectedFixedLinks: mixedBackNavigation ? nonContextLinks : unsafeNonContext,
        action: mixedBackNavigation ? "remove_context_anchors" :
          unsafeNonContext.length ? "unsafe_mixed_component" : "remove_block",
      });
    }
  }

  // 部分主题没有 Related 外壳：一个语义 h2 后面直接排 2-3 个同级 card div。
  // 把 heading 到最后一个纯 contextual sibling 作为一整块，避免只删第一张卡、
  // 留下空标题和后两张参考文章卡。明确语义 heading 时允许单链接，覆盖只有
  // Previous 或一篇 Related 的真实边界页。
  for (const heading of nodes) {
    if (!["h2", "h3", "h4", "h5", "h6"].includes(heading.tag)) continue;
    if (hasFooterAncestor(heading)) continue;
    const headingText = fragment.slice(heading.openEnd, heading.closeStart).replace(/<[^>]+>/g, " ");
    const before = fragment.slice(Math.max(0, heading.start - 220), heading.start);
    if (!CONTEXT_WIDGET_HINT.test(`${before} ${heading.openTag} ${headingText}`)) continue;
    let lastEnd = null;
    for (const sibling of nodes) {
      if (sibling.parent !== heading.parent || sibling.start < heading.end) continue;
      if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(sibling.tag)) break;
      if (isFooterLike(sibling)) break;
      if (anchors.some((anchor) => anchor.classified && !anchor.inFooter && nodeContains(sibling, anchor.node))) {
        lastEnd = sibling.end;
      }
    }
    if (lastEnd === null) continue;
    const runAnchors = anchors.filter(
      (anchor) => anchor.node.start >= heading.start && anchor.node.start < lastEnd,
    );
    const contextLinks = runAnchors.filter((anchor) => anchor.classified && !anchor.inFooter);
    if (contextLinks.length && contextLinks.length === runAnchors.length) {
      blocks.push({
        node: { start: heading.start, end: lastEnd },
        hint: true,
        strongHint: true,
        contextLinks,
        allLinks: runAnchors,
        nonContextLinks: [],
        allowedAuxiliaryLinks: [],
        protectedFixedLinks: [],
        action: "remove_block",
      });
    }
  }

  // HTML 树区间只能是嵌套或不相交。先看外层；某区间已覆盖时丢掉内层，
  // 例如 Related <section> 盖住里面的 <ul>，避免留下空标题/空框。
  const narrowed = blocks.filter((candidate) => !(
    !candidate.strongHint &&
    !(candidate.hint && ["section", "aside"].includes(candidate.node.tag)) &&
    blocks.some((other) =>
      other !== candidate && other.strongHint && nodeContains(candidate.node, other.node)
    )
  ));
  narrowed.sort((a, b) => a.node.start - b.node.start || b.node.end - a.node.end);
  const outer = [];
  for (const block of narrowed) {
    if (outer.some((kept) => nodeContains(kept.node, block.node))) continue;
    for (let i = outer.length - 1; i >= 0; i -= 1) {
      if (nodeContains(block.node, outer[i].node)) outer.splice(i, 1);
    }
    outer.push(block);
  }
  return { nodes, anchors, blocks: outer };
}

function stripReferenceArticleContext(fragment) {
  const footerBefore = footerSubtrees(fragment);
  const chosen = chooseContextBlocks(fragment);
  if (!chosen.blocks.length) {
    const remaining = chosen.anchors.filter((anchor) => anchor.classified && !anchor.inFooter);
    if (remaining.length >= 2) {
      throw new Error(
        `TAIL 有 ${remaining.length} 条参考文章上下文链接，但找不到可安全移除的完整组件：` +
        remaining.slice(0, 4).map((anchor) => anchor.href).join(", "),
      );
    }
    if (remaining.length === 1) {
      console.warn(`⚠ TAIL 留有 1 条无组件语义的具体内容链接：${remaining[0].href}`);
    }
    return { html: fragment, removedBlocks: 0, removedLinks: 0, remainingLinks: remaining.length };
  }
  const unsafe = chosen.blocks.filter((block) => block.action === "unsafe_mixed_component");
  if (unsafe.length) {
    throw new Error(
      "TAIL contextual component contains unproven fixed navigation: " +
      unsafe.flatMap((block) => block.protectedFixedLinks.map((anchor) => anchor.href)).slice(0, 4).join(", "),
    );
  }
  const interactive = chosen.blocks.find(
    (block) => block.action === "remove_block" &&
      NON_CONTEXT_INTERACTIVE.test(fragment.slice(block.node.start, block.node.end)),
  );
  if (interactive) {
    throw new Error(
      "TAIL contextual component also contains an interactive control; refusing whole-block removal",
    );
  }
  const approvedAuxiliary = new Set(chosen.blocks
    .filter((block) => block.action === "remove_block")
    .flatMap((block) => block.allowedAuxiliaryLinks.map((item) => item.anchor)));
  const protectedFragments = chosen.anchors
    .filter((anchor) => !anchor.classified && !anchor.inFooter && !approvedAuxiliary.has(anchor))
    .map((anchor) => fragment.slice(anchor.node.start, anchor.node.end));
  const occurrenceCount = (haystack, needle) => needle ? haystack.split(needle).length - 1 : 0;
  const protectedCounts = protectedFragments.map(
    (item) => [item, occurrenceCount(fragment, item)],
  );
  let output = fragment;
  let removedLinks = 0;
  const removals = [];
  for (const block of chosen.blocks) {
    removedLinks += block.contextLinks.length;
    if (block.action === "remove_context_anchors") {
      let mixed = fragment.slice(block.node.start, block.node.end);
      for (const anchor of [...block.allLinks].sort((a, b) => b.node.start - a.node.start)) {
        const start = anchor.node.start - block.node.start;
        const end = anchor.node.end - block.node.start;
        mixed = mixed.slice(0, start) + mixed.slice(end);
      }
      const visible = mixed
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/(?:&nbsp;|&#160;)/gi, " ")
        .trim();
      if (visible) {
        throw new Error(
          "TAIL mixed back navigation has non-anchor visible text; refusing anchor-only removal",
        );
      }
      removals.push(...block.contextLinks.map((anchor) => ({
        start: anchor.node.start,
        end: anchor.node.end,
      })));
    } else {
      removals.push({ start: block.node.start, end: block.node.end });
    }
  }
  for (const removal of removals.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, removal.start) + D1_CONTEXT_SLOT + output.slice(removal.end);
  }
  for (const [fixedHtml, count] of protectedCounts) {
    if (occurrenceCount(output, fixedHtml) !== count) {
      throw new Error("TAIL contextual sanitizer changed protected fixed navigation");
    }
  }
  const footerAfter = footerSubtrees(output);
  if (JSON.stringify(footerAfter) !== JSON.stringify(footerBefore)) {
    throw new Error("TAIL contextual sanitizer changed fixed footer HTML");
  }
  const rescanned = chooseContextBlocks(output);
  const remaining = rescanned.anchors.filter((anchor) => anchor.classified && !anchor.inFooter);
  // 两条以上具体链接仍留在 TAIL 就是本事故原判据，必须 fail closed；一条
  // 没有组件语义的孤立链接只告警，避免把合法的固定“精选文章”CTA 误杀。
  if (remaining.length >= 2) {
    throw new Error(
      `TAIL 仍有 ${remaining.length} 条参考文章上下文链接，无法安全识别完整组件：` +
      remaining.slice(0, 4).map((anchor) => anchor.href).join(", "),
    );
  }
  if (remaining.length === 1) {
    console.warn(`⚠ TAIL 留有 1 条无组件语义的具体内容链接：${remaining[0].href}`);
  }
  return {
    html: output,
    removedBlocks: chosen.blocks.length,
    removedLinks,
    remainingLinks: remaining.length,
  };
}

const tailContext = stripReferenceArticleContext(tail);
tail = tailContext.html;

// Older R254 site generators receive only this marker block during minimal
// remediation.  They do not all have the shared template's outer
// stripSelfReferenceUrls/replaceArticleDates helpers, so TAIL self references
// and Article JSON-LD dates must be closed here as part of the distributable
// sanitizer contract as well.  Running the same operations again in a newer
// full generator is intentionally idempotent.
function sanitizeRuntimeTailSelfReferences(fragment) {
  let output = fragment;

  // Raw canonical instances preserve the reference page's trailing-slash
  // convention.  The encoded variant deliberately mirrors the Worker fill
  // contract: encodeURIComponent(`${canonicalBase}/`).  This also covers a
  // percent-encoded Unicode pathname, whose '%' bytes become '%25' inside a
  // share URL (oshc-org-cn); it is one encodeURIComponent pass over the exact
  // canonical literal, not a site-specific double-encoding special case.
  output = output.split(CANONICAL_BASE + "/").join("{{CANONICAL}}/");
  output = output.split(CANONICAL_BASE).join("{{CANONICAL}}");
  output = output
    .split(encodeURIComponent(CANONICAL_BASE + "/"))
    .join("{{CANONICAL_ENC}}");

  // A reference slug can also occur in a non-URL article-owned attribute
  // (liuxuestreet-com uses data-scene="article_{slug}_city_form"), or one
  // percent-encoding layer deeper inside a CTA query.  Treat the exact raw,
  // encoded and safely-decoded slug forms as evidence.  No word-boundary
  // assertion is used: suffixes such as "_city_form", "-2026" and ".png"
  // are precisely the reference-derived variants this pass must consume.
  const slugVariants = new Set([REF_SLUG, encodeURIComponent(REF_SLUG)]);
  try { slugVariants.add(decodeURIComponent(REF_SLUG)); } catch { /* keep exact forms */ }

  // Article-owned JSON-LD images are handled structurally below.  HTML media
  // still needs exact reference-slug evidence: replacing only its substring
  // would manufacture a nonexistent dynamic image URL.
  const hasReferenceSlug = (value) => [...slugVariants].some(
    (variant) => variant && value.includes(variant),
  );
  const replaceReferenceImage = (all, prefix, value, suffix) => {
    if (!hasReferenceSlug(value)) return all;
    if (!DEFAULT_OG) throw new Error(`TAIL image contains reference slug but DEFAULT_OG is empty: ${value}`);
    return `${prefix}${DEFAULT_OG}${suffix}`;
  };
  output = output.replace(
    /(<(?:img|source)\b[^>]*\b(?:src|srcset)=["'])([^"']*)(["'])/gi,
    replaceReferenceImage,
  );

  for (const variant of [...slugVariants].filter(Boolean).sort((left, right) => right.length - left.length)) {
    const escapedSlug = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quotedSlug = new RegExp(
      `(["'])([^"']*?)${escapedSlug}([^"']*)\\1`,
      "g",
    );
    output = output.replace(
      quotedSlug,
      (_all, quote, prefix, suffix) => `${quote}${prefix}{{SLUG}}${suffix || ""}${quote}`,
    );
  }

  // Fail closed after a small, deterministic decoding closure.  A literal
  // grep cannot see a canonical nested in a share URL, and decodeURIComponent
  // over the whole HTML is unsafe because unrelated '%' bytes can be invalid.
  // Decode only well-formed percent runs plus numeric/&amp; HTML references, up
  // to three layers, then look for the exact canonical/slug evidence.
  const decodeHtmlReferences = (value) => value
    .replace(/&#x([0-9a-f]+);/gi, (_all, digits) => String.fromCodePoint(parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_all, digits) => String.fromCodePoint(parseInt(digits, 10)))
    .replace(/&amp;/gi, "&");
  const decodePercentRuns = (value) => value.replace(
    /(?:%[0-9a-f]{2})+/gi,
    (run) => { try { return decodeURIComponent(run); } catch { return run; } },
  );
  let decoded = output;
  for (let round = 0; round < 4; round += 1) {
    if (decoded.includes(CANONICAL_BASE) || decoded.includes(REF_SLUG)) {
      throw new Error(
        `TAIL self-reference sanitizer left encoded reference context after ${round} decode round(s)`,
      );
    }
    const next = decodePercentRuns(decodeHtmlReferences(decoded));
    if (next === decoded) break;
    decoded = next;
  }
  return output;
}

function sanitizeRuntimeArticleJsonLd(fragment, { canonicalizeImages = false, lane = "fragment" } = {}) {
  const schemaTypes = (value) => (Array.isArray(value?.["@type"]) ?
    value["@type"] : [value?.["@type"]]).filter(Boolean)
    .map((type) => String(type).split("/").pop().toLowerCase());
  const protectedSignatures = (source) => {
    const signatures = [];
    const visit = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      const types = schemaTypes(value);
      if (!types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type)) &&
          types.some((type) => CROSS_LEAF_PROTECTED_SCHEMA_TYPES.has(type))) {
        signatures.push(JSON.stringify(crossLeafCanonicalJson(value)));
        return;
      }
      for (const item of Object.values(value)) visit(item);
    };
    for (const script of crossLeafJsonScripts(source)) if (!script.error) visit(script.value);
    return signatures.sort();
  };
  const containsProtectedIdentity = (value) => {
    if (Array.isArray(value)) return value.some(containsProtectedIdentity);
    if (!value || typeof value !== "object") return false;
    const types = schemaTypes(value);
    if (!types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type)) &&
        types.some((type) => CROSS_LEAF_PROTECTED_SCHEMA_TYPES.has(type))) return true;
    return Object.values(value).some(containsProtectedIdentity);
  };
  const articleAuthorSignatures = (source) => {
    const signatures = [];
    const visit = (value) => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (!value || typeof value !== "object") return;
      const types = schemaTypes(value);
      const article = types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type));
      const protectedEntity = !article &&
        types.some((type) => CROSS_LEAF_PROTECTED_SCHEMA_TYPES.has(type));
      if (protectedEntity) return;
      if (article && Object.prototype.hasOwnProperty.call(value, "author")) {
        signatures.push(JSON.stringify(crossLeafCanonicalJson(value.author)));
      }
      for (const [key, item] of Object.entries(value)) {
        if (!["@context", "@type", "author"].includes(key)) visit(item);
      }
    };
    for (const script of crossLeafJsonScripts(source)) if (!script.error) visit(script.value);
    return signatures.sort();
  };
  const protectedBefore = protectedSignatures(fragment);
  const authorsBefore = articleAuthorSignatures(fragment);
  const replacements = [];
  let articleCount = 0;
  let headlineCount = 0;
  let descriptionCount = 0;
  let dateCount = 0;
  let imageCount = 0;
  let imageRemovedCount = 0;

  const walkGraph = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walkGraph(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = schemaTypes(value);
    const article = types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type));
    const protectedEntity = !article &&
      types.some((type) => CROSS_LEAF_PROTECTED_SCHEMA_TYPES.has(type));
    if (protectedEntity) return;
    if (article) {
      articleCount += 1;
      if (Object.prototype.hasOwnProperty.call(value, "headline")) {
        value.headline = "{{TITLE}}";
        headlineCount += 1;
      }
      if (Object.prototype.hasOwnProperty.call(value, "description")) {
        value.description = "{{DESC}}";
        descriptionCount += 1;
      }
      for (const field of ["datePublished", "dateModified"]) {
        if (!(field in value)) continue;
        value[field] = "{{DATE_ISO_FULL}}";
        dateCount += 1;
      }
      for (const field of canonicalizeImages ? ["image", "thumbnailUrl"] : []) {
        if (!(field in value)) continue;
        if (containsProtectedIdentity(value[field])) {
          throw new Error(`${lane} Article ${field} contains a protected site identity subtree`);
        }
        if (!DEFAULT_OG) {
          // No D1 image field and no site fallback means omission is the only
          // truthful runtime representation.  Delete the whole compound field;
          // never leave an empty ImageObject shell or borrow the reference art.
          delete value[field];
          imageRemovedCount += 1;
          continue;
        }
        // The D1 row has no per-article image field.  Preserve neither the old
        // reference value nor its ImageObject/array shell: the explicit site
        // fallback is the only current-page-safe value available at runtime.
        value[field] = DEFAULT_OG;
        imageCount += 1;
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (["@context", "@type", "headline", "description", "author", "datePublished", "dateModified", "image", "thumbnailUrl"].includes(key)) continue;
      walkGraph(item);
    }
  };

  for (const script of crossLeafJsonScripts(fragment)) {
    if (script.error) throw new Error(`TAIL JSON-LD parse failed: ${script.error}`);
    const value = structuredClone(script.value);
    const before = JSON.stringify(value);
    walkGraph(value);
    if (JSON.stringify(value) !== before) {
      replacements.push({ start: script.bodyStart, end: script.bodyEnd, value: crossLeafSafeJson(value) });
    }
  }
  const output = applyHeadReplacements(fragment, replacements);
  const parsedAfter = crossLeafJsonScripts(output);
  if (parsedAfter.some((script) => script.error)) {
    throw new Error(`${lane} Article sanitizer produced invalid JSON-LD`);
  }
  if (JSON.stringify(protectedSignatures(output)) !== JSON.stringify(protectedBefore)) {
    throw new Error(`${lane} Article sanitizer changed protected WebSite/Organization JSON-LD`);
  }
  if (JSON.stringify(articleAuthorSignatures(output)) !== JSON.stringify(authorsBefore)) {
    throw new Error(`${lane} Article sanitizer changed Article author semantics`);
  }
  const issues = [];
  const inspectGraph = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) inspectGraph(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = schemaTypes(value);
    const article = types.some((type) => CROSS_LEAF_ARTICLE_SCHEMA_TYPES.has(type));
    const protectedEntity = !article &&
      types.some((type) => CROSS_LEAF_PROTECTED_SCHEMA_TYPES.has(type));
    if (protectedEntity) return;
    if (article) {
      if ("headline" in value && value.headline !== "{{TITLE}}") issues.push(`${types.join("+")}.headline`);
      if ("description" in value && value.description !== "{{DESC}}") issues.push(`${types.join("+")}.description`);
      for (const field of ["datePublished", "dateModified"]) {
        if (field in value && value[field] !== "{{DATE_ISO_FULL}}") issues.push(`${types.join("+")}.${field}`);
      }
      for (const field of canonicalizeImages ? ["image", "thumbnailUrl"] : []) {
        if (field in value && value[field] !== DEFAULT_OG) issues.push(`${types.join("+")}.${field}`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (["@context", "@type", "headline", "description", "author", "datePublished", "dateModified", "image", "thumbnailUrl"].includes(key)) continue;
      inspectGraph(item);
    }
  };
  for (const script of parsedAfter) inspectGraph(script.value);
  if (issues.length) throw new Error(`${lane} Article sanitizer left unsafe fields: ${issues.join(", ")}`);
  if (process.env.D1_CONTEXT_EXACT_DEBUG === "1") {
    console.error(JSON.stringify({
      event: "d1_article_jsonld_result", lane, articleCount, headlineCount,
      descriptionCount, dateCount, imageCount, imageRemovedCount,
      protectedCount: protectedBefore.length, authorCount: authorsBefore.length, issues,
    }));
  }
  return output;
}

tail = sanitizeRuntimeArticleJsonLd(tail, { canonicalizeImages: true, lane: "tail" });
tail = sanitizeRuntimeTailSelfReferences(tail);
// D1_CONTEXT_SANITIZER_END

// 必须在 contextual widget 识别之后再做自我引用占位符化。unireview-org 的
// Related 区块恰含参考文章自己的多语言镜像；若先删除/改写那条 <a>，原本
// 2+ 条的组件会被降成 1 条而逃过结构判定。
tail = stripSelfReferenceUrls(tail);

// 2026-08-21 事故防复发（taxplan-hk 实测）：部分站点 <h1> 与 meta
// description 文案逐字相同（SEO 组件用标题直接生成描述）。原来两轮独立
// split/join 处理 TITLE/DESC 会互相踩踏——第一轮把 HEAD 里所有该字符串
// 出现处都吃成 {{TITLE}}，第二轮找不到剩余的 REF_DESC 可替换，{{DESC}}
// 占位符永远生成不出来，第 4 节 fail closed 报"参考页可能已改版"，具有
// 误导性——真因是替换顺序 bug，跟参考页有没有改版无关。改成按标签上下文
// 逐个锚定替换，文案相同与否都不受影响；两串不同时行为与原实现等价。
// 全局匹配（g 标志）：taxplan-hk 实测同一页面存在两个 <h1>（header 区一个
// 展示用，正文容器开头折叠进 HEAD 的又一个，文案逐字相同）——非全局正则
// 只replace命中的第一个，第二个残留原文本，slug 就藏在它的自动生成 id
// 属性里（下面单独处理 id）。这里先保证 TITLE/DESC 在多处重复出现时
// 全部被替换，不只是"至少一处"。
function replaceTagContent(h, re, placeholder, refText) {
  return h.replace(re, (all, pre, val, post) =>
    (val.includes(refText) ? pre + val.replace(refText, () => placeholder) + post : all));
}
// <h1>（extractTitle 的权威来源，容器折叠进 HEAD 时这里几乎总能命中；
// 部分家族同一页面有不止一个 <h1> 复述标题，g 标志确保全部替换）
head = replaceTagContent(head, /(<h1[^>]*>)([\s\S]*?)(<\/h1>)/gi, "{{TITLE}}", REF_TITLE);
// <title> 标签（常带站点名后缀，如"标题 | 站点名"，只换匹配到的那一段）
head = replaceTagContent(head, /(<title[^>]*>)([\s\S]*?)(<\/title>)/gi, "{{TITLE}}", REF_TITLE);
// meta name=description（两种属性顺序都认，跟 extractDesc 的探测逻辑对齐）
head = replaceTagContent(
  head, /(<meta[^>]*name=["']description["'][^>]*content=["'])([^"']*)(["'])/gi, "{{DESC}}", REF_DESC,
);
head = replaceTagContent(
  head, /(<meta[^>]*content=["'])([^"']*)(["'][^>]*name=["']description["'])/gi, "{{DESC}}", REF_DESC,
);
// <h1 id="...从标题自动生成的 kebab-case 锚点...">（taxplan-hk 实测）：这个
// id 是标题的 slugify 版本，不是 REF_TITLE 字面量也不是 canonical URL，
// 上面几条都碰不到它，但确实是"参考文章专属"的残留（id 由标题内容派生，
// 每篇动态文章的标题不同，id 也该跟着变，模板生成阶段没有运行时可用的
// slugify 机制去正确重建它）。只在 id 值确实包含 REF_SLUG 时才摘掉这个
// 属性（避免误伤跟 slug 无关的固定 id，比如 id="main-title" 这类），
// 摘掉不影响可见内容，只是少了一个可能没人引用的锚点；如果这个 id 真被
// 页内锚点/TOC 引用，会在冒烟测试的锚点跳转检查里暴露，不是本次范围内
// 能穷举验证的点。
head = head.replace(/<h1\b[^>]*>/gi, (tag) => {
  const idMatch = /\sid=["']([^"']*)["']/i.exec(tag);
  return idMatch && idMatch[1].includes(REF_SLUG) ? tag.replace(idMatch[0], "") : tag;
});
// og:title/twitter:title、og:description/twitter:description
// （property=/name= 混用都认，跟上面 estate-sydney 那条 og:image 修复同款宽松匹配）
head = head.replace(
  /(<meta[^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*content=["'])([^"']*)(["'])/gi,
  (all, pre, val, post) => (val.includes(REF_TITLE) ? pre + val.replace(REF_TITLE, () => "{{TITLE}}") + post : all),
);
head = head.replace(
  /(<meta[^>]*(?:property|name)=["'](?:og:description|twitter:description)["'][^>]*content=["'])([^"']*)(["'])/gi,
  (all, pre, val, post) => (val.includes(REF_DESC) ? pre + val.split(REF_DESC).join("{{DESC}}") + post : all),
);
// JSON-LD headline/description 字段。结构化数据可能放在正文容器闭合之后
// （oshcquote-com 实测），因此 HEAD/TAIL 都处理；只锚定字段值，不能对 TAIL
// 盲目全局替换，否则“相关文章”里恰好出现参考文章标题时会被错误改成当前文章。
function replaceStructuredArticleText(str) {
  return str
    .replace(/("headline"\s*:\s*")([^"]*)(")/g,
      (all, pre, val, post) => (val.includes(REF_TITLE) ? pre + val.replace(REF_TITLE, () => "{{TITLE}}") + post : all))
    .replace(/("description"\s*:\s*")([^"]*)(")/g,
      (all, pre, val, post) => (val.includes(REF_DESC) ? pre + val.split(REF_DESC).join("{{DESC}}") + post : all));
}
head = replaceStructuredArticleText(head);
tail = replaceStructuredArticleText(tail);
// 可见导语与 meta description 同文（offerai-au / ovhcquote-com 等 2026-09-26 实测）：
// 只替换 meta 会让每篇 D1 文章都显示参考文章的导语。正文插入点之前（HEAD 的
// <body> 部分）整段文字等于 REF_DESC 的叶元素，内容换成 {{DESC}}。
function replaceVisibleDesc(str) {
  const refDesc = titleBlockText(REF_DESC);
  if (refDesc.length < 12) return str;
  const bodyAt = str.search(/<body\b/i);
  if (bodyAt < 0) return str;
  const body = str.slice(bodyAt).replace(
    /(<(p|div|span|small|em|blockquote|h2|h3|h4)\b[^>]*>)([^<]*)(<\/\2\s*>)/gi,
    (all, open, _tag, inner, close) => (titleBlockText(inner) === refDesc ? `${open}{{DESC}}${close}` : all),
  );
  return str.slice(0, bodyAt) + body;
}
head = replaceVisibleDesc(head);
// Unscoped literal replacements would mutate site names and fixed copy.
// Article identity is replaced only in the explicit fields above.

// og:image / twitter:image 指向按 slug 生成的配图时，运行时文章没有对应
// 产物，换成站点默认图；没有默认图则 fail closed（绝不让所有动态文章
// 顶着参考文章的配图上线）。
//
// 2026-08-21 事故防复发（estate-sydney 实测，两处）：①原正则假定 og:image
// 用 property=、twitter:image 用 name=，但 estate-sydney 的 SEO 组件两个都用
// property=（<meta property="twitter:image" ...>，非标准但真实存在），只认
// 固定搭配会让 twitter:image 那条漏网；②同一张配图 URL 经常在 JSON-LD
// "image" 字段里独立复制一份，正则只改 <meta> 标签本身抓不到它。改成先从
// og:image 拿到"按 slug 生成的配图"这个精确 URL 值，再把它作为字面量整体
// 在 HEAD/TAIL 里全局替换——不管它出现在 meta 标签、JSON-LD 还是别的地方。
// oshc-net-au / unimelb-help 实测 Article JSON-LD 位于 </article> 之后；只改
// HEAD 会让 TAIL 继续携带参考文章按 slug 生成的图片并被末尾残留闸拦下。
{
  const imgMatch = /<meta[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']*)["']/i.exec(head);
  const slugImageUrl = imgMatch && (imgMatch[1].includes(REF_SLUG) || imgMatch[1].includes("{{SLUG}}")) ? imgMatch[1] : null;
  if (slugImageUrl) {
    if (!DEFAULT_OG) throw new Error(`og:image 按 slug 生成（${slugImageUrl}）但站点没有默认 og 图`);
    head = head.split(slugImageUrl).join(DEFAULT_OG);
    tail = tail.split(slugImageUrl).join(DEFAULT_OG);
    // 2026-08-22 事故防复发（airfare-cn 实测）：同一张配图的 URL 经常在
    // <meta> 里是百分号编码（浏览器/构建器对 URL 属性统一编码），但在
    // JSON-LD "image" 字段里是构建器原样吐出的未编码路径（含中文分类段），
    // 两处字面量不同，上面这一次 split/join 只灭得掉编码那份。两个方向都
    // 补一遍：编码值再解码一次、原值再编码一次，谁是原值谁是衍生值不重要，
    // 两条都跑，跑不动（URIError：非法转义序列）就跳过那一条，不拖累主流程。
    for (const variant of [decodeSafely(slugImageUrl), encodeSafely(slugImageUrl)]) {
      if (variant && variant !== slugImageUrl) {
        head = head.split(variant).join(DEFAULT_OG);
        tail = tail.split(variant).join(DEFAULT_OG);
      }
    }
  }
}

// 2026-08-22 事故防复发（accommodation-hk 实测）：上面 og:image 处理只认
// <meta property="og:image">。不少站在 og:image 之外，容器前面还有一块
// 模板级"文章头图"（hero image，<img class="article-hero-image"> 这类），
// 所有文章都有这块区域，但 <img src> 走的是按 slug 生成的相对路径图
// （跟 og:image 的绝对 URL 经常是两张不同的图/不同写法），og:image 那条
// 灭不掉它——HEAD 里仍残留 REF_SLUG，直接 fail closed。这里补一条同款
// fail-closed 处理：扫 head 里所有 <img src> 值，凡是包含 REF_SLUG 的，
// 一律换成站点默认图；没有默认图依旧 fail closed，不让所有动态文章顶着
// 参考文章的头图上线。循环收集去重是因为同一张 slug 图可能在 head 里
// 出现不止一次。
{
  const imgSrcRe = /<img\b[^>]*\bsrc=["']([^"']*)["']/gi;
  const slugImgSrcs = new Set();
  let imgMatch2;
  while ((imgMatch2 = imgSrcRe.exec(head)) !== null) {
    if (imgMatch2[1].includes(REF_SLUG)) slugImgSrcs.add(imgMatch2[1]);
  }
  for (const src of slugImgSrcs) {
    if (!DEFAULT_OG) throw new Error(`<img src> 按 slug 生成（${src}）但站点没有默认 og 图`);
    head = head.split(src).join(DEFAULT_OG);
  }
}

// 日期：JSON-LD → meta → 可见文本，全部换成占位符。文章 JSON-LD 不一定
// 在正文容器之前：oshcquote-com 实测把它放在 </article> 之后（TAIL）。若只
// 处理 HEAD，切模会 fail closed；更危险的是放松验收后所有动态文章会继承
// 参考页日期。HEAD/TAIL 共用同一函数，Worker 已对两段都执行占位符填充。
function replaceArticleDates(str) {
  let out = sanitizeRuntimeArticleJsonLd(str, { canonicalizeImages: false, lane: "head" });
  // Only article-specific metadata is authorized here.  A literal date match
  // elsewhere may belong to a fixed announcement or protected site identity.
  out = out.replace(/<meta\b[^>]*>/gi, (tag) => {
    const key = /\b(?:name|property)\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2]?.toLowerCase() || "";
    if (!["article:published_time", "article:modified_time"].includes(key)) return tag;
    return tag.replace(/(\bcontent\s*=\s*["'])[^"']*(["'])/i, "$1{{DATE_ISO_FULL}}$2");
  });
  return out;
}
head = replaceArticleDates(head);
// TAIL JSON-LD was already handled structurally inside the distributable
// sanitizer marker.  A global string replacement here would also rewrite a
// WebSite/Organization date, or a fixed footer date that merely equals the
// reference article date.

// Astro 文章布局有时会把可见 <time> 与 JSON-LD 日期分开生成，且两者甚至
// 不是同一天（remittance-hk 实测 JSON-LD 来自文章 frontmatter，但布局里的
// <time> 仍残留样板日期 2026-07-30）。不能只按 REF_DATE_ISO 做字面替换；
// 锚定 article 模板中的 <time datetime>，同时替换机器值和可见文本。HEAD /
// TAIL 都处理，与 Worker 对两段统一 fillPlaceholders 的合同一致。
function replaceVisibleTimes(str) {
  return str.replace(
    /(<time\b[^>]*\bdatetime=["'])[^"']+(["'][^>]*>)[\s\S]*?(<\/time>)/gi,
    "$1{{DATE_ISO_FULL}}$2 {{DATE}} $3",
  // 没有 datetime 属性的 <time>（assets-sg 实测直接吐 JS Date 字符串）：文字同样是
  // 参考文章自己的日期，换成 {{DATE}}。
  ).replace(
    /(<time\b(?![^>]*\bdatetime=)[^>]*>)(?:(?!<\/time>)[^<])*[0-9][^<]*(<\/time>)/gi,
    "$1{{DATE}}$2",
  );
}
head = replaceVisibleTimes(head);

// course/stays 家族的日期+分类行：整行换成 {{DATE}}{{CATEGORY_SUFFIX}}
head = head.replace(
  /(<div class="text-sm mb-3"[^>]*>)[\s\S]*?(<\/div>)/,
  "$1{{DATE}}{{CATEGORY_SUFFIX}}$2",
);

// ── 3.5 逐篇 og:image（R254，2026-09-18） ──────────────────────────
// 上面所有处理都是把"参考文章自己的图"换成站级默认图——结果是一个站所有
// 动态文章分享出去都是同一张，文章 md 里的 ogImage frontmatter 根本进不了
// 页面。这里再走一步：把 og:image / twitter:image 的 content 切成
// {{OG_IMAGE}} 占位，并把切之前的那个值作为站级默认图导出。运行时
// worker/index.ts 填本篇 articles.og_image，没有就填这个默认值——所以
// "没配图的文章"与改造前逐字一样，不会产出空 og:image。
//
// 只碰 <meta> 的 og/twitter 图片字段：JSON-LD image、页内头图、logo 一概不动
// （那几处上面已按参考页语义归一化过，动它们会连带撕掉既有的 fail-closed 闸）。
const OG_IMAGE_META_KEYS = new Set([
  "og:image", "og:image:url", "og:image:secure_url",
  "twitter:image", "twitter:image:src",
]);
let TEMPLATE_DEFAULT_OG = "";
function placeholderizeOgImageMeta(str) {
  return str.replace(/<meta\b[^>]*>/gi, (tag) => {
    const key = (/\b(?:name|property)\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2] || "").toLowerCase();
    if (!OG_IMAGE_META_KEYS.has(key)) return tag;
    const value = (/\bcontent\s*=\s*(["'])([^"']*)\1/i.exec(tag)?.[2] || "").trim();
    if (!value) return tag; // 空 content：保持原样，别把空串当默认图
    if (!TEMPLATE_DEFAULT_OG && value !== "{{OG_IMAGE}}") TEMPLATE_DEFAULT_OG = value;
    if (!/\bcontent\s*=\s*["']/i.test(tag)) return tag;
    return tag.replace(
      /(\bcontent\s*=\s*["'])[^"']*(["'])/i,
      (_all, prefix, suffix) => `${prefix}{{OG_IMAGE}}${suffix}`,
    );
  });
}
head = placeholderizeOgImageMeta(head);
if (!TEMPLATE_DEFAULT_OG) TEMPLATE_DEFAULT_OG = DEFAULT_OG;
if (head.includes("{{OG_IMAGE}}") && !TEMPLATE_DEFAULT_OG) {
  throw new Error("og:image 已占位符化但站点没有默认 og 图，没配图的文章会产出空 og:image");
}

// ── 3.6 去掉参考页自己的 robots noindex/nofollow（2026-09-22） ──────
// 参考页（常见 /articles/__d1_reference/）本身必须 noindex，但它的 <meta
// name="robots"> 会被原样切进 HEAD，于是每篇 D1 动态文章都带 noindex
// （实测 40 个仓中招，fangdai.help 19/36、waihui.help 10/10）。这里整条删掉
// robots/googlebot/bingbot 等爬虫 meta 里含 noindex/nofollow 的标签；参考页
// 自身在静态产物里不受影响，仍然 noindex。
const ROBOTS_META_NAMES = new Set(["robots", "googlebot", "googlebot-news", "bingbot", "baiduspider"]);
function stripRobotsNoindexMeta(str) {
  return str.replace(/<meta\b[^>]*>/gi, (tag) => {
    const name = (/\bname\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2] || "").trim().toLowerCase();
    if (!ROBOTS_META_NAMES.has(name)) return tag;
    const content = /\bcontent\s*=\s*(["'])([^"']*)\1/i.exec(tag)?.[2] || "";
    return /\b(?:noindex|nofollow|none)\b/i.test(content) ? "" : tag;
  });
}
head = stripRobotsNoindexMeta(head);
tail = stripRobotsNoindexMeta(tail);

// ── 4. 验收（fail closed） ─────────────────────────────────────────
for (const token of ["{{CANONICAL}}", "{{TITLE}}", "{{DESC}}"]) {
  if (!head.includes(token)) throw new Error(`占位符 ${token} 缺失——参考页可能已改版`);
}
if (head.includes(REF_SLUG)) {
  throw new Error(`HEAD 里仍残留参考文章 slug（${REF_SLUG}），模板会把所有动态文章指向它`);
}
if (replaceArticleDates(head) !== head) {
  throw new Error("HEAD 里仍残留未占位符化的 Article 日期字段");
}
if (!/\{\{DATE(_ISO(_FULL)?)?\}\}/.test(head)) {
  console.warn("⚠ 模板里没有任何日期占位符（参考页本身不展示日期），动态文章将不显示日期");
}

// 2026-08-22 事故防复发（ovhc-cn 实测）：TAIL 现在也跑过
// stripSelfReferenceUrls（见上），同样必须 fail closed 验收，不能只信任
// "跑过就一定干净"。TAIL 不像 head 那样一定含 canonical/title/desc（很多
// 站的 TAIL 只是页脚，什么占位符都没有也合法），所以不做 token 存在性
// 检查，只检查残留——REF_SLUG 是判定"这是参考文章自己的痕迹"的充要条件
// （见 stripSelfReferenceUrls 内注释），tail 里如果还有就必须 fail closed，
// 不能像本次改造前那样悄悄放行。
if (tail.includes(REF_SLUG)) {
  throw new Error(`TAIL 里仍残留参考文章 slug（${REF_SLUG}），模板会把所有动态文章的分享/相关链接指向它`);
}
if (tail.includes(CANONICAL_BASE)) {
  throw new Error(`TAIL 里仍残留参考文章 canonical URL（${CANONICAL_BASE}）`);
}
if (sanitizeRuntimeArticleJsonLd(tail, { canonicalizeImages: true, lane: "tail-validation" }) !== tail) {
  throw new Error("TAIL 里仍残留未归一化的 Article 日期或图片字段");
}

// 2026-09-26 WS-I：HEAD 可见文字里只属于参考文章的标题/导语换成占位符。
// 面包屑当前页、分享文案、副标题常直接写着参考文章标题或导语（liuxuecentre、
// warwickuni-help、xgboost-org、studyau-au 实测）；不换掉，每篇 D1 文章都会显示
// 参考文章的标题/导语。只动 <body> 之后的纯文本段，不碰 script/style/属性。
function placeholderizeHeadArticleText(str) {
  const bodyAt = str.search(/<body\b/i);
  if (bodyAt < 0) return str;
  const refTitle = titleBlockText(REF_TITLE);
  const refDesc = titleBlockText(REF_DESC);
  const body = str.slice(bodyAt).replace(
    /(<(script|style)\b[^>]*>[\s\S]*?<\/\2\s*>)|>([^<]+)</gi,
    (all, raw, _tag, text) => {
      if (raw) return all;
      const plain = titleBlockText(text);
      if (!plain || /^\{\{[A-Z_]+\}\}$/.test(plain)) return all;
      const lead = text.match(/^\s*/)[0];
      const trail = text.match(/\s*$/)[0];
      if (refTitle.length >= 6) {
        if (plain === refTitle) return `>${lead}{{TITLE}}${trail}<`;
        const cut = plain.replace(/(?:…|\.\.\.)$/, "").trim();
        if (cut !== plain && cut.length >= 8 && refTitle.startsWith(cut)) return `>${lead}{{TITLE}}${trail}<`;
        if (plain.includes(refTitle)) {
          for (const form of [REF_TITLE, refTitle, refTitle.replace(/&/g, "&amp;")]) {
            if (text.includes(form)) return `>${text.split(form).join("{{TITLE}}")}<`;
          }
        }
      }
      if (refDesc.length >= 12) {
        const head20 = refDesc.slice(0, Math.min(20, refDesc.length));
        if (plain === refDesc || plain.includes(refDesc) || (plain.length >= 20 && plain.startsWith(head20))) {
          return `>${lead}{{DESC}}${trail}<`;
        }
      }
      return all;
    },
  );
  return str.slice(0, bodyAt) + body;
}
head = placeholderizeHeadArticleText(head);
// 标题块里的「来源：…」行是参考文章自己的出处（usyd-org-cn 实测），D1 文章没有对应字段：
// 只删最后一个 <h1> 之后、内容以「来源/來源/资料来源/Sources」开头的叶元素。
{
  const lastH1 = [...head.matchAll(/<h1\b/gi)].pop();
  if (lastH1) {
    const at = lastH1.index;
    head = head.slice(0, at) + head.slice(at).replace(
      /<(span|p|div|small|li)\b[^>]*>\s*(?:资料来源|資料來源|来源|來源|参考来源|參考來源|Sources?)\s*[:：][^<]*<\/\1\s*>/gi, "");
  }
}
// 标题 h1 文案与 <title> 对不上（<title> 截断、工具页 tagline：apexam-help、
// oceanian-org、electricianinsurance-au 实测）时上面的替换都碰不到它：HEAD 里
// 最后一个（最靠近正文的）<h1> 就是文章标题位，内容换成 {{TITLE}}。
if (!/<h1\b[^>]*>(?:\s|<(?!\/h1)[^>]*>)*\{\{TITLE\}\}/i.test(head)) {
  const bodyAt = Math.max(0, head.search(/<body\b/i));
  const re = /(<h1\b[^>]*>)([\s\S]*?)(<\/h1\s*>)/gi;
  re.lastIndex = bodyAt;
  let last = null;
  let m;
  while ((m = re.exec(head)) !== null) last = { index: m.index, all: m[0], open: m[1], close: m[3] };
  if (last) {
    head = head.slice(0, last.index) + `${last.open}{{TITLE}}${last.close}` + head.slice(last.index + last.all.length);
  }
}

// 2026-09-26 WS-I：D1 正文不含 <h1>（bridge 会剥掉），标题只能由模板给。
// 模板里必须有一个内容就是 {{TITLE}} 的 <h1>，否则所有 D1 文章页都没有标题。
if (!/<h1\b[^>]*>(?:\s|<(?!\/h1)[^>]*>)*\{\{TITLE\}\}/i.test(head + tail)) {
  throw new Error("模板里没有 {{TITLE}} 的 <h1>：D1 文章页会没有标题（正文 h1 会被 bridge 剥掉）");
}
// 参考文章自己的标题/导语不得留在可见外壳里（固定导航还原之前查，不误伤
// 恰好链到参考文章的全局导航）。
{
  const bodyAt = head.search(/<body\b/i);
  const visibleShell = titleBlockText((bodyAt < 0 ? head : head.slice(bodyAt)) + " " + tail);
  const refTitleText = titleBlockText(REF_TITLE);
  const refDescText = titleBlockText(REF_DESC);
  if (refTitleText.length >= 6 && visibleShell.includes(refTitleText)) {
    throw new Error(`模板可见外壳里仍残留参考文章标题（${refTitleText}）`);
  }
  if (refDescText.length >= 12 && visibleShell.includes(refDescText)) {
    throw new Error("模板可见外壳里仍残留参考文章导语/描述");
  }
}

// Restore only proven global shell after article-specific residual validation.
for (const [token, original] of fixedShell) {
  const count = (head + tail).split(token).length - 1;
  if (count !== 1) throw new Error("fixed shell lost or duplicated during template extraction");
  head = head.replace(token, () => original);
  tail = tail.replace(token, () => original);
}

// robots 残留验收放在 fixed shell 还原之后，覆盖最终写出的内容。
// 正文链接的 rel="nofollow" 合法，只查 robots 类 meta；noindex 则任何位置都不允许。
if (/noindex/i.test(head + tail) || stripRobotsNoindexMeta(head + tail) !== head + tail) {
  throw new Error("模板里仍残留 robots noindex/nofollow，所有 D1 文章会被排除索引");
}

// 老版 worker/index.ts 兼容（2026-09-26 WS-I）：站内 worker 是转换当时的快照，
// 老版不认 {{OG_IMAGE}}、也不对 TAIL 填占位符。模板里出现它不认的占位符，
// 线上会把「{{OG_IMAGE}}」这类字面量直接吐给读者/爬虫。
{
  let workerSrc = "";
  for (const candidate of ["worker/index.ts", "worker/pages-worker.body.js"]) {
    // Pages 站的运行时是 worker/pages-worker.body.js（postbuild 拼进 dist/_worker.js）
    try { workerSrc = readFileSync(candidate, "utf8"); break; } catch { /* 共享 hub 成员等：没有站内 worker */ }
  }
  if (workerSrc) {
    if (head.includes("{{OG_IMAGE}}") && !workerSrc.includes("{{OG_IMAGE}}")) {
      if (!TEMPLATE_DEFAULT_OG) throw new Error("本站 worker 不认 {{OG_IMAGE}}，且没有默认 og 图可内联");
      head = head.split("{{OG_IMAGE}}").join(TEMPLATE_DEFAULT_OG); // 与改造前一样：所有 D1 文章用站级默认图
    }
    const tailFilled = /fillPlaceholders\(\s*(?:withoutStaticArticleSchema\()?\s*TAIL\b/.test(workerSrc) ||
      /\bTAIL\s*(?:\/\/[^\n]*\s*)*\.split\(\s*["']\{\{/.test(workerSrc); // Pages 版逐个 split/join
    if (!tailFilled && /\{\{[A-Z_]+\}\}/.test(tail)) {
      throw new Error("TAIL 里有占位符，但本站 worker/index.ts 是不填 TAIL 的旧版：先升级 worker 再切模板");
    }
    const literal = new Set([...workerSrc.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]));
    if (literal.has("TITLE")) {
      const missing = [...new Set([...(head + tail).matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))]
        .filter((name) => !literal.has(name));
      if (missing.length) throw new Error(`本站 worker/index.ts 不认这些占位符：${missing.join(", ")}`);
    }
  }
}

mkdirSync("worker", { recursive: true });
writeFileSync(
  OUT,
  `// 本文件由 scripts/gen-article-template.mjs 从 ${REF} 生成（容器定位：${cutVia}），请勿手改。
// 站点外壳改版后重跑该脚本，让动态文章页跟静态页保持一致。
export const HEAD = ${JSON.stringify(head)};

export const TAIL = ${JSON.stringify(tail)};

// 站级默认分享图：文章没有自己的 og_image 时 worker 填这个值。
export const DEFAULT_OG_IMAGE = ${JSON.stringify(TEMPLATE_DEFAULT_OG)};
`,
  "utf8",
);

console.log(
  `ok: ${OUT} (via=${cutVia}, head ${head.length}B, tail ${tail.length}B, ` +
  `context_blocks_removed=${tailContext.removedBlocks}, context_links_removed=${tailContext.removedLinks}, ` +
  `og_image=${head.includes("{{OG_IMAGE}}") ? "per-article" : "none"}, default_og=${TEMPLATE_DEFAULT_OG || "-"}, ` +
  `seg=/${SEG}/, ref=${REF_SLUG})`,
);
