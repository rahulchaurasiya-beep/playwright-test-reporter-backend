/**
 * Generate aws-s3-artifacts.pdf from aws-s3-artifacts.html
 *
 * Run from automation-tests-2.0:
 *   pnpm exec node ../playwright-reporter-backend/docs/generate-aws-s3-pdf.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, "aws-s3-artifacts.html");
const pdfPath = path.join(__dirname, "aws-s3-artifacts.pdf");

const playwrightTestEntry = path.join(
  __dirname,
  "../../automation-tests-2.0/node_modules/@playwright/test/index.mjs",
);
const { chromium } = await import(pathToFileURL(playwrightTestEntry).href);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
await page.waitForFunction(
  () => document.querySelectorAll(".mermaid svg").length >= 2,
  { timeout: 30000 },
);

await page.pdf({
  path: pdfPath,
  format: "A4",
  printBackground: true,
  margin: { top: "16mm", right: "14mm", bottom: "16mm", left: "14mm" },
});

await browser.close();
console.log(`PDF written to: ${pdfPath}`);
