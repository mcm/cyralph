/**
 * Linear OAuth for an agent app (actor=app), as Cyrus does: the app becomes a workspace member
 * that can be assigned/delegated issues and @mentioned.
 */
export const LINEAR_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: LINEAR_SCOPES.join(","),
		actor: "app",
		state,
		prompt: "consent",
	});
	return `https://linear.app/oauth/authorize?${params.toString()}`;
}

export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type: string;
	scope: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch("https://api.linear.app/oauth/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
	if (!res.ok) throw new Error(`Linear token endpoint returned ${res.status}: ${await res.text()}`);
	return (await res.json()) as TokenResponse;
}

export function exchangeCode(opts: { clientId: string; clientSecret: string; redirectUri: string; code: string }) {
	return tokenRequest({
		grant_type: "authorization_code",
		code: opts.code,
		redirect_uri: opts.redirectUri,
		client_id: opts.clientId,
		client_secret: opts.clientSecret,
	});
}

export function refreshToken(opts: { clientId: string; clientSecret: string; refreshToken: string }) {
	return tokenRequest({
		grant_type: "refresh_token",
		refresh_token: opts.refreshToken,
		client_id: opts.clientId,
		client_secret: opts.clientSecret,
	});
}
