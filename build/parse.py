#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 build/_raw_paragraphs.json 解析成结构化题库。

输入: extract_questions.ps1 产出的段落数组（WPS 只读导出，段落顺序即文档顺序）
输出: data/questions.json 与 data/questions.js (window.ZZ_DATA)

解析规则:
  - 学科头: 马克思主义哲学 / 毛中特+习思想 / 史纲要 / 思法
  - 部分头: 唯物论部分 / 辩证法 / 认识论 / 唯物史观 / 政治经济学 / 科学社会主义（仅马原）
  - 题型头: 单选 / 多选
  - 题干起点: 1994-单选.（1） / 1997-单选（4） / 2016-单选（8）
  - 选项: 以 A. B. C. D. (偶尔 E.) 开头；同段内用制表符并列的选项需二次切分
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
RAW = BASE / "build" / "_raw_paragraphs.json"
OUT_JSON = BASE / "data" / "questions.json"

SUBJECTS = {"马克思主义哲学", "毛中特+习思想", "史纲要", "思法"}
PARTS = {
    "唯物论部分": "唯物论",
    "辩证法": "辩证法",
    "认识论": "认识论",
    "唯物史观": "唯物史观",
    "政治经济学": "政治经济学",
    "科学社会主义": "科学社会主义",
}
TYPES = {"单选", "多选"}

# 个别题目写作 "2022.（4）"，缺题型标记，此时沿用当前小节题型
Q_RE = re.compile(r"^\s*(\d{4})\s*[-－—]?\s*(单选|多选)?\s*[.．]?\s*[（(]\s*(\d+)\s*[）)]")
# 选项标记：A. / B． / C、 —— 必须出现在段首或空白之后
OPT_SCAN = re.compile(r"([A-E])[.．、]")


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def parse(paras: list[str]) -> tuple[list[dict], list[str]]:
    questions: list[dict] = []
    warnings: list[str] = []

    subject = ""
    part = ""
    qtype = ""
    cur: dict | None = None
    cur_opt: dict | None = None
    opt_seen: set[str] = set()
    used_ids: set[str] = set()

    def flush() -> None:
        nonlocal cur, cur_opt
        if cur is None:
            return
        cur["stem"] = cur["stem"].strip()
        cur["options"] = [o for o in cur["options"] if o["text"].strip()]
        base = "/".join([cur["subject"], cur["part"] or "-", cur["type"], str(cur["no"])])
        qid = base
        if qid in used_ids:
            qid = f"{base}@{cur['year']}"
            k = 2
            while qid in used_ids:
                qid = f"{base}@{cur['year']}#{k}"
                k += 1
        used_ids.add(qid)
        cur["id"] = qid
        questions.append(cur)
        cur = None
        cur_opt = None

    def _append(chunk: str) -> None:
        chunk = " ".join(chunk.split())
        if not chunk:
            return
        if cur_opt is None:
            cur["stem"] = (cur["stem"] + " " + chunk).strip()
        else:
            cur_opt["text"] = (cur_opt["text"] + " " + chunk).strip()

    def absorb(text: str) -> None:
        """把一段文字拆成「正文 / 选项」，兼容 \\x0b 换行、\\xa0、多个空格分隔的选项。"""
        nonlocal cur_opt
        text = text.replace("\u000b", " ").replace("\u00a0", " ").replace("\u3000", " ")
        last = 0
        for mm in OPT_SCAN.finditer(text):
            s = mm.start()
            if s > 0 and text[s - 1] not in " \t\r\n":
                continue
            _append(text[last:s])
            key = mm.group(1)
            if key in opt_seen:
                _append(mm.group(0))
            else:
                opt_seen.add(key)
                cur_opt = {"key": key, "text": ""}
                cur["options"].append(cur_opt)
            last = mm.end()
        _append(text[last:])

    for raw in paras:
        line = (raw or "").strip()
        if not line:
            continue
        compact = norm(line)

        # 头部
        if line in SUBJECTS:
            flush()
            subject = line
            part = ""          # 学科切换时必须清掉上一个学科的部分
            qtype = ""
            continue
        if line in PARTS and subject == "马克思主义哲学":
            flush()
            part = PARTS[line]
            qtype = ""
            continue
        if line in TYPES:
            flush()
            qtype = line
            continue

        # 题干起点
        m = Q_RE.match(line)
        if m:
            flush()
            year, typ, no = int(m.group(1)), (m.group(2) or qtype or "单选"), int(m.group(3))
            cur = {
                "subject": subject,
                "part": part,
                "type": typ,
                "year": year,
                "no": no,
                "stem": "",
                "options": [],
            }
            cur_opt = None
            opt_seen = set()
            absorb(line[m.end():])
            continue

        if cur is None:
            # 章节注释 / 重复考察说明等，跳过
            continue

        absorb(line)

    flush()

    # 修补：个别选项的字母后没有点号（如 "D变是相对的"），会被并进上一个选项
    def repair(q: dict) -> None:
        if not q["options"]:
            return
        fixed: list[dict] = []
        for opt in q["options"]:
            text = opt["text"]
            key = opt["key"]
            while True:
                nxt = chr(ord(key) + 1)
                if nxt > "E":
                    break
                pat = re.compile(rf"(?:^|(?<=\s)){nxt}(?=[\u4e00-\u9fff“（(A-Za-z])")
                mm = pat.search(text)
                if not mm:
                    break
                head = text[: mm.start()].rstrip()
                tail = text[mm.end():].strip()
                opt["text"] = head
                fixed.append(opt)
                opt = {"key": nxt, "text": tail}
                key = nxt
                text = tail
            fixed.append(opt)
        q["options"] = fixed

    for q in questions:
        repair(q)

    # 校验与标记
    seq_counter: dict[tuple, int] = {}
    number_mismatch = 0
    for q in questions:
        scope = (q["subject"], q["part"], q["type"])
        seq_counter[scope] = seq_counter.get(scope, 0) + 1
        q["seq"] = seq_counter[scope]          # 该范围内按文档顺序的序号
        keys = [o["key"] for o in q["options"]]
        if len(keys) < 2:
            warnings.append(f"选项不足: {q['id']} / 年份 {q['year']} / 题号 {q['no']}")
        if len(set(keys)) != len(keys):
            warnings.append(f"选项重复: {q['id']} -> {keys}")
        if q["no"] != q["seq"]:
            number_mismatch += 1               # 源文档本身存在混编，只计数不刷屏
        q.setdefault("answer", None)
        q.setdefault("explain", None)
        q.setdefault("answerSource", None)
    if number_mismatch:
        warnings.append(f"提示: {number_mismatch} 题的卷面题号与文档顺序不一致（源文档混编，属正常）")

    # 同一道题在多个年份重复出现（题干相同）
    seen: dict[str, str] = {}
    for q in questions:
        key = norm(q["stem"])[:80]
        if key and key in seen:
            q.setdefault("relatedIds", []).append(seen[key])
            for other in questions:
                if other["id"] == seen[key]:
                    other.setdefault("relatedIds", []).append(q["id"])
                    break
        elif key:
            seen[key] = q["id"]

    return questions, warnings


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if not RAW.exists():
        print(f"缺少 {RAW}，请先运行 build/extract_questions.ps1")
        return 2

    paras = json.loads(RAW.read_text(encoding="utf-8-sig"))
    questions, warnings = parse(paras)

    meta = {
        "source": "2026政治真题集.doc",
        "total": len(questions),
        "subjects": sorted({q["subject"] for q in questions}),
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    }
    payload = {"meta": meta, "questions": questions}

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"题目数: {len(questions)}  ->  {OUT_JSON.name}")
    by_scope: dict[str, list[int]] = {}
    for q in questions:
        by_scope.setdefault(f"{q['subject']} / {q['part'] or '-'} / {q['type']}", []).append(q["no"])
    for scope, nos in by_scope.items():
        nos_sorted = sorted(nos)
        nums = set(nos_sorted)
        gaps = [n for n in range(1, max(nos_sorted) + 1) if n not in nums]
        gap_txt = f"  缺号: {gaps}" if gaps else ""
        print(f"  {scope}: {len(nos)} 题 (1-{max(nos_sorted)}){gap_txt}")

    if warnings:
        print(f"\n警告 {len(warnings)} 条:")
        for w in warnings[:15]:
            print("  -", w)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
