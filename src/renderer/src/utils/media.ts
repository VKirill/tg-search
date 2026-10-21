/** Display URL for a local file path (Electron) or inline data URL (mock). */
export function mediaDisplayUrl(filePath: string): string {
  if (/^(data:|https?:|blob:)/i.test(filePath)) return filePath;
  return `tgmedia://local/${encodeURIComponent(filePath)}`;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}
