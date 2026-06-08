const sharp = require("sharp");
const path = require("path");

const sizes = [16, 32, 48, 128];
const src = path.join(__dirname, "icon.svg");

(async () => {
  for (const size of sizes) {
    await sharp(src)
      .resize(size, size)
      .png()
      .toFile(path.join(__dirname, `icon${size}.png`));
    console.log(`icon${size}.png`);
  }
})();
