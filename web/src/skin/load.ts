import { readSkin, type Skin } from "./skin";

/**
 * Gets the pixels out of a skin PNG.
 *
 * <p>Through a canvas, which is the only way a browser will hand over the
 * pixels of an image. Nearest neighbour is forced off the drawing path by
 * drawing at the image's own size, so no smoothing invents colours that are
 * not in the file -- a skin is sixty-four texels wide and every one of them
 * matters.
 */
async function pixelsOf(source: Blob): Promise<Skin> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) {
      throw new Error("This browser would not open a canvas to read the skin with.");
    }
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return readSkin(data.data, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** Reads a skin the user picked or dropped. */
export async function skinFromFile(file: File): Promise<Skin> {
  if (!/\.png$/i.test(file.name) && file.type !== "image/png") {
    throw new Error("A skin is a PNG.");
  }
  return pixelsOf(file);
}

/** Reads a skin the server fetched from Mojang, which arrives base64 encoded. */
export async function skinFromBase64(png: string): Promise<Skin> {
  const binary = atob(png);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return pixelsOf(new Blob([bytes], { type: "image/png" }));
}
