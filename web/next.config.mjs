import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(webDirectory, "..");

// Keep the existing root environment file as the single source of truth.
config({ path: path.join(repositoryRoot, ".env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: repositoryRoot,
  serverExternalPackages: [
    "@langchain/anthropic",
    "@langchain/core",
    "@langchain/openai",
    "deepagents",
    "langchain",
    "pdfkit",
    "sharp",
    "ws"
  ],
  webpack(webpackConfig) {
    // The agent uses NodeNext-style `.js` specifiers in TypeScript source.
    // Resolve those specifiers to source files while bundling the web route.
    webpackConfig.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"]
    };
    return webpackConfig;
  }
};

export default nextConfig;
