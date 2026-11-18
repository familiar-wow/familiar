// What the app knows about the game. So far that is the character from the header of the last
// question; the collectors of phase 2 add equipment, bags, talents and quests (FAM-3).
import type { Character } from "./brain/chat.ts";

export class Game {
	private last?: { character: Character; at: Date };

	/** Notes the character a question came from. */
	see(character: Character): void {
		this.last = { character, at: new Date() };
	}

	/** The character of the last question and when it asked, if there was one. */
	get character(): { character: Character; at: Date } | undefined {
		return this.last;
	}
}
