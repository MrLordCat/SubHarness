import * as assert from "node:assert";
import { chatImageFileName } from "../chat/image-file";

suite("chat image file", () => {
	test("maps image extensions and falls back to bin", () => {
		for (const [mime, extension] of [["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"], ["image/bmp", "bmp"], ["image/svg+xml", "svg"], ["unknown", "bin"]]) {
			assert.strictEqual(chatImageFileName("key", mime), `key.${extension}`);
		}
	});

	test("sanitizes and caps the key", () => {
		assert.strictEqual(chatImageFileName("../a:b /", "image/png"), ".._a_b__.png");
		assert.strictEqual(chatImageFileName("x".repeat(130), "image/png"), `${"x".repeat(120)}.png`);
	});
});
