import { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Alepes",
    short_name: "Alepes",
    description: "Your money, moving together.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b1322",
    theme_color: "#0b1322",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}