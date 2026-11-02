/**
 * One-off migration: the covers move from PNG to lossless WebP (public/assets/covers/<id>.webp),
 * no larger than twice their biggest display size. Each WebP is compared with
 * its PNG at the same size (PSNR): below MIN_PSNR the PNG is kept and listed.
 *
 *   node scripts/migrations/covers-to-webp.js --dry-run
 *   node scripts/migrations/covers-to-webp.js            (writes the WebP, keeps the PNG)
 *   node scripts/migrations/covers-to-webp.js --delete   (then removes the converted PNG)
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { COVERS_DIR, toCoverWebp } = require('../../helpers/game-covers');

const DRY_RUN = process.argv.includes('--dry-run');
const DELETE = process.argv.includes('--delete');
// 40 dB and more: differences invisible to the eye
const MIN_PSNR = 40;

// Peak signal-to-noise ratio of the WebP against the PNG scaled to its size, on RGBA
async function psnr(png, webp) {
  const target = await sharp(webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = target.info;
  const source = await sharp(png).rotate().resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    const diff = source[i] - target.data[i];
    sum += diff * diff;
  }
  const mse = sum / source.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

async function main() {
  const files = fs.readdirSync(COVERS_DIR).filter(f => f.endsWith('.png')).sort();
  let before = 0;
  let after = 0;
  const kept = [];
  const scores = [];
  for (const file of files) {
    const pngFile = path.join(COVERS_DIR, file);
    const webpFile = pngFile.replace(/\.png$/, '.webp');
    const png = fs.readFileSync(pngFile);
    const webp = await toCoverWebp(png);
    const score = await psnr(png, webp);
    scores.push(score);
    if (score < MIN_PSNR) {
      kept.push(`${file} (${score.toFixed(1)} dB)`);
      continue;
    }
    before += png.length;
    after += webp.length;
    if (DRY_RUN) continue;
    fs.writeFileSync(webpFile, webp);
    if (DELETE) fs.unlinkSync(pngFile);
  }
  scores.sort((a, b) => a - b);
  const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  console.log(`${files.length} PNG, ${files.length - kept.length} convertis : ${mb(before)} → ${mb(after)}`);
  console.log(`PSNR : min ${scores[0]?.toFixed(1)} dB, médiane ${scores[Math.floor(scores.length / 2)]?.toFixed(1)} dB`);
  if (kept.length) console.log(`Gardés en PNG (sous ${MIN_PSNR} dB) :\n  ${kept.join('\n  ')}`);
  if (DRY_RUN) console.log('(dry-run : rien écrit)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
