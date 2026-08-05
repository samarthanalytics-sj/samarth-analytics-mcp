// Native Word .docx export of the verification results, with each proof screenshot embedded as a REAL
// binary media part (/word/media/imageN.jpeg) referenced through the OOXML relationships. This is the
// format that survives an upload to Google Docs WITH its images — the HTML-based .doc uses `data:` URI
// images, which Google Docs strips on import (so the screenshots vanish). Zero-dependency: the .docx ZIP is
// assembled with Node's zlib (deflate) + a tiny ZIP writer, so no npm install is needed.

import { deflateRawSync } from 'node:zlib';
import type { VerifyExportPayload } from '../../shared/ipc';

const EMU_PER_PX = 9525; // 914400 EMU per inch ÷ 96 px per inch
const MAX_CX = 5486400; // cap image width at 6 inches so a 1200px clip fits the page
const IMG_DATA_URI = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=\s]+)$/i;

// House rule: no em/en dashes at any export boundary.
const nd = (s: string): string => (s ?? '').replace(/[—–]/g, '-');
const esc = (s: string): string =>
  nd(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- tiny ZIP writer (deflate) ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
interface ZipEntry { name: string; data: Buffer }
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const comp = deflateRawSync(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// --- JPEG / PNG pixel size (for the drawing EMU extent) --------------------------------------------------
function imageSize(buf: Buffer): { w: number; h: number } {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; // PNG
    if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: walk to a SOF marker
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* fall through */ }
  return { w: 1200, h: 900 };
}

const para = (runs: string, before = 60): string =>
  `<w:p><w:pPr><w:spacing w:before="${before}" w:after="0"/></w:pPr>${runs}</w:p>`;
const textRun = (t: string, bold: boolean, sz: number): string =>
  `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const imagePara = (rid: string, cx: number, cy: number, id: number): string =>
  `<w:p><w:pPr><w:spacing w:before="60" w:after="120"/></w:pPr><w:r><w:drawing>`
  + `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
  + `<wp:docPr id="${id}" name="Proof ${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
  + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
  + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
  + `<pic:nvPicPr><pic:cNvPr id="${id}" name="Proof ${id}"/><pic:cNvPicPr/></pic:nvPicPr>`
  + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
  + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
  + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`
  + `</wp:inline></w:drawing></w:r></w:p>`;

/** Build a self-contained .docx (Buffer) of the verification results with each proof screenshot embedded as
 *  a real image part — so the document, uploaded to Google Docs, shows the screenshots. */
export function buildVerifyResultsDocx(payload: VerifyExportPayload): Buffer {
  const rows = payload.rows ?? [];
  const c = payload.counts;
  const media: ZipEntry[] = [];
  const rels: string[] = [];
  const body: string[] = [];

  body.push(para(textRun(`Tag Verification${payload.url ? ' - ' + payload.url : ''}`, true, 32), 0));
  const summary = [`Fired: ${c.fired}`, `Issues: ${c.issues}`, `Untested: ${c.untested}`,
    c.config ? `Config: ${c.config}` : '', c.server ? `Server: ${c.server}` : ''].filter(Boolean).join('    ');
  body.push(para(textRun(summary, false, 20)));
  if (payload.authoritative) body.push(para(textRun('Authoritative - read from the real Tag Assistant debug stream.', false, 18)));

  let imgN = 0;
  for (const r of rows) {
    body.push(para(textRun(`${r.status} - ${r.tag}`, true, 24), 200));
    const meta = [r.triggerEvent && `Event: ${r.triggerEvent}`, r.trigger && `Trigger: ${r.trigger}`,
      r.firedVia && `Fired via: ${r.firedVia}`, r.signal && `Signal: ${r.signal}`].filter(Boolean).join('    .    ');
    if (meta) body.push(para(textRun(meta, false, 18)));
    const m = r.screenshot ? IMG_DATA_URI.exec(r.screenshot) : null;
    if (m) {
      imgN += 1;
      const ext = m[1].toLowerCase() === 'png' ? 'png' : 'jpeg';
      const data = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      media.push({ name: `word/media/image${imgN}.${ext}`, data });
      const rid = `rId${100 + imgN}`;
      rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imgN}.${ext}"/>`);
      const { w, h } = imageSize(data);
      const cx = Math.min(Math.round(w * EMU_PER_PX), MAX_CX);
      const cy = Math.max(1, Math.round(cx * (h / Math.max(1, w))));
      body.push(imagePara(rid, cx, cy, imgN));
    } else {
      body.push(para(textRun('(no proof image for this tag)', false, 18)));
    }
  }

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<w:body>${body.join('')}`
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
    + '</w:body></w:document>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + rels.join('') + '</Relationships>';

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf8') },
    ...media,
  ]);
}
