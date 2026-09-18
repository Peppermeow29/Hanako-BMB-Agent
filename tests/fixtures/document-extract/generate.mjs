// 重新生成文档抽取测试用的样本文件。产物已提交进仓库，这个脚本是它们的复现凭据：
// 想改样本内容或补新格式时改这里再跑一次，不要手工编辑二进制产物。
//
//   node tests/fixtures/document-extract/generate.mjs
//
// 仅供本地开发使用，不参与 CI 与打包。样本内容一律是通用英文示例。

import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const outDir = path.dirname(fileURLToPath(import.meta.url));

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function write(name, data) {
  const target = path.join(outDir, name);
  fs.writeFileSync(target, data);
  process.stdout.write(`wrote ${name} (${data.length} bytes)\n`);
}

// ---------------------------------------------------------------- docx

async function buildDocx() {
  const zip = new JSZip();

  zip.file("[Content_Types].xml", `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + "</Types>");

  zip.file("_rels/.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + "</Relationships>");

  zip.file("word/_rels/document.xml.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + "</Relationships>");

  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

  zip.file("word/styles.xml", `${XML_HEADER}<w:styles ${w}>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
    + '<w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
    + "</w:styles>");

  const cell = (text) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>`
    + `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const row = (a, b) => `<w:tr>${cell(a)}${cell(b)}</w:tr>`;

  zip.file("word/document.xml", `${XML_HEADER}<w:document ${w}><w:body>`
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Notes</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">This paragraph has </w:t></w:r>'
    + "<w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>"
    + '<w:r><w:t xml:space="preserve"> text in it.</w:t></w:r></w:p>'
    + '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
    + `${row("Region", "Total")}${row("North", "120")}`
    + "</w:tbl>"
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>'
    + "</w:body></w:document>");

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------- xlsx

async function buildXlsx() {
  const zip = new JSZip();

  zip.file("[Content_Types].xml", `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + "</Types>");

  zip.file("_rels/.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + "</Relationships>");

  const main = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

  zip.file("xl/workbook.xml", `${XML_HEADER}<workbook ${main} ${rel}>`
    + '<sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets>'
    + "</workbook>");

  zip.file("xl/_rels/workbook.xml.rels", `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    + "</Relationships>");

  const strings = ["Region", "Total", "North"];
  zip.file("xl/sharedStrings.xml", `${XML_HEADER}<sst ${main} count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.map((value) => `<si><t>${value}</t></si>`).join("")
    + "</sst>");

  zip.file("xl/worksheets/sheet1.xml", `${XML_HEADER}<worksheet ${main}><sheetData>`
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>120</v></c></row>'
    + "</sheetData></worksheet>");

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------- pdf

// 最小 PDF：把对象体依次拼起来，边拼边记录每个对象的字节偏移，最后按偏移写 xref 表。
// 手写而不是引依赖，是为了让"扫描件"样本真的只有图片、没有任何文字算子。
function buildPdf(objectBodies) {
  const chunks = [];
  const offsets = [];
  let cursor = 0;

  const push = (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
    chunks.push(buf);
    cursor += buf.length;
  };

  push("%PDF-1.4\n");
  objectBodies.forEach((body, index) => {
    offsets.push(cursor);
    push(`${index + 1} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  });

  const xrefOffset = cursor;
  const size = objectBodies.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

function streamObject(dictExtras, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "latin1");
  return Buffer.concat([
    Buffer.from(`<< ${dictExtras} /Length ${body.length} >>\nstream\n`, "latin1"),
    body,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

function buildTextPdf() {
  const content = "BT\n/F1 24 Tf\n72 700 Td\n(Hello from PDF) Tj\n0 -32 Td\n(Second line of text) Tj\nET\n";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    streamObject("", content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]);
}

function buildScannedPdf() {
  // 4 像素的灰度图，页面内容流里只有画图指令，一个文字算子都没有——扫描件就是这个形状。
  const pixels = Buffer.from([0x20, 0x60, 0xa0, 0xe0]);
  const content = "q\n400 0 0 500 100 200 cm\n/Im0 Do\nQ\n";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    streamObject("", content),
    streamObject("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8", pixels),
  ]);
}

// ---------------------------------------------------------------- main

write("sample.docx", await buildDocx());
write("sample.xlsx", await buildXlsx());
write("sample.csv", Buffer.from("Region,Total\nNorth,120\nSouth,95\n", "utf-8"));
write("sample-text.pdf", buildTextPdf());
write("sample-scanned.pdf", buildScannedPdf());
