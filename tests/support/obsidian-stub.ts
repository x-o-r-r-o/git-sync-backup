// Just enough of the Obsidian API for the sync engine to run under Node.
export class TAbstractFile {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}
export class TFile extends TAbstractFile {
	stat = { mtime: 0, size: 0, ctime: 0 };
}
export class TFolder extends TAbstractFile {}
export function arrayBufferToBase64(b: ArrayBuffer): string {
	return Buffer.from(new Uint8Array(b)).toString("base64");
}
export function requestUrl(): never {
	throw new Error("network not available in tests");
}
