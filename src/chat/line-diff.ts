/** Counts changed lines, ignoring line-ending style. */
export function lineDiff(before: string, after: string): { added: number; removed: number } {
	const lines = (text: string): string[] => text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
	let a = lines(before), b = lines(after);
	// Edits are usually local: the unchanged head and tail keep the LCS small and exact.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) { start++; }
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) { end++; }
	a = a.slice(start, a.length - end);
	b = b.slice(start, b.length - end);
	if (a.length * b.length > 4_000_000 || a.length > 20_000 || b.length > 20_000) {
		const counts = new Map<string, number>();
		for (const line of a) { counts.set(line, (counts.get(line) ?? 0) + 1); }
		let common = 0;
		for (const line of b) {
			const count = counts.get(line) ?? 0;
			if (count > 0) { common++; counts.set(line, count - 1); }
		}
		return { added: b.length - common, removed: a.length - common };
	}
	let previous = new Uint32Array(b.length + 1);
	for (const line of a) {
		const current = new Uint32Array(b.length + 1);
		for (let j = 1; j <= b.length; j++) {
			current[j] = line === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
		}
		previous = current;
	}
	const common = previous[b.length];
	return { added: b.length - common, removed: a.length - common };
}
