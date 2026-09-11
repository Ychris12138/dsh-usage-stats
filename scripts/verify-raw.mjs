// verify-raw.mjs — independent verification of dsh-usage-stats numbers
// (INTEGRATION test: requires a running `dsh web` on :3080).
//
// Path A (raw bytes): decompress ~/.dsh/sessions/**/session.jsonl.zstd with
//   node:zlib + the zstd frame scanner (no dsh code involved in reading),
//   parse events, fold usage with lib/usage.js.
// Path B (dsh API): page session.history for the SAME seq prefix per session.
// Path C (plugin endpoint): GET /api/usage-stats/usage on the live server.
// Path D (official projection): session.list tokenUsage projection.
//
// Sessions are compared PER SESSION (raw file ↔ history of the same id) and
// in aggregate. Exits non-zero on any mismatch.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { consumeEvents, foldUsage, renderUsage } from "../lib/usage.js";

const BASE = "http://127.0.0.1:3080";
const ZSTD_MAGIC = 4247762216;

/** Replicate the JSONL backend's zstd frame scanner (per-frame header/block walk). */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

/** Decompress a whole session artifact into parsed event objects. */
function readSessionLog(file) {
	const buffer = readFileSync(file);
	const events = [];
	if (file.endsWith(".zstd")) {
		const { frames } = scanZstdFrames(buffer);
		if (frames.length === 0) throw new Error(`no complete frames in ${file}`);
		for (const frame of frames) {
			const plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end));
			for (const line of plain.toString("utf8").split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				const event = JSON.parse(trimmed);
				if (event !== null && typeof event === "object" && typeof event.type === "string" && typeof event.seq === "number") events.push(event);
			}
		}
	} else {
		for (const line of buffer.toString("utf8").split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			const event = JSON.parse(trimmed);
			if (event !== null && typeof event === "object" && typeof event.type === "string" && typeof event.seq === "number") events.push(event);
		}
	}
	return events;
}

async function rpc(method, payload) {
	const body = JSON.stringify({ type: "client-request", rpcId: `ver-${Math.random().toString(36).slice(2)}`, method, payload });
	const response = await fetch(`${BASE}/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body
	});
	const message = await response.json();
	if (!message.result?.ok) throw new Error(`${method}: ${message.result?.error?.code} ${message.result?.error?.message}`);
	return message.result.value;
}

/** Page every event of one session (oldest first). */
async function fetchAllEvents(sessionId) {
	const pages = [];
	let beforeSeq;
	let guard = 0;
	for (;;) {
		guard += 1;
		if (guard > 2000) throw new Error(`paging guard for ${sessionId}`);
		const page = await rpc("session.history", { sessionId, ...(beforeSeq === void 0 ? {} : { beforeSeq }), maxMessages: 500 });
		const events = page.events.map((entry) => entry.event);
		if (events.length === 0) break;
		pages.push(events);
		let minSeq = events[0].seq;
		for (const event of events) if (event.seq < minSeq) minSeq = event.seq;
		if (!page.hasMore || minSeq === 0) break;
		beforeSeq = minSeq;
	}
	return pages.reverse().flat();
}

// ---- collect raw session files, keyed by session id ----
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const sessionsRoot = join(dshHome, "sessions");
// Canonical generation filenames: `session.jsonl` (v0) and `session.v<N>.jsonl`
// (v1+), each optionally `.zstd`. A migrated session directory keeps its older
// generations, so exactly one artifact per directory is read: the highest
// version, which is the committed one.
const CANONICAL_LOG_FILENAME = /^session(\.v([1-9]\d*))?\.jsonl(\.zstd)?$/;
const files = [];
(function walk(dir) {
	const generations = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full);
			continue;
		}
		const match = CANONICAL_LOG_FILENAME.exec(entry.name);
		if (match !== null) generations.push([Number(match[2] ?? 0), full]);
	}
	if (generations.length === 0) return;
	generations.sort((left, right) => right[0] - left[0]);
	files.push(generations[0][1]);
})(sessionsRoot);
console.log(`raw session files: ${files.length}`);
for (const file of files) console.log("  ", file.replace(dshHome, "<DSH_HOME>"));

const rawSessions = new Map(); // id -> events
let preflightFailures = files.length === 0 ? 1 : 0;
if (files.length === 0) console.log("  !! no raw session artifacts found");
for (const file of files) {
	let events;
	try {
		events = readSessionLog(file);
	} catch (error) {
		console.log(`  !! read failed for ${basename(dirname(file))}: ${error.message}`);
		preflightFailures += 1;
		continue;
	}
	const headerLine = events.find((event) => event.type === "session");
	const id = headerLine?.id ?? basename(dirname(file));
	if (rawSessions.has(id)) {
		console.log(`  !! duplicate raw artifact for session ${id}`);
		preflightFailures += 1;
	}
	rawSessions.set(id, events);
}
console.log(`raw sessions identified: ${rawSessions.size}`);

// ---- Path A vs Path B, per session ----
const list = await rpc("session.list", {});
const listById = new Map(list.items.map((item) => [item.sessionId, item]));
const buckets = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "tokens"];
let mismatches = preflightFailures;
const projectedIds = new Set(list.items
	.filter((item) => item.projections?.values?.tokenUsage !== void 0)
	.map((item) => item.sessionId));
for (const id of projectedIds) {
	if (!rawSessions.has(id)) {
		console.log(`  !! projected session has no readable raw artifact: ${id}`);
		mismatches += 1;
	}
}
console.log(`raw coverage: ${projectedIds.size - [...projectedIds].filter((id) => !rawSessions.has(id)).length}/${projectedIds.size} projected session(s)`);

const compare = (name, left, right) => {
	const diffs = buckets.filter((key) => left[key] !== right[key]).map((key) => `${key}: ${left[key]} vs ${right[key]}`);
	if (diffs.length > 0) mismatches += diffs.length;
	console.log(`${name}: ${diffs.length === 0 ? "MATCH ✔" : "DIFFERS ✘  " + diffs.join(", ")}`);
};

const aggRaw = new Map();
const aggHistory = new Map();
for (const [id, rawEvents] of rawSessions) {
	const rawLastSeq = rawEvents.reduce((max, event) => Math.max(max, event.seq), -1);
	consumeEvents(aggRaw, rawEvents);
	console.log(`\n[${id}] raw bytes: ${rawEvents.length} events, lastSeq=${rawLastSeq}`);
	let historyEvents = [];
	if (listById.has(id)) {
		historyEvents = (await fetchAllEvents(id)).filter((event) => event.seq <= rawLastSeq);
		consumeEvents(aggHistory, historyEvents);
		console.log(`[${id}] history prefix: ${historyEvents.length} events (seq <= ${rawLastSeq})`);
	} else {
		console.log(`[${id}] not in session.list — validation failure`);
		mismatches += 1;
	}
	if (listById.has(id)) {
		compare(`A vs B (${id})`, renderUsage(foldUsage(rawEvents), Date.now()).total, renderUsage(foldUsage(historyEvents), Date.now()).total);
	}
}
compare("A aggregate (raw bytes) vs B aggregate (history)", renderUsage(aggRaw, Date.now()).total, renderUsage(aggHistory, Date.now()).total);

// ---- Path C vs Path D ----
const endpoint = await (await fetch(`${BASE}/api/usage-stats/usage`)).json();
console.log(`\n[Path C] plugin endpoint: days=${endpoint.days.length}`);
console.log(`  total: ${JSON.stringify(endpoint.total)}`);
const projectionAgg = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
for (const item of list.items) {
	const p = item.projections?.values?.tokenUsage;
	if (p === void 0) continue;
	projectionAgg.inputTokens += p.uncachedInputTokens ?? 0;
	projectionAgg.outputTokens += p.outputTokens ?? 0;
	projectionAgg.cacheReadTokens += p.cacheReadTokens ?? 0;
	projectionAgg.cacheWriteTokens += p.cacheWriteTokens ?? 0;
}
const d = { ...projectionAgg, tokens: projectionAgg.inputTokens + projectionAgg.outputTokens + projectionAgg.cacheReadTokens + projectionAgg.cacheWriteTokens };
console.log(`\n[Path D] official tokenUsage projections (sum over ${list.items.length} session(s)):`);
console.log(`  total: ${JSON.stringify(d)}`);
compare("C (plugin endpoint) vs D (official projection)", endpoint.total, d);

// ---- per-day table from raw ----
console.log("\nper-day table (from raw bytes):");
for (const day of renderUsage(aggRaw, Date.now()).days) console.log(`  ${day.date}  tokens=${day.tokens}  input=${day.inputTokens}  output=${day.outputTokens}  cacheRead=${day.cacheReadTokens}`);

if (mismatches > 0) {
	console.log(`\nVALIDATION FAILED: ${mismatches} bucket mismatches`);
	process.exit(1);
}
console.log("\nALL PATHS MATCH");
