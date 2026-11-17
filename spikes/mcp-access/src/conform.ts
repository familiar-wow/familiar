// Does the hand-written server satisfy a client it was not written against? The official MCP
// client connects, lists the tools and calls one; plain requests then try the doors that must
// stay shut. No agent and no model take part.
// Usage: bun src/conform.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve, tools } from "./server.ts";

const token = crypto.randomUUID();
const nonce = crypto.randomUUID().slice(0, 8);
const server = serve({ token, tools: tools(nonce) });
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const client = new Client({ name: "conform", version: "0.0.0" });
await client.connect(
	new StreamableHTTPClientTransport(new URL(server.url), {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	}),
);
check(
	"initialize",
	client.getServerVersion()?.name === "wow",
	JSON.stringify(client.getServerVersion()),
);
const listed = await client.listTools();
check(
	"tools/list",
	listed.tools.map((t) => t.name).join() === "character_equipment",
);
const called = await client.callTool({
	name: "character_equipment",
	arguments: { slot: "mainHand" },
});
check("tools/call", JSON.stringify(called.content).includes(nonce));
const wrong = await client.callTool({
	name: "character_equipment",
	arguments: { slot: "tail" },
});
check(
	"a bad argument is an error the model can read",
	wrong.isError === true,
	JSON.stringify(wrong.content),
);
await client.close();

const post = (headers: Record<string, string>, method = "POST") =>
	fetch(server.url, {
		method,
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...headers,
		},
		body:
			method === "POST"
				? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
				: undefined,
	}).then((r) => r.status);
const auth = { Authorization: `Bearer ${token}` };
check("no token", (await post({})) === 401);
check(
	"wrong token",
	(await post({ Authorization: `Bearer ${crypto.randomUUID()}` })) === 401,
);
check(
	"a browser's request (Origin)",
	(await post({ ...auth, Origin: "https://example.com" })) === 403,
);
check(
	"another host name (DNS rebinding)",
	(await post({ ...auth, Host: "evil.example:80" })) === 403,
);
check("GET opens no stream", (await post(auth, "GET")) === 405);
check("right token", (await post(auth)) === 200);

console.log("\nrequests the server saw:");
for (const s of server.seen)
	console.log(
		`  ${String(s.at).padStart(5)} ms  ${s.status}  ${s.method}${s.tool ? ` ${s.tool}` : ""}  [${s.version || "no version header"}]  ${s.agent}`,
	);
server.stop();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
