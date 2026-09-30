#!/usr/bin/env python3
"""
samsung-word 표준 문서 빌더

"표준 문서 작성 가이드"의 서식 규칙(폰트, 레벨별 기호/크기, 줄간격, 강조,
꺾임기호 주석, 페이지 번호 등)을 그대로 구현한 .docx 생성기.

호출 방식은 두 가지:
  1) CLI: JSON 스펙 파일을 읽어 .docx 생성
       python3 build_doc.py spec.json output.docx
  2) 라이브러리: build_from_spec(spec: dict, out_path: str) 를 직접 호출

spec의 정확한 구조는 SKILL.md 및 references/spec_schema.md 참고.
"""

import sys
import json
import copy
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

FONT_NAME = "바탕체"

# 레벨별 규칙 (가이드 표 그대로)
LEVEL_RULES = {
    1: {"size": 16, "bold": True, "space_before": 14, "space_after": 8},
    2: {"size": 14, "bold": True, "space_before": 12, "space_after": 8},
    3: {"size": 14, "bold": False, "space_before": 8, "space_after": 8},
    4: {"size": 14, "bold": False, "space_before": 8, "space_after": 8},
    5: {"size": 12, "bold": False, "space_before": 8, "space_after": 8},
    "note": {"size": 9, "bold": False, "space_before": 0, "space_after": 8},
}

LINE_SPACING = 1.08  # 배수

# 들여쓰기는 "레벨 번호"가 아니라 "실제 문서 트리에서 몇 단계 들어가 있는가(depth)"
# 로 정한다. 예를 들어 2레벨(□) 밑에 3레벨을 건너뛰고 바로 4레벨(-)을 붙이면,
# 4레벨은 절대 레벨 번호(4)가 아니라 "2레벨의 자식"이라는 실제 위치 기준으로
# 한 칸만 더 들여쓴다. 문단 서식(left_indent)이 아니라 스페이스 문자를 그대로
# 앞에 붙이는 방식을 쓰는데, 이렇게 해야 다른 문서에 복사-붙여넣기 하거나
# 사용자가 워드에서 손으로 수정할 때도 눈에 보이는 그대로 유지된다.
INDENT_CHAR = " "


def set_east_asian_font(run, font_name=FONT_NAME):
    """동아시아 폰트(바탕체)를 run에 확실히 적용."""
    run.font.name = font_name
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = OxmlElement('w:rFonts')
        rPr.append(rFonts)
    rFonts.set(qn('w:eastAsia'), font_name)
    rFonts.set(qn('w:ascii'), font_name)
    rFonts.set(qn('w:hAnsi'), font_name)


def add_page_number_footer(doc):
    """하단 페이지 번호를 '1/전체페이지수' 형식으로 추가."""
    section = doc.sections[0]
    footer = section.footer
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.text = ""

    def make_field(instr_text):
        run = p.add_run()
        set_east_asian_font(run)
        run.font.size = Pt(9)
        fldChar1 = OxmlElement('w:fldChar')
        fldChar1.set(qn('w:fldCharType'), 'begin')
        instrText = OxmlElement('w:instrText')
        instrText.set(qn('xml:space'), 'preserve')
        instrText.text = instr_text
        fldChar2 = OxmlElement('w:fldChar')
        fldChar2.set(qn('w:fldCharType'), 'end')
        run._r.append(fldChar1)
        run._r.append(instrText)
        run._r.append(fldChar2)

    make_field(' PAGE ')
    slash_run = p.add_run("/")
    set_east_asian_font(slash_run)
    slash_run.font.size = Pt(9)
    make_field(' NUMPAGES ')


def apply_paragraph_format(paragraph, level):
    rule = LEVEL_RULES[level]
    pf = paragraph.paragraph_format
    pf.line_spacing = LINE_SPACING
    pf.space_before = Pt(rule["space_before"])
    pf.space_after = Pt(rule["space_after"])
    return rule


def add_level_paragraph(doc, level, text, bold_override=None, after_table=False, depth=0):
    """
    레벨(1~5, 'note')에 맞는 기호 + 서식으로 문단 추가.
    개조식 원칙: 서술형 어미(-임/-함/-됨 등 종결형) 대신 명사형/명사구로
    끝나는 문장을 권장 — 이 함수는 서식만 처리하고 문장 다듬기는 호출자 책임.

    depth: 문서 트리에서 실제로 몇 단계 들어가 있는지 (최상위 항목 = 0).
    레벨 번호가 아니라 depth 만큼 스페이스로 들여쓴다 — 레벨을 건너뛰어도
    (예: 2레벨 밑에 바로 4레벨) 부모보다 한 칸만 더 들어가야 하기 때문.
    """
    symbol_map = {
        1: lambda i: f"{i}.",
        2: lambda i: "□",
        3: lambda i: f"{i})",
        4: lambda i: "-",
        5: lambda i: "·",
    }
    p = doc.add_paragraph()
    rule = apply_paragraph_format(p, level)
    if after_table and level != "note":
        # 표 뒤 내용은 줄 앞간격 기본 8pt 로 재정의
        p.paragraph_format.space_before = Pt(8)

    prefix = INDENT_CHAR * depth
    if level in symbol_map and isinstance(text, tuple):
        idx, body = text
        prefix += f"{symbol_map[level](idx)} "
        text = body
    elif level == "note":
        # 주석은 꺾임기호(ㄴ, ㄱ) + Shift+Enter 로 표현
        marker, body = text if isinstance(text, tuple) else ("ㄴ", text)
        prefix += f"{marker} "
        text = body

    run = p.add_run(prefix + text)
    set_east_asian_font(run)
    run.font.size = Pt(rule["size"])
    run.bold = bold_override if bold_override is not None else rule["bold"]
    return p


def add_note_line(paragraph, text, marker="ㄴ"):
    """
    이미 존재하는 문단에 Shift+Enter(줄바꿈, 문단 아님)로 주석 라인 추가.
    별도 텍스트박스/각주/미주를 쓰지 않는 규칙을 지키기 위한 방식.
    """
    br = OxmlElement('w:br')
    paragraph._p.append(br)
    run = paragraph.add_run(f"{marker} {text}")
    set_east_asian_font(run)
    run.font.size = Pt(LEVEL_RULES["note"]["size"])
    return paragraph


# 한 항목의 내용이 길어서 줄을 나눠 써야 할 때, 둘째 줄부터는 첫째 줄의
# "텍스트가 시작되는 위치"에 맞춰 들여써서 시각적으로 정렬한다.
# 첫째 줄은 depth칸 만큼의 스페이스 + 기호(예: "- ", "· ")로 시작하는데,
# 이 기호+공백은 거의 항상 2글자이므로 들여쓰기 칸 수는 "depth + 2"가 된다
# (예: depth 1 항목이면 3칸, depth 2 항목이면 4칸). add_note_line(꺾임기호
# 주석)과는 다른 용도 — 이건 "주석"이 아니라 같은 내용이 이어지는 둘째 줄이다.
#
# 처음에는 Shift+Enter(같은 문단 안 줄바꿈)로 구현했으나, 실제 Word에서
# 폰트 폭이 렌더러마다 미세하게 달라 첫 줄 세그먼트가 예상보다 길면 그
# 안에서 또 자동 줄바꿈이 일어나 버렸다(들여쓰기 없는 셋째 줄 발생).
# 그래서 **완전히 별도의 문단(진짜 Enter)** 으로 바꿨다 — 문단을 나누면
# 그 문단이 설령 다시 자동 줄바꿈되더라도 문제가 겉으로 덜 드러나고,
# 무엇보다 실제 사용자가 손으로 교정한 결과물도 이 방식(별도 문단 +
# 앞부분 들여쓰기 스페이스, 대시 기호 없음)을 쓰고 있었다.
SYMBOL_WIDTH = 2  # "- ", "· ", "□ ", "ㄴ " 등 기호+공백 1칸의 폭(대부분 2글자)


def add_continuation_line(doc, paragraph, text, depth=0):
    """
    paragraph 바로 뒤에 새 문단을 삽입해 "같은 내용의 이어지는 줄"을
    표현한다 (Shift+Enter 아님, 진짜 문단 나눔). 기호(-, · 등) 없이
    depth+2칸 스페이스만 앞에 붙여 첫째 줄 텍스트 시작 위치에 맞춘다.
    문단 서식(줄간격 1.08배, 앞/뒤간격 8pt)과 폰트 크기·굵기는 앞
    문단의 마지막 run을 그대로 이어받는다.
    """
    last_run = paragraph.runs[-1] if paragraph.runs else None
    inherited_size = last_run.font.size if last_run is not None else None
    inherited_bold = last_run.bold if last_run is not None else None

    indent = " " * (depth + SYMBOL_WIDTH)
    new_p = doc.add_paragraph()
    paragraph._p.addnext(new_p._p)  # 문서 순서상 바로 다음 위치로 이동

    pf = new_p.paragraph_format
    pf.line_spacing = LINE_SPACING
    pf.space_before = Pt(8)
    pf.space_after = Pt(8)

    run = new_p.add_run(f"{indent}{text}")
    set_east_asian_font(run)
    if inherited_size is not None:
        run.font.size = inherited_size
    if inherited_bold is not None:
        run.bold = inherited_bold
    return new_p


def add_emphasis(paragraph, text):
    """강조 표현: 밑줄 + 굵게(Bold)."""
    run = paragraph.add_run(text)
    set_east_asian_font(run)
    run.bold = True
    run.underline = True
    return run


def add_title_meta(doc, text):
    """제목 아래 우측 정렬로 들어가는 날짜·작성부서 등 메타 정보 한 줄."""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p.paragraph_format.space_after = Pt(20)
    run = p.add_run(text)
    set_east_asian_font(run)
    run.font.size = Pt(14)
    return p


def add_table_caption(doc, text):
    """표 위에 붙는 표 제목 (가운데 정렬, 12pt) — 예: <시스템 장애 발생 로그>."""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.line_spacing = LINE_SPACING
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(8)
    run = p.add_run(text)
    set_east_asian_font(run)
    run.font.size = Pt(12)
    return p


def add_table_source_note(doc, text):
    """표 아래 붙는 표 설명/출처 표시 — '※ ...' 형식, 9pt, 들여쓰기 없음."""
    p = doc.add_paragraph()
    p.paragraph_format.line_spacing = LINE_SPACING
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(8)
    run = p.add_run(f"※ {text}")
    set_east_asian_font(run)
    run.font.size = Pt(9)
    return p


def add_end_marker(doc):
    """문서 맨 끝 관용 표시 '- 이 상 -' (우측 정렬)."""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p.paragraph_format.space_before = Pt(14)
    run = p.add_run("- 이 상 -")
    set_east_asian_font(run)
    run.font.size = Pt(12)
    return p


# 표 셀 정렬: 화폐·수치/문장 길이에 따라 정렬을 다르게 했더니 오히려
# 보기 나쁘다는 피드백이 있어서, 모든 셀(헤더 포함)을 예외 없이 가운데
# 정렬로 통일한다. 필요하면 나중에 다시 컬럼별로 바꿀 수 있게 셀 값을
# 넘겨받는 구조 자체는 남겨둔다.
HEADER_SHADE_HEX = "D9D9D9"  # 헤더 배경색 (밝은 회색), 글자는 검정


def _shade_cell(cell, hex_color):
    """표 셀 배경색 지정 (헤더 행을 어둡게 해서 제목/내용 구분을 준다)."""
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), hex_color)
    tcPr.append(shd)


def add_data_table(doc, headers, rows, col_widths_cm=None, caption=None, source_note=None):
    """
    데이터는 표로 표현 (그래프/그림 지양). caption은 표 위, source_note는 표 아래.

    모든 셀은 가운데 정렬로 통일한다. 헤더 행은 밝은 회색(#D9D9D9) 배경 + 검정 굵은
    글씨로 표시해 제목행과 데이터행을 시각적으로 구분한다.
    """
    if caption:
        add_table_caption(doc, caption)

    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    hdr_cells = table.rows[0].cells
    for i, h in enumerate(headers):
        hdr_cells[i].text = ""
        p = hdr_cells[i].paragraphs[0]
        p.paragraph_format.line_spacing = LINE_SPACING
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(str(h))
        set_east_asian_font(run)
        run.font.size = Pt(12)
        run.bold = True
        run.font.color.rgb = RGBColor(0x00, 0x00, 0x00)
        _shade_cell(hdr_cells[i], HEADER_SHADE_HEX)

    for row in rows:
        cells = table.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            p.paragraph_format.line_spacing = LINE_SPACING
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run(str(val))
            set_east_asian_font(run)
            run.font.size = Pt(11)

    if col_widths_cm:
        for i, w in enumerate(col_widths_cm):
            for row in table.rows:
                row.cells[i].width = Cm(w)

    if source_note:
        add_table_source_note(doc, source_note)

    return table


def _set_cell_border(cell, sz=8, color="000000"):
    """표 셀 사방에 실선 테두리를 준다 (목차 박스용)."""
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement('w:tcBorders')
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f'w:{edge}')
        el.set(qn('w:val'), 'single')
        el.set(qn('w:sz'), str(sz))
        el.set(qn('w:space'), '0')
        el.set(qn('w:color'), color)
        borders.append(el)
    tcPr.append(borders)


def add_toc_placeholder(doc, entries):
    """
    전사 공유 양식용 목차 페이지. 실무 관행대로 네모 박스를 페이지 가운데
    배치하고, 그 안에 "목차" 제목 + 1레벨 섹션 제목 목록을 실제 텍스트로
    적는다 (Word 필드 코드 방식은 미리보기에서 비어 보이고 F9를 눌러야
    채워지는 불편함이 있어, 실제 텍스트를 바로 넣는 방식으로 변경).

    entries: ["1. 글로벌 AI 시장 현황", "2. 2026년 핵심 기술 트렌드", ...]
             처럼 이미 번호가 붙은 1레벨 제목 문자열 리스트.
    """
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(60)

    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    box_width = Cm(9)
    table.columns[0].width = box_width
    cell = table.rows[0].cells[0]
    cell.width = box_width
    _set_cell_border(cell)

    # 셀 안쪽 여백을 조금 줘서 답답해 보이지 않게
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for edge, val in (("top", "200"), ("bottom", "200"), ("left", "300"), ("right", "300")):
        el = OxmlElement(f'w:{edge}')
        el.set(qn('w:w'), val)
        el.set(qn('w:type'), 'dxa')
        tcMar.append(el)
    tcPr.append(tcMar)

    title_p = cell.paragraphs[0]
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_p.paragraph_format.space_after = Pt(12)
    title_run = title_p.add_run("목차")
    set_east_asian_font(title_run)
    title_run.font.size = Pt(16)
    title_run.bold = True

    for entry in entries:
        p = cell.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.space_after = Pt(6)
        run = p.add_run(entry)
        set_east_asian_font(run)
        run.font.size = Pt(12)

    doc.add_page_break()


def _add_summary_line(doc, label, value):
    """
    요약 페이지 한 줄(목적/주장/결론) 추가. value는 문자열이거나,
    길어서 줄바꿈이 필요하면 {"text": "...", "wrap_lines": ["..."]} 형태로
    줄 수 있다 (섹션의 wrap_lines와 동일한 방식 — 별도 문단으로 이어붙임).
    """
    if isinstance(value, dict):
        text = value.get("text", "")
        wraps = value.get("wrap_lines", [])
    else:
        text = value
        wraps = []
    p = add_level_paragraph(doc, 4, (None, f"{label}: {text}"), depth=1)
    last_p = p
    for wrap_text in wraps:
        last_p = add_continuation_line(doc, last_p, wrap_text, depth=1)


def add_summary_page(doc, purpose, claim, conclusion):
    """전사 공유 양식: 첫 장 요약 페이지 (목적·주장·결론)."""
    add_level_paragraph(doc, 2, (None, "요약"), depth=0)
    _add_summary_line(doc, "목적", purpose)
    _add_summary_line(doc, "주장", claim)
    _add_summary_line(doc, "결론", conclusion)
    doc.add_page_break()


def setup_base_document(doc_type="general"):
    """
    doc_type: "general"(일반 양식) | "shared"(전사 공유 양식)
    전사 공유 양식은 여백을 최소화.
    """
    doc = Document()

    # 기본 스타일 폰트 지정 (Normal 스타일에도 바탕체 적용)
    style = doc.styles["Normal"]
    style.font.name = FONT_NAME
    style.font.size = Pt(14)
    rpr = style.element.get_or_add_rPr()
    rFonts = rpr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = OxmlElement('w:rFonts')
        rpr.append(rFonts)
    rFonts.set(qn('w:eastAsia'), FONT_NAME)

    section = doc.sections[0]
    if doc_type == "shared":
        # 정보 전달 최적화를 위한 최소 여백
        section.left_margin = Cm(1.5)
        section.right_margin = Cm(1.5)
        section.top_margin = Cm(1.5)
        section.bottom_margin = Cm(1.5)
    else:
        section.left_margin = Cm(2.0)
        section.right_margin = Cm(2.0)
        section.top_margin = Cm(2.0)
        section.bottom_margin = Cm(2.0)

    add_page_number_footer(doc)
    return doc


def build_from_spec(spec, out_path):
    """
    spec 예시는 references/spec_schema.md 참고.
    최소 구조:
    {
      "doc_type": "general" | "shared",
      "title": "문서 제목",
      "summary": {"purpose": "...", "claim": "...", "conclusion": "..."},  # shared일 때만 사용
      "sections": [
        {"level": 1, "text": "현안 개요", "children": [
            {"level": 2, "text": "배경"},
            {"level": 4, "text": "고객 문의 30% 증가", "emphasis": ["30%"]},
            {"table": {"headers": [...], "rows": [[...], ...]}},
            {"level": "note", "text": "세부 내역은 별첨 참고", "marker": "ㄴ"}
        ]}
      ]
    }
    """
    doc = setup_base_document(spec.get("doc_type", "general"))

    if spec.get("title"):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(spec["title"])
        set_east_asian_font(run)
        run.font.size = Pt(20)
        run.bold = True
        p.paragraph_format.space_after = Pt(20)

    if spec.get("meta"):
        add_title_meta(doc, spec["meta"])

    if spec.get("doc_type") == "shared":
        top_level_titles = [
            f"{idx}. {item['text']}"
            for idx, item in enumerate(
                (s for s in spec.get("sections", []) if s.get("level") == 1), start=1
            )
        ]
        add_toc_placeholder(doc, top_level_titles)
        summary = spec.get("summary")
        if summary:
            add_summary_page(
                doc,
                summary.get("purpose", ""),
                summary.get("claim", ""),
                summary.get("conclusion", ""),
            )

    def walk(items, counters, depth):
        for item in items:
            if "table" in item:
                add_data_table(
                    doc,
                    item["table"]["headers"],
                    item["table"]["rows"],
                    item["table"].get("col_widths_cm"),
                    caption=item["table"].get("caption"),
                    source_note=item["table"].get("source_note"),
                )
                continue

            level = item["level"]
            text = item["text"]
            after_table = item.get("after_table", False)

            if level in (1, 2, 3, 4, 5):
                counters[level] = counters.get(level, 0) + 1
                # 하위 레벨 진입 시 상위보다 깊은 레벨 카운터 초기화
                for deeper in range(level + 1, 6):
                    counters[deeper] = 0
                idx = counters[level]
                p = add_level_paragraph(doc, level, (idx, text), after_table=after_table, depth=depth)
            else:
                p = add_level_paragraph(doc, "note", (item.get("marker", "ㄴ"), text), depth=depth)

            # wrap_lines: 같은 내용이 길어서 줄만 나눠 쓰는 경우 (주석 아님).
            # 각 줄을 별도 문단으로 바로 뒤에 이어 붙이고, 이후 문단은 항상
            # 방금 추가한 문단 뒤로 이어져야 하므로 참조를 갱신해 나간다.
            # notes(꺾임기호 주석)보다 먼저 처리해서, 문장이 끝까지 이어진
            # 다음에 주석이 붙도록 한다 (주석이 문장 중간에 끼어들지 않게).
            last_p = p
            for wrap_text in item.get("wrap_lines", []):
                last_p = add_continuation_line(doc, last_p, wrap_text, depth=depth)

            for extra in item.get("notes", []):
                add_note_line(last_p, extra.get("text", extra) if isinstance(extra, dict) else extra,
                              extra.get("marker", "ㄴ") if isinstance(extra, dict) else "ㄴ")

            if item.get("children"):
                # depth는 레벨 번호가 아니라 실제 트리 깊이 기준 — 자식으로
                # 내려갈 때마다 딱 1씩만 늘린다 (레벨을 몇 단계 건너뛰어도 동일)
                walk(item["children"], counters, depth + 1)

    walk(spec.get("sections", []), {}, 0)

    # 문서 맨 끝 '- 이 상 -' 표시. 명시적으로 false를 주지 않는 한 기본으로 붙인다
    # (사내 문서 관행상 거의 항상 들어가는 마무리 표시이기 때문).
    if spec.get("end_marker", True):
        add_end_marker(doc)

    doc.save(out_path)
    return out_path


def main():
    if len(sys.argv) != 3:
        print("사용법: python3 build_doc.py <spec.json> <output.docx>")
        sys.exit(1)
    spec_path, out_path = sys.argv[1], sys.argv[2]
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    build_from_spec(spec, out_path)
    print(f"생성 완료: {out_path}")


if __name__ == "__main__":
    main()
