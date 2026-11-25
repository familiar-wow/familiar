import { expect, test } from "bun:test";
import {
	type Backend,
	keychain,
	memoryStore,
	names,
	SecretError,
} from "./secrets.ts";

const SECRET = "hunter2-correct-horse";

/** The error a call ends with, or undefined if it worked. */
async function failure(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
		return undefined;
	} catch (error) {
		return error;
	}
}

test("names say what a secret is for, with the host in lower case", () => {
	expect(names.apiKey("openrouter")).toBe("api-key/openrouter");
	expect(names.sshPassword("Gamer-PC")).toBe("ssh-password/gamer-pc");
	expect(names.sshPassphrase("Gamer-PC")).toBe("ssh-passphrase/gamer-pc");
});

test("the memory store keeps, returns and removes a value", async () => {
	const store = memoryStore();
	expect(await store.get("api-key/openai")).toBeNull();
	await store.set("api-key/openai", SECRET);
	expect(await store.get("api-key/openai")).toBe(SECRET);
	expect(await store.delete("api-key/openai")).toBe(true);
	expect(await store.delete("api-key/openai")).toBe(false);
	expect(await store.get("api-key/openai")).toBeNull();
});

test("a value over 2,000 bytes is refused in fixed words", async () => {
	for (const store of [memoryStore(), keychain(fake().backend)]) {
		// Bytes count, not characters: "ä" takes two.
		await store.set("a", "ä".repeat(1000));
		const long = `${SECRET}${"ä".repeat(1000)}`;
		const error = await failure(() => store.set("a", long));
		expect(error).toBeInstanceOf(SecretError);
		expect((error as Error).message).toBe("Too long for the system keychain.");
	}
});

test("an empty value or name is refused instead of deleting the entry", async () => {
	const { backend, calls } = fake();
	for (const store of [memoryStore(), keychain(backend)]) {
		expect(await failure(() => store.set("a", ""))).toBeInstanceOf(SecretError);
		expect(await failure(() => store.set("", SECRET))).toBeInstanceOf(
			SecretError,
		);
		expect(await failure(() => store.get(""))).toBeInstanceOf(SecretError);
	}
	expect(calls).toEqual([]);
});

test("the keychain keeps everything under the service Familiar, on this computer only", async () => {
	const { backend, calls } = fake();
	const store = keychain(backend);
	await store.set("ssh-password/box", SECRET);
	expect(await store.get("ssh-password/box")).toBe(SECRET);
	expect(await store.delete("ssh-password/box")).toBe(true);
	expect(await store.get("ssh-password/box")).toBeNull();
	expect(calls).toEqual([
		{
			service: "Familiar",
			name: "ssh-password/box",
			value: SECRET,
			persist: "local",
		},
		{ service: "Familiar", name: "ssh-password/box" },
		{ service: "Familiar", name: "ssh-password/box" },
		{ service: "Familiar", name: "ssh-password/box" },
	]);
});

test("a keychain failure becomes fixed words without the value", async () => {
	// A backend that quotes what it was given, as a careless system message might.
	const broken: Backend = {
		get: async ({ name }) => {
			throw new Error(`no backend for ${name}`);
		},
		set: async ({ value }) => {
			throw new Error(`could not store ${value}`);
		},
		delete: async () => {
			throw new Error("no backend");
		},
	};
	const store = keychain(broken);
	for (const work of [
		() => store.set("api-key/openai", SECRET),
		() => store.get("api-key/openai"),
		() => store.delete("api-key/openai"),
	]) {
		const error = await failure(work);
		expect(error).toBeInstanceOf(SecretError);
		expect((error as Error).message).toBe(
			"The system keychain is not available.",
		);
		expect(String((error as Error).stack)).not.toContain(SECRET);
		expect((error as Error).cause).toBeUndefined();
	}
});

// A CI runner has no Secret Service; then Bun.secrets throws and there is nothing to test.
const available = await Bun.secrets
	.get({ service: "Familiar", name: "test/probe" })
	.then(
		() => true,
		() => false,
	);

test.skipIf(!available)("the real keychain keeps a value", async () => {
	const store = keychain();
	const name = `test/${crypto.randomUUID()}`;
	try {
		await store.set(name, "not-a-real-secret");
		expect(await store.get(name)).toBe("not-a-real-secret");
	} finally {
		expect(await store.delete(name)).toBe(true);
	}
	expect(await store.get(name)).toBeNull();
});

test.skipIf(available)(
	"without a keychain the error is fixed words",
	async () => {
		const error = await failure(() => keychain().get("api-key/openai"));
		expect(error).toBeInstanceOf(SecretError);
		expect((error as Error).message).toBe(
			"The system keychain is not available.",
		);
	},
);

/** Stands in for Bun.secrets and notes what it was asked. */
function fake(): { backend: Backend; calls: unknown[] } {
	const kept = new Map<string, string>();
	const calls: unknown[] = [];
	return {
		calls,
		backend: {
			get: async (options) => {
				calls.push(options);
				return kept.get(options.name) ?? null;
			},
			set: async (options) => {
				calls.push(options);
				kept.set(options.name, options.value);
			},
			delete: async (options) => {
				calls.push(options);
				return kept.delete(options.name);
			},
		},
	};
}
