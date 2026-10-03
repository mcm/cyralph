/**
 * Files uploaded to Linear (pasted screenshots, mockups, PDFs) live at `https://uploads.linear.app/...`
 * and need the workspace token to download. Like Cyrus' AttachmentService, cyralph downloads them
 * into a local folder and lists them in the prompt so the agent can open them with the Read tool
 * (which shows images to Claude).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export interface UploadRef {
	/** Upload URL without the expiring `?signature=...` query. */
	url: string;
	/** Name Linear stores with the upload (e.g. "mockup.png"), when known. */
	title?: string;
}

const UPLOAD_URL = /https:\/\/uploads\.linear\.app\/[A-Za-z0-9/_.-]+/;

function unsigned(url: string): string | undefined {
	// Sentence punctuation after a bare URL isn't part of it.
	return UPLOAD_URL.exec(url)?.[0]?.replace(/[.]+$/, "");
}

/**
 * Find upload references in markdown: Linear's `<linear-image>{json}</linear-image>` blocks,
 * `![title](url)` / `[title](url)` links, and bare upload URLs. Deduplicated by unsigned URL.
 */
export function extractUploads(text: string | undefined | null): UploadRef[] {
	if (!text) return [];
	const found = new Map<string, UploadRef>();
	const add = (rawUrl: string, title?: string) => {
		const url = unsigned(rawUrl);
		if (!url) return;
		const existing = found.get(url);
		if (!existing) found.set(url, { url, ...(title?.trim() && { title: title.trim() }) });
		else if (!existing.title && title?.trim()) existing.title = title.trim();
	};
	for (const m of text.matchAll(/<linear-image>([\s\S]*?)<\/linear-image>/g)) {
		try {
			const data = JSON.parse(m[1] ?? "") as { attrs?: { src?: string; title?: string; alt?: string } };
			if (data.attrs?.src) add(data.attrs.src, data.attrs.title ?? data.attrs.alt);
		} catch {
			// fall through to URL scanning
		}
	}
	for (const m of text.matchAll(/!?\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g)) {
		if (m[2]) add(m[2], m[1]);
	}
	for (const m of text.matchAll(new RegExp(UPLOAD_URL.source, "g"))) add(m[0]);
	return [...found.values()];
}

export interface DownloadResult {
	ok: boolean;
	status: number;
	contentType: string;
	data?: Buffer;
	error?: string;
}

export interface AttachmentFetcher {
	download(url: string): Promise<DownloadResult>;
}

const MAX_BYTES = 25 * 1024 * 1024;

/** Downloads with the Linear OAuth token (read lazily, so refreshed tokens are picked up). */
export class LinearUploadFetcher implements AttachmentFetcher {
	constructor(private readonly token: () => string | undefined) {}

	async download(url: string): Promise<DownloadResult> {
		const token = this.token();
		if (!token) return { ok: false, status: 0, contentType: "", error: "no Linear access token" };
		try {
			const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" });
			const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
			if (!res.ok) return { ok: false, status: res.status, contentType, error: `HTTP ${res.status}` };
			// A sign-in page instead of the file means the token wasn't accepted.
			if (contentType === "text/html") return { ok: false, status: res.status, contentType, error: "got an HTML page instead of the file" };
			const data = Buffer.from(await res.arrayBuffer());
			if (data.length > MAX_BYTES) return { ok: false, status: res.status, contentType, error: `larger than ${MAX_BYTES / 1024 / 1024} MB` };
			return { ok: true, status: res.status, contentType, data };
		} catch (err) {
			return { ok: false, status: 0, contentType: "", error: err instanceof Error ? err.message : String(err) };
		}
	}
}

const EXT_BY_TYPE: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/heic": ".heic",
	"application/pdf": ".pdf",
	"text/plain": ".txt",
	"text/csv": ".csv",
	"application/json": ".json",
	"application/zip": ".zip",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
};

/** A safe local filename: the upload's title when it has an extension, else title/fallback + type extension. */
export function attachmentFileName(ref: UploadRef, contentType: string, fallback: string): string {
	const base = (ref.title ?? "")
		.replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_")
		.replace(/^\.+/, "")
		.trim()
		.slice(0, 120);
	const typeExt = EXT_BY_TYPE[contentType] ?? "";
	if (base && /^\.[A-Za-z0-9]{1,8}$/.test(extname(base))) return base;
	return `${base || fallback}${typeExt || ".bin"}`;
}

export interface AttachmentSource {
	/** Where the text came from, e.g. "ENG-1 description", "US-002", "comment by Ana". */
	label: string;
	text: string | undefined | null;
	/** Story key this source belongs to (story-scoped attachments only go to that story's prompt). */
	storyKey?: string;
}

export interface AttachmentEntry {
	url: string;
	title?: string;
	/** Labels of every source that referenced it. */
	sources: string[];
	storyKeys: string[];
	/** Referenced by something not tied to one story (epic description, thread, epic comments). */
	shared: boolean;
	/** Local file, when downloaded. */
	path?: string;
	contentType?: string;
	error?: string;
}

interface CacheIndex {
	files: Record<string, { file: string; contentType: string }>;
}

/**
 * Download every upload referenced by `sources` into `dir` (cached by URL across runs) and return
 * the manifest. At most `max` files are fetched per call; the rest are reported as skipped.
 */
export async function collectAttachments(opts: {
	sources: AttachmentSource[];
	dir: string;
	fetcher: AttachmentFetcher;
	max?: number;
}): Promise<AttachmentEntry[]> {
	const max = opts.max ?? 20;
	const entries = new Map<string, AttachmentEntry>();
	for (const src of opts.sources) {
		for (const ref of extractUploads(src.text)) {
			const e = entries.get(ref.url) ?? { url: ref.url, title: ref.title, sources: [], storyKeys: [], shared: false };
			e.title ??= ref.title;
			if (!e.sources.includes(src.label)) e.sources.push(src.label);
			if (!src.storyKey) e.shared = true;
			else if (!e.storyKeys.includes(src.storyKey)) e.storyKeys.push(src.storyKey);
			entries.set(ref.url, e);
		}
	}
	if (entries.size === 0) return [];

	await mkdir(opts.dir, { recursive: true });
	const indexPath = join(opts.dir, ".index.json");
	let index: CacheIndex = { files: {} };
	try {
		index = JSON.parse(await readFile(indexPath, "utf8")) as CacheIndex;
	} catch {
		// first download for this epic
	}
	const used = new Set(Object.values(index.files).map((f) => f.file));

	let fetched = 0;
	let unnamed = Object.keys(index.files).length;
	for (const e of entries.values()) {
		const cached = index.files[e.url];
		if (cached && existsSync(join(opts.dir, cached.file))) {
			e.path = join(opts.dir, cached.file);
			e.contentType = cached.contentType;
			continue;
		}
		if (fetched >= max) {
			e.error = `skipped: more than ${max} attachments`;
			continue;
		}
		fetched++;
		const r = await opts.fetcher.download(e.url);
		if (!r.ok || !r.data) {
			e.error = r.error ?? `HTTP ${r.status}`;
			continue;
		}
		let file = attachmentFileName(e, r.contentType, `attachment-${unnamed + 1}`);
		if (!e.title) unnamed++;
		if (used.has(file)) {
			const ext = extname(file);
			const stem = file.slice(0, file.length - ext.length);
			let i = 2;
			while (used.has(`${stem}-${i}${ext}`)) i++;
			file = `${stem}-${i}${ext}`;
		}
		used.add(file);
		await writeFile(join(opts.dir, file), r.data);
		index.files[e.url] = { file, contentType: r.contentType };
		e.path = join(opts.dir, file);
		e.contentType = r.contentType;
	}
	await writeFile(indexPath, JSON.stringify(index, null, 2));
	return [...entries.values()];
}

/** Attachments relevant to one story: its own plus anything not tied to a specific story. */
export function attachmentsForStory(entries: AttachmentEntry[], storyKey: string): AttachmentEntry[] {
	return entries.filter((e) => e.shared || e.storyKeys.includes(storyKey));
}

/** Markdown list for prompts. */
export function formatAttachments(entries: AttachmentEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	return entries
		.map((e) => {
			const name = e.title ? `**${e.title}**` : "attachment";
			const from = `(from ${e.sources.join(", ")})`;
			return e.path ? `- ${name} ${from}: \`${e.path}\`` : `- ${name} ${from}: could not be downloaded (${e.error ?? "unknown error"}). Don't guess what it shows; say so if it matters.`;
		})
		.join("\n");
}
