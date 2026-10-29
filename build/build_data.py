#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把基础题库 questions.json 与答案库 answers.json 合并，产出前端直接加载的 questions.js。

为什么单独一步：抽题（parse.py）可以重跑而不丢答案；答案导入（import_answers.py）
只改 answers.json。前端只需一个 <script src="data/questions.js">，避免 file:// 下的 CORS 限制。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
Q_JSON = BASE / "data" / "questions.json"
A_JSON = BASE / "data" / "answers.json"
OUT_JS = BASE / "data" / "questions.js"
OUT_JSON = BASE / "data" / "merged.json"


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if not Q_JSON.exists():
        print(f"缺少 {Q_JSON.name}，请先运行 build/parse.py")
        return 2

    payload = json.loads(Q_JSON.read_text(encoding="utf-8-sig"))
    questions = payload["questions"]

    answers = {}
    if A_JSON.exists():
        raw = json.loads(A_JSON.read_text(encoding="utf-8-sig"))
        answers = raw.get("answers", {})

    unknown = [k for k in answers if k not in {q["id"] for q in questions}]
    hits = 0
    for q in questions:
        a = answers.get(q["id"])
        if not a:
            continue
        ans = (a.get("answer") or "").strip().upper()
        if ans:
            q["answer"] = ans
            q["explain"] = a.get("explain") or None
            q["answerSource"] = a.get("source") or "imported"
            hits += 1

    meta = payload.setdefault("meta", {})
    meta["answered"] = hits
    meta["total"] = len(questions)
    meta["builtAt"] = datetime.now().isoformat(timespec="seconds")

    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    OUT_JS.write_text(
        "window.ZZ_DATA = " + json.dumps(payload, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    print(f"题库 {len(questions)} 题，已填答案 {hits} 题 -> {OUT_JS.name}")
    if unknown:
        print(f"警告: answers.json 中有 {len(unknown)} 个 id 在题库中不存在（前 5 个: {unknown[:5]}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
