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
		{
			name: "stats",
			description:
				"The player's current character stats in WoW Forever: max health, primary resource, Strength/Agility/Stamina/Intellect/Spirit, armor, melee and ranged attack power, melee/ranged/spell crit chance, spell damage, spell healing, dodge, parry, block and defense.",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			call: () => game.get("stats"),
		},
		{
			name: "professions",
			description:
				"The player's professions and skills in WoW Forever (primary and secondary professions, weapon skills, languages), with current rank, max rank, modifier and category. Names are in the game's language.",
			inputSchema: {
				type: "object",
				properties: {
					search: {
						type: "string",
						description:
							"Optional case-insensitive substring to filter by skill or category name.",
					},
				},
				additionalProperties: false,
			},
			call: async ({ search }) => {
				const prof = await game.get("prof");
				const needle =
					search === undefined ? "" : String(search).trim().toLowerCase();
				if (!needle) return prof;
				return {
					...prof,
					skills: prof.skills.filter(
						(s) =>
							s.name.toLowerCase().includes(needle) ||
							(s.category?.toLowerCase().includes(needle) ?? false),
					),
				};
			},
		},
		{
			name: "reputation",
			description:
				"The player's faction standings in WoW Forever: faction ID, name (in the game's language), category, standing label (Hated to Exalted), current progress within the standing and whether it is watched.",
			inputSchema: {
				type: "object",
				properties: {
					search: {
						type: "string",
						description:
							"Optional case-insensitive substring to filter by faction or category name.",
					},
				},
				additionalProperties: false,
			},
			call: async ({ search }) => {
				const rep = await game.get("rep");
				const needle =
					search === undefined ? "" : String(search).trim().toLowerCase();
				if (!needle) return rep;
				return {
					...rep,
					factions: rep.factions.filter(
						(f) =>
							f.name.toLowerCase().includes(needle) ||
							(f.category?.toLowerCase().includes(needle) ?? false),
					),
				};
			},
		},
		{
			name: "spells",
			description:
				"The player's learned spells in WoW Forever (highest rank of each spell): spell ID, name (in the game's language), category/tab, whether it is passive, and sub-name such as Rank. Call this before recommending abilities or rotations.",
			inputSchema: {
				type: "object",
				properties: {
					search: {
						type: "string",
						description:
							"Optional case-insensitive substring to filter by spell or category name.",
					},
					includePassive: {
						type: "boolean",
						description:
							"Whether to include passive spells and racial traits (default true).",
					},
				},
				additionalProperties: false,
			},
			call: async ({ search, includePassive }) => {
				const book = await game.get("spells");
				const needle =
					search === undefined ? "" : String(search).trim().toLowerCase();
				const keepPassive = includePassive !== false;
				if (!needle && keepPassive) return book;
				return {
					...book,
					spells: book.spells.filter(
						(s) =>
							(keepPassive || !s.passive) &&
							(!needle ||
								s.name.toLowerCase().includes(needle) ||
								(s.category?.toLowerCase().includes(needle) ?? false)),
					),
				};
			},
		},
		{
			name: "bank",
			description:
				"Items last seen in the player's character bank during this WoW Forever session (updated whenever the player opens the bank). Returns available=false if the player has not opened the bank since login/reload.",
			inputSchema: {
				type: "object",
				properties: {
					search: {
						type: "string",
						description:
							"Optional case-insensitive substring to filter bank items by name.",
					},
				},
				additionalProperties: false,
			},
			call: async ({ search }) => {
				const bank = await game.get("bank");
				const needle =
					search === undefined ? "" : String(search).trim().toLowerCase();
				if (!needle) return bank;
				return {
					...bank,
					items: bank.items.filter((i) =>
						i.name.toLowerCase().includes(needle),
					),
				};
			},
		},
		{
			name: "merchant",
			description:
				"Goods offered by the merchant the player last opened during this WoW Forever session (NPC name, timestamp, items with ID, money price, other costs in items or currencies, stack count and usability). Returns available=false if no merchant was opened since login/reload.",
			inputSchema: {
				type: "object",
				properties: {
					search: {
						type: "string",
						description:
							"Optional case-insensitive substring to filter merchant items by name.",
					},
				},
				additionalProperties: false,
			},
			call: async ({ search }) => {
				const merchant = await game.get("merchant");
				const needle =
					search === undefined ? "" : String(search).trim().toLowerCase();
				if (!needle) return merchant;
				return {
					...merchant,
					items: merchant.items.filter((i) =>
						i.name.toLowerCase().includes(needle),
					),
				};
			},
		},
		{
			name: "trainer",
			description:
				"Spells or skills offered by the class/profession trainer the player last opened during this WoW Forever session (NPC name, timestamp, status such as available/unavailable/used, required level and cost in money, or in training points at a pet trainer). Returns available=false if no trainer was opened since login/reload.",
			inputSchema: {
				type: "object",
				properties: {
					onlyAvailable: {
						type: "boolean",
						description:
							"If true, return only services with status 'available'.",
					},
				},
				additionalProperties: false,
			},
			call: async ({ onlyAvailable }) => {
				const trainer = await game.get("trainer");
				if (!onlyAvailable) return trainer;
				return {
					...trainer,
					services: trainer.services.filter((s) => s.status === "available"),
				};
			},
		},
	];
}
