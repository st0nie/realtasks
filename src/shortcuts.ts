// Shortcut key ids and the rules for sharing keys with Pi's keybindings.

import { getKeybindings, type KeyId } from "@earendil-works/pi-tui";

export type ShortcutSetting = "background" | "manager";
export type ResolvedBindings = Record<string, KeyId | KeyId[] | undefined>;

/** How a configured shortcut is installed: Pi does not bind it, it shares an editor key, or it clashes. */
export type ShortcutPlan = { kind: "free" } | { kind: "shared" } | { kind: "clash"; action: string };

const SPECIAL = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/** Pi actions already bound to `key` (defaults merged with keybindings.json). */
export function findKeyConflicts(key: string, resolved: ResolvedBindings): string[] {
	const k = key.toLowerCase();
	return Object.entries(resolved)
		.filter(([, keys]) => [keys].flat().some((x) => x?.toLowerCase() === k))
		.map(([action]) => action);
}

/**
 * Pi's resolved bindings. In the TUI, Pi installs its full manager (app and
 * editor defaults plus keybindings.json) with setKeybindings() before
 * session_start, so call this from session_start or later, not at load.
 */
export function piBindings(): ResolvedBindings {
	try {
		return getKeybindings().getResolvedBindings() as ResolvedBindings;
	} catch {
		return {};
	}
}

/**
 * Only the background key may share an editor key (through the input listener,
 * on an empty input); any other clash is refused.
 */
export function planShortcut(setting: ShortcutSetting, key: string, resolved: ResolvedBindings): ShortcutPlan {
	const clashes = findKeyConflicts(key, resolved);
	if (clashes.length === 0) return { kind: "free" };
	if (setting === "background" && clashes.every((a) => a.startsWith("tui.editor."))) return { kind: "shared" };
	return { kind: "clash", action: clashes.find((a) => !a.startsWith("tui.editor.")) ?? clashes[0] };
}

/** Why `key` is not a usable shortcut key id (Pi's `ctrl+shift+b` form), or undefined when it is. */
export function keyIdProblem(key: string): string | undefined {
	const parts = key.toLowerCase().split("+");
	// A trailing "+" is the plus key itself: "ctrl++".
	if (parts.length > 1 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
	const base = parts.pop() ?? "";
	const mods = parts;
	if (mods.some((m) => !MODIFIERS.has(m))) return `Unknown modifier in "${key}"; use ctrl, shift, alt or super.`;
	if (new Set(mods).size !== mods.length) return `Repeated modifier in "${key}".`;
	const printable = base.length === 1 && base !== " ";
	if (!printable && !SPECIAL.has(base)) return `Unknown key "${base || key}".`;
	if ((printable || base === "space") && !mods.some((m) => m !== "shift")) {
		return `"${key}" types text; add ctrl, alt or super.`;
	}
	return undefined;
}

/** Why `key` cannot be the `setting` shortcut, or undefined when it can. "off" is always accepted. */
export function shortcutProblem(setting: ShortcutSetting, key: string, resolved: ResolvedBindings): string | undefined {
	if (key === "off") return undefined;
	const bad = keyIdProblem(key);
	if (bad) return bad;
	const plan = planShortcut(setting, key, resolved);
	return plan.kind === "clash" ? `${key} is Pi's ${plan.action}; pick another key or "off".` : undefined;
}
