import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type PdfSection = { heading: string; lines: string[] };

const FOREST = rgb(0.106, 0.263, 0.196); // #1B4332
const GRAY = rgb(0.35, 0.35, 0.35);

/**
 * Render a simple, paginated report PDF (MODULE_SPEC.md §6) — used for filed
 * injury/incident reports and the postable weekly schedule. Dependency: pdf-lib (pure JS).
 */
export async function renderReportPdf(opts: {
  title: string;
  subtitle?: string;
  sections: PdfSection[];
  footer?: string;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 612, H = 792, M = 56;
  let page = doc.addPage([W, H]);
  let y = H - M;

  const newPageIfNeeded = (need: number) => {
    if (y - need < M) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };
  const wrap = (text: string, size: number, maxW: number): string[] => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  };

  page.drawText(opts.title, { x: M, y, size: 18, font: bold, color: FOREST });
  y -= 24;
  if (opts.subtitle) {
    page.drawText(opts.subtitle, { x: M, y, size: 10, font, color: GRAY });
    y -= 18;
  }
  y -= 6;

  for (const section of opts.sections) {
    newPageIfNeeded(28);
    page.drawText(section.heading, { x: M, y, size: 12, font: bold, color: FOREST });
    y -= 18;
    for (const line of section.lines) {
      for (const wrapped of wrap(line, 10, W - 2 * M)) {
        newPageIfNeeded(14);
        page.drawText(wrapped, { x: M, y, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
        y -= 14;
      }
    }
    y -= 10;
  }

  if (opts.footer) {
    page.drawText(opts.footer, { x: M, y: M - 24, size: 8, font, color: GRAY });
  }

  return doc.save();
}
