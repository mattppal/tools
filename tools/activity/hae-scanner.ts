type Item = Record<string, unknown>;

type Role = "root" | "data" | "metrics" | "workouts" | "metric" | "samples" | "other";
type Frame = { role: Role; array: boolean; key: string | null; count: number; expectKey: boolean; metric: number };

export type HaeEvent =
	| { type: "sample"; metric: number; raw: string }
	| { type: "field"; metric: number; key: "name" | "units"; value: string }
	| { type: "metricEnd"; metric: number }
	| { type: "workout"; item: Item };

const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_OBJECT = 123;
const CLOSE_OBJECT = 125;
const OPEN_ARRAY = 91;
const CLOSE_ARRAY = 93;
const COMMA = 44;
const COLON = 58;

const isSpace = (code: number): boolean => code === 32 || code === 10 || code === 13 || code === 9;
const isItem = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);

export class HaeScanner {
	private buffer = "";
	private position = 0;
	private stack: Frame[] = [];
	private mode: "value" | "key" | "string" | "literal" | "capture" = "value";
	private tokenStart = 0;
	private escaped = false;
	private inString = false;
	private depth = 0;
	private capturing: "sample" | "workout" = "sample";
	private sawData = false;

	push(chunk: string): HaeEvent[] {
		const keep = this.mode === "key" || this.mode === "string" || this.mode === "capture" ? this.tokenStart : this.position;
		this.buffer = this.buffer.slice(keep) + chunk;
		this.position -= keep;
		this.tokenStart -= keep;
		const events: HaeEvent[] = [];
		const text = this.buffer;
		let index = this.position;
		while (index < text.length) {
			if (this.mode === "capture") {
				index = this.scanCapture(text, index, events);
				continue;
			}
			if (this.mode === "key" || this.mode === "string") {
				index = this.scanString(text, index, events);
				continue;
			}
			const code = text.charCodeAt(index);
			if (this.mode === "literal") {
				if (code === COMMA || code === CLOSE_OBJECT || code === CLOSE_ARRAY || isSpace(code)) this.mode = "value";
				else index++;
				continue;
			}
			index++;
			if (isSpace(code) || code === COLON) continue;
			const top = this.stack.at(-1);
			if (code === COMMA) {
				if (top !== undefined && !top.array) top.expectKey = true;
			} else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
				this.open(code === OPEN_ARRAY, index - 1);
			} else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
				const frame = this.stack.pop();
				if (frame?.role === "metric") events.push({ type: "metricEnd", metric: frame.metric });
			} else if (code === QUOTE) {
				this.mode = top !== undefined && !top.array && top.expectKey ? "key" : "string";
				if (this.mode === "string") this.startValue();
				this.tokenStart = index - 1;
				this.escaped = false;
			} else {
				this.startValue();
				this.mode = "literal";
			}
		}
		this.position = index;
		return events;
	}

	end(): string | null {
		if (this.mode === "capture" || this.mode === "key" || this.mode === "string" || this.stack.length > 0) return "The body ended before the JSON did.";
		if (!this.sawData) return 'Expected Health Auto Export JSON, version 2: {"data":{"metrics":[...],"workouts":[...]}}';
		return null;
	}

	private startValue(): void {
		const top = this.stack.at(-1);
		if (top?.array === true) top.count++;
	}

	private open(array: boolean, at: number): void {
		const parent = this.stack.at(-1);
		this.startValue();
		const key = parent === undefined || parent.array ? null : parent.key;
		if (!array && (parent?.role === "samples" || parent?.role === "workouts")) {
			this.mode = "capture";
			this.capturing = parent.role === "samples" ? "sample" : "workout";
			this.tokenStart = at;
			this.depth = 1;
			this.inString = false;
			this.escaped = false;
			return;
		}
		const role = this.roleFor(parent, key, array);
		if (role === "data") this.sawData = true;
		const metric = role === "metric" ? (parent?.count ?? 0) - 1 : (parent?.metric ?? -1);
		this.stack.push({ role, array, key: null, count: 0, expectKey: !array, metric });
	}

	private roleFor(parent: Frame | undefined, key: string | null, array: boolean): Role {
		if (parent === undefined) return array ? "other" : "root";
		if (parent.role === "root" && !array && key === "data") return "data";
		if (parent.role === "data" && array && key === "metrics") return "metrics";
		if (parent.role === "data" && array && key === "workouts") return "workouts";
		if (parent.role === "metrics" && !array) return "metric";
		if (parent.role === "metric" && array && key === "data") return "samples";
		return "other";
	}

	private scanString(text: string, from: number, events: HaeEvent[]): number {
		for (let index = from; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (this.escaped) this.escaped = false;
			else if (code === BACKSLASH) this.escaped = true;
			else if (code === QUOTE) {
				const value = JSON.parse(text.slice(this.tokenStart, index + 1)) as string;
				const top = this.stack.at(-1);
				if (this.mode === "key" && top !== undefined) {
					top.key = value;
					top.expectKey = false;
				} else if (top?.role === "metric" && (top.key === "name" || top.key === "units")) {
					events.push({ type: "field", metric: top.metric, key: top.key, value });
				}
				this.mode = "value";
				return index + 1;
			}
		}
		return text.length;
	}

	private scanCapture(text: string, from: number, events: HaeEvent[]): number {
		for (let index = from; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (this.inString) {
				if (this.escaped) this.escaped = false;
				else if (code === BACKSLASH) this.escaped = true;
				else if (code === QUOTE) this.inString = false;
			} else if (code === QUOTE) {
				this.inString = true;
			} else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
				this.depth++;
			} else if ((code === CLOSE_OBJECT || code === CLOSE_ARRAY) && --this.depth === 0) {
				const raw = text.slice(this.tokenStart, index + 1);
				if (this.capturing === "sample") events.push({ type: "sample", metric: this.stack.at(-1)?.metric ?? -1, raw });
				else {
					const item: unknown = JSON.parse(raw);
					if (isItem(item)) events.push({ type: "workout", item });
				}
				this.mode = "value";
				return index + 1;
			}
		}
		return text.length;
	}
}
