// Original script was GPT4 but it has been deeply Ship of Theseused.
// Modernized (v0.2.0) for newer Ollama models:
//   * real system prompting via the chat API (messages: system + user),
//   * a "replacement keyword" marker at the cursor that the model completes from,
//   * a "lookahead" stop boundary so the explicit (multi-line) command stops at the
//     code that already follows — the model "sees ahead" and bridges in without
//     overwriting it.
// The on-completion-key suggestion is single-line (it stops at the next newline, like a
// legacy autocomplete); the command runs a full multi-line generation. Both stream into
// the cursor with a selection to undo.

import * as vscode from "vscode";
import axios from "axios";

let apiEndpoint: string;
let apiBearerToken: string;
let apiModel: string;
let systemPrompt: string;
let numPredict: number;
let promptWindowSize: number;
let completionKeys: Array<string>;
let responsePreview: boolean | undefined;
let responsePreviewMaxTokens: number;
let responsePreviewDelay: number;
let apiTemperature: number;
let replacementKeyword: string;
let lookaheadChars: number;
// Thinking/reasoning models put output in message.thinking, leaving content
// empty; disabling the reasoning phase routes the completion into content.
let think: boolean;

function updateVSConfig() {
	const c = vscode.workspace.getConfiguration("ollama-autocoder");
	apiEndpoint = c.get("endpoint") || "http://localhost:11434/api/chat";
	apiModel = c.get("model") || "";
	// System prompt replaces the old pseudo-system "message header".
	systemPrompt = c.get("system prompt") ?? "";
	numPredict = c.get("max tokens predicted") || 0;
	promptWindowSize = c.get("prompt window size") || 0;
	// "completion keys" used to be a string before it became an array. A legacy
	// or stray non-array value is still truthy, so the old `|| [" "]` fallback
	// would let it through and then `.map()` in activate() would throw. Coerce
	// any value into an array of strings, defaulting to [" "] when it is empty.
	const rawKeys = c.get("completion keys");
	const keyList = Array.isArray(rawKeys) ? rawKeys : rawKeys === undefined ? [] : [rawKeys];
	completionKeys = keyList.filter((k): k is string => typeof k === "string");
	if (completionKeys.length === 0) completionKeys = [" "];
	responsePreview = c.get("response preview");
	responsePreviewMaxTokens = c.get("preview max tokens") || 0;
	responsePreviewDelay = c.get("preview delay") || 0; // || 0 not || [default] because 0 is falsy
	apiTemperature = c.get("temperature") || 0;
	// The keyword may contain a literal newline, so use ?? (not ||) to respect an empty value.
	replacementKeyword = c.get("replacement keyword") ?? "<|COMPLETE|>";
	lookaheadChars = c.get("lookahead") || 0;
	// Thinking/reasoning models emit their completion into a separate reasoning
	// stream (message.thinking), leaving message.content empty. Default to off.
	think = c.get("think") ?? false;
}

updateVSConfig();

// No need for restart for any of these settings
vscode.workspace.onDidChangeConfiguration(updateVSConfig);

// Substitute placeholders so the model knows exactly what it is completing.
function substitute(template: string, document: vscode.TextDocument): string {
	return template
		.replace("{LANG}", document.languageId)
		.replace("{FILE_NAME}", document.fileName)
		.replace("{PROJECT_NAME}", vscode.workspace.name || "Untitled")
		.replace("{REPLACEMENT_KEYWORD}", replacementKeyword);
}

interface Prompt {
	/** The full user message sent to the model. */
	user: string;
	/** Stop sequences: the model halts when its output would reproduce any of these. */
	stop: string[];
}

// Build the modern prompt: the code before the cursor (windowed), a marker the model
// completes from, and a stop boundary chosen by `stopAtNewline`. The frequent
// on-completion-key *suggestion* is single-line: a newline always halts it, like a
// legacy autocomplete. The explicit *command* runs a full multi-line generation that
// "sees ahead" and stops at the following code's first non-empty line instead of a
// newline. The lookahead is a stop hint only — it is NOT sent to the model as input, so
// following code is never part of its context beyond what the model itself generates.
function buildPrompt(document: vscode.TextDocument, position: vscode.Position, stopAtNewline: boolean): Prompt {
	// Everything before the cursor, windowed to the prompt window.
	const before = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
	const windowed = before.length > promptWindowSize ? before.slice(before.length - promptWindowSize) : before;

	// Make sure the marker sits on its own line so the model has a clean "start here".
	const marker = windowed.endsWith("\n") ? replacementKeyword : "\n" + replacementKeyword;
	const user = windowed + marker;

	// Never echo the marker back.
	const stop: string[] = replacementKeyword ? [replacementKeyword] : [];

	if (stopAtNewline) {
		// The on-completion-key suggestion is a single line: always stop when the model
		// would continue onto the next line.
		stop.push("\n");
		return { user, stop };
	}

	// The explicit command runs a full multi-line generation that "sees ahead": keep
	// generating across newlines, but stop at the first non-empty line of the code that
	// already follows the cursor so it bridges in instead of overwriting it.
	if (lookaheadChars > 0) {
		const end = new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
		const ahead = document.getText(new vscode.Range(position, end));
		const aheadWindow = ahead.length > lookaheadChars ? ahead.slice(0, lookaheadChars) : ahead;
		// Stop at the first non-empty line of the following code.
		const boundary = aheadWindow.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
		if (boundary) stop.push(boundary);
	}

	return { user, stop };
}

// The Ollama chat API request body. No `raw`, so the model's chat template is applied
// (what modern models expect: they run on a system + user message, not a bare prompt).
function buildPayload(document: vscode.TextDocument, prompt: Prompt, stream: boolean, numTokens: number) {
	return {
		model: apiModel,
		// Thinking/reasoning models route their output into message.thinking,
		// leaving message.content empty, so the completion vanishes. Disabling the
		// reasoning phase puts it in content. NOTE: this must be top-level —
		// Ollama silently ignores "think" when nested inside options.
		think,
		messages: [
			{ role: "system", content: substitute(systemPrompt, document) },
			{ role: "user", content: prompt.user },
		],
		stream,
		options: {
			num_predict: numTokens,
			temperature: apiTemperature,
			stop: prompt.stop,
			num_ctx: Math.min(prompt.user.length, promptWindowSize), // assumes worst case of 1 char = 1 token
		},
	};
}

// Parse one streamed chat chunk. Tolerant of both `message` (chat) and `response`
// (generate) shapes in case a user points the endpoint at /api/generate.
function parseChunk(raw: Buffer): string {
	try {
		const obj = JSON.parse(raw.toString());
		return obj.message?.content ?? obj.response ?? "";
	} catch {
		return "";
	}
}

async function handleError(err: any) {
	if (err.code === 'ERR_CANCELED') return;

	let error_reason = err.code ? err.code.toString() : "";
	if (err.code === 'ECONNREFUSED') error_reason = "ECONNREFUSED — Ollama is likely not running";
	if (err.code === 'ERR_BAD_REQUEST') error_reason = "ERR_BAD_REQUEST — Settings are likely misconfigured";

	const error_response = err.message;

	// Show an error message
	vscode.window.showErrorMessage(
		"Ollama Autocoder encountered an error: " + error_reason + (error_response != "" ? ": " : "") +
		error_response);
	console.error(err);
}

// Full (multi-line) completion, run by the command: stream into the cursor with a
// selection to undo. It "sees ahead" (see buildPrompt) and stops at the code that
// already follows, so it is deliberately NOT stopped at the first newline.
async function inlineComplete(textEditor: vscode.TextEditor) {
	const document = textEditor.document;
	const position = textEditor.selection.active;

	// Show a progress message
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Ollama Autocoder",
			cancellable: true,
		},
		async (progress, progressCancellationToken) => {
			try {
				progress.report({ message: "Starting model..." });

				let axiosCancelPost: () => void;
				const axiosCancelToken = new axios.CancelToken((c) => {
					const cancelPost = function () {
						c("Autocompletion request terminated by user cancel");
					};
					axiosCancelPost = cancelPost;
					progressCancellationToken.onCancellationRequested(cancelPost);
					vscode.workspace.onDidCloseTextDocument(cancelPost);
				});

				const prompt = buildPrompt(document, position, false);
				const body = buildPayload(document, prompt, true, numPredict);

				const response = await axios.post(apiEndpoint, body, {
					cancelToken: axiosCancelToken,
					responseType: 'stream',
					headers: {
						Authorization: apiBearerToken !== "" ? "Bearer " + apiBearerToken : undefined,
					},
				});

				// tracker
				let currentPosition = position;

				response.data.on('data', async (d: Buffer) => {
					progress.report({ message: "Generating..." });

					// Check for user input (cancel)
					if (currentPosition.line != textEditor.selection.end.line || currentPosition.character != textEditor.selection.end.character) {
						axiosCancelPost(); // cancel axios => cancel finished promise => close notification
						return;
					}

					const completion = parseChunk(d);
					if (completion === "") {
						return;
					}

					// complete edit for token
					const edit = new vscode.WorkspaceEdit();
					edit.insert(document.uri, currentPosition, completion);
					await vscode.workspace.applyEdit(edit);

					// Move the cursor to the end of the completion
					const completionLines = completion.split("\n");
					const newPosition = new vscode.Position(
						currentPosition.line + completionLines.length - 1,
						(completionLines.length > 1 ? 0 : currentPosition.character) + completionLines[completionLines.length - 1].length
					);
					const newSelection = new vscode.Selection(
						position,
						newPosition
					);
					currentPosition = newPosition;

					// completion bar
					progress.report({ message: "Generating...", increment: 1 / (numPredict / 100) });

					// move cursor
					textEditor.selection = newSelection;
				});

				// Keep cancel window available
				const finished = new Promise((resolve) => {
					response.data.on('end', () => {
						progress.report({ message: "Ollama completion finished." });
						resolve(true);
					});
					axiosCancelToken.promise.finally(() => { // prevent notification from freezing on user input cancel
						resolve(false);
					});
				});

				await finished;
			} catch (err: any) {
				if (err.response && err.response.data) err.response.data.on('data', async (d: Buffer) => {
					const completion = JSON.parse(d.toString()).error;
					handleError(err);
				}).catch(handleError);
				else handleError(err);
			}
		}
	);
}

// Completion item provider callback for activate
async function provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, cancellationToken: vscode.CancellationToken) {

	// Create a completion item
	const item = new vscode.CompletionItem("Autocomplete with Ollama");

	// Set the insert text to a placeholder
	item.insertText = new vscode.SnippetString('${1:}');

	// Wait before initializing Ollama to reduce compute usage
	if (responsePreview) await new Promise(resolve => setTimeout(resolve, responsePreviewDelay * 1000));
	if (cancellationToken.isCancellationRequested) {
		return [item];
	}

	// Set the label & insert text to a shortened, non-stream single-line preview
	if (responsePreview) {
		try {
			const prompt = buildPrompt(document, position, true);
			const body = buildPayload(document, prompt, false, responsePreviewMaxTokens);

			const response_preview = await axios.post(apiEndpoint, body, {
				cancelToken: new axios.CancelToken((c) => {
					const cancelPost = function () {
						c("Autocompletion request terminated by completion cancel");
					};
					cancellationToken.onCancellationRequested(cancelPost);
				}),
				headers: {
					Authorization: apiBearerToken !== "" ? "Bearer " + apiBearerToken : undefined,
				},
			});

			const preview = (response_preview.data.message?.content ?? response_preview.data.response ?? "").trim();
			if (preview != "") {
				item.label = preview;
				item.insertText = preview;
			}
		} catch (err: any) {
			if (err.response && err.response.data) err.message = err.response.data.error;
			handleError(err);
		}
	}

	// Set the documentation to a message
	item.documentation = new vscode.MarkdownString('Press `Enter` to get an autocompletion from Ollama');
	// Keep the same inline behavior as before: accepting the item runs the command that
	// streams the completion into the cursor with a selection to undo.
	item.command = {
		command: 'ollama-autocoder.autocomplete',
		title: 'Autocomplete with Ollama',
		arguments: [cancellationToken],
	};
	// Return the completion item
	return [item];
}

// This method is called when extension is activated
function activate(context: vscode.ExtensionContext) {
	// Register a completion provider for everything
	const completionProvider = vscode.languages.registerCompletionItemProvider("*", {
		provideCompletionItems,
	},
		...completionKeys.map((s) => s.replace("\\n", "\n"))
	);

	// Bearer token secret handling
	context.secrets.get("apiBearerToken").then(value => {
		apiBearerToken = value || "";
	});

	const bearerSetChangeEvent = context.secrets.onDidChange((event) => {
		if (event.key === "apiBearerToken") {
			context.secrets.get("apiBearerToken").then(value => {
				apiBearerToken = value || "";
			});
		}
	});

	const externalSetBearerCommand = vscode.commands.registerCommand(
		"ollama-autocoder.setBearerToken",
		async () => {
			const tokenInput: string | undefined = await vscode.window.showInputBox({
				password: true,
				title: "Set API bearer token",
				prompt: "Enter your API key or the username followed by the password, depending on which reverse proxy you are using. If you would like to remove the authorization header, type [SPACE] and submit."
			});

			if (tokenInput && tokenInput.trim() !== "") {
				context.secrets.store("apiBearerToken", tokenInput);
			} else if (tokenInput) {
				context.secrets.delete("apiBearerToken");
			}
		}
	);

	// Inline completion as a command. The completion-item path passes a cancellation
	// token as its argument (not a TextEditor), so target the active editor explicitly.
	const internalAutocompleteCommand = vscode.commands.registerCommand(
		"ollama-autocoder.autocomplete",
		(..._args: any[]) => {
			const ed = vscode.window.activeTextEditor;
			if (ed) inlineComplete(ed);
		},
	);

	// Add the commands & completion provider to the context
	try {
		context.subscriptions.push(completionProvider);
		context.subscriptions.push(internalAutocompleteCommand);
		context.subscriptions.push(externalSetBearerCommand);
		context.subscriptions.push(bearerSetChangeEvent);
	} catch (err) {
		handleError(err);
	}

}

// This method is called when extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate,
};
