/* ============================================================
   XLSX прямо из браузера
   ============================================================
   Зачем свой генератор: страница обязана открываться у колонны,
   где интернета может не быть, — значит библиотеку с CDN не подтянуть.
   А гонять файл через питоновский конвертер ради оформления —
   лишний шаг, о котором забудешь ровно тогда, когда он нужен.

   .xlsx — это zip с несколькими xml. Сжатие не обязательно:
   кладём файлы как есть (метод store), это законный zip.
   Журнал погона — десятки килобайт, экономить нечего.

   Пользоваться:
     XLSX.save('имя.xlsx', [{name, cols, merges, freeze, rows}])
   Ячейка: {v, t:'n'|'s'|'f', s:стиль} либо просто число или строка.
   ============================================================ */
(function(){
"use strict";

/* ---------- CRC32: нужен zip-у для каждой записи ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++){
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf){
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const enc = s => new TextEncoder().encode(s);

/* ---------- Сборка zip без сжатия ---------- */
function zip(files){
  const parts = [], central = [];
  let off = 0;

  const u16 = n => [n & 255, (n >> 8) & 255];
  const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

  files.forEach(f => {
    const name = enc(f.name), data = f.data;
    const crc = crc32(data);
    const local = [].concat(
      u32(0x04034b50), u16(20), u16(0), u16(0),
      u16(0), u16(0),                       // время и дата — нули, Excel не против
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0));
    parts.push(new Uint8Array(local), name, data);

    central.push([].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0),
      u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(off)));
    off += local.length + name.length + data.length;
  });

  const cdir = [];
  central.forEach((c, i) => {
    cdir.push(...c);
    cdir.push(...enc(files[i].name));
  });
  const cd = new Uint8Array(cdir);
  const end = new Uint8Array([].concat(
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(cd.length), u32(off), u16(0)));

  let total = 0;
  parts.forEach(p => total += p.length);
  const out = new Uint8Array(total + cd.length + end.length);
  let p = 0;
  parts.forEach(a => { out.set(a, p); p += a.length; });
  out.set(cd, p); p += cd.length;
  out.set(end, p);
  return out;
}

/* ---------- Экранирование для xml ---------- */
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Excel не откроет файл с управляющими символами внутри
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

/* Номер колонки → буква: 1→A, 27→AA */
function col(n){
  let s = '';
  while (n > 0){ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

/* ============================================================
   СТИЛИ
   Набор фиксированный: под журнал погона его хватает, а собирать
   стили динамически — это отдельная библиотека, которая здесь
   не нужна.
   ============================================================ */
const S = {
  PLAIN:0, TITLE:1, SECTION:2, LABEL:3, INPUT:4, CALC:5, UNIT:6, HEAD:7,
  CELL:8, CELL2:9, CELL3:10, TEXT:11, NUM0:12, PCT:13, TEMP:14, DT:15,
  // фазы идут подряд, PHASE0 + индекс
  PHASE0:16
};
const PHASES = ['Прогрев','Стабилизация','Головы','Подголовники','Тело','Хвосты','Стоп'];
const PHASE_BG = ['E8EAED','DCE9F2','F8DDD9','FBEED5','DEEDE4','F0E2D2','D9D9D9'];

/* Давление — один знак после запятой. Такого формата среди готовых не было:
   TEMP даёт 0.00, CELL2 целое.
   Стиль кладётся ПОСЛЕ всех фазовых, иначе сдвинулся бы PHASE0 и фазы
   перекрасились бы. Индекс поэтому считается от их числа, а не пишется
   числом: добавят фазу — он поедет сам. Каждая фаза даёт ДВА стиля,
   обычный и текстовый (для колонки примечания), отсюда множитель. */
S.PRESS = S.PHASE0 + PHASE_BG.length * 2;
const HDR_BG = '1F3864', CALC_BG = 'EDF3E7', IN_BG = 'FFF6D9';

function styles(){
  const fills = ['<fill><patternFill patternType="none"/></fill>',
                 '<fill><patternFill patternType="gray125"/></fill>'];
  const fillId = {};
  [HDR_BG, CALC_BG, IN_BG].concat(PHASE_BG).forEach(c => {
    fillId[c] = fills.length;
    fills.push('<fill><patternFill patternType="solid"><fgColor rgb="FF' + c +
               '"/><bgColor indexed="64"/></patternFill></fill>');
  });

  const fonts = [
    '<font><sz val="11"/><name val="Calibri"/></font>',                          // 0 обычный
    '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',// 1 белый жирный
    '<font><b/><sz val="10"/><name val="Calibri"/></font>',                       // 2 жирный мелкий
    '<font><b/><sz val="11"/><color rgb="FF1F6B3B"/><name val="Calibri"/></font>',// 3 зелёный жирный
    '<font><sz val="9"/><color rgb="FF808080"/><name val="Calibri"/></font>',     // 4 серый мелкий
    '<font><b/><sz val="9"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>', // 5 белый мелкий
    '<font><sz val="10"/><name val="Calibri"/></font>'                            // 6 обычный мелкий
  ];

  // Свои числовые форматы. ΔT со знаком — чтобы «минус полградуса»
  // читался как минус, а не терялся среди цифр.
  const numFmts = [
    '<numFmt numFmtId="164" formatCode="0.00"/>',
    '<numFmt numFmtId="165" formatCode="+0.000;-0.000;0.000"/>',
    '<numFmt numFmtId="166" formatCode="# ##0"/>',
    '<numFmt numFmtId="167" formatCode="0.0%"/>',
    '<numFmt numFmtId="168" formatCode="0.000"/>',
    '<numFmt numFmtId="169" formatCode="0.0"/>'
  ];

  const B = '<border><left style="thin"><color rgb="FFBFBFBF"/></left>' +
            '<right style="thin"><color rgb="FFBFBFBF"/></right>' +
            '<top style="thin"><color rgb="FFBFBFBF"/></top>' +
            '<bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>';
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>', B];

  const C = (f, fl, b, nf, al) =>
    '<xf numFmtId="' + (nf || 0) + '" fontId="' + f + '" fillId="' + (fl || 0) +
    '" borderId="' + (b || 0) + '" xfId="0" applyFont="1" applyFill="1" applyBorder="1"' +
    (nf ? ' applyNumberFormat="1"' : '') +
    (al ? ' applyAlignment="1">' + al + '</xf>' : '/>');

  const CEN = '<alignment horizontal="center" vertical="center"/>';
  const RIG = '<alignment horizontal="right" vertical="center"/>';
  const LEF = '<alignment horizontal="left" vertical="center"/>';
  const WRP = '<alignment horizontal="center" vertical="center" wrapText="1"/>';

  const xf = [
    C(0),                                              // 0 PLAIN
    C(1, fillId[HDR_BG], 0, 0, CEN),                   // 1 TITLE
    C(5, fillId[HDR_BG], 0, 0, CEN),                   // 2 SECTION
    C(2, 0, 0, 0, RIG),                                // 3 LABEL
    C(2, fillId[IN_BG], 1, 0, CEN),                    // 4 INPUT
    C(3, fillId[CALC_BG], 1, 0, CEN),                  // 5 CALC
    C(4, 0, 0, 0, LEF),                                // 6 UNIT
    C(5, fillId[HDR_BG], 1, 0, WRP),                   // 7 HEAD
    C(6, 0, 1, 0, CEN),                                // 8 CELL
    C(6, 0, 1, 166, CEN),                              // 9 CELL2 целое
    C(6, 0, 1, 168, CEN),                              // 10 CELL3 три знака
    C(6, 0, 1, 0, LEF),                                // 11 TEXT
    C(3, fillId[CALC_BG], 1, 166, CEN),                // 12 NUM0 расчёт целое
    C(3, fillId[CALC_BG], 1, 167, CEN),                // 13 PCT расчёт процент
    C(6, 0, 1, 164, CEN),                              // 14 TEMP 0.00
    C(6, 0, 1, 165, CEN)                               // 15 DT ±0.000
  ];
  // Фазы: те же ячейки, но с заливкой
  PHASE_BG.forEach(c => xf.push(C(6, fillId[c], 1, 0, CEN)));
  // И текстовый вариант фазовой заливки для примечания
  PHASE_BG.forEach(c => xf.push(C(6, fillId[c], 1, 0, LEF)));
  // S.PRESS — строго последним, см. комментарий у его объявления
  xf.push(C(6, 0, 1, 169, CEN));

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="' + numFmts.length + '">' + numFmts.join('') + '</numFmts>' +
    '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts>' +
    '<fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
    '<borders count="' + borders.length + '">' + borders.join('') + '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + xf.length + '">' + xf.join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/* ---------- Лист ---------- */
function sheetXml(sh){
  // Порядок элементов в worksheet — строгая последовательность, и Excel
  // её проверяет: sheetViews, потом cols, потом sheetData, потом
  // autoFilter и только затем mergeCells. openpyxl такой файл читает
  // молча, а Excel отказывается открывать «повреждённую книгу».
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

  // 1. Закрепление шапки
  if (sh.freeze){
    const m = /^([A-Z]+)(\d+)$/.exec(sh.freeze);
    if (m){
      const xs = m[1].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const ys = +m[2] - 1;
      x += '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
           '<pane xSplit="' + xs + '" ySplit="' + ys + '" topLeftCell="' + sh.freeze +
           '" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>';
    }
  }

  // 2. Ширины колонок
  if (sh.cols && sh.cols.length){
    x += '<cols>';
    sh.cols.forEach((w, i) => {
      x += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w +
           '" customWidth="1"/>';
    });
    x += '</cols>';
  }

  // 3. Данные
  x += '<sheetData>';
  (sh.rows || []).forEach((row, ri) => {
    if (!row) return;
    const r = ri + 1;
    x += '<row r="' + r + '"' + (sh.heights && sh.heights[ri]
        ? ' ht="' + sh.heights[ri] + '" customHeight="1"' : '') + '>';
    row.forEach((cell, ci) => {
      if (cell === null || cell === undefined || cell === '') return;
      const c = (typeof cell === 'object') ? cell : {v: cell};
      const ref = col(ci + 1) + r;
      const st = c.s ? ' s="' + c.s + '"' : '';
      if (c.v === '' || c.v === null || c.v === undefined){
        // Пустая, но со стилем: так тянется заливка заголовка раздела
        x += '<c r="' + ref + '"' + st + '/>';
      } else if (c.t === 'f'){
        x += '<c r="' + ref + '"' + st + '><f>' + esc(c.v) + '</f></c>';
      } else if (c.t === 'n' || (c.t === undefined && typeof c.v === 'number')){
        x += '<c r="' + ref + '"' + st + '><v>' + c.v + '</v></c>';
      } else {
        // inlineStr: без общей таблицы строк файл проще и меньше кода
        x += '<c r="' + ref + '" t="inlineStr"' + st +
             '><is><t xml:space="preserve">' + esc(c.v) + '</t></is></c>';
      }
    });
    x += '</row>';
  });
  x += '</sheetData>';

  // 4. Фильтр — строго до объединений
  if (sh.filter) x += '<autoFilter ref="' + sh.filter + '"/>';
  if (sh.merges && sh.merges.length){
    x += '<mergeCells count="' + sh.merges.length + '">' +
         sh.merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>';
  }
  x += '</worksheet>';
  return x;
}

function build(sheets){
  const files = [];
  const add = (name, str) => files.push({name, data: enc(str)});

  add('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
      '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');

  add('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');

  add('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => '<sheet name="' + esc(s.name || ('Лист' + (i + 1))) +
      '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
    '</sheets></workbook>');

  add('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
      (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (sheets.length + 1) +
    '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');

  add('xl/styles.xml', styles());
  sheets.forEach((s, i) => add('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s)));

  return zip(files);
}

function save(name, sheets){
  const data = build(sheets);
  const blob = new Blob([data], {type:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const api = {build, save, S, PHASES, PHASE_BG, col};
if (typeof window !== 'undefined') window.XLSX = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
