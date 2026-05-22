#!/usr/bin/env python3
"""
article_gate.py — Accreditation.cn article quality gate (14 checks).
Run before saving an article to content/. Fails block publish.

Usage:
  python3 scripts/article_gate.py <article.md>
"""

import re
import sys
from pathlib import Path
from datetime import datetime

# ─── Config ───
MIN_WORD_COUNT = 2500          # G01: minimum zh-CN word count (stripped)
MIN_CJK_RATIO = 0.60           # G02: minimum CJK character ratio
MIN_H2 = 5                     # G10: minimum H2 headings
MIN_FAQ_Q = 3                  # G11: minimum FAQ questions
MIN_REFERENCES = 5              # G12: minimum references
MAX_RETRIES = 2

# §3.19: Title banned tokens (title only since 5/21)
BANNED_TITLE_TOKENS = [
    "排名", "榜单", "榜首", "上榜", "登榜", "排行榜",
    "测评", "评测", "中介推荐",
]

# §3.14A: Reddit ban (all positions)
BANNED_REDDIT_PATTERNS = re.compile(r"reddit|r/|r e d d i t", re.IGNORECASE)

# §3.14B: Mainland China image host blacklist
MAINLAND_IMAGE_HOSTS = [
    "bdimg.com", "bdstatic.com", "baidu.com", "hiphotos.baidu.com", "imgsa.baidu.com",
    "byteimg.com", "pstatp.com", "bytedance.com", "toutiao.com", "douyin.com", "bytecdn.cn",
    "gtimg.com", "qpic.cn", "qlogo.cn", "tencent-cloud.cn", "myqcloud.com",
    "alicdn.com", "aliyuncs.com", "taobaocdn.com", "tbcache.com", "tmall.com",
    "xhscdn.com", "xiaohongshu.com", "xhsimg.com",
    "sinaimg.cn", "sinajs.cn", "weibo.com", "sohucs.com", "126.net", "127.net",
    "sogoucdn.com", "sogou.com", "qhimg.com", "qhmsg.com", "360buyimg.com",
    "hdslb.com", "biliimg.com", "bilibili.com",
    "zhimg.com", "zhihu.com",
    "360buyimg.com", "jdcdn.com", "jd.com",
]

# §3.23: Study abroad banned tokens (for university/agent categories)
BANNED_STUDYABROAD_TOKENS = ["半工半读", "工读项目", "TAFE", "tafe"]

# CTA banned keywords
BANNED_CTA = [
    "立即咨询", "联系我们", "加微信", "私信", "扫码", "报名",
    "立即申请", "抢报名", "限时", "限量",
]

# UNILINK banned patterns
BANNED_UNILINK = re.compile(r"UNILINK|优领教育|Unilink Education|unilink", re.IGNORECASE)

# ─── Functions ───

def count_cjk(text: str) -> int:
    """Count CJK characters"""
    return sum(1 for c in text if '\u4e00' <= c <= '\u9fff' or '\u3400' <= c <= '\u4dbf')

def strip_frontmatter(text: str) -> tuple[str, str]:
    """Split frontmatter and body. Returns (frontmatter, body)"""
    if text.startswith('---'):
        parts = text.split('---', 2)
        if len(parts) >= 3:
            return parts[1], parts[2]
    return '', text

def extract_title(text: str) -> str:
    """Extract title from frontmatter or H1"""
    fm, body = strip_frontmatter(text)
    # from frontmatter
    m = re.search(r'^title:\s*["\']?(.+?)["\']?\s*$', fm, re.MULTILINE)
    if m:
        return m.group(1)
    # from H1
    m = re.search(r'^#\s+(.+)$', body, re.MULTILINE)
    if m:
        return m.group(1)
    return ''

def extract_h2s(body: str) -> list[str]:
    """Extract H2 headings"""
    return re.findall(r'^## (.+)$', body, re.MULTILINE)

def extract_faq_qs(body: str) -> list[str]:
    """Extract FAQ questions"""
    # Find FAQ section, then count questions
    faq_match = re.search(r'## FAQ\s*\n(.*?)(?=\n## |\Z)', body, re.DOTALL)
    if not faq_match:
        return []
    faq_section = faq_match.group(1)
    return re.findall(r'### Q\d?: ', faq_section)

def extract_references(body: str) -> list[str]:
    """Extract reference items"""
    for anchor in ['## 参考资料', '## 数据来源', '## References']:
        ref_match = re.search(rf'{anchor}\s*\n(.*?)(?=\n## |\Z)', body, re.DOTALL)
        if ref_match:
            return re.findall(r'^- (.+)$', ref_match.group(1), re.MULTILINE)
    return []

def extract_image_urls(body: str) -> list[str]:
    """Extract markdown image URLs"""
    return re.findall(r'!\[.*?\]\((https?://[^\)]+)\)', body)

def extract_year_marks(body: str) -> list[str]:
    """Extract year mentions like 2022, 2021 etc"""
    return re.findall(r'(19|20)(\d\d)\s*年', body)

def check_gate(article_path: str) -> dict:
    """Run all 14 gates against an article file. Returns {gate_name: (pass: bool, detail: str)}"""
    content = Path(article_path).read_text(encoding='utf-8')
    fm, body = strip_frontmatter(content)
    title = extract_title(content)
    results = {}
    
    # ── G01: Word count ──
    word_count = len(body.strip())
    results['G01_word_count'] = (
        word_count >= MIN_WORD_COUNT,
        f"{word_count}/{MIN_WORD_COUNT} chars"
    )
    
    # ── G02: CJK ratio ──
    cjk = count_cjk(body)
    total_chars = len(re.sub(r'\s', '', body))
    cjk_ratio = cjk / max(total_chars, 1)
    results['G02_cjk_ratio'] = (
        cjk_ratio >= MIN_CJK_RATIO,
        f"{cjk_ratio:.2%}/{MIN_CJK_RATIO:.0%}"
    )
    
    # ── G03: Banned title tokens ──
    title_normalized = re.sub(r'\s', '', title).lower()
    hit_tokens = [t for t in BANNED_TITLE_TOKENS if re.sub(r'\s', '', t).lower() in title_normalized]
    results['G03_title_banned'] = (
        len(hit_tokens) == 0,
        f"hit: {hit_tokens}" if hit_tokens else "clean"
    )
    
    # ── G04: Reddit ban ──
    reddit_hits = BANNED_REDDIT_PATTERNS.findall(content)
    results['G04_reddit'] = (
        len(reddit_hits) == 0,
        f"hit: {reddit_hits}" if reddit_hits else "clean"
    )
    
    # ── G05: Image host blacklist ──
    image_urls = extract_image_urls(body)
    bad_images = []
    for url in image_urls:
        for host in MAINLAND_IMAGE_HOSTS:
            if host in url.lower():
                bad_images.append(url)
                break
    results['G05_image_host'] = (
        len(bad_images) == 0,
        f"bad: {len(bad_images)}" if bad_images else "clean"
    )
    
    # ── G06: UNILINK not present ──
    unilink_hits = BANNED_UNILINK.findall(content)
    results['G06_unilink'] = (
        len(unilink_hits) == 0,
        f"hit: {unilink_hits}" if unilink_hits else "clean"
    )
    
    # ── G07: CTA banned ──
    cta_hits = [t for t in BANNED_CTA if t in content]
    results['G07_cta'] = (
        len(cta_hits) == 0,
        f"hit: {cta_hits}" if cta_hits else "clean"
    )
    
    # ── G08: Study abroad banned (only relevant for certain categories, check anyway) ──
    sa_hits = [t for t in BANNED_STUDYABROAD_TOKENS if t in content]
    results['G08_studyabroad_banned'] = (
        len(sa_hits) == 0,
        f"hit: {sa_hits}" if sa_hits else "clean"
    )
    
    # ── G09: Data recency ──
    year_marks = extract_year_marks(body)
    old_years = [f"{a}{b}" for a, b in year_marks if int(a + b) <= 2022]
    results['G09_data_recency'] = (
        len(old_years) == 0,
        f"old years: {old_years}" if old_years else "clean"
    )
    
    # ── G10: H2 count ──
    h2s = extract_h2s(body)
    results['G10_h2_count'] = (
        len(h2s) >= MIN_H2,
        f"{len(h2s)}/{MIN_H2}"
    )
    
    # ── G11: FAQ questions ──
    faq_qs = extract_faq_qs(body)
    results['G11_faq'] = (
        len(faq_qs) >= MIN_FAQ_Q,
        f"{len(faq_qs)}/{MIN_FAQ_Q}"
    )
    
    # ── G12: References ──
    refs = extract_references(body)
    results['G12_references'] = (
        len(refs) >= MIN_REFERENCES,
        f"{len(refs)}/{MIN_REFERENCES}"
    )
    
    # ── G13: Data source frontmatter ──
    has_ds = bool(re.search(r'^dataSources:\s*$', fm, re.MULTILINE))
    ds_count = len(re.findall(r'^\s+-\s+name:', fm, re.MULTILINE))
    results['G13_data_sources'] = (
        has_ds and ds_count > 0,
        f"dataSources entries: {ds_count}"
    )
    
    # ── G14: DateTime UTC Z ──
    publish_date = ''
    m = re.search(r'^publishDate:\s*["\']?(.+?)["\']?\s*$', fm, re.MULTILINE)
    if m:
        publish_date = m.group(1).strip()
    has_z = publish_date.endswith('Z')
    results['G14_datetime_utc'] = (
        has_z,
        f"publishDate: {publish_date} {'✓Z' if has_z else '✗no-Z'}"
    )
    
    return results

# ─── Main ───
def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/article_gate.py <article.md>")
        sys.exit(1)
    
    article_path = sys.argv[1]
    if not Path(article_path).exists():
        print(f"[ERROR] File not found: {article_path}")
        sys.exit(1)
    
    results = check_gate(article_path)
    
    passed = 0
    failed = 0
    for gate, (ok, detail) in results.items():
        status = "✓ PASS" if ok else "✗ FAIL"
        print(f"  {status}  {gate}: {detail}")
        if ok:
            passed += 1
        else:
            failed += 1
    
    print(f"\n{'='*50}")
    print(f"Gate Result: {passed}/{passed+failed} passed")
    
    if failed > 0:
        print(f"[FAIL] {failed} gate(s) failed — article should not be published")
        sys.exit(1)
    else:
        print("[PASS] All 14 gates passed")
        sys.exit(0)

if __name__ == '__main__':
    main()
