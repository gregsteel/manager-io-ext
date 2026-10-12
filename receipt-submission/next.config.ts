import type { NextConfig } from "next";

const buildCpus = Number(process.env.NEXT_BUILD_CPUS);

const nextConfig: NextConfig = {
  output: "standalone",
  // @napi-rs/canvas ships a native .node binary (loaded via a JS binding
  // shim) that neither Turbopack nor webpack can bundle into an ESM/CJS
  // chunk — keep it (and pdfjs-dist, which pulls it in for PDF-to-image
  // conversion, §6.2/§9.2) external so it's `require`d from node_modules at
  // runtime instead. `output: "standalone"` traces and copies the real
  // module (native binary included) into the standalone bundle regardless.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  // pdfjs's Node fallback ("fake worker") dynamically requires
  // pdf.worker.mjs by computed path rather than a static import, so
  // standalone output tracing doesn't discover it on its own — it built and
  // ran locally but 404'd on `Cannot find module '.../pdfjs-dist/legacy/
  // build/pdf.worker.mjs'` once deployed, because only pdf.mjs made it into
  // .next/standalone. Force the whole legacy/build directory along for the
  // one route that needs it.
  outputFileTracingIncludes: {
    "/api/send": ["./node_modules/pdfjs-dist/legacy/build/**"],
  },
  ...(Number.isFinite(buildCpus) && buildCpus > 0
    ? { experimental: { cpus: buildCpus } }
    : {}),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
