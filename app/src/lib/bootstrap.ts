// The steps that connect a page to a freshly started core. They run once per generation: a
// second trigger for the same core joins the run under way, a newer core abandons the old run.

export interface Step {
	name: string;
	run: () => Promise<void>;
}

export interface BootstrapOptions {
	steps: (gen: number) => Step[];
	/** A step failed for the current generation; the run stops there. */
	failed: (gen: number, step: string, message: string) => void;
}

export class Bootstrap {
	private gen = 0;
	private flight?: Promise<boolean>;

	constructor(private readonly o: BootstrapOptions) {}

	/** Resolves to true when every step of this generation ran. */
	run(gen: number): Promise<boolean> {
		if (gen < this.gen) return Promise.resolve(false);
		if (gen === this.gen && this.flight) return this.flight;
		this.gen = gen;
		this.flight = this.go(gen);
		return this.flight;
	}

	private async go(gen: number): Promise<boolean> {
		for (const step of this.o.steps(gen)) {
			if (gen !== this.gen) return false;
			try {
				await step.run();
			} catch (error) {
				if (gen === this.gen)
					this.o.failed(
						gen,
						step.name,
						error instanceof Error ? error.message : String(error),
					);
				return false;
			}
		}
		return gen === this.gen;
	}
}
