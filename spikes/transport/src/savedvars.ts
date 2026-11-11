// Reads the subset of Lua the client writes into SavedVariables files. Never evaluates code.

export type LuaValue = string | number | boolean | LuaTable;
export interface LuaTable {
	[key: string]: LuaValue;
}

type Token =
	| { type: "punct"; value: string }
	| { type: "string"; value: string }
	| { type: "number"; value: number }
	| { type: "name"; value: string };

const ESCAPES: Record<string, string> = {
	n: "\n",
	r: "\r",
	t: "\t",
	a: "\x07",
	b: "\b",
	f: "\f",
	v: "\v",
	"\\": "\\",
	'"': '"',
	"'": "'",
	"\n": "\n",
};

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i] as string;
		if (/\s/.test(c)) {
			i++;
		} else if (text.startsWith("--", i)) {
			const end = text.indexOf("\n", i);
			i = end === -1 ? text.length : end + 1;
		} else if (c === '"' || c === "'") {
			let value = "";
			i++;
			while (i < text.length && text[i] !== c) {
				if (text[i] === "\\") {
					const next = text[i + 1] ?? "";
					const digits = /^\d{1,3}/.exec(text.slice(i + 1, i + 4))?.[0];
					if (digits) {
						value += String.fromCharCode(Number(digits));
						i += 1 + digits.length;
					} else {
						value += ESCAPES[next] ?? next;
						i += 2;
					}
				} else {
					value += text[i];
					i++;
				}
			}
			i++;
			tokens.push({ type: "string", value });
		} else if (/[-\d.]/.test(c) && /^-?(\d|\.\d)/.test(text.slice(i, i + 3))) {
			const match = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(text.slice(i));
			const raw = match?.[0] ?? c;
			tokens.push({ type: "number", value: Number(raw) });
			i += raw.length;
		} else if (/[A-Za-z_]/.test(c)) {
			const raw = /^[A-Za-z_]\w*/.exec(text.slice(i))?.[0] ?? c;
			tokens.push({ type: "name", value: raw });
			i += raw.length;
		} else {
			tokens.push({ type: "punct", value: c });
			i++;
		}
	}
	return tokens;
}

export function parseSavedVariables(text: string): LuaTable {
	const tokens = tokenize(text);
	let at = 0;
	const peek = () => tokens[at];
	const take = () => {
		const token = tokens[at++];
		if (!token) throw new Error("unexpected end of SavedVariables");
		return token;
	};
	const expect = (value: string) => {
		const token = take();
		if (token.type !== "punct" || token.value !== value)
			throw new Error(`expected ${value} in SavedVariables`);
	};
	const value = (): LuaValue => {
		const token = take();
		if (token.type === "string" || token.type === "number") return token.value;
		if (token.type === "name") {
			if (token.value === "true") return true;
			if (token.value === "false") return false;
			if (token.value === "nil") return "";
			throw new Error(`unexpected name ${token.value}`);
		}
		if (token.value !== "{") throw new Error(`unexpected ${token.value}`);
		const table: LuaTable = {};
		let index = 1;
		for (;;) {
			const next = peek();
			if (!next) throw new Error("unterminated table");
			if (next.type === "punct" && next.value === "}") {
				at++;
				return table;
			}
			if (next.type === "punct" && next.value === "[") {
				at++;
				const key = take();
				expect("]");
				expect("=");
				table[String(key.value)] = value();
			} else if (next.type === "name" && tokens[at + 1]?.value === "=") {
				at += 2;
				table[next.value] = value();
			} else {
				table[String(index++)] = value();
			}
			const separator = peek();
			if (
				separator?.type === "punct" &&
				(separator.value === "," || separator.value === ";")
			)
				at++;
		}
	};
	const globals: LuaTable = {};
	while (at < tokens.length) {
		const name = take();
		if (name.type !== "name") throw new Error("expected a global name");
		expect("=");
		globals[name.value] = value();
	}
	return globals;
}

/** Array part of a table (keys 1..n), in order. */
export function list(value: LuaValue | undefined): LuaValue[] {
	if (!value || typeof value !== "object") return [];
	const items: LuaValue[] = [];
	for (let i = 1; String(i) in value; i++)
		items.push(value[String(i)] as LuaValue);
	return items;
}

export function table(value: LuaValue | undefined): LuaTable | undefined {
	return value && typeof value === "object" ? value : undefined;
}

export function text(value: LuaValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function num(value: LuaValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}
