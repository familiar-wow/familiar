// The tools of the `wow` server. Each one describes itself: its name, description and
// parameters are all the agent's model learns about it (FAM-3). They only read (ADR 0007).
import type { Game } from "../game.ts";
import type { Tool } from "./server.ts";

export function wowTools(game: Game): Tool[] {
	return [
		{
			name: "character",
			description:
				"The player's character in WoW Forever as the game showed it when the player last asked: name, realm, level, race, class, faction, the zone and subzone it stands in, and the game's language. Names of races, classes and places are in the game's language.",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			call: () => {
				const last = game.character;
				if (!last || Object.keys(last.character).length === 0)
					throw new Error("The game has sent nothing about the character yet.");
				return { ...last.character, asOf: last.at.toISOString() };
			},
		},
	];
}
