// The addon's files, imported as text to embed them into the executable.
declare module "*.lua" {
	const source: string;
	export default source;
}

declare module "*.toc" {
	const source: string;
	export default source;
}
