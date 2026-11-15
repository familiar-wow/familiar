// The part of opentype.js the font test uses; the package ships no types.
declare module "opentype.js" {
	export interface Font {
		unitsPerEm: number;
		charToGlyph(char: string): { advanceWidth: number };
	}
	export function parse(buffer: ArrayBuffer | ArrayBufferLike): Font;
}
