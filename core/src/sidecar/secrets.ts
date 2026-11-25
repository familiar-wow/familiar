// The player's secrets (API keys, SSH passwords and passphrases) live in the operating system's
// keychain and nowhere else: Windows Credential Manager, the macOS Keychain, the Secret Service
// on Linux, all through Bun.secrets. Nothing here logs a value, puts it into an error or writes
// it to a file.

const SERVICE = "Familiar";
/** Windows Credential Manager takes about 2.5 KB per entry; stay clearly below on every system. */
const MAX_BYTES = 2000;

export interface SecretStore {
	/** The kept value, or null if there is none under that name. */
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
	/** True if something was removed. */
	delete(name: string): Promise<boolean>;
}

/** A problem the player can act on; its message is fixed words and never holds a value. */
export class SecretError extends Error {
	override name = "SecretError";
}

/** The names the secrets are kept under. Hosts are lowercased, as ssh does with them. */
export const names = {
	apiKey: (provider: string) => `api-key/${provider}`,
	sshPassword: (host: string) => `ssh-password/${host.toLowerCase()}`,
	sshPassphrase: (host: string) => `ssh-passphrase/${host.toLowerCase()}`,
};

/** The part of Bun.secrets that is used; tests pass a stand-in. */
export interface Backend {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: {
		service: string;
		name: string;
		value: string;
		persist?: "local" | "enterprise";
	}): Promise<void>;
	delete(options: { service: string; name: string }): Promise<boolean>;
}

/** The system keychain, under the service name "Familiar". */
export function keychain(backend: Backend = Bun.secrets): SecretStore {
	// What the backend throws is dropped, never passed on: its message is the system's, and
	// nothing guarantees that it leaves the value out.
	const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
		try {
			return await work();
		} catch {
			throw new SecretError("The system keychain is not available.");
		}
	};
	return {
		get: async (name) => {
			named(name);
			return await guarded(() => backend.get({ service: SERVICE, name }));
		},
		set: async (name, value) => {
			named(name);
			fits(value);
			// "local": the entry stays on this computer. The Windows default would let it
			// travel to other computers with a roaming profile.
			await guarded(() =>
				backend.set({ service: SERVICE, name, value, persist: "local" }),
			);
		},
		delete: async (name) => {
			named(name);
			return await guarded(() => backend.delete({ service: SERVICE, name }));
		},
	};
}

/** Keeps the secrets in memory only, with the same rules as the keychain. For tests. */
export function memoryStore(): SecretStore {
	const kept = new Map<string, string>();
	return {
		get: async (name) => {
			named(name);
			return kept.get(name) ?? null;
		},
		set: async (name, value) => {
			named(name);
			fits(value);
			kept.set(name, value);
		},
		delete: async (name) => {
			named(name);
			return kept.delete(name);
		},
	};
}

function named(name: string): void {
	if (!name) throw new SecretError("The secret has no name.");
}

function fits(value: string): void {
	// An empty value would delete the entry (Bun.secrets); that is what delete() is for.
	if (!value) throw new SecretError("There is nothing to keep.");
	if (Buffer.byteLength(value, "utf8") > MAX_BYTES)
		throw new SecretError("Too long for the system keychain.");
}
