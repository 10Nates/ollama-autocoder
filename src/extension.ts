// Original script was GPT4 but it has been deeply Ship of Theseused.
// Modernized (v0.2.0) for newer Ollama models:
//   * real system prompting via the chat API (messages: system + user),
//   * a "replacement keyword" marker at the cursor that the model completes from,
//   * a "lookahead" stop boundary so multi-line proposals bridge into the code
//     that already follows the cursor.
// The single-line completion (shown on a completion key and filled inline with a
// selection to undo) is unchanged. Multi-line proposals move to a diff box (see
// the "propose" flow), which can be accepted, rejected, or modified.

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

// --- Diff-box (multi-line proposal) state ------------------------------------
// The proposal is shown in a native VS Code diff editor against the current
// document. The "proposed" side lives in an in-memory document served by a content
// provider, so it can be edited ("modified") live without touching the source file.
const proposalScheme = "ollama-autocoder";
const proposalContents = new Map<string, string>();
let activeSession: ProposalSession | undefined;
let proposalId = 0;

interface ProposalSession {
	document: vscode.TextDocument;
	/** In-memory "proposed" document; its live text holds any user edits ("modify"). */
	proposalDocument: vscode.TextDocument;
	proposalUri: vscode.Uri;
	statusBarItem: vscode.StatusBarItem;
}

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

type Mode = "line" | "block";

interface Prompt {
	/** The full user message sent to the model. */
	user: string;
	/** Stop sequences: the model halts when its output would reproduce any of these. */
	stop: string[];
}

// Build the modern prompt: code before the cursor (windowed) + the replacement
// keyword marker, plus a lookahead stop boundary for block proposals.
function buildPrompt(document: vscode.TextDocument, position: vscode.Position, mode: Mode): Prompt {
	// Everything before the cursor, windowed to the prompt window.
	const before = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
	const windowed = before.length > promptWindowSize ? before.slice(before.length - promptWindowSize) : before;

	// Make sure the marker sits on its own line so the model has a clean "start here".
	const marker = windowed.endsWith("\n") ? replacementKeyword : "\n" + replacementKeyword;
	const user = windowed + marker;

	// Never echo the marker back, and (for the line) stop at the end of the current line.
	const stop: string[] = replacementKeyword ? [replacementKeyword] : [];
	if (mode === "line") {
		stop.push("\n");
		return { user, stop };
	}

	// "block": use a lookahead so the proposal stops where the code that already follows
	// begins, instead of overwriting it. The lookahead is NOT sent to the model as trailing
	// input (that would make it continue past the marker); it only finds the stop boundary.
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

// Generate a full completion and return its text (no insertion). Streaming is
// cancellable from the progress notification and aborts if the source document
// changes underneath us (which would invalidate the cursor position).
async function generateCompletion(
	document: vscode.TextDocument,
	position: vscode.Position,
	mode: Mode,
	numTokens: number,
): Promise<string> {
	const prompt = buildPrompt(document, position, mode);
	const startVersion = document.version;

	return await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Ollama Autocoder",
			cancellable: true,
		},
		async (_progress, progressCancellationToken) => {
			_progress.report({ message: "Starting model..." });

			let axiosCancelPost: () => void;
			const axiosCancelToken = new axios.CancelToken((c) => {
				const cancelPost = function () {
					c("Autocompletion request terminated by user cancel");
				};
				axiosCancelPost = cancelPost;
				progressCancellationToken.onCancellationRequested(cancelPost);
				// Abort if the source document closes or changes underneath us
				// (the box generation does not insert live, so a version change is the
				// signal the user is now editing the same document).
				const onClose = vscode.workspace.onDidCloseTextDocument((closed) => {
					if (closed === document) axiosCancelPost();
				});
				const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
					if (e.document === document && document.version !== startVersion) axiosCancelPost();
				});
				axiosCancelToken.promise.finally(() => {
					onClose.dispose();
					onDocChange.dispose();
				});
			});

			const response = await axios.post(apiEndpoint, buildPayload(document, prompt, true, numTokens), {
				cancelToken: axiosCancelToken,
				responseType: 'stream',
				headers: {
					Authorization: apiBearerToken !== "" ? "Bearer " + apiBearerToken : undefined,
				},
			});

			let text = "";
			const done = new Promise<void>((resolve) => {
				response.data.on('data', (chunk: Buffer) => {
					const chunk2 = parseChunk(chunk);
					if (chunk2 !== "") text += chunk2;
				});
				response.data.on('end', () => resolve());
				axiosCancelToken.promise.finally(() => resolve());
			});

			await done;
			return text;
		}
	);
}

// inline / single-line completion (behavior unchanged: stream into the cursor with a
// selection highlight so the user can undo). "Line completion stays the same."
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

				const prompt = buildPrompt(document, position, "line");
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
			const prompt = buildPrompt(document, position, "line");
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
	// Keep the same inline behavior as before when the item is accepted.
	item.command = {
		command: 'ollama-autocoder.autocomplete',
		title: 'Autocomplete with Ollama',
		arguments: [cancellationToken],
	};
	// Return the completion item
	return [item];
}

// Show a multi-line proposal as a git-diff-like box the user can accept, reject,
// or modify. The "proposed" side is an in-memory, editable document, so the user
// can tweak the proposal directly before accepting.
async function showProposalBox(document: vscode.TextDocument, position: vscode.Position, generated: string) {
	// Dismiss any dangling proposal first.
	disposeSession();

	if (generated.trim() === "") return;

	// Rebuild the proposal from the current document so it reflects live edits.
	const end = new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
	const before = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
	const after = document.getText(new vscode.Range(position, end));
	const proposed = before + generated + after;

	// Serve the proposed content from an in-memory document so it's editable.
	const proposalUri = vscode.Uri.parse(`${proposalScheme}://proposal-${proposalId++}`);
	proposalContents.set(proposalUri.toString(), proposed);
	const proposalDocument = await vscode.workspace.openTextDocument(proposalUri);
	try {
		await vscode.languages.setTextDocumentLanguage(proposalDocument, document.languageId);
	} catch (_e) {
		/* language may be unknown; ignore */
	}

	// Open the native diff editor: original on the left, proposed (editable) on the right.
	await vscode.commands.executeCommand(
		"vscode.diff",
		document.uri,
		proposalUri,
		"Original ⇆ Ollama Autocoder",
	);

	// Accept / reject controls.
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.text = "$(check-all) Ollama proposal";
	statusBarItem.tooltip =
		"Accept (Ctrl+Enter) / Reject (Ctrl+Shift+Enter) the Ollama proposal. " +
		"Click into the right panel to modify the proposal, then accept.";
	statusBarItem.command = "ollama-autocoder.accept";
	statusBarItem.show();

	activeSession = { document, proposalDocument, proposalUri, statusBarItem };
}

// Replace the whole source document with the (possibly "modified") proposal text.
async function acceptSession() {
	const session = activeSession;
	if (!session) return;
	// getText() is live, so any edits the user made in the right panel are included.
	const text = session.proposalDocument.getText();
	disposeSession();

	const doc = session.document;
	const full = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(doc.uri, full, text);
	await vscode.workspace.applyEdit(edit);
	// Return focus to the source; the diff now shows "no changes", confirming the accept.
	if (vscode.workspace.textDocuments.includes(doc)) {
		try {
			await vscode.window.showTextDocument(doc);
		} catch (_e) {
			/* ignore a document that was closed before we could refocus it */
		}
	}
}

async function rejectSession() {
	const session = activeSession;
	if (!session) return;
	disposeSession();
	// Return focus to the source without applying anything, if it's still open.
	if (vscode.workspace.textDocuments.includes(session.document)) {
		try {
			await vscode.window.showTextDocument(session.document);
		} catch (_e) {
			/* ignore a document that was closed */
		}
	}
}

// Tear down the active proposal, if any.
function disposeSession() {
	const session = activeSession;
	if (!session) return;
	activeSession = undefined;
	session.statusBarItem.dispose();
	proposalContents.delete(session.proposalUri.toString());
}

// Generate a multi-line block for the active editor and open the diff box for it.
async function proposeBlock() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const position = editor.selection.active;
	const generated = await generateCompletion(editor.document, position, "block", numPredict);
	await showProposalBox(editor.document, position, generated);
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

	// Register the inline (single-line) completion command. Behavior unchanged from
	// before; multi-line proposals use the diff box below.
	const internalAutocompleteCommand = vscode.commands.registerCommand(
		"ollama-autocoder.autocomplete",
		(textEditor: vscode.TextEditor, ..._args: any[]) => {
			// The completion-item path passes args positionally; use the active editor otherwise.
			const ed = textEditor || vscode.window.activeTextEditor;
			if (ed) inlineComplete(ed);
		},
	);

	// Serve in-memory "proposed" documents so the diff box's right (proposed) side is
	// editable, i.e. the user can modify a proposal before accepting.
	const proposalProvider: vscode.TextDocumentContentProvider = {
		provideTextDocumentContent: (uri) => proposalContents.get(uri.toString()) ?? "",
	};

	// Register the multi-line diff-box proposal and its accept / reject controls.
	const proposeCommand = vscode.commands.registerCommand("ollama-autocoder.propose", () => proposeBlock());
	const acceptCommand = vscode.commands.registerCommand("ollama-autocoder.accept", () => acceptSession());
	const rejectCommand = vscode.commands.registerCommand("ollama-autocoder.reject", () => rejectSession());

	// Clean up (reject) automatically when the source or proposal document is closed.
	// VS Code has no editor-close event for diff editors, and a diff tab's panes are not
	// TextEditors (so onDidChangeVisibleTextEditors can't see the proposal either); watching
	// the closed documents is the reliable signal that a proposal is no longer in play.
	const onDidCloseProposalDocument = vscode.workspace.onDidCloseTextDocument((closed) => {
		const session = activeSession;
		if (!session) return;
		if (closed === session.document || closed.uri.toString() === session.proposalUri.toString()) {
			rejectSession();
		}
	});

	// Add the commands & providers to the context
	try {
		context.subscriptions.push(completionProvider);
		context.subscriptions.push(internalAutocompleteCommand);
		context.subscriptions.push(externalSetBearerCommand);
		context.subscriptions.push(bearerSetChangeEvent);
		context.subscriptions.push(proposeCommand);
		context.subscriptions.push(acceptCommand);
		context.subscriptions.push(rejectCommand);
		context.subscriptions.push(onDidCloseProposalDocument);
		context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(proposalScheme, proposalProvider));
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
