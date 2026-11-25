<script lang="ts" generics="T extends string | number">
// A row of choices of which one is on: the saved value, not the last click.
let {
	labelledby,
	options,
	value,
	disabled,
	onchoose,
}: {
	labelledby: string;
	options: { value: T; label: string }[];
	value: T;
	disabled: boolean;
	onchoose: (value: T) => void;
} = $props();
</script>

<div class="seg" role="radiogroup" aria-labelledby={labelledby}>
	{#each options as option (option.value)}
		<button
			type="button"
			role="radio"
			aria-checked={value === option.value}
			class:on={value === option.value}
			{disabled}
			onclick={() => onchoose(option.value)}
		>
			{option.label}
		</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		flex-wrap: wrap;
		background: #0f1219;
		border: 1px solid var(--line);
		border-radius: 9px;
		padding: 3px;
		gap: 3px;
	}

	button {
		padding: 6px 14px;
		border-radius: 6px;
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
	}

	button:hover:not(:disabled):not(.on) {
		color: var(--text);
	}

	button.on {
		background: var(--panel2);
		color: var(--gold);
		box-shadow: inset 0 0 0 1px var(--gold-dim);
	}

	button:disabled {
		cursor: default;
	}

	button:disabled:not(.on) {
		opacity: 0.6;
	}

	button:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 2px;
	}
</style>
