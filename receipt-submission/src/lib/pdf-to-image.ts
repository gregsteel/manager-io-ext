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

// Cap on the stacked image height so long PDFs still fit the canvas and 8 MB limits.
const MAX_STACKED_HEIGHT = 16000;

/**
 * Renders every page of a PDF, stacked vertically, into one JPEG via
 * pdfjs-dist + @napi-rs/canvas — both pure npm packages with prebuilt
 * binaries (incl. linux-musl), so this needs no system packages in the
 * Docker image. The app models one JPEG per receipt row, so pages are
 * combined into a single tall image. Multi-page PDFs are scaled down as
 * needed to stay under MAX_STACKED_HEIGHT.
 *
 * pdfjs is imported dynamically (not at module scope) so routes that never
 * see a PDF upload don't pay its parse cost.
 */
export async function renderPdfToJpeg(
  pdfBytes: Buffer,
): Promise<ConvertedPdfImage> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
  });

  try {
    const doc = await loadingTask.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) pages.push(await doc.getPage(n));

    const unit = pages.map((p) => p.getViewport({ scale: 1 }));
    const heightAtUnit = unit.reduce((sum, v) => sum + v.height, 0);
    const scale = Math.min(RENDER_SCALE, MAX_STACKED_HEIGHT / heightAtUnit);
    const viewports = pages.map((p) => p.getViewport({ scale }));

    const width = Math.ceil(Math.max(...viewports.map((v) => v.width)));
    const height = Math.ceil(viewports.reduce((sum, v) => sum + v.height, 0));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    let y = 0;
    for (let i = 0; i < pages.length; i++) {
      const viewport = viewports[i];
      const pageCanvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      // @napi-rs/canvas's context is a structural, not nominal, match for
      // pdfjs's expected CanvasRenderingContext2D — this is the documented
      // way to pair the two outside a browser. `canvas: null` tells pdfjs to
      // render via canvasContext directly rather than requiring a real
      // HTMLCanvasElement (backward-compat path, per pdfjs's own docs).
      await pages[i].render({
        canvas: null,
        canvasContext: pageCanvas.getContext("2d") as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      ctx.drawImage(pageCanvas, Math.floor((width - pageCanvas.width) / 2), Math.floor(y));
      y += viewport.height;
    }
    const bytes = canvas.toBuffer("image/jpeg", JPEG_QUALITY);
    return { bytes, mimeType: "image/jpeg" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read PDF: ${detail}`);
  } finally {
    await loadingTask.destroy();
  }
}
