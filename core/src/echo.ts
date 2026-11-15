/**
 * Stands in for a brain until Hermes is connected (FAM-24): "heard: <text>". A number n as text
 * asks for a reply of n bytes, up to 8000.
 */
export function echo(text: string): string {
	const heard = `heard: ${text}`;
	const size = /^\d+$/.test(text) ? Math.min(Number(text), 8000) : 0;
	if (size <= heard.length) return heard;
	return `${heard}\n${"familiar ".repeat(Math.ceil(size / 9))}`.slice(0, size);
}
