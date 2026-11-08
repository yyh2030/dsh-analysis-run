"""07 · 本地三线表渲染：把 results.json 里的表写成 DOCX 与 XLSX。

原则：
  - 三线表结构 = 顶线、表头下线、底线；无竖线、无行内横线；
  - Word 表可编辑，多页重复表头；Excel 保持同样的数值与边框，表头冻结；
  - 数值不在渲染时重算，只做显示格式化；缺失写 "—"。
用法：
    python office_export.py --results <results.json> --out <目录>
输出：<目录>/tables.docx、<目录>/tables.xlsx，stdout 打印一行 JSON。
"""
import argparse
import json
import os
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Cm
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, Side

INTEGER_KEYS = {'subjects', 'n', 'observations', 'validObservations', 'missing', 'df', 'count', 'denominator'}


def display(key, value):
    if value is None or value == '':
        return '—'
    if key in ('p', 'p-value'):
        if not isinstance(value, (int, float)):
            return str(value)
        if value < 0.001:
            return '< .001'
        if value > 0.999:
            return '> .999'
        text = f'{value:.3f}'
        return text[1:] if text.startswith('0') else text
    if key == 'percent' and isinstance(value, (int, float)):
        return f'{value:.1f}%'
    if isinstance(value, bool):
        return '是' if value else '否'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # 整数列只在数值确实是整数时按整数显示；Welch df 之类的浮点自由度保留小数。
        if key in INTEGER_KEYS and float(value).is_integer():
            return str(int(value))
        text = f'{value:.2f}'
        return '0.00' if text == '-0.00' else text
    return str(value)


def numeric_format(key):
    if key in ('p', 'p-value'):
        return '0.0000'
    if key == 'percent':
        return '0.0"%"'
    if key in INTEGER_KEYS:
        return '0'
    return '0.00'


def analysis_set(table, results):
    return table.get('analysisSet') or results.get('analysisSet') or {}


def three_line_table(doc, table, results):
    columns = table['columns']
    rows = table['rows']
    caption = doc.add_paragraph()
    caption.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = caption.add_run(f"表 {table['number']}  {table['title']['zh']}  {table['title']['en']}")
    run.bold = True
    run.font.size = Pt(10.5)
    meta = doc.add_paragraph()
    scope = analysis_set(table, results)
    meta_run = meta.add_run(
        f"分析集：{scope.get('subset', '—')} · n={scope.get('subjects', '—')} · "
        f"观测={scope.get('observations', '—')} · 来源版本：{str(table.get('sourceHash') or '—')[:12]}")
    meta_run.font.size = Pt(8.5)
    grid = doc.add_table(rows=1, cols=len(columns))
    grid.alignment = WD_TABLE_ALIGNMENT.CENTER
    grid.autofit = True
    # 表头：中文一行 + 英文一行
    header = grid.rows[0]
    trPr = header._tr.get_or_add_trPr()
    tblHeader = OxmlElement('w:tblHeader')
    tblHeader.set(qn('w:val'), 'true')
    trPr.append(tblHeader)
    numeric_columns = {column['key'] for column in columns
                       if any(isinstance(row.get(column['key']), (int, float)) and not isinstance(row.get(column['key']), bool) for row in rows)}
    for index, column in enumerate(columns):
        cell = header.cells[index]
        cell.text = ''
        paragraph = cell.paragraphs[0]
        zh = paragraph.add_run(column['zh'])
        zh.bold = True
        zh.font.size = Pt(9.5)
        paragraph.add_run('\n')
        en = paragraph.add_run(column['en'])
        en.font.size = Pt(8)
        # 表头与数值列用同一种对齐（居中），避免"表头靠左、数字靠右"的错位。
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER if column['key'] in numeric_columns else WD_ALIGN_PARAGRAPH.LEFT
    for row in rows:
        cells = grid.add_row().cells
        for index, column in enumerate(columns):
            value = row.get(column['key'])
            cells[index].text = display(column['key'], value)
            paragraph = cells[index].paragraphs[0]
            numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER if numeric else WD_ALIGN_PARAGRAPH.LEFT
            for run in paragraph.runs:
                run.font.size = Pt(9)
    # 三线：整表只留顶线与底线；表头行加下边框；无竖线、无内部横线。
    tbl = grid._tbl
    tblPr = tbl.tblPr
    borders = OxmlElement('w:tblBorders')
    for edge, size in (('top', '12'), ('bottom', '12'), ('left', '0'), ('right', '0'), ('insideH', '0'), ('insideV', '0')):
        element = OxmlElement(f'w:{edge}')
        element.set(qn('w:val'), 'single' if size != '0' else 'none')
        element.set(qn('w:sz'), size)
        element.set(qn('w:color'), '000000')
        borders.append(element)
    tblPr.append(borders)
    for cell in header.cells:
        tcPr = cell._tc.get_or_add_tcPr()
        tcBorders = OxmlElement('w:tcBorders')
        bottom = OxmlElement('w:bottom')
        bottom.set(qn('w:val'), 'single')
        bottom.set(qn('w:sz'), '8')
        bottom.set(qn('w:color'), '000000')
        tcBorders.append(bottom)
        tcPr.append(tcBorders)
    for note in table.get('notes', []):
        paragraph = doc.add_paragraph()
        note_run = paragraph.add_run(note)
        note_run.font.size = Pt(8.5)
    doc.add_paragraph()


def build_docx(results, path):
    doc = Document()
    style = doc.styles['Normal']
    style.font.name = 'Times New Roman'
    style.font.size = Pt(10)
    style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
    title = doc.add_heading(results.get('study', {}).get('name') or '研究报告', level=1)
    subtitle = doc.add_paragraph(
        f"运行 {results.get('runId')} · 结果版本 {results.get('version')} · "
        f"分析集 {results.get('analysisSet', {}).get('subset')} · 独立人数 {results.get('analysisSet', {}).get('subjects', '—')}")
    subtitle.runs[0].font.size = Pt(8.5)
    for table in results.get('tables', []):
        three_line_table(doc, table, results)
    doc.save(path)


def build_xlsx(results, path):
    workbook = Workbook()
    default = workbook.active
    workbook.remove(default)
    thin = Side(style='thin', color='000000')
    none_side = Side(style=None)
    for table in results.get('tables', []):
        sheet = workbook.create_sheet(title=str(table['key'])[:31] or 'Table')
        columns = table['columns']
        sheet.cell(row=1, column=1, value=f"表 {table['number']}  {table['title']['zh']} / {table['title']['en']}").font = Font(bold=True, size=11)
        scope = analysis_set(table, results)
        sheet.cell(row=2, column=1, value=f"分析集：{scope.get('subset', '—')} · n={scope.get('subjects', '—')} · 观测={scope.get('observations', '—')} · 来源版本：{str(table.get('sourceHash') or '—')[:12]}").font = Font(size=8, color='666666')
        header_row = 4
        numeric_keys = set()
        for row in table['rows']:
            for column in columns:
                value = row.get(column['key'])
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    numeric_keys.add(column['key'])
        for index, column in enumerate(columns, start=1):
            cell = sheet.cell(row=header_row, column=index, value=column['zh'])
            cell.font = Font(bold=True, size=9)
            cell.alignment = Alignment(horizontal='center' if column['key'] in numeric_keys else 'left', vertical='bottom')
            en = sheet.cell(row=header_row + 1, column=index, value=column['en'])
            en.font = Font(size=8, color='666666')
        for offset, row in enumerate(table['rows'], start=1):
            for index, column in enumerate(columns, start=1):
                value = row.get(column['key'])
                numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
                if numeric and column['key'] not in ('p', 'p-value'):
                    # 数值单元格保留数值类型，用 number_format 控制显示；不把格式化字符串当数据。
                    cell = sheet.cell(row=header_row + 1 + offset, column=index, value=float(value))
                    cell.number_format = numeric_format(column['key'])
                else:
                    cell = sheet.cell(row=header_row + 1 + offset, column=index, value=display(column['key'], value))
                cell.font = Font(size=9)
                cell.alignment = Alignment(horizontal='center' if numeric else 'left')
        last_row = header_row + 1 + len(table['rows'])
        for column_index in range(1, len(columns) + 1):
            top = sheet.cell(row=header_row, column=column_index)
            top.border = Border(top=thin, bottom=thin, left=none_side, right=none_side)
            sheet.cell(row=header_row + 1, column=column_index).border = Border(top=thin, bottom=none_side, left=none_side, right=none_side)
            sheet.cell(row=last_row, column=column_index).border = Border(bottom=thin, top=none_side, left=none_side, right=none_side)
        for column_index, column in enumerate(columns, start=1):
            width = max(len(column['zh']) * 2 + 2, 10)
            sheet.column_dimensions[sheet.cell(row=header_row, column=column_index).column_letter].width = min(28, width)
        sheet.freeze_panes = sheet.cell(row=header_row + 2, column=1)
        note_row = last_row + 2
        for note in table.get('notes', []):
            sheet.cell(row=note_row, column=1, value=note).font = Font(size=8, color='666666')
            note_row += 1
    workbook.save(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--results', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    with open(args.results, encoding='utf-8-sig') as handle:
        results = json.load(handle)
    os.makedirs(args.out, exist_ok=True)
    docx_path = os.path.join(args.out, 'tables.docx')
    xlsx_path = os.path.join(args.out, 'tables.xlsx')
    try:
        build_docx(results, docx_path)
        build_xlsx(results, xlsx_path)
    except Exception as error:  # 导出失败要明确，不覆盖已完成交付物
        print('===JSON===')
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
    print('===JSON===')
    print(json.dumps({'ok': True, 'docx': docx_path, 'xlsx': xlsx_path, 'tables': len(results.get('tables', []))}, ensure_ascii=False))


if __name__ == '__main__':
    main()
