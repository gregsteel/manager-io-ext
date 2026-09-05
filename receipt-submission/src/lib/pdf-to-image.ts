import { createCanvas } from "@napi-rs/canvas";

export type ConvertedPdfImage = {
  bytes: Buffer;
  mimeType: string;
};

// PDF units are 72/inch, so scale = target-DPI / 72. 144 DPI (scale 2) looked
// visibly blurry/aliased for dense invoice text once rendered; 600 DPI gives
// a comfortable margin over the usual 300 DPI "good enough" bar for small
// print, and a single mostly-white text page is still well under the 8 MB
// cap at this quality (a few hundred KB in practice).
const RENDER_SCALE = 600 / 72;
const JPEG_QUALITY = 0.92;

/**
 * Renders a PDF's first page to a JPEG via pdfjs-dist + @napi-rs/canvas —
 * both pure npm packages with prebuilt binaries (incl. linux-musl), so this
 * needs no system packages (poppler/ImageMagick) in the Docker image.
 *
 * Only the first page is rendered: receipts/invoices that arrive as PDF
 * (emailed statements, exported bills) are single-page in practice, and the
 * rest of the app models one JPEG per receipt row — there's nowhere to put
 * a second page.
 *
 * pdfjs is imported dynamically (not at module scope) so routes that never
 * see a PDF upload don't pay its parse cost.
 */
export async function renderPdfFirstPageToJpeg(
  pdfBytes: Buffer,
): Promise<ConvertedPdfImage> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
  });

  try {
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    // @napi-rs/canvas's context is a structural, not nominal, match for
    // pdfjs's expected CanvasRenderingContext2D — this is the documented
    // way to pair the two outside a browser. `canvas: null` tells pdfjs to
    // render via canvasContext directly rather than requiring a real
    // HTMLCanvasElement (backward-compat path, per pdfjs's own docs).
    await page.render({
      canvas: null,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const bytes = canvas.toBuffer("image/jpeg", JPEG_QUALITY);
    return { bytes, mimeType: "image/jpeg" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read PDF: ${detail}`);
  } finally {
    await loadingTask.destroy();
  }
}
