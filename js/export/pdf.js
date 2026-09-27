// PDF export (Section 10.1) with our own paginator on top of html2canvas + jsPDF.
// Each block (title, summary-table chunk, report card) is rendered on its own,
// so a card never splits: it moves whole to the next page when it does not fit.
// A card taller than a page continues on the next page(s) under "<Name> — continued",
// cutting only between paragraphs / photo rows.
import { CONFIG } from '../config.js?v=9';
import { el, fmtDateTime, isoDay, mapLimit } from '../lib.js?v=9';
import { buildCard, buildContinued, buildTitleBlock, buildSummaryTable } from './card.js?v=9';

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 15;
const CONTENT_TOP = 22;      // below the running header band
const CONTENT_BOTTOM = 282;  // above the running footer
const CSS_W = 720;           // rendering width of blocks in CSS px
const MM_PER_PX = (PAGE_W - 2 * MARGIN) / CSS_W;
const CONTENT_H = (CONTENT_BOTTOM - CONTENT_TOP) / MM_PER_PX; // in CSS px
const GAP = 18;
const SCALE = 1.6;           // canvas pixels per CSS px (sharpness vs. file size)
const MAX_CANVAS_H = 16000;
const TABLE_CHUNK = 28;
const JPEG_Q = 0.82;

const INK = [30, 43, 58];
const ACCENT = [47, 93, 138];
const BAND = [230, 238, 246];
const MUTED = [95, 107, 120];

/**
 * @param opts.reports       report rows (with body_html, projects(name), report_photos)
 * @param opts.filterParts   [[label, value], …] for the summary line
 * @param opts.loadPhotos    async (report) => Blob[] in display order
 * @param opts.onProgress    (done, total) => void
 * @returns Blob (application/pdf)
 */
export async function buildPdf({ reports, filterParts, loadPhotos, onProgress = () => {} }) {
  await document.fonts.ready;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const exportedAt = fmtDateTime(new Date());
  const stage = el('div', { class: 'pdf-stage', 'aria-hidden': 'true' });
  document.body.append(stage);

  let page = 1;
  let cursor = 0; // CSS px used on the current page
  drawChrome(doc, page, exportedAt);

  const newPage = () => {
    doc.addPage();
    page += 1;
    cursor = 0;
    drawChrome(doc, page, exportedAt);
  };

  const drawSlice = (shot, fromPx, toPx) => {
    const k = shot.canvas.width / CSS_W;
    const sy = Math.round(fromPx * k);
    const sh = Math.max(1, Math.round((toPx - fromPx) * k));
    const c = document.createElement('canvas');
    c.width = shot.canvas.width;
    c.height = sh;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(shot.canvas, 0, sy, c.width, sh, 0, 0, c.width, sh);
    doc.addImage(c.toDataURL('image/jpeg', JPEG_Q), 'JPEG',
      MARGIN, CONTENT_TOP + cursor * MM_PER_PX, CSS_W * MM_PER_PX, (toPx - fromPx) * MM_PER_PX,
      undefined, 'FAST');
    cursor += toPx - fromPx;
    c.width = 0;
  };

  const place = async (shot, continuedNode) => {
    const h = shot.height;
    if (h <= CONTENT_H - cursor) {
      drawSlice(shot, 0, h);
    } else if (h <= CONTENT_H) {
      newPage();
      drawSlice(shot, 0, h);
    } else {
      // Taller than a full page: start on a fresh page and cut at safe points.
      if (cursor > 0) newPage();
      let cont = null;
      let start = 0;
      while (start < h - 0.5) {
        if (start > 0) {
          cont ??= await snap(stage, continuedNode);
          drawSlice(cont, 0, cont.height);
        }
        const avail = CONTENT_H - cursor;
        const fits = shot.breaks.filter((b) => b > start + 1 && b - start <= avail);
        const end = fits.length ? Math.max(...fits) : Math.min(start + avail, h);
        drawSlice(shot, start, end);
        start = end;
        if (start < h - 0.5) newPage();
      }
      cont?.canvas && (cont.canvas.width = 0);
    }
    cursor += GAP;
    shot.canvas.width = 0; // release memory
  };

  try {
    // Page 1: title, filter summary, summary table (in chunks that never split).
    await place(await snap(stage, buildTitleBlock(CONFIG.APP_NAME, filterParts)));
    const showDate = spansDays(reports);
    for (let i = 0; i < reports.length; i += TABLE_CHUNK) {
      await place(await snap(stage, buildSummaryTable(reports.slice(i, i + TABLE_CHUNK), i, showDate)));
    }

    for (let i = 0; i < reports.length; i++) {
      const r = reports[i];
      const blobs = await loadPhotos(r);
      const photos = await mapLimit(blobs, 4, async (blob) => {
        const src = URL.createObjectURL(blob);
        try {
          const bmp = await createImageBitmap(blob);
          const dims = { w: bmp.width, h: bmp.height };
          bmp.close?.();
          return { src, ...dims };
        } catch {
          return { src };
        }
      });
      try {
        const shot = await snap(stage, buildCard(r, { photos, lang: 'en' }));
        await place(shot, buildContinued(r, 'en'));
      } finally {
        photos.forEach((p) => URL.revokeObjectURL(p.src));
      }
      onProgress(i + 1, reports.length);
    }
    return doc.output('blob');
  } finally {
    stage.remove();
  }
}

function spansDays(reports) {
  return new Set(reports.map((r) => isoDay(r.submitted_at))).size > 1;
}

/** Renders one block off-screen and records the y positions where it may be cut. */
async function snap(stage, node) {
  stage.replaceChildren(node);
  // Not img.decode(): it never settles while the tab is in the background.
  await Promise.all([...node.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 15000);
  }))));
  const top = node.getBoundingClientRect().top;
  const height = Math.ceil(node.getBoundingClientRect().height);
  const breaks = [...node.querySelectorAll('[data-break], .rbody > *, .rbody li')]
    .map((n) => Math.ceil(n.getBoundingClientRect().bottom - top))
    .concat(height)
    .sort((a, b) => a - b);
  const scale = Math.min(SCALE, MAX_CANVAS_H / Math.max(1, height));
  const canvas = await withUnhintedText(() => window.html2canvas(node, {
    scale, backgroundColor: '#ffffff', logging: false, useCORS: true,
    width: CSS_W, windowWidth: 1280,
  }));
  return { canvas, height, breaks };
}

// html2canvas draws each word at the position the browser laid it out, but canvas text at
// small sizes uses hinted (rounded-up) letter widths, so words overrun the spaces between
// them ("Cablepullingcompleted"). Drawing the text 4× larger under a 1/4 transform gives
// unhinted widths that match the page layout.
async function withUnhintedText(render) {
  const proto = CanvasRenderingContext2D.prototype;
  const original = proto.fillText;
  const F = 4;
  proto.fillText = function fillText(text, x, y, maxWidth) {
    const m = /([\d.]+)px/.exec(this.font);
    if (!m) return original.call(this, text, x, y, maxWidth);
    const font = this.font;
    this.save();
    this.scale(1 / F, 1 / F);
    this.font = font.replace(m[0], `${parseFloat(m[1]) * F}px`);
    original.call(this, text, x * F, y * F);
    this.restore();
    this.font = font;
    return undefined;
  };
  try {
    return await render();
  } finally {
    proto.fillText = original;
  }
}

function drawChrome(doc, page, exportedAt) {
  // Running header band with a thin accent line under it.
  doc.setFillColor(...BAND);
  doc.rect(MARGIN, 8, PAGE_W - 2 * MARGIN, 8.5, 'F');
  doc.setFillColor(...ACCENT);
  doc.rect(MARGIN, 16.5, PAGE_W - 2 * MARGIN, 0.6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(...INK);
  doc.text(CONFIG.APP_NAME, MARGIN + 3, 13.6);

  // Running footer.
  doc.setDrawColor(185, 201, 218);
  doc.setLineWidth(0.2);
  doc.line(MARGIN, PAGE_H - 11.5, PAGE_W - MARGIN, PAGE_H - 11.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(`Exported: ${exportedAt}`, MARGIN, PAGE_H - 7);
  doc.text(`Page ${page}`, PAGE_W - MARGIN, PAGE_H - 7, { align: 'right' });
}
