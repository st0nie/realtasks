// rtk compatibility: recover the model's original `bash` command after the
// rtk hook rewrote `event.input.command` in place.

export interface BranchEntryLike {
	type: string;
	message?: { role?: string; content?: unknown };
}

const stash = new Map<string, string>();
const MAX_STASH = 256;

/** Our own tool_call handler: stores the command as we saw it. */
export function stashCommand(toolCallId: string, command: unknown): void {
	if (typeof command !== "string") return;
	if (stash.has(toolCallId)) return;
	stash.set(toolCallId, command);
	if (stash.size > MAX_STASH) {
		const first = stash.keys().next().value;
		if (first !== undefined) stash.delete(first);
	}
}

/** Original arguments of a tool call from the assistant message on the branch. */
export function commandFromBranch(entries: readonly BranchEntryLike[], toolCallId: string): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const content = e.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as { type?: string; id?: string; arguments?: { command?: unknown } };
			if (b?.type === "toolCall" && b.id === toolCallId) {
				const c = b.arguments?.command;
				return typeof c === "string" ? c : undefined;
			}
		}
	}
	return undefined;
}

export interface Recovered {
	/** Command the model wrote. */
	requested: string;
	/** Command the hooks handed to execute(). */
	executed: string;
	/** True when a hook rewrote the command. */
	rewritten: boolean;
	/** False when neither source knew the original (step 3 of the spec). */
	known: boolean;
}

/**
 * Step 1: our stash (exact if we load before rtk). Step 2: the transcript.
 * Step 3: unknown, run the rewrite and say so.
 */
export function recoverCommand(
	toolCallId: string,
	executed: string,
	branch: () => readonly BranchEntryLike[],
): Recovered {
	const stashed = stash.get(toolCallId);
	stash.delete(toolCallId);
	let original = stashed !== undefined && stashed !== executed ? stashed : undefined;
	if (original === undefined) {
		try {
			original = commandFromBranch(branch(), toolCallId);
		} catch {
			original = undefined;
		}
	}
	if (original === undefined) {
		// Stash matched executed (no rewrite, or we ran after rtk) and the branch had nothing.
		return { requested: executed, executed, rewritten: false, known: stashed !== undefined };
	}
	return { requested: original, executed, rewritten: original !== executed, known: true };
}

export function looksLikeRtk(executed: string): boolean {
	return /^\s*rtk\s/.test(executed);
}
