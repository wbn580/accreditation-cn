#!/usr/bin/env python3
"""
accreditation-cn article writer — 10-worker parallel DSPro writer
Writes articles from article-plan.json, runs gate checks, updates state.

Usage:
  python3 scripts/write_articles.py [--resume] [--limit N]
"""
import asyncio
import json
import os
import re
import sys
import hashlib
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

# ─── Config ───
SITE_ROOT = Path.home() / 'site-builds/accreditation-cn'
PLAN_PATH = SITE_ROOT / 'data-research/article-plan.json'
STATE_PATH = SITE_ROOT / 'state/articles-progress.json'
ARTICLES_DIR = SITE_ROOT / 'src/content/articles'
SCRIPTS_DIR = SITE_ROOT / 'scripts'
MAX_WORKERS = 10
MAX_RETRIES = 3

# ─── DSPro API ───
# Load credentials
CREDS_PATH = Path('/Users/benwu/Library/CloudStorage/Dropbox-Personal/cowork/cowork-cloud-tools/credentials.json')
with open(CREDS_PATH) as f:
    _c = json.load(f)
DS_API_KEY = _c.get('deepseek', {}).get('api_key', '')
DS_BASE = 'https://api.deepseek.com/v1'

# ─── System Prompt ───
SYSTEM_PROMPT = """你是「全球认证信息汇编」(accreditation.cn) 的特约编辑。这是一个独立运营的中文权威信息汇编平台，定位类似 OECD / IMF / 教育部学位与研究生教育发展中心的对外信息发布频道——严肃、克制、第三方中立。

写作铁律：
1. 第三人称中立陈述。禁"我们 / 本站推荐 / 我推荐 / 强烈建议 / 这就是最佳选择"等。改用"本汇编整理 / 据 XX 公开发布数据 / 依据 XX 年度报告 / 按照 XX 官方规定 / 截至 2026 年 X 月"等。
2. 严谨克制。禁感叹号、禁夸张词（"火爆 / 最佳 / 第一 / 强烈"等）、禁营销腔（"赋能 / 闭环 / 打通 / 颠覆"等）。
3. 术语规范化：accreditation 统一译"认证"，agency 统一译"机构"，全文一致。
4. 数据点必标年份 + 来源。"截至 2026 年 4 月共认证 989 所院校（数据来源：AACSB 2026 年度年报，2026-05-22 核对）"
5. 段首陈述核心结论，后续句举证（律所 brief 风）。
6. 历史 + 现状 + 未来三段式组织信息。
7. 数据时效首选 2026，次选 2025。2022 及更早禁用，除非历史对比节明示。
8. 标题禁词：禁"排名 / 榜单 / 测评 / 评测 / 中介推荐"及其变体。正文可用中性学术语境（"QS 2026 全球排名"等 OK）。
9. 禁 reddit 字样（全位置）。
10. 禁出现 UNILINK / 优领教育 / 任何商业品牌 / 任何中介推介——本站是中立汇编。
11. 文章结尾禁出现 CTA（"立即咨询 / 联系我们 / 加微信" 等）。
12. 禁"半工半读 / TAFE"。
13. 字数按要求的 target，不少于规定字数。
14. AIO/SEO 结构：5-7 个 H2 + 每 H2 下 1-3 个 H3 + 短段落（每段 ≤ 200 字）+ 加粗关键词 + 首段权威数据开场 + FAQ ≥ 3 个 Q&A + 参考资料 ≥ 5 条（每条机构名 + 年份 + URL）。
15. 文末会自动注入免责段，不需要在正文里重复。

输出 markdown 全文，frontmatter 完整。"""

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
"""]
    
    # Accreditation system specific context
    if item.get('accreditation_system'):
        sys_info = item['accreditation_system']
        parts.append(f"""
**认证体系背景**：
- 名称：{sys_info.get('name_zh', '')}
- 国家：{sys_info.get('country', '')}
- 范围：{sys_info.get('scope', '')}
""")
    
    # Article type specific instructions
    if atype == 'overview':
        parts.append("""
**内容结构**（概况页）：
1. 导语：认证体系的基本定位、核心职能
2. 起源与成立背景（历史段）
3. 认证范围与适用对象
4. 认证标准概览
5. 全球认证数量与分布
6. 费用与时效
7. FAQ（≥ 3 个 Q&A）
8. 参考资料（≥ 5 条）
""")
    elif atype == 'history':
        parts.append("""
**内容结构**（历史演变）：
1. 创立背景与最初使命
2. 关键里程碑（按年代排列）
3. 重大政策改革与争议事件
4. 近年演变与未来方向
5. FAQ（≥ 3 个 Q&A）
6. 参考资料（≥ 5 条）
""")
    elif atype == 'criteria':
        parts.append("""
**内容结构**（认证标准详解）：
1. 标准总览（列出所有维度）
2. 逐条详解（每条标准的具体含义、评分维度、典型案例）
3. 标准的演进与争议
4. FAQ（≥ 3 个 Q&A）
5. 参考资料（≥ 5 条）
""")
    elif atype == 'accredited_list':
        parts.append("""
**内容结构**（受认证机构名单）：
1. 数据说明（数据来源、更新时间）
2. 按地区/国家分组列出的受认证机构清单
3. 名单的解读与分析
4. FAQ（≥ 3 个 Q&A）
5. 参考资料（≥ 5 条）
""")
    elif atype == 'how_to_apply':
        parts.append("""
**内容结构**（申请流程指南）：
1. 申请前的准备工作
2. 分步流程（提交 → 评审 → 现场访问 → 决议 → 复审）
3. 时间线与费用
4. 常见被拒原因
5. FAQ（≥ 3 个 Q&A）
6. 参考资料（≥ 5 条）
""")
    elif atype == 'faq':
        parts.append("""
**内容结构**（常见问题）：
- 包含 15-25 个 Q&A
- 每个 Q 100-150 字，A 200-300 字
- 使用 ## FAQ 和 ### Q1/Q2/... 格式
- 参考资料（≥ 3 条）
""")
    elif atype == 'comparison':
        parts.append("""
**内容结构**（跨体系对比）：
1. 参与对比的认证体系简介
2. 多维度对比（严格度/含金量/受认范围/申请难度/费用/时效）
3. 对比表
4. 不同场景下的选择建议
5. FAQ（≥ 3 个 Q&A）
6. 参考资料（≥ 5 条）
""")
    elif atype == 'insight':
        parts.append(f"""
**内容结构**（深度分析）：
1. 导语：为什么这个话题值得关注
2. 核心论点（2-3 个 H2）
3. 数据支撑与案例分析
4. 结论与展望
5. FAQ（≥ 3 个 Q&A）
6. 参考资料（≥ 5 条）
""")
    elif atype == 'glossary_term':
        parts.append(f"""
**内容结构**（术语词条，200-500 字）：
1. 中英对照
2. 官方定义
3. 历史溯源
4. 适用范围
5. 易混淆术语辨析
""")
    elif atype == 'faq_answer':
        parts.append(f"""
**内容结构**（FAQ 解答，800-1500 字）：
1. 直接回答问题（开篇第一句给出答案）
2. 详细解释与背景
3. 相关数据与案例
4. 参考资料（≥ 3 条）
""")
    
    parts.append("""
现在开始写作。直接输出完整的 markdown 文件，不要有任何开场白或结尾说明。""")
    
    return '\n'.join(parts)

def make_frontmatter(item: dict) -> str:
    """Create YAML frontmatter"""
    title = item['title']
    cat = item['category']
    now_utc = '2026-05-22T10:00:00Z'
    today = '2026-05-22'
    
    tags = [item.get('subCategory', cat), cat]
    if item.get('accreditation_system'):
        sys_info = item['accreditation_system']
        tags.append(sys_info.get('scope', ''))
    
    keywords = [title]
    
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
keywords: {json.dumps(keywords, ensure_ascii=False)}
dataSources:
  - name: "来源待补充"
    url: ""
    fetchedDate: "{today}"
ogImage: "/og-images/{cat}-default.svg"
draft: false
---"""

async def call_dspro(prompt: str, system: str = SYSTEM_PROMPT) -> str:
    """Call DeepSeek V4 Pro API"""
    import aiohttp
    
    headers = {
        'Authorization': f'Bearer {DS_API_KEY}',
        'Content-Type': 'application/json',
    }
    payload = {
        'model': 'deepseek-chat',
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': prompt},
        ],
        'temperature': 0.7,
        'max_tokens': 8192,
    }
    
    async with aiohttp.ClientSession() as session:
        async with session.post(f'{DS_BASE}/chat/completions', json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=300)) as resp:
            data = await resp.json()
            if 'choices' in data and len(data['choices']) > 0:
                return data['choices'][0]['message']['content']
            else:
                raise Exception(f"DS API error: {data}")

def run_gate(article_path: str) -> dict:
    """Run article gate script"""
    import subprocess
    result = subprocess.run(
        ['python3', str(SCRIPTS_DIR / 'article_gate.py'), article_path],
        capture_output=True, text=True, timeout=60
    )
    return {
        'returncode': result.returncode,
        'stdout': result.stdout,
        'stderr': result.stderr,
    }

async def write_article(item: dict, sem: asyncio.Semaphore, state: dict) -> bool:
    """Write a single article"""
    slug = item['slug']
    
    async with sem:
        # Update state
        state['articles'][slug] = {
            'status': 'in_progress',
            'started_at': datetime.now(timezone.utc).isoformat(),
            'retry_count': 0,
        }
        save_state(state)
        
        article_path = ARTICLES_DIR / f'{slug}.md'
        article_path.parent.mkdir(parents=True, exist_ok=True)
        
        for attempt in range(MAX_RETRIES + 1):
            try:
                # Generate article
                user_prompt = build_user_prompt(item)
                response = await call_dspro(user_prompt)
                
                # Ensure frontmatter exists
                if not response.strip().startswith('---'):
                    fm = make_frontmatter(item)
                    response = fm + '\n' + response
                
                # Save
                article_path.write_text(response, encoding='utf-8')
                
                # Run gate
                gate_result = run_gate(str(article_path))
                
                if gate_result['returncode'] == 0:
                    # Passed!
                    word_count = len(re.sub(r'\s', '', response.split('---', 2)[-1] if '---' in response else response))
                    state['articles'][slug] = {
                        'status': 'completed',
                        'started_at': state['articles'][slug]['started_at'],
                        'finished_at': datetime.now(timezone.utc).isoformat(),
                        'word_count': word_count,
                        'retry_count': attempt,
                    }
                    state['completed_count'] = state.get('completed_count', 0) + 1
                    save_state(state)
                    return True
                else:
                    # Gate failed - retry
                    if attempt < MAX_RETRIES:
                        print(f"  [{slug}] Gate failed on attempt {attempt+1}, retrying...")
                        print(f"    {gate_result['stdout'][:200]}")
                        time.sleep(2)
                        continue
                    else:
                        state['articles'][slug] = {
                            'status': 'failed',
                            'started_at': state['articles'][slug]['started_at'],
                            'finished_at': datetime.now(timezone.utc).isoformat(),
                            'retry_count': attempt,
                            'error': f"Gate failed after {MAX_RETRIES} retries",
                        }
                        state['failed_count'] = state.get('failed_count', 0) + 1
                        save_state(state)
                        return False
                        
            except Exception as e:
                if attempt < MAX_RETRIES:
                    print(f"  [{slug}] Error on attempt {attempt+1}: {e}, retrying...")
                    time.sleep(3)
                    continue
                else:
                    state['articles'][slug] = {
                        'status': 'failed',
                        'started_at': state['articles'][slug]['started_at'],
                        'finished_at': datetime.now(timezone.utc).isoformat(),
                        'retry_count': attempt,
                        'error': str(e),
                    }
                    state['failed_count'] = state.get('failed_count', 0) + 1
                    save_state(state)
                    return False
    
    return False

def load_state() -> dict:
    """Load or create state JSON"""
    if STATE_PATH.exists():
        with open(STATE_PATH) as f:
            return json.load(f)
    return {
        'started_at': datetime.now(timezone.utc).isoformat(),
        'target_count': 0,
        'completed_count': 0,
        'failed_count': 0,
        'skipped_count': 0,
        'last_heartbeat': datetime.now(timezone.utc).isoformat(),
        'articles': {},
    }

def save_state(state: dict):
    """Atomic state save"""
    state['last_heartbeat'] = datetime.now(timezone.utc).isoformat()
    tmp = STATE_PATH.with_suffix('.tmp')
    with open(tmp, 'w') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)

async def main(args):
    # Load plan
    with open(PLAN_PATH) as f:
        plan = json.load(f)
    
    # Load or init state
    state = load_state()
    state['target_count'] = len(plan)
    
    # Filter: skip completed, retry failed
    pending = []
    for item in plan:
        slug = item['slug']
        if slug in state.get('articles', {}):
            article_state = state['articles'][slug]
            if article_state.get('status') == 'completed':
                continue  # skip completed
            if article_state.get('status') == 'failed':
                # Retry if less than MAX_RETRIES
                if article_state.get('retry_count', MAX_RETRIES) < MAX_RETRIES:
                    pending.append(item)
                else:
                    state['skipped_count'] = state.get('skipped_count', 0) + 1
                    continue
            if article_state.get('status') == 'in_progress':
                # Was interrupted - retry
                pending.append(item)
                continue
        else:
            pending.append(item)
    
    print(f"Total plan: {len(plan)}, Pending: {len(pending)}, "
          f"Completed: {state.get('completed_count', 0)}, "
          f"Failed: {state.get('failed_count', 0)}")
    
    # Apply limit if specified
    if args.limit and args.limit > 0:
        pending = pending[:args.limit]
        print(f"Limited to {len(pending)} articles")
    
    if not pending:
        print("All articles completed!")
        return
    
    # Process with semaphore
    sem = asyncio.Semaphore(MAX_WORKERS)
    tasks = []
    
    for item in pending:
        task = asyncio.create_task(write_article(item, sem, state))
        tasks.append(task)
    
    # Run all
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    # Final stats
    print(f"\n{'='*60}")
    print(f"COMPLETE: {state.get('completed_count', 0)}/{state['target_count']} articles")
    print(f"Failed: {state.get('failed_count', 0)}")
    print(f"Skipped: {state.get('skipped_count', 0)}")

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--resume', action='store_true', help='Resume from state')
    ap.add_argument('--limit', type=int, default=0, help='Max articles to process')
    args = ap.parse_args()
    
    asyncio.run(main(args))
