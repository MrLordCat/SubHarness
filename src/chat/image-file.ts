const extensions: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
};

/** A safe file name for a chat image: the key with unsafe characters replaced, cut to 120 characters, and an extension from the MIME type. */
export function chatImageFileName(key: string, mimeType: string): string {
	return `${key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.${extensions[mimeType] ?? "bin"}`;
}
