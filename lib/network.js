/** Shared pure network classification used by identity and SSRF policy. */

import { isIP } from "node:net";

function ipv4Private(octets) {
	const [a, b, c] = octets;
	return a === 0
		|| a === 10
		|| a === 127
		|| a === 169 && b === 254
		|| a === 172 && b >= 16 && b <= 31
		|| a === 192 && b === 168
		|| a === 192 && b === 0 && (c === 0 || c === 2)
		|| a === 192 && b === 88 && c === 99
		|| a === 100 && b >= 64 && b <= 127
		|| a === 198 && (b === 18 || b === 19)
		|| a === 198 && b === 51 && c === 100
		|| a === 203 && b === 0 && c === 113
		|| a >= 224;
}

function ipv6Bytes(address) {
	let value = address.toLowerCase().split("%")[0];
	const lastColon = value.lastIndexOf(":");
	if (value.slice(lastColon + 1).includes(".")) {
		const octets = value.slice(lastColon + 1).split(".").map(Number);
		if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
		value = `${value.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] === "" ? [] : halves[0].split(":");
	const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
	const missing = 8 - left.length - right.length;
	if (missing < 0 || halves.length === 1 && missing !== 0) return null;
	const words = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part || "0", 16));
	if (words.length !== 8 || words.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
	const bytes = [];
	for (const word of words) bytes.push(word >> 8, word & 0xff);
	return bytes;
}

/** True for loopback, private, link-local, documentation, multicast, and other non-public IP space. */
export function isPrivateAddress(address) {
	const value = String(address ?? "").trim().replace(/^\[|\]$/g, "");
	if (isIP(value) === 4) return ipv4Private(value.split(".").map(Number));
	if (isIP(value) !== 6) return false;
	const bytes = ipv6Bytes(value);
	if (bytes === null) return true;
	if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4Private(bytes.slice(12));
	const globalUnicast = (bytes[0] & 0xe0) === 0x20;
	const word0 = (bytes[0] << 8) | bytes[1];
	const word1 = (bytes[2] << 8) | bytes[3];
	const ietfSpecial = word0 === 0x2001 && word1 <= 0x01ff;
	const sixToFour = word0 === 0x2002;
	const documentation = word0 === 0x2001 && word1 === 0x0db8
		|| word0 === 0x3fff && (word1 & 0xf000) === 0;
	return !globalUnicast || ietfSpecial || sixToFour || documentation;
}

/** Whether a URL hostname is local/private without performing DNS resolution. */
export function isPrivateHostname(hostname) {
	const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	return host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host);
}
