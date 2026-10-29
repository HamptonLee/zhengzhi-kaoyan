#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""题库体检：跑在 data/questions.js 合并之后，检查结构完整性并给出答案覆盖率。

退出码: 0 无错误；1 有错误。
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
MERGED = BASE / "data" / "merged.json"
# 可选：设置环境变量 ZZ_EXPECTED_TOTAL=497 可校验题库总数
EXPECTED_TOTAL = int(os.environ.get("ZZ_EXPECTED_TOTAL", "0"))


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if not MERGED.exists():
        print(f"缺少 {MERGED.name}，请先运行 build/build_data.py")
        return 1

    data = json.loads(MERGED.read_text(encoding="utf-8-sig"))
    qs = data["questions"]
    errors: list[str] = []
    warnings: list[str] = []

    if EXPECTED_TOTAL and len(qs) != EXPECTED_TOTAL:
        warnings.append(f"题目数 {len(qs)} != 预期 {EXPECTED_TOTAL}")

    ids = Counter(q["id"] for q in qs)
    dup_ids = [i for i, c in ids.items() if c > 1]
    if dup_ids:
        errors.append(f"重复 ID {len(dup_ids)} 个: {dup_ids[:5]}")

    keys_counter = Counter()
    answered = 0
    for q in qs:
        keys = [o["key"] for o in q["options"]]
        keys_counter[len(keys)] += 1
        if len(keys) < 2:
            errors.append(f"{q['id']} 选项不足: {keys}")
        if len(set(keys)) != len(keys):
            errors.append(f"{q['id']} 选项键重复: {keys}")
        if not q.get("stem", "").strip():
            errors.append(f"{q['id']} 题干为空")
        for o in q["options"]:
            if not o["text"].strip():
                errors.append(f"{q['id']} 选项 {o['key']} 文本为空")
        ans = q.get("answer")
        if ans:
            answered += 1
            if not re.fullmatch(r"[A-E]+", ans):
                errors.append(f"{q['id']} 答案格式异常: {ans}")
            elif set(ans) - set(keys):
                errors.append(f"{q['id']} 答案 {ans} 超出选项 {keys}")
            elif q["type"] == "多选" and len(ans) < 2:
                warnings.append(f"{q['id']} 多选题答案只有 {ans}，请核对")
            elif q["type"] == "单选" and len(ans) != 1:
                errors.append(f"{q['id']} 单选题答案 {ans} 不是单个字母")

    # 同号题（源文档题号重复）——只提示，不报错
    byno = defaultdict(list)
    for q in qs:
        byno[(q["subject"], q["part"], q["type"], q["no"])].append(q["year"])
    same = {k: v for k, v in byno.items() if len(v) > 1}

    print(f"题目总数: {len(qs)}  |  选项数分布: {dict(sorted(keys_counter.items()))}")
    print(f"已填答案: {answered}/{len(qs)} ({answered * 100 // max(len(qs), 1)}%)")
    print(f"同号题: {len(same)} 组（输入该题号会给出多个候选）")

    scope = defaultdict(lambda: [0, 0])
    for q in qs:
        k = f"{q['subject']} / {q['part'] or '-'} / {q['type']}"
        scope[k][0] += 1
        if q.get("answer"):
            scope[k][1] += 1
    print("\n覆盖率:")
    for k, (total, done) in scope.items():
        print(f"  {k}: {done}/{total}")

    if warnings:
        print(f"\n提示 {len(warnings)} 条:")
        for w in warnings[:10]:
            print("  -", w)

    if errors:
        print(f"\n错误 {len(errors)} 条:")
        for e in errors[:20]:
            print("  -", e)
        return 1

    print("\n体检通过 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
