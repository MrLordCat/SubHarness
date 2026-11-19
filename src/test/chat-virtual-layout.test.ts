import * as assert from "node:assert";
import { VirtualLayout } from "../chat/shared/virtual-layout";

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

suite("Chat virtual layout", () => {
	test("computes offsets and total height from estimates", () => {
		const layout = new VirtualLayout(80);
		layout.setCount(3);
		assert.strictEqual(layout.offsetOf(0), 0);
		assert.strictEqual(layout.offsetOf(1), 80);
		assert.strictEqual(layout.offsetOf(2), 160);
		assert.strictEqual(layout.offsetOf(3), 240);
		assert.strictEqual(layout.totalHeight, 240);
	});

	test("height changes move the offsets that follow", () => {
		const layout = new VirtualLayout(80);
		layout.setCount(3);
		assert.strictEqual(layout.setHeight(0, 120), true);
		assert.deepStrictEqual([0, 1, 2, 3].map(index => layout.offsetOf(index)), [0, 120, 200, 280]);
		assert.strictEqual(layout.totalHeight, 280);
		assert.strictEqual(layout.setHeight(0, 120), false);
		assert.strictEqual(layout.setHeight(2, 40), true);
		assert.deepStrictEqual([0, 1, 2, 3].map(index => layout.offsetOf(index)), [0, 120, 200, 240]);
		assert.strictEqual(layout.setHeight(-1, 10), false);
		assert.strictEqual(layout.setHeight(3, 10), false);
	});

	test("lazily rebuilds the prefix after a change in the middle", () => {
		const layout = new VirtualLayout(100);
		layout.setCount(5);
		assert.strictEqual(layout.offsetOf(5), 500);
		assert.strictEqual(layout.setHeight(2, 300), true);
		assert.strictEqual(layout.offsetOf(1), 100);
		assert.strictEqual(layout.offsetOf(2), 200);
		assert.strictEqual(layout.offsetOf(3), 500);
		assert.strictEqual(layout.offsetOf(5), 700);
		assert.strictEqual(layout.totalHeight, 700);
	});

	test("indexAt finds the item containing the offset and clamps at both ends", () => {
		const layout = new VirtualLayout(100);
		layout.setCount(4);
		assert.strictEqual(layout.indexAt(-10), 0);
		assert.strictEqual(layout.indexAt(0), 0);
		assert.strictEqual(layout.indexAt(99.9), 0);
		assert.strictEqual(layout.indexAt(100), 1);
		assert.strictEqual(layout.indexAt(199.9), 1);
		assert.strictEqual(layout.indexAt(200), 2);
		assert.strictEqual(layout.indexAt(399.9), 3);
		assert.strictEqual(layout.indexAt(400), 3);
		assert.strictEqual(layout.indexAt(5000), 3);
	});

	test("range applies overscan and clamps to the list", () => {
		const layout = new VirtualLayout(100);
		layout.setCount(10);
		assert.deepStrictEqual(layout.range(0, 250, 0), { start: 0, end: 3 });
		assert.deepStrictEqual(layout.range(500, 200, 100), { start: 4, end: 9 });
		assert.deepStrictEqual(layout.range(900, 300, 100), { start: 8, end: 10 });
		assert.deepStrictEqual(layout.range(0, 100, 500), { start: 0, end: 7 });
		assert.deepStrictEqual(layout.range(-100, 100, 100), { start: 0, end: 2 });
	});

	test("setCount grows with estimates and shrinks without stale heights", () => {
		const layout = new VirtualLayout(50);
		layout.setCount(2);
		assert.strictEqual(layout.totalHeight, 100);
		assert.strictEqual(layout.setHeight(1, 100), true);
		assert.strictEqual(layout.totalHeight, 150);
		layout.setCount(3);
		assert.strictEqual(layout.totalHeight, 200);
		assert.strictEqual(layout.setHeight(2, 20), true);
		assert.strictEqual(layout.totalHeight, 170);
		layout.setCount(1);
		assert.strictEqual(layout.totalHeight, 50);
		assert.strictEqual(layout.offsetOf(5), 50);
		layout.setCount(2);
		assert.strictEqual(layout.totalHeight, 100);
		layout.setCount(-4);
		assert.strictEqual(layout.totalHeight, 0);
	});

	test("ignores zero and invalid heights so the item stays reachable", () => {
		const layout = new VirtualLayout(100);
		layout.setCount(4);
		assert.strictEqual(layout.setHeight(0, 300), true);
		assert.strictEqual(layout.setHeight(0, 0), false);
		assert.strictEqual(layout.setHeight(1, -5), false);
		assert.strictEqual(layout.setHeight(2, Number.NaN), false);
		assert.strictEqual(layout.setHeight(3, Number.POSITIVE_INFINITY), false);
		assert.deepStrictEqual([0, 1, 2, 3, 4].map(index => layout.offsetOf(index)), [0, 300, 400, 500, 600]);
		assert.deepStrictEqual(layout.range(0, 100, 0), { start: 0, end: 1 });
	});

	test("empty list reports zero size and an empty range", () => {
		const layout = new VirtualLayout(80);
		assert.strictEqual(layout.totalHeight, 0);
		assert.strictEqual(layout.offsetOf(0), 0);
		assert.strictEqual(layout.indexAt(100), 0);
		assert.deepStrictEqual(layout.range(0, 600, 100), { start: 0, end: 0 });
		assert.strictEqual(layout.setHeight(0, 10), false);
	});

	test("5000 random heights stay consistent after lazy rebuilds", () => {
		const random = seededRandom(7);
		const layout = new VirtualLayout(80);
		const count = 5000;
		const heights: number[] = [];
		layout.setCount(count);
		for (let index = 0; index < count; index += 1) {
			let height = 20 + Math.floor(random() * 200);
			if (height === 80) {
				height += 1;
			}
			heights.push(height);
			assert.strictEqual(layout.setHeight(index, height), true);
		}
		let sum = 0;
		for (let index = 0; index < count; index += 1) {
			sum += heights[index];
			assert.strictEqual(layout.offsetOf(index + 1), sum);
			assert.strictEqual(layout.offsetOf(index + 1) - layout.offsetOf(index), heights[index]);
		}
		assert.strictEqual(layout.totalHeight, sum);

		const touched = [4999, 0, 2500, 1234, 2500];
		for (const index of touched) {
			heights[index] += 10 + Math.floor(random() * 400);
			assert.strictEqual(layout.setHeight(index, heights[index]), true);
		}
		let running = 0;
		for (let index = 0; index < count; index += 1) {
			running += heights[index];
			assert.strictEqual(layout.offsetOf(index + 1), running);
		}
		assert.strictEqual(layout.totalHeight, running);
		assert.strictEqual(layout.indexAt(running - 0.1), count - 1);
		assert.strictEqual(layout.indexAt(running + 1000), count - 1);
	});
});
