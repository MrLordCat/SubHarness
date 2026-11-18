/** Fixed-height virtual list geometry: heights may change, offsets rebuild lazily. */
export class VirtualLayout {
	private readonly estimatedHeight: number;
	private readonly heights: number[] = [];
	private readonly offsets: number[] = [0];
	private count = 0;
	/** offsets[0..validTo] are up to date; later offsets are recomputed on demand. */
	private validTo = 0;

	constructor(estimatedHeight: number) {
		this.estimatedHeight = Number.isFinite(estimatedHeight) && estimatedHeight > 0 ? estimatedHeight : 40;
	}

	setCount(count: number): void {
		const target = Math.max(0, Math.floor(count));
		if (target === this.count) {
			return;
		}
		if (target < this.count) {
			this.heights.length = target;
			this.count = target;
			this.offsets.length = Math.min(this.offsets.length, target + 1);
			this.validTo = Math.min(this.validTo, target);
			return;
		}
		this.ensureOffsets(this.count);
		for (let index = this.count; index < target; index += 1) {
			this.heights.push(this.estimatedHeight);
			this.offsets.push(this.offsets[index] + this.estimatedHeight);
		}
		this.count = target;
		this.validTo = target;
	}

	setHeight(index: number, height: number): boolean {
		if (!Number.isInteger(index) || index < 0 || index >= this.count) {
			return false;
		}
		const next = Number.isFinite(height) && height > 0 ? height : 0;
		if (this.heights[index] === next) {
			return false;
		}
		this.heights[index] = next;
		this.validTo = Math.min(this.validTo, index);
		return true;
	}

	offsetOf(index: number): number {
		if (this.count === 0) {
			return 0;
		}
		const target = Number.isFinite(index) ? Math.max(0, Math.min(Math.floor(index), this.count)) : 0;
		this.ensureOffsets(target);
		return this.offsets[target];
	}

	get totalHeight(): number {
		this.ensureOffsets(this.count);
		return this.offsets[this.count];
	}

	indexAt(offset: number): number {
		if (this.count === 0) {
			return 0;
		}
		this.ensureOffsets(this.count);
		const target = Number.isFinite(offset) ? Math.max(0, offset) : 0;
		if (target >= this.offsets[this.count]) {
			return this.count - 1;
		}
		let low = 0;
		let high = this.count - 1;
		while (low < high) {
			const middle = low + Math.floor((high - low) / 2);
			if (this.offsets[middle + 1] <= target) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		return low;
	}

	/** end is exclusive. */
	range(scrollTop: number, viewportHeight: number, overscan: number): { start: number; end: number } {
		if (this.count === 0) {
			return { start: 0, end: 0 };
		}
		const margin = Number.isFinite(overscan) ? Math.max(0, overscan) : 0;
		const top = Math.max(0, scrollTop - margin);
		const bottom = Math.max(top, scrollTop + Math.max(0, viewportHeight) + margin);
		return { start: this.indexAt(top), end: Math.min(this.count, this.indexAt(bottom) + 1) };
	}

	private ensureOffsets(index: number): void {
		const end = Math.min(index, this.count);
		if (this.validTo >= end) {
			return;
		}
		for (let current = this.validTo + 1; current <= end; current += 1) {
			this.offsets[current] = this.offsets[current - 1] + this.heights[current - 1];
		}
		this.validTo = end;
	}
}
