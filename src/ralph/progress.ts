/**
 * The Ralph progress log: an append-only markdown file the agent writes learnings to after
 * each story, with a "Codebase Patterns" section at the top that is fed into every prompt.
 * Each iteration runs with a fresh context window, so this file is the loop's long-term memory.
 */
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export const PROGRESS_HEADER = `# Ralph Progress Log

## Codebase Patterns (Study These First)
*Add reusable patterns discovered during development here.*

---
`;

export async function ensureProgressFile(path: string, epicTitle: string): Promise<void> {
	try {
		await readFile(path, "utf8");
	} catch {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${PROGRESS_HEADER}\nEpic: ${epicTitle}\n\n`, "utf8");
	}
}

export async function readProgress(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

export async function appendProgress(path: string, entry: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `\n${entry.trim()}\n`, "utf8");
}

/** The `## Codebase Patterns` section body, or undefined if empty/placeholder. */
export function extractCodebasePatterns(progress: string): string | undefined {
	const m = /^## Codebase Patterns[^\n]*\n([\s\S]*?)(?=^---\s*$|^## (?!Codebase)|(?![\s\S]))/m.exec(progress);
	const body = m?.[1]?.trim();
	if (!body || /^\*Add reusable patterns/.test(body)) return undefined;
	return body;
}

/** The last `count` story entries (sections starting with `## ` other than Codebase Patterns). */
export function recentProgressEntries(progress: string, count = 5): string | undefined {
	const parts = progress.split(/^(?=## )/m).filter((p) => p.startsWith("## ") && !p.startsWith("## Codebase Patterns"));
	if (parts.length === 0) return undefined;
	return parts
		.slice(-count)
		.map((p) => p.trim())
		.join("\n\n");
}
