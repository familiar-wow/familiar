// How long the app waits for each core method, so a slow one is not cut off by the default and a
// page need not know. The core has its own limits inside these; the app waits a little longer.
import { TIMEOUT_MS } from "./client.ts";

export const TIMEOUTS: Record<string, number> = {
	// Installing writes thousands of files: about 15 s on a Windows runner, more on a slow disk.
	"addon.install": 120_000,
	"addon.uninstall": 120_000,
	start: 60_000,
	restart: 60_000,
	// Up to five pages of 10 s each at a provider.
	"models.list": 60_000,
	// The browser sign-in waits 10 minutes, then the token exchange.
	"chatgpt.signIn": 12 * 60_000,
	// May renew the sign-in, or wait for its lock, first.
	"chatgpt.models": 90_000,
	"chatgpt.signOut": 90_000,
	// The registry on Windows can be slow; start looks again afterwards.
	"local.find": 90_000,
	"local.start": 90_000,
	"local.models": 20_000,
	"agents.find": 60_000,
	"ssh.resolve": 20_000,
	"ssh.hostKey": 35_000,
	"ssh.trust": 35_000,
	"ssh.test": 45_000,
	// The core gives a test 80 s in all, starting the brain included.
	"brain.test": 95_000,
};

export function timeoutFor(method: string): number {
	return TIMEOUTS[method] ?? TIMEOUT_MS;
}
