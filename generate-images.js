const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = __dirname;
const SOURCE_ROOT = String.raw`C:\Users\Jovans\Downloads\Rust Assets\Rust Assets\RUST ICONS .PNG`;
const TARGET_ROOT = path.join(PROJECT_ROOT, "data", "itemimages");

const FOLDERS = [
  "Ammo",
  "Attire",
  "Components",
  "Construction",
  "Electrical",
  "Food",
  "Fun",
  "Items",
  "Medical",
  "Misc",
  "Resources",
  "Tools",
  "Traps",
  "Weapons"
];

const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeFolderName(folderName) {
  return String(folderName)
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "-")
    .replace(/\s+/g, "-");
}

function copyFolder(folderName) {
  const sourceDir = path.join(SOURCE_ROOT, folderName);
  const targetDir = path.join(TARGET_ROOT, normalizeFolderName(folderName));

  if (!fs.existsSync(sourceDir)) {
    console.log(`Missing source folder: ${sourceDir}`);
    return 0;
  }

  ensureDir(targetDir);

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  let copied = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED.has(ext)) continue;

    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);

    fs.copyFileSync(from, to);
    copied++;
  }

  console.log(`${folderName} -> ${targetDir} : copied ${copied}`);
  return copied;
}

ensureDir(TARGET_ROOT);

let total = 0;

for (const folder of FOLDERS) {
  total += copyFolder(folder);
}

console.log(`Done. Total copied: ${total}`);
console.log(`Images stored in: ${TARGET_ROOT}`);