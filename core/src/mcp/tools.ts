// The tools of the `wow` server. Each one describes itself: its name, description and
// parameters are all the agent's model learns about it (FAM-3). They only read (ADR 0007).
import { formatMoney, type Game } from "../game.ts";
import type { Tool } from "./server.ts";

export function wowTools(game: Game): Tool[] {
	return [
		{
			name: "character",
			description:
				"The player's character in WoW Forever as the game showed it when the player last asked: name, realm, level, race, class, faction, zone, subzone, map ID, coordinates, money and game language. Names of races, classes and places are in the game's language.",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			call: () => {
				const last = game.character;
				if (!last || Object.keys(last.character).length === 0)
					throw new Error("The game has sent nothing about the character yet.");
				const { money, ...rest } = last.character;
				const copper = money && /^\d+$/.test(money) ? Number(money) : undefined;
				return {
					...rest,
					...(copper === undefined
						? {}
						: { money: { copper, formatted: formatMoney(copper) } }),
					asOf: last.at.toISOString(),
				};
			},
		},
		{
			name: "equipment",
			description:
				"What the player's character wears right now in WoW Forever: equipped slots with item ID, name (in the game's language), item level, quality (0 poor to 5 legendary), enchant ID, gem IDs and durability. Call this before answering questions about gear, upgrades or enchants. Empty slots are omitted.",
			inputSchema: {
				type: "object",
				properties: {
					slot: {
						type: "string",
						description:
							'Optional slot filter, e.g. "head", "chest", "mainHand", "offHand", "ranged", "trinket1". Leave out for all equipped slots.',
					},
				},
				additionalProperties: false,
			},
			call: async ({ slot }) => {
				const eq = await game.get("eq");
				if (slot === undefined) return eq;
				const wanted = String(slot).toLowerCase();
				const matched = eq.items.filter(
					(item) => item.slot.toLowerCase() === wanted,
				);
				return { ...eq, items: matched };
			},
		},
		{
			name: "bags",
			description:
				"Items in the player's bags in WoW Forever, grouped by item ID with total count and quality, plus free/total bag slots and current money. Call this before answering questions about inventory, consumables, crafting materials or gold. Item names are in the game's language.",
			inputSchema: {
				type: "object",
				properties: {
					search: {
						type: "string",
						description:
							"Optional case-insensitive substring to filter bag items by name.",
					},
				},
				additionalProperties: false,
			},
			call: async ({ search }) => {
				const bags = await game.get("bags");
				if (search === undefined || String(search).trim() === "") return bags;
				const needle = String(search).trim().toLowerCase();
				return {
					...bags,
					items: bags.items.filter((item) =>
						item.name.toLowerCase().includes(needle),
					),
				};
			},
		},
		{
			name: "quests",
			description:
				"The player's active quest log in WoW Forever: quest ID, title (in the game's language), level, category/zone, whether it is complete or tracked, and each objective with its progress. Call this before answering questions about current quests or where to go next.",
			inputSchema: {
				type: "object",
				properties: {
					questId: {
						type: "integer",
						description:
							"Optional quest ID to return only that quest from the log.",
					},
				},
				additionalProperties: false,
			},
			call: async ({ questId }) => {
				const log = await game.get("quests");
				if (questId === undefined) return log;
				const wanted = Number(questId);
				return {
					...log,
					quests: log.quests.filter((q) => q.id === wanted),
				};
			},
		},
		{
			name: "talents",
			description:
				"The player's active talent build in WoW Forever: points spent per tree, unspent points, and every allocated talent with its tree, name (in the game's language), current rank, max rank and spell ID. Call this before giving spec, talent or build advice.",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			call: () => game.get("talents"),
		},
	];
}
