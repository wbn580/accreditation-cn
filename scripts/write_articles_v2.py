#!/usr/bin/env python3
"""
accreditation-cn batch article writer — synchronous, ThreadPoolExecutor-based
Reliable version using requests + concurrent.futures
"""
import json
import os
import re
import sys
import time
import subprocess
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

# ─── Config ───
SITE_ROOT = Path.home() / 'site-builds/accreditation-cn'
PLAN_PATH = SITE_ROOT / 'data-research/article-plan.json'
STATE_PATH = SITE_ROOT / 'state/articles-progress.json'
ARTICLES_DIR = SITE_ROOT / 'src/content/articles'
MAX_WORKERS = 10
MAX_RETRIES = 3

# ─── Load credentials ───
CREDS_PATH = Path('/Users/benwu/Library/CloudStorage/Dropbox-Personal/cowork/cowork-cloud-tools/credentials.json')
with open(CREDS_PATH) as f:
    _c = json.load(f)
DS_API_KEY = _c['deepseek']['api_key']

# ─── System Prompt ───
SYSTEM_PROMPT = """你是「全球认证信息汇编」(accreditation.cn) 的特约编辑。这是一个独立运营的中文权威信息汇编平台，定位类似 OECD / IMF / 教育部学位与研究生教育发展中心的对外信息发布频道——严肃、克制、第三方中立。

写作铁律：
1. 第三人称中立陈述。禁"我们 / 本站推荐 / 我推荐 / 强烈建议 / 这就是最佳选择"等。改用"本汇编整理 / 据 XX 公开发布数据 / 依据 XX 年度报告 / 按照 XX 官方规定 / 截至 2026 年 X 月"等。
2. 严谨克制。禁感叹号、禁夸张词、禁营销腔。
3. 术语规范化：accreditation 统一译"认证"，agency 统一译"机构"，全文一致。
4. 数据点必标年份 + 来源。"截至 2026 年 4 月共认证 989 所院校（数据来源：AACSB 2026 年度年报）"
5. 段首陈述核心结论，后续句举证。
6. 历史 + 现状 + 未来三段式组织信息。
7. 数据时效首选 2026，次选 2025。2022 及更早禁用除历史对比节外。
8. 标题禁词：禁"排名 / 榜单 / 测评 / 评测 / 中介推荐"。正文可用中性学术语境。
9. 禁 reddit 字样（全位置）。
10. 禁出现 UNILINK / 优领教育 / 任何商业品牌。
11. 禁 CTA（"立即咨询 / 联系我们 / 加微信"等）。
12. 禁"半工半读 / TAFE"。
13. AIO/SEO：5-7 个 H2 + 短段落 + 加粗关键词 + 首段权威数据开场 + 文末 ## FAQ（至少1个Q&A）+ ## 参考资料（≥5条）。
14. 文末会自动注入免责段，不要在正文里重复。

输出 markdown 全文，frontmatter 完整。直接开始写，不要开场白。"""

def build_user_prompt(item: dict) -> str:
    """Build user prompt for a specific article"""
    cat = item['category']
    atype = item['articleType']
    title = item['title']
    target_wc = item.get('word_count_target', 2500)
    
    parts = [f"""请撰写以下文章：

**文章标题**：{title}
**分类**：{cat}
**文章类型**：{atype}
**目标字数**：{target_wc} 字（简体中文）
**国家/地区**：{item.get('country', 'global')}

**要求**：
- 按上述写作铁律执行
- 输出包含完整 YAML frontmatter（title/description/category/subCategory/articleType/country/publishDate/lastVerified/readingTime/tags/keywords/dataSources/ogImage/draft）
- publishDate 用 2026-05-22T10:00:00Z
- lastVerified 用 2026-05-22
- frontmatter 的 dataSources 字段至少列出 3 条真实数据来源（含 URL）
- 文末必须包含 ## FAQ（至少1个Q&A，用 ### Q1: 格式）和 ## 参考资料（≥5条，用 - 列表格式）
"""]
    
    if item.get('accreditation_system'):
        sys_info = item['accreditation_system']
        parts.append(f"""
**认证体系背景**：
- 名称：{sys_info.get('name_zh', '')}
- 国家：{sys_info.get('country', '')}
- 范围：{sys_info.get('scope', '')}
""")
    
    # Type-specific instructions
    type_instructions = {
        'overview': "概况页：起源→认证范围→全球统计→费用时效→FAQ→参考资料",
        'history': "历史演变：创立背景→关键里程碑→重大改革→近年演变→FAQ→参考资料",
        'criteria': "认证标准详解：标准总览→逐条详解→标准演进→FAQ→参考资料",
        'accredited_list': "受认证机构名单：数据说明→按地区分组列出的机构清单→解读→FAQ→参考资料",
        'how_to_apply': "申请流程指南：准备工作→分步流程→时间线与费用→常见被拒原因→FAQ→参考资料",
        'faq': "常见问题：15-25个Q&A（用 ### Q1/Q2格式），每个Q 100-150字，A 200-300字→参考资料（≥3条）",
        'comparison': "跨体系对比：参与对比的体系简介→多维度对比→对比表→选择建议→FAQ→参考资料",
        'insight': "深度分析：导语→核心论点→数据支撑→结论展望→FAQ→参考资料",
        'glossary_term': "术语词条200-500字：中英对照→官方定义→历史溯源→适用范围→易混淆辨析",
        'faq_answer': "FAQ解答800-1500字：直接回答→详细解释→数据案例→参考资料（≥3条）",
    }
    if atype in type_instructions:
        parts.append(f"\n**内容结构**：{type_instructions[atype]}")
    
    parts.append("\n现在开始写作。直接输出完整的 markdown 文件。")
    return '\n'.join(parts)

def make_frontmatter(item: dict) -> str:
    """Create YAML frontmatter if missing"""
    title = item['title']
    cat = item['category']
    now_utc = '2026-05-22T10:00:00Z'
    today = '2026-05-22'
    
    tags = [item.get('subCategory', cat), cat]
    return f"""---
title: "{title}"
description: "本文为{title}的公开信息汇编，独立整理自官方来源，仅供参考。"
category: "{cat}"
subCategory: "{item.get('subCategory', cat)}"
articleType: "{item['articleType']}"
country: "{item.get('country', 'global')}"
publishDate: "{now_utc}"
lastVerified: "{today}"
readingTime: {max(item.get('word_count_target', 2500) // 250, 5)}
tags: {json.dumps(tags, ensure_ascii=False)}
keywords: ["{title}"]
dataSources:
  - name: "来源待补充"
    url: ""
    fetchedDate: "{today}"
ogImage: "/og-images/{cat}-default.svg"
draft: false
---"""

def call_dspro(prompt: str) -> str:
    """Call DeepSeek API (synchronous)"""
    headers = {
        'Authorization': f'Bearer {DS_API_KEY}',
        'Content-Type': 'application/json',
    }
    payload = {
        'model': 'deepseek-chat',
        'messages': [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user', 'content': prompt},
        ],
        'temperature': 0.7,
        'max_tokens': 8192,
    }
    
    resp = requests.post(
        'https://api.deepseek.com/v1/chat/completions',
        json=payload, headers=headers, timeout=300
    )
    data = resp.json()
    
    if 'choices' in data and len(data['choices']) > 0:
        return data['choices'][0]['message']['content']
    else:
        raise Exception(f"DS API error: {json.dumps(data, ensure_ascii=False)[:300]}")

def run_gate(article_path: str) -> tuple:
    """Run gate, return (passed: bool, output: str)"""
    result = subprocess.run(
        ['python3', str(SITE_ROOT / 'scripts/article_gate.py'), article_path],
        capture_output=True, text=True, timeout=60
    )
    return result.returncode == 0, result.stdout

def write_one_article(item: dict, state: dict) -> bool:
    """Write a single article (called by thread)"""
    slug = item['slug']
    article_path = ARTICLES_DIR / f'{slug}.md'
    article_path.parent.mkdir(parents=True, exist_ok=True)
    
    for attempt in range(MAX_RETRIES + 1):
        try:
            user_prompt = build_user_prompt(item)
            response = call_dspro(user_prompt)
            
            # Ensure frontmatter exists
            if not response.strip().startswith('---'):
                response = make_frontmatter(item) + '\n' + response
            
            # Save
            article_path.write_text(response, encoding='utf-8')
            
            # Run gate
            passed, output = run_gate(str(article_path))
            
            if passed:
                word_count = len(re.sub(r'\s', '', response.split('---', 2)[-1] if '---' in response else response))
                with STATE_LOCK:
                    with open(STATE_PATH) as f:
                        s = json.load(f)
                    s['articles'][slug] = {
                        'status': 'completed',
                        'started_at': s['articles'].get(slug, {}).get('started_at', datetime.now(timezone.utc).isoformat()),
                        'finished_at': datetime.now(timezone.utc).isoformat(),
                        'word_count': word_count,
                        'retry_count': attempt,
                    }
                    s['completed_count'] = s.get('completed_count', 0) + 1
                    _atomic_save(s)
                print(f"  ✓ {slug}: {word_count} words (attempt {attempt+1})", flush=True)
                return True
            else:
                if attempt < MAX_RETRIES:
                    print(f"  ↻ {slug}: gate failed attempt {attempt+1}, retrying...", flush=True)
                    time.sleep(2)
                    continue
                else:
                    # Extract failed gates
                    failed_gates = [l for l in output.split('\n') if 'FAIL' in l]
                    with STATE_LOCK:
                        with open(STATE_PATH) as f:
                            s = json.load(f)
                        s['articles'][slug] = {
                            'status': 'failed',
                            'started_at': s['articles'].get(slug, {}).get('started_at', datetime.now(timezone.utc).isoformat()),
                            'finished_at': datetime.now(timezone.utc).isoformat(),
                            'retry_count': attempt,
                            'error': f"Gate failed: {'; '.join(failed_gates[:3])}",
                        }
                        s['failed_count'] = s.get('failed_count', 0) + 1
                        _atomic_save(s)
                    print(f"  ✗ {slug}: FAILED after {MAX_RETRIES} retries: {'; '.join(failed_gates[:2])}", flush=True)
                    return False
                    
        except Exception as e:
            if attempt < MAX_RETRIES:
                print(f"  ↻ {slug}: error attempt {attempt+1}: {e}", flush=True)
                time.sleep(5)
                continue
            else:
                with STATE_LOCK:
                    with open(STATE_PATH) as f:
                        s = json.load(f)
                    s['articles'][slug] = {
                        'status': 'failed',
                        'error': str(e),
                        'retry_count': attempt,
                    }
                    s['failed_count'] = s.get('failed_count', 0) + 1
                    _atomic_save(s)
                print(f"  ✗ {slug}: FAILED: {e}", flush=True)
                return False
    
    return False

# ─── Thread-safe state ───
import threading
STATE_LOCK = threading.Lock()

def _atomic_save(state: dict):
    """Thread-safe atomic state save"""
    state['last_heartbeat'] = datetime.now(timezone.utc).isoformat()
    tmp = STATE_PATH.with_suffix('.tmp')
    with open(tmp, 'w') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)

def load_state() -> dict:
    """Load or create state"""
    if STATE_PATH.exists():
        with open(STATE_PATH) as f:
            return json.load(f)
    return {
        'started_at': datetime.now(timezone.utc).isoformat(),
        'target_count': 0,
        'completed_count': 0,
        'failed_count': 0,
        'last_heartbeat': datetime.now(timezone.utc).isoformat(),
        'articles': {},
    }

# ─── Main ───
def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()
    
    with open(PLAN_PATH) as f:
        plan = json.load(f)
    
    state = load_state()
    state['target_count'] = len(plan)
    
    # Build pending list
    pending = []
    for item in plan:
        slug = item['slug']
        if slug in state.get('articles', {}):
            art = state['articles'][slug]
            if art.get('status') == 'completed':
                continue
            if art.get('status') == 'failed' and art.get('retry_count', 0) >= MAX_RETRIES:
                continue
        if item['slug'] not in state.get('articles', {}) or \
           state['articles'][item['slug']].get('status') != 'completed':
            pending.append(item)
    
    if args.limit and args.limit > 0:
        pending = pending[:args.limit]
    
    print(f"Total: {len(plan)}, Pending: {len(pending)}, "
          f"Done: {state.get('completed_count', 0)}, "
          f"Failed: {state.get('failed_count', 0)}", flush=True)
    
    if not pending:
        print("All done!", flush=True)
        return
    
    # Save initial state
    for item in pending:
        if item['slug'] not in state['articles']:
            state['articles'][item['slug']] = {'status': 'pending'}
    _atomic_save(state)
    
    # Process with thread pool
    start_time = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(write_one_article, item, state): item for item in pending}
        
        for i, future in enumerate(as_completed(futures)):
            item = futures[future]
            try:
                future.result()
            except Exception as e:
                print(f"  ✗ {item['slug']}: unhandled exception: {e}", flush=True)
            
            elapsed = time.time() - start_time
            with STATE_LOCK:
                with open(STATE_PATH) as f:
                    s = json.load(f)
            done = s.get('completed_count', 0)
            rate = done / max(elapsed, 1) * 60
            eta = (len(pending) - done - s.get('failed_count', 0)) / max(rate, 0.01) if rate > 0 else 999
            print(f"[{done}/{len(pending)}] {rate:.1f} articles/min, ETA {eta:.0f} min", flush=True)
    
    # Final stats
    with open(STATE_PATH) as f:
        final = json.load(f)
    print(f"\n{'='*60}")
    print(f"DONE: {final.get('completed_count', 0)}/{final['target_count']}")
    print(f"Failed: {final.get('failed_count', 0)}")
    print(f"Elapsed: {(time.time() - start_time) / 60:.1f} min")

if __name__ == '__main__':
    main()
