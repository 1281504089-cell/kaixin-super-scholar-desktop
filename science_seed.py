"""Synthetic records only. Call before starting the isolated QA application's backend."""
import asyncio
import json
import os
import sys
from pathlib import Path


async def seed_science():
    home = Path(os.environ["DEEPTUTOR_HOME"])
    assert (home / ".science-fixture-allowed").is_file(), "Explicitly mark an isolated QA home first"
    from deeptutor.services.session import get_sqlite_session_store
    from deeptutor.co_writer.storage import get_co_writer_storage
    from deeptutor.services.student_learning import mistakes

    cases = json.loads(Path(__file__).with_name("science-cases.json").read_text(encoding="utf-8"))
    assert len(cases) == 12
    title = "物理化学等科公式显示合成验证"
    text = "# " + title + "\n\n| 类别 | 公式 |\n|---|---|\n"
    text += "\n".join("| " + name + " | " + (formula if name == "science-physical-units" else "$" + formula + "$") + " |" for name, formula in cases)
    store = get_sqlite_session_store()
    session = await store.create_session(title)
    await store.add_message(session["id"], "user", "以下为合成公式，仅验证显示，不生成学习结论。")
    await store.add_message(session["id"], "assistant", text, capability="chat")
    notes = get_co_writer_storage()
    note = notes.create_document(title=title, content=text)
    saved_cases = [cases[0], cases[4], cases[5], cases[-1]]
    saved = notes.create_document(title="已保存理化公式兼容", blocks=[{
        "id": "original-table", "type": "table", "props": {}, "content": {
            "type": "tableContent", "columnWidths": [160, 360], "rows": [
                {"cells": [[{"type": "text", "text": name, "styles": {}}], [{"type": "inlineMath", "props": {"formula": formula}}]]}
                for name, formula in saved_cases
            ]
        }, "children": []
    }])
    ids = {}
    for subject in ("physics", "chemistry"):
        selected = [(name, formula) for name, formula in cases if name.startswith(subject)]
        question = "\n\n".join(name + "：$" + formula + "$" for name, formula in selected)
        record = mistakes.create_record({"manual": True, "messages": [
            {"id": subject + "u", "role": "user", "content": question},
            {"id": subject + "w", "role": "user", "content": "$" + selected[0][1] + "$"}
        ]}, subject=subject, title=("物理" if subject == "physics" else "化学") + "公式合成记录")
        record.update(status="ready", analysis={
            "title": record["title"], "subject": subject,
            "question": {"messageId": subject + "u", "text": question},
            "studentWork": None, "verdict": "uncertain",
            "explanation": "合成显示样例：$" + selected[1][1] + "$",
            "correction": "保留原式：$" + selected[0][1] + "$",
            "examPoints": ["$" + selected[-1][1] + "$"],
            "uncertainties": [], "knowledgePoints": ["公式显示"]
        })
        mistakes._save(*mistakes.storage(), record)
        ids[subject] = record["id"]
    return {"session": session["id"], "note": note.id, "saved_note": saved.id,
            "mistakes": ids, "cases": cases, "saved_cases": saved_cases}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    assert (args.home / ".science-fixture-allowed").is_file(), "Refusing an unmarked home"
    for name in list(os.environ):
        if name.endswith("API_KEY"):
            del os.environ[name]
    os.environ["DEEPTUTOR_HOME"] = str(args.home.resolve())
    source = args.source.resolve()
    os.chdir(source)
    sys.path.insert(0, str(source))
    from deeptutor.services.student_learning.bootstrap import initialize
    initialize()
    args.output.write_text(json.dumps(asyncio.run(seed_science()), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
