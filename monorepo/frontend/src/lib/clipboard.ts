const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

export interface PastedImage {
  file: File;
  filename: string;
}

/** Return the first image file in a clipboard payload, with a stable extension. */
export function pastedImage(data: DataTransfer | null, now = Date.now()): PastedImage | null {
  if (!data) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const inferred = item.type.slice("image/".length).replace(/[^a-z0-9]/gi, "");
    const extension = IMAGE_EXTENSIONS[item.type] ?? (inferred || "png");
    return { file, filename: `pasted-image-${now}.${extension}` };
  }
  return null;
}
