import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LinearUploadFetcher, attachmentFileName, collectAttachments, extractUploads } from "../src/linear/attachments.js";

const U = "https://uploads.linear.app/org/a1b2/c3d4";

describe("extractUploads", () => {
	it("reads Linear's <linear-image> blocks (signed src + title), markdown and bare URLs", () => {
		const text = `<linear-image>{"type":"image","attrs":{"src":"${U}?signature=e.y.J","title":"pavilion_contact_sheet.png"}}</linear-image>
See ![mockup](${U}/m?signature=abc) and [spec.pdf](${U}/spec) and ${U}/bare.
Again: ${U}?signature=other`;
		expect(extractUploads(text)).toEqual([
			{ url: U, title: "pavilion_contact_sheet.png" },
			{ url: `${U}/m`, title: "mockup" },
			{ url: `${U}/spec`, title: "spec.pdf" },
			{ url: `${U}/bare` },
		]);
		expect(extractUploads("no uploads here https://example.com/x.png")).toEqual([]);
	});
});

describe("attachmentFileName", () => {
	it("keeps titled names, adds an extension from the content type, and sanitises", () => {
		expect(attachmentFileName({ url: U, title: "pavilion_contact_sheet.png" }, "image/png", "a")).toBe("pavilion_contact_sheet.png");
		expect(attachmentFileName({ url: U, title: "badge mockup" }, "image/jpeg", "a")).toBe("badge mockup.jpg");
		expect(attachmentFileName({ url: U }, "image/webp", "attachment-3")).toBe("attachment-3.webp");
		expect(attachmentFileName({ url: U, title: "../../etc/passwd" }, "text/plain", "a")).toBe("_.._etc_passwd.txt");
		expect(attachmentFileName({ url: U }, "application/x-unknown", "f")).toBe("f.bin");
	});
});

describe("LinearUploadFetcher", () => {
	it("sends the Bearer token and rejects error statuses and HTML sign-in pages", async () => {
		const seen: Array<string | undefined> = [];
		const server = createServer((req, res) => {
			seen.push(req.headers.authorization);
			if (req.url === "/ok") return void res.writeHead(200, { "Content-Type": "image/png" }).end("PNGDATA");
			if (req.url === "/login") return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<html>");
			res.writeHead(401).end();
		});
		await new Promise<void>((r) => server.listen(0, r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		let token = "tok-1";
		const f = new LinearUploadFetcher(() => token);
		const ok = await f.download(`${base}/ok`);
		expect(ok).toMatchObject({ ok: true, contentType: "image/png" });
		expect(ok.data?.toString()).toBe("PNGDATA");
		token = "tok-2"; // refreshed token is picked up
		expect(await f.download(`${base}/nope`)).toMatchObject({ ok: false, status: 401, error: "HTTP 401" });
		expect(await f.download(`${base}/login`)).toMatchObject({ ok: false, error: "got an HTML page instead of the file" });
		expect(seen).toEqual(["Bearer tok-1", "Bearer tok-2", "Bearer tok-2"]);
		expect(await new LinearUploadFetcher(() => undefined).download(`${base}/ok`)).toMatchObject({ ok: false, error: "no Linear access token" });
		server.close();
	});
});

describe("collectAttachments", () => {
	it("dedupes names, caches by URL, and caps downloads per call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cyralph-att-"));
		const calls: string[] = [];
		const fetcher = {
			download: async (url: string) => {
				calls.push(url);
				return { ok: true, status: 200, contentType: "image/png", data: Buffer.from(url) };
			},
		};
		const sources = [{ label: "desc", text: `![shot.png](${U}/1) ![shot.png](${U}/2) ![x](${U}/3)` }];
		const first = await collectAttachments({ sources, dir, fetcher, max: 2 });
		expect(first.map((e) => e.path?.split("/").pop() ?? e.error)).toEqual(["shot.png", "shot-2.png", "skipped: more than 2 attachments"]);
		const second = await collectAttachments({ sources, dir, fetcher, max: 2 });
		expect(second.every((e) => e.path)).toBe(true);
		expect(calls).toEqual([`${U}/1`, `${U}/2`, `${U}/3`]);
		expect(readdirSync(dir).sort()).toEqual([".index.json", "shot-2.png", "shot.png", "x.png"]);
	});
});
