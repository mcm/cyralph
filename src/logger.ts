export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
	debug(msg: string): void;
}

export function createLogger(scope = "cyralph"): Logger {
	const debug = process.env.CYRALPH_DEBUG === "1";
	const fmt = (level: string, msg: string) => `${new Date().toISOString()} ${level} [${scope}] ${msg}`;
	return {
		info: (m) => console.log(fmt("INFO ", m)),
		warn: (m) => console.warn(fmt("WARN ", m)),
		error: (m) => console.error(fmt("ERROR", m)),
		debug: (m) => {
			if (debug) console.log(fmt("DEBUG", m));
		},
	};
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
