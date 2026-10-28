// Pure text helpers: ANSI stripping, CR collapsing, escape decoding, formatting.

// CSI, OSC, and single-char ESC sequences, plus stray C0 controls except \t \n \r.
const ANSI_RE =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** Collapse carriage-return progress output to the final state of each line. */
export function collapseCR(s: string): string {
	if (!s.includes("\r")) return s;
	return s
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			if (!line.includes("\r")) return line;
			const parts = line.split("\r");
			// Last non-empty segment wins (a trailing \r leaves an empty one).
			for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i];
			return "";
		})
		.join("\n");
}

/** Model-facing cleanup: strip ANSI, collapse progress bars. */
export function cleanOutput(s: string): string {
	return collapseCR(stripAnsi(s.replace(/\r\n/g, "\n")));
}

/** Decode C-style escapes: \n \r \t \e \\ \0 \xHH \uHHHH \u{H+} \NNN (octal). */
export function decodeEscapes(s: string): string {
	return s.replace(/\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_m, e: string) => {
		switch (e[0]) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "e":
				return "\x1b";
			case "a":
				return "\x07";
			case "b":
				return "\b";
			case "\\":
				return "\\";
			case "x":
				return String.fromCharCode(parseInt(e.slice(1), 16));
			case "u":
				return String.fromCodePoint(parseInt(e.startsWith("u{") ? e.slice(2, -1) : e.slice(1), 16));
			default:
				if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
				return `\\${e}`;
		}
	});
}

const NAMED_KEYS: Record<string, string> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	space: " ",
	escape: "\x1b",
	esc: "\x1b",
	backspace: "\x7f",
	delete: "\x1b[3~",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
};

/** Map key names (`ctrl-c`, `enter`, `up`, `alt-x`) to bytes. Throws on unknown names. */
export function encodeKeys(keys: string[]): string {
	let out = "";
	for (const raw of keys) {
		const k = raw.trim().toLowerCase().replace(/\+/g, "-");
		const ctrl = /^(?:ctrl|c)-(.)$/.exec(k);
		if (ctrl) {
			const ch = ctrl[1];
			if (ch >= "a" && ch <= "z") out += String.fromCharCode(ch.charCodeAt(0) - 96);
			else if (ch === "[") out += "\x1b";
			else if (ch === "\\") out += "\x1c";
			else if (ch === "]") out += "\x1d";
			else if (ch === "@" || ch === " ") out += "\x00";
			else throw new Error(`Unknown key: ${raw}`);
			continue;
		}
		const alt = /^(?:alt|meta|m)-(.+)$/.exec(k);
		if (alt) {
			out += `\x1b${NAMED_KEYS[alt[1]] ?? alt[1]}`;
			continue;
		}
		const named = NAMED_KEYS[k];
		if (named === undefined) {
			if (k.length === 1) out += k;
			else throw new Error(`Unknown key: ${raw}`);
		} else out += named;
	}
	return out;
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Last N lines of text (ignoring one trailing newline). */
export function lastLines(s: string, n: number): string {
	const lines = s.replace(/\n$/, "").split("\n");
	return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** Last non-empty line, trimmed. */
export function lastNonEmptyLine(s: string): string {
	const lines = s.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const t = lines[i].trim();
		if (t) return t;
	}
	return "";
}

/** Heuristic: does a line look like an interactive prompt waiting for input? */
export function looksLikePrompt(line: string): boolean {
	const t = line.trimEnd();
	if (!t) return false;
	return (
		/\?\s*$/.test(t) ||
		/\((?:y\/n|yes\/no|y\/N|Y\/n)\)\s*:?$/i.test(t) ||
		/\[(?:y\/n|Y\/n|y\/N)\]\s*:?$/.test(t) ||
		/(?:password|passphrase|username|login)[^:]*:\s*$/i.test(t) ||
		/>\s*$/.test(t)
	);
}

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Kind prefix plus 7 base36 chars, 8 chars total (e.g. `b7f3k9a2`). */
export function newTaskId(prefix: "b" | "m"): string {
	let s = prefix;
	for (let i = 0; i < 7; i++) s += B36[Math.floor(Math.random() * 36)];
	return s;
}

/** Shell-style single-quote a value. */
export function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** First line, clipped for labels. */
export function oneLine(s: string, max = 60): string {
	const first = s.trim().split("\n")[0] ?? "";
	return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
