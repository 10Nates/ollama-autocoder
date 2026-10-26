import { StringDecoder } from "string_decoder";

/** Consume newline-delimited UTF-8 records in stream order. */
export async function consumeNdjsonStream(
	stream: AsyncIterable<Uint8Array>,
	processRecord: (record: string) => Promise<void>
): Promise<void> {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	for await (const chunk of stream) {
		buffer += decoder.write(chunk);
		const records = buffer.split("\n");
		buffer = records.pop() || "";

		for (const record of records) {
			if (record.trim() !== "") await processRecord(record);
		}
	}

	buffer += decoder.end();
	if (buffer.trim() !== "") await processRecord(buffer);
}
