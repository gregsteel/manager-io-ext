import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Receipt Submission",
    short_name: "Receipts",
    description: "Capture a receipt and save it on the server.",
    start_url: "/",
    display: "standalone",
    background_color: "#e8eef2",
    theme_color: "#e8eef2",
    orientation: "portrait",
    icons: [
      {
        src: "/icon",
        sizes: "32x32",
        type: "image/png",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}
