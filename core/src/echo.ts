import type { Brain } from "./brain/chat.ts";

/**
 * Stands in for a brain to test the transport (`familiar --echo`): "heard: <text>". A number n
 * as text asks for a reply of n bytes, up to 8000.
 */
export function echo(text: string): string {
	const heard = `heard: ${text}`;
	const size = /^\d+$/.test(text) ? Math.min(Number(text), 8000) : 0;
	if (size <= heard.length) return heard;
	return `${heard}\n${"familiar ".repeat(Math.ceil(size / 9))}`.slice(0, size);
}

/**
 * The echo as a brain. "tools" reports two tools first, "permission" asks the player; both test
 * the window without an agent.
 */
export const echoBrain: Brain = {
	async ask({ text }, turn) {
		if (text === "tools") {
			turn.onTool("web_search: echo");
			turn.onTool("web_extract: echo");
			await Bun.sleep(100);
		}
		if (text === "permission")
			return `heard: permission, ${(await turn.onPermission("echo a test")) ? "allowed" : "denied"}`;
		return echo(text);
	},
};
