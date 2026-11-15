/** Mono 8-bit PCM silence of `ms` milliseconds. */
export function silence(ms: number): Uint8Array {
	const samples = Math.round(8 * ms);
	const bytes = new Uint8Array(44 + samples).fill(0x80);
	const v = new DataView(bytes.buffer);
	const ascii = (at: number, text: string) => {
		for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
	};
	ascii(0, "RIFF");
	v.setUint32(4, 36 + samples, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, 8000, true);
	v.setUint32(28, 8000, true);
	v.setUint16(32, 1, true);
	v.setUint16(34, 8, true);
	ascii(36, "data");
	v.setUint32(40, samples, true);
	return bytes;
}

/**
 * A raised doorbell. Long enough that C_Sound.IsPlaying still reports it a moment later: the
 * client says even an empty file plays (build 1.60.1.70888).
 */
export const RAISED = silence(1500);
