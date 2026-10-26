const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const { consumeNdjsonStream } = require("../out/streaming.js");

test("consumes split UTF-8 NDJSON records sequentially and flushes the final record", async () => {
	const payload = Buffer.from('{"response":"first"}\n{"response":"café 🧪"}');
	const chunks = Array.from(payload, (_, index) => payload.subarray(index, index + 1));
	const values = [];
	let active = 0;
	let maxActive = 0;

	await consumeNdjsonStream(Readable.from(chunks), async (record) => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => setImmediate(resolve));
		values.push(JSON.parse(record).response);
		active--;
	});

	assert.deepEqual(values, ["first", "café 🧪"]);
	assert.equal(maxActive, 1);
});
