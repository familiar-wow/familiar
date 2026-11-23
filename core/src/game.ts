// What the app knows about the game (FAM-3, FAM-46): the character from the last question's
// header and a revisioned per-character cache of larger slices pulled on demand from the addon
// (equipment, bags, quests, talents). Unchanged slices come from the cache without touching the
// transport (ADR 0001).
import type { Character } from "./brain/chat.ts";

export type Slice =
	| "eq"
	| "bags"
	| "quests"
	| "talents"
	| "stats"
	| "prof"
	| "rep"
	| "spells"
	| "bank"
	| "merchant"
	| "trainer";

export interface EquipmentItem {
	slot: string;
	id: number;
	name: string;
	itemLevel?: number;
	quality?: number;
	enchantId?: number;
	gems?: number[];
	durability?: { current: number; max: number };
}

export interface EquipmentState {
	items: EquipmentItem[];
	truncated?: boolean;
}

export interface BagItem {
	id: number;
	name: string;
	count: number;
	quality?: number;
}

export interface BagsState {
	freeSlots: number;
	totalSlots: number;
	money: { copper: number; formatted: string };
	items: BagItem[];
	truncated?: boolean;
}

export interface QuestObjective {
	text: string;
	finished: boolean;
}

export interface QuestEntry {
	id: number;
	title: string;
	level: number;
	complete: boolean;
	watched: boolean;
	category?: string;
	objectives: QuestObjective[];
}

export interface QuestsState {
	quests: QuestEntry[];
	truncated?: boolean;
}

export interface TalentTree {
	name: string;
	spent: number;
}

export interface TalentEntry {
	tree: string;
	name: string;
	rank: number;
	maxRank: number;
	spellId?: number;
}

export interface TalentsState {
	unspent: number;
	spent: number;
	trees: TalentTree[];
	talents: TalentEntry[];
	truncated?: boolean;
}

export interface StatsState {
	healthMax?: number;
	powerType?: string;
	powerMax?: number;
	str?: number;
	agi?: number;
	sta?: number;
	int?: number;
	spi?: number;
	armor?: number;
	meleeAP?: number;
	rangedAP?: number;
	meleeCrit?: number;
	rangedCrit?: number;
	spellCrit?: number;
	spellDamage?: number;
	spellHealing?: number;
	dodge?: number;
	parry?: number;
	block?: number;
	defense?: number;
	truncated?: boolean;
}

export interface SkillEntry {
	id: number;
	name: string;
	category?: string;
	rank: number;
	maxRank: number;
	modifier?: number;
}

export interface ProfessionsState {
	skills: SkillEntry[];
	truncated?: boolean;
}

export interface FactionEntry {
	id: number;
	name: string;
	category?: string;
	reaction: number;
	standingLabel: string;
	current: number;
	max: number;
	watched: boolean;
}

export interface ReputationState {
	factions: FactionEntry[];
	truncated?: boolean;
}

export interface SpellEntry {
	id: number;
	name: string;
	category?: string;
	passive: boolean;
	subName?: string;
}

export interface SpellsState {
	spells: SpellEntry[];
	truncated?: boolean;
}

export interface BankState {
	available: boolean;
	seenAt?: string;
	freeSlots?: number;
	totalSlots?: number;
	items: BagItem[];
	truncated?: boolean;
}

/** An item or currency an offer costs besides money (the merchant's "extended cost"). */
export interface MerchantCost {
	amount: number;
	itemId?: number;
	currencyId?: number;
	name: string;
}

export interface MerchantItem {
	id?: number;
	name: string;
	/** The money part of the price only; `extendedCost` lists what else the offer costs. */
	price: { copper: number; formatted: string };
	extendedCost?: MerchantCost[];
	stackCount: number;
	numAvailable: number;
	usable: boolean;
}

export interface MerchantState {
	available: boolean;
	seenAt?: string;
	npc?: string;
	items: MerchantItem[];
	truncated?: boolean;
}

export interface TrainerService {
	name: string;
	status: string;
	requiredLevel: number;
	/** Money, except at a pet trainer, where services cost the pet's training points. */
	cost: { copper: number; formatted: string } | { trainingPoints: number };
	subText?: string;
}

/** Enum.TrainerType in the WoW Forever client. */
const TRAINER_TYPES: Record<string, TrainerState["trainerType"]> = {
	"0": "general",
	"2": "tradeskills",
	"3": "pet",
};

export interface TrainerState {
	available: boolean;
	seenAt?: string;
	npc?: string;
	trainerType?: "general" | "tradeskills" | "pet";
	services: TrainerService[];
	truncated?: boolean;
}

export interface SliceMap {
	eq: EquipmentState;
	bags: BagsState;
	quests: QuestsState;
	talents: TalentsState;
	stats: StatsState;
	prof: ProfessionsState;
	rep: ReputationState;
	spells: SpellsState;
	bank: BankState;
	merchant: MerchantState;
	trainer: TrainerState;
}

export type SliceResult<K extends Slice> = SliceMap[K] & {
	revision: number;
	asOf: string;
	cached: boolean;
};

interface CachedEntry {
	rev: number;
	data: SliceMap[Slice];
	at: Date;
}

interface PendingFetch {
	charKey: string;
	slice: Slice;
	resolve: (result: SliceResult<Slice>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** How long a pull from the addon may take before the tool reports a timeout. */
const DEFAULT_FETCH_MS = 15_000;

export function formatMoney(copper: number): string {
	const total = Math.max(0, Math.floor(copper));
	const g = Math.floor(total / 10000);
	const s = Math.floor((total % 10000) / 100);
	const c = total % 100;
	const parts: string[] = [];
	if (g > 0) parts.push(`${g}g`);
	if (s > 0 || g > 0) parts.push(`${s}s`);
	parts.push(`${c}c`);
	return parts.join(" ");
}

function characterKey(c: Character): string {
	return c.name || c.realm ? `${c.name ?? ""}-${c.realm ?? ""}` : "unknown";
}

export class Game {
	private last?: {
		key: string;
		character: Character;
		revs: Record<string, number>;
		at: Date;
	};
	private readonly cache = new Map<string, Map<Slice, CachedEntry>>();
	private readonly pending = new Map<number, PendingFetch>();
	private readonly inflight = new Map<string, Promise<SliceResult<Slice>>>();
	private fetcher?: (id: number, slice: Slice) => boolean;
	private nextId = 1;
	private readonly fetchTimeoutMs: number;

	constructor(options: { fetchTimeoutMs?: number } = {}) {
		this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_MS;
	}

	/** Wires how the cache asks the addon for a slice. Returns false if the transport cannot send. */
	setFetcher(fn: (id: number, slice: Slice) => boolean): void {
		this.fetcher = fn;
	}

	/** Notes the character and slice revisions a question came with. */
	see(character: Character, revs: Record<string, number> = {}): void {
		this.last = {
			key: characterKey(character),
			character,
			revs: { ...revs },
			at: new Date(),
		};
	}

	/**
	 * Forgets everything the addon told before: its revision counters restart with every UI load,
	 * so a cached slice from an earlier load could carry the same revision as new data.
	 */
	forget(): void {
		this.last = undefined;
		this.cache.clear();
		for (const [id, waiting] of this.pending) {
			clearTimeout(waiting.timer);
			waiting.reject(new Error("The game reloaded its interface; ask again."));
			this.pending.delete(id);
		}
	}

	/** The character of the last question and when it asked, if there was one. */
	get character(): { character: Character; at: Date } | undefined {
		return this.last
			? { character: this.last.character, at: this.last.at }
			: undefined;
	}

	/**
	 * Returns `slice` for the active character: from cache if its revision matches what the last
	 * question reported, otherwise pulled fresh from the addon. Concurrent calls for the same
	 * character and slice share one pull.
	 */
	async get<K extends Slice>(slice: K): Promise<SliceResult<K>> {
		const charKey = this.last?.key ?? "unknown";
		const knownRev = this.last?.revs[slice];
		const cached = this.cache.get(charKey)?.get(slice);
		if (cached && knownRev !== undefined && cached.rev === knownRev) {
			return {
				...(cached.data as SliceMap[K]),
				revision: cached.rev,
				asOf: cached.at.toISOString(),
				cached: true,
			};
		}
		const flightKey = `${charKey}:${slice}`;
		const running = this.inflight.get(flightKey);
		if (running) return running as unknown as Promise<SliceResult<K>>;
		if (!this.fetcher) throw new Error("No connection to the game client.");

		const id = this.nextId++;
		const promise = new Promise<SliceResult<Slice>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						`The game did not send ${slice} within ${Math.round(this.fetchTimeoutMs / 1000)} s.`,
					),
				);
			}, this.fetchTimeoutMs);
			this.pending.set(id, { charKey, slice, resolve, reject, timer });
			if (!this.fetcher?.(id, slice)) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(
					new Error(
						`Could not ask the game for ${slice}; the addon may not be connected.`,
					),
				);
			}
		}).finally(() => {
			this.inflight.delete(flightKey);
		});
		this.inflight.set(flightKey, promise);
		return promise as unknown as Promise<SliceResult<K>>;
	}

	/** Delivers a `state` message from the addon for an earlier `fetch`. */
	receiveState(id: number, slice: string, rev: number, payload: string): void {
		const waiting = this.pending.get(id);
		if (!waiting) return;
		clearTimeout(waiting.timer);
		this.pending.delete(id);
		if (slice !== waiting.slice) {
			waiting.reject(
				new Error(`Expected ${waiting.slice} from the game, got ${slice}.`),
			);
			return;
		}
		if (payload.startsWith("error\t")) {
			waiting.reject(
				new Error(payload.slice(6) || "The addon could not read it."),
			);
			return;
		}
		const data = parseSlice(waiting.slice, payload);
		const at = new Date();
		let byChar = this.cache.get(waiting.charKey);
		if (!byChar) {
			byChar = new Map();
			this.cache.set(waiting.charKey, byChar);
		}
		byChar.set(waiting.slice, { rev, data, at });
		if (this.last && this.last.key === waiting.charKey)
			this.last.revs[waiting.slice] = rev;
		waiting.resolve({
			...data,
			revision: rev,
			asOf: at.toISOString(),
			cached: false,
		});
	}
}

// TSV parsers for addon/Familiar/Collect.lua ----------------------------------------------

function linesOf(payload: string): string[] {
	return payload === "" ? [] : payload.split("\n").filter((l) => l !== "");
}

const optInt = (s: string | undefined): number | undefined =>
	s && /^-?\d+$/.test(s) ? Number(s) : undefined;

const optNum = (s: string | undefined): number | undefined =>
	s && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;

const REACTION_LABELS: Record<number, string> = {
	1: "Hated",
	2: "Hostile",
	3: "Unfriendly",
	4: "Neutral",
	5: "Friendly",
	6: "Honored",
	7: "Revered",
	8: "Exalted",
};

export function parseSlice<K extends Slice>(
	slice: K,
	payload: string,
): SliceMap[K] {
	switch (slice) {
		case "eq":
			return parseEquipment(payload) as SliceMap[K];
		case "bags":
			return parseBags(payload) as SliceMap[K];
		case "quests":
			return parseQuests(payload) as SliceMap[K];
		case "talents":
			return parseTalents(payload) as SliceMap[K];
		case "stats":
			return parseStats(payload) as SliceMap[K];
		case "prof":
			return parseProfessions(payload) as SliceMap[K];
		case "rep":
			return parseReputation(payload) as SliceMap[K];
		case "spells":
			return parseSpells(payload) as SliceMap[K];
		case "bank":
			return parseBank(payload) as SliceMap[K];
		case "merchant":
			return parseMerchant(payload) as SliceMap[K];
		case "trainer":
			return parseTrainer(payload) as SliceMap[K];
	}
}

export function parseEquipment(payload: string): EquipmentState {
	const items: EquipmentItem[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const [slot, idStr, ilvl, quality, ench, gemsStr, durStr, name] =
			line.split("\t");
		const id = optInt(idStr);
		if (!slot || id === undefined) continue;
		const item: EquipmentItem = { slot, id, name: name ?? "" };
		const lvl = optInt(ilvl);
		if (lvl !== undefined) item.itemLevel = lvl;
		const q = optInt(quality);
		if (q !== undefined) item.quality = q;
		const e = optInt(ench);
		if (e !== undefined && e > 0) item.enchantId = e;
		if (gemsStr) {
			const gems = gemsStr
				.split(",")
				.map(optInt)
				.filter((g): g is number => g !== undefined && g > 0);
			if (gems.length > 0) item.gems = gems;
		}
		if (durStr) {
			const m = /^(\d+)\/(\d+)$/.exec(durStr);
			if (m) item.durability = { current: Number(m[1]), max: Number(m[2]) };
		}
		items.push(item);
	}
	return truncated ? { items, truncated: true } : { items };
}

export function parseBags(payload: string): BagsState {
	let freeSlots = 0;
	let totalSlots = 0;
	let copper = 0;
	const items: BagItem[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] === "meta") {
			freeSlots = Number(parts[1] ?? 0) || 0;
			totalSlots = Number(parts[2] ?? 0) || 0;
			copper = Number(parts[3] ?? 0) || 0;
		} else if (parts[0] === "item") {
			const id = optInt(parts[1]);
			if (id === undefined) continue;
			const item: BagItem = {
				id,
				count: Number(parts[2] ?? 1) || 1,
				name: parts[4] ?? "",
			};
			const q = optInt(parts[3]);
			if (q !== undefined) item.quality = q;
			items.push(item);
		}
	}
	const result: BagsState = {
		freeSlots,
		totalSlots,
		money: { copper, formatted: formatMoney(copper) },
		items,
	};
	if (truncated) result.truncated = true;
	return result;
}

export function parseQuests(payload: string): QuestsState {
	const quests: QuestEntry[] = [];
	let current: QuestEntry | undefined;
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] === "q") {
			const id = optInt(parts[1]);
			if (id === undefined) continue;
			current = {
				id,
				level: Number(parts[2] ?? 0) || 0,
				complete: parts[3] === "1",
				watched: parts[4] === "1",
				...(parts[5] ? { category: parts[5] } : {}),
				title: parts[6] ?? "",
				objectives: [],
			};
			quests.push(current);
		} else if (parts[0] === "o" && current) {
			current.objectives.push({
				finished: parts[1] === "1",
				text: parts[2] ?? "",
			});
		}
	}
	return truncated ? { quests, truncated: true } : { quests };
}

export function parseTalents(payload: string): TalentsState {
	let unspent = 0;
	let spent = 0;
	const trees: TalentTree[] = [];
	const talents: TalentEntry[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] === "meta") {
			unspent = Number(parts[1] ?? 0) || 0;
			spent = Number(parts[2] ?? 0) || 0;
		} else if (parts[0] === "tree") {
			trees.push({
				name: parts[1] ?? "",
				spent: Number(parts[2] ?? 0) || 0,
			});
		} else if (parts[0] === "t") {
			const rank = Number(parts[2] ?? 0) || 0;
			const maxRank = Number(parts[3] ?? rank) || rank;
			const spellId = optInt(parts[4]);
			const entry: TalentEntry = {
				tree: parts[1] ?? "",
				name: parts[5] ?? "",
				rank,
				maxRank,
			};
			if (spellId !== undefined && spellId > 0) entry.spellId = spellId;
			talents.push(entry);
		}
	}
	const result: TalentsState = { unspent, spent, trees, talents };
	if (truncated) result.truncated = true;
	return result;
}

const NUMERIC_STAT_KEYS = new Set([
	"healthMax",
	"powerMax",
	"str",
	"agi",
	"sta",
	"int",
	"spi",
	"armor",
	"meleeAP",
	"rangedAP",
	"meleeCrit",
	"rangedCrit",
	"spellCrit",
	"spellDamage",
	"spellHealing",
	"dodge",
	"parry",
	"block",
	"defense",
]);

export function parseStats(payload: string): StatsState {
	const out: Record<string, number | string | boolean> = {};
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			out.truncated = true;
			continue;
		}
		const [key, value] = line.split("\t");
		if (!key || value === undefined) continue;
		if (key === "powerType") out.powerType = value;
		else if (NUMERIC_STAT_KEYS.has(key)) {
			const n = optNum(value);
			if (n !== undefined) out[key] = n;
		}
	}
	return out as StatsState;
}

export function parseProfessions(payload: string): ProfessionsState {
	const skills: SkillEntry[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] !== "s") continue;
		const id = optInt(parts[1]) ?? 0;
		const mod = optInt(parts[5]) ?? 0;
		const entry: SkillEntry = {
			id,
			name: parts[6] ?? "",
			...(parts[2] ? { category: parts[2] } : {}),
			rank: Number(parts[3] ?? 0) || 0,
			maxRank: Number(parts[4] ?? 0) || 0,
			...(mod !== 0 ? { modifier: mod } : {}),
		};
		if (entry.name) skills.push(entry);
	}
	return truncated ? { skills, truncated: true } : { skills };
}

export function parseReputation(payload: string): ReputationState {
	const factions: FactionEntry[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] !== "r") continue;
		const id = optInt(parts[1]) ?? 0;
		const reaction = optInt(parts[3]) ?? 0;
		const standing = optInt(parts[4]) ?? 0;
		const min = optInt(parts[5]) ?? 0;
		const max = optInt(parts[6]) ?? 0;
		const name = parts[8] ?? "";
		if (!name) continue;
		factions.push({
			id,
			name,
			...(parts[2] ? { category: parts[2] } : {}),
			reaction,
			standingLabel: REACTION_LABELS[reaction] ?? `Reaction ${reaction}`,
			current: standing - min,
			max: Math.max(0, max - min),
			watched: parts[7] === "1",
		});
	}
	return truncated ? { factions, truncated: true } : { factions };
}

export function parseSpells(payload: string): SpellsState {
	const spells: SpellEntry[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] !== "sp") continue;
		const id = optInt(parts[1]);
		const name = parts[5] ?? "";
		if (id === undefined || !name) continue;
		spells.push({
			id,
			name,
			...(parts[2] ? { category: parts[2] } : {}),
			passive: parts[3] === "1",
			...(parts[4] ? { subName: parts[4] } : {}),
		});
	}
	return truncated ? { spells, truncated: true } : { spells };
}

export function parseBank(payload: string): BankState {
	if (!payload || payload === "empty") return { available: false, items: [] };
	let seenAt: string | undefined;
	let freeSlots = 0;
	let totalSlots = 0;
	const items: BagItem[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] === "meta") {
			if (parts[1]) seenAt = parts[1];
			freeSlots = Number(parts[2] ?? 0) || 0;
			totalSlots = Number(parts[3] ?? 0) || 0;
		} else if (parts[0] === "item") {
			const id = optInt(parts[1]);
			if (id === undefined) continue;
			const q = optInt(parts[3]);
			items.push({
				id,
				count: Number(parts[2] ?? 1) || 1,
				...(q !== undefined ? { quality: q } : {}),
				name: parts[4] ?? "",
			});
		}
	}
	return {
		available: true,
		...(seenAt ? { seenAt } : {}),
		freeSlots,
		totalSlots,
		items,
		...(truncated ? { truncated: true } : {}),
	};
}

export function parseMerchant(payload: string): MerchantState {
	if (!payload || payload === "empty") return { available: false, items: [] };
	let seenAt: string | undefined;
	let npc: string | undefined;
	const items: MerchantItem[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] === "meta") {
			if (parts[1]) seenAt = parts[1];
			if (parts[2]) npc = parts[2];
		} else if (parts[0] === "mc") {
			// An extended cost belongs to the item line right before it.
			const item = items.at(-1);
			const amount = optInt(parts[1]);
			if (!item || amount === undefined) continue;
			const costId = optInt(parts[3]);
			const cost: MerchantCost = {
				amount,
				...(costId !== undefined && parts[2] === "item"
					? { itemId: costId }
					: {}),
				...(costId !== undefined && parts[2] === "currency"
					? { currencyId: costId }
					: {}),
				name: parts[4] ?? "",
			};
			item.extendedCost = [...(item.extendedCost ?? []), cost];
		} else if (parts[0] === "m") {
			const id = optInt(parts[1]);
			const copper = optInt(parts[2]) ?? 0;
			const name = parts[6] ?? "";
			if (!name) continue;
			items.push({
				...(id !== undefined ? { id } : {}),
				name,
				price: { copper, formatted: formatMoney(copper) },
				stackCount: optInt(parts[3]) ?? 1,
				numAvailable: optInt(parts[4]) ?? -1,
				usable: parts[5] !== "0",
			});
		}
	}
	return {
		available: true,
		...(seenAt ? { seenAt } : {}),
		...(npc ? { npc } : {}),
		items,
		...(truncated ? { truncated: true } : {}),
	};
}

export function parseTrainer(payload: string): TrainerState {
	if (!payload || payload === "empty")
		return { available: false, services: [] };
	let seenAt: string | undefined;
	let npc: string | undefined;
	let trainerType: TrainerState["trainerType"];
	const services: TrainerService[] = [];
	let truncated = false;
	for (const line of linesOf(payload)) {
		if (line === "truncated") {
			truncated = true;
			continue;
		}
		const parts = line.split("\t");
		if (parts[0] === "meta") {
			if (parts[1]) seenAt = parts[1];
			if (parts[2]) npc = parts[2];
			trainerType = TRAINER_TYPES[parts[3] ?? ""];
		} else if (parts[0] === "tr") {
			const name = parts[5] ?? "";
			if (!name) continue;
			const amount = optInt(parts[3]) ?? 0;
			services.push({
				name,
				status: parts[1] ?? "",
				requiredLevel: optInt(parts[2]) ?? 0,
				cost:
					trainerType === "pet"
						? { trainingPoints: amount }
						: { copper: amount, formatted: formatMoney(amount) },
				...(parts[4] ? { subText: parts[4] } : {}),
			});
		}
	}
	return {
		available: true,
		...(seenAt ? { seenAt } : {}),
		...(npc ? { npc } : {}),
		...(trainerType ? { trainerType } : {}),
		services,
		...(truncated ? { truncated: true } : {}),
	};
}
