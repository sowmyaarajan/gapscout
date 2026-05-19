// One-time recon script: decodes the Claude artifact bundle at
// C:\Users\Sowmya.Rajan\Downloads\GapScout-standalone.html and writes its
// unwrapped HTML / styles / scripts to ./extracted/ for inspection.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SRC = "C:\\Users\\Sowmya.Rajan\\Downloads\\GapScout-standalone.html";
const OUT_DIR = path.join(process.cwd(), "extracted");
fs.mkdirSync(OUT_DIR, { recursive: true });

const html = fs.readFileSync(SRC, "utf8");

function extractScript(typeAttr) {
  const re = new RegExp(`<script[^>]*type="${typeAttr}"[^>]*>([\\s\\S]*?)</script>`, "i");
  const m = html.match(re);
  return m ? m[1] : null;
}

const templateRaw = extractScript("__bundler/template");
const manifestRaw = extractScript("__bundler/manifest");
const extResRaw   = extractScript("__bundler/ext_resources");

if (!templateRaw || !manifestRaw) {
  console.error("Could not find bundler template/manifest scripts");
  process.exit(1);
}

let template = JSON.parse(templateRaw);
const manifest = JSON.parse(manifestRaw);
const extRes = extResRaw ? JSON.parse(extResRaw) : [];

console.log("Manifest assets:", Object.keys(manifest).length);
console.log("Template size (chars):", template.length);
console.log("External resources:", extRes.length);

// Build asset summary
const assetSummary = Object.entries(manifest).map(([uuid, e]) => ({
  uuid,
  mime: e.mime,
  compressed: !!e.compressed,
  sizeB64: e.data?.length ?? 0,
}));
fs.writeFileSync(
  path.join(OUT_DIR, "manifest-summary.json"),
  JSON.stringify({ assets: assetSummary, extRes }, null, 2)
);

// Replace UUIDs with placeholders we can read (don't substitute real blob URLs — just for inspection)
for (const uuid of Object.keys(manifest)) {
  const tag = `__ASSET[${uuid.slice(0, 8)}|${manifest[uuid].mime}]__`;
  template = template.split(uuid).join(tag);
}

// Write the full unwrapped template
fs.writeFileSync(path.join(OUT_DIR, "artifact-template.html"), template);

// Pull out style blocks
const styles = [...template.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join("\n\n/* ===== next style block ===== */\n\n");
fs.writeFileSync(path.join(OUT_DIR, "artifact-styles.css"), styles);

// Pull out script blocks (these are likely text/babel JSX)
const scripts = [...template.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
  .map((m, i) => `/* ===== script #${i} attrs:${m[1].trim()} ===== */\n${m[2]}`)
  .join("\n\n");
fs.writeFileSync(path.join(OUT_DIR, "artifact-scripts.jsx"), scripts);

// Body skeleton without scripts/styles for layout-only inspection
const skeleton = template
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "<!-- STYLE -->")
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "<!-- SCRIPT -->");
fs.writeFileSync(path.join(OUT_DIR, "artifact-skeleton.html"), skeleton);

// If any text-mime assets are gzipped, decompress and write a sample
let textAssetCount = 0;
for (const [uuid, e] of Object.entries(manifest)) {
  if (!e.mime || (!e.mime.startsWith("text/") && !e.mime.includes("json") && !e.mime.includes("javascript") && !e.mime.includes("css"))) continue;
  try {
    let bytes = Buffer.from(e.data, "base64");
    if (e.compressed) bytes = zlib.gunzipSync(bytes);
    const fname = `asset-${uuid.slice(0, 8)}.${e.mime.split("/")[1].split("+")[0]}`;
    fs.writeFileSync(path.join(OUT_DIR, fname), bytes);
    textAssetCount++;
  } catch (err) {
    console.warn("could not decode asset", uuid, err.message);
  }
}

console.log(`\nWrote to ${OUT_DIR}:`);
console.log("  manifest-summary.json");
console.log("  artifact-template.html  (full unwrapped)");
console.log("  artifact-skeleton.html  (layout only, no styles/scripts)");
console.log("  artifact-styles.css     (all <style> blocks concatenated)");
console.log("  artifact-scripts.jsx    (all <script> blocks concatenated)");
console.log(`  ${textAssetCount} decoded text assets`);
