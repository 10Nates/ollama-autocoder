// Significant help from GPT4

import * as vscode from "vscode";
import axios from "axios";

let VSConfig: vscode.WorkspaceConfiguration;
let apiEndpoint: string;
let apiModel: string;
let apiSystemMessage: string | undefined;
let numPredict: number;
let promptWindowSize: number;
let rawInput: boolean | undefined;

function updateVSConfig() {
	VSConfig = vscode.workspace.getConfiguration("ollama-autocoder");
	apiEndpoint = VSConfig.get("apiEndpoint") || "http://localhost:11434/api/generate";
	apiModel = VSConfig.get("model") || "openhermes2.5-mistral:7b-q4_K_M"; // The model I tested with
	apiSystemMessage = VSConfig.get("system message");
	numPredict = VSConfig.get("max tokens predicted") || 500;
	promptWindowSize = VSConfig.get("prompt window size") || 2000;
	rawInput = VSConfig.get("raw input");

	if (apiSystemMessage == "DEFAULT" || rawInput) apiSystemMessage = undefined;
}

updateVSConfig();

// No need for restart for any of these settings
vscode.workspace.onDidChangeConfiguration(updateVSConfig);

// internal function for autocomplete, not directly exposed
async function autocompleteCommand(document: vscode.TextDocument, position: vscode.Position, cancellationToken?: vscode.CancellationToken) {
	// Get the current prompt
	let prompt = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
	prompt = prompt.substring(Math.max(0, prompt.length - promptWindowSize), prompt.length);

	// Show a progress message
	vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Ollama Autocoder",
			cancellable: true,
		},
		async (progress, progressCancellationToken) => {
			try {
				progress.report({ message: "Starting model..." });

				// Make a request to the ollama.ai REST API
				const response = await axios.post(apiEndpoint, {
					model: apiModel, // Change this to the model you want to use
					prompt: prompt,
					stream: true,
					system: apiSystemMessage,
					raw: rawInput,
					options: {
						num_predict: numPredict
					}
				}, {
					cancelToken: new axios.CancelToken((c) => {
						const cancelPost = function () {
							c("Autocompletion request terminated");
						};
						if (cancellationToken) cancellationToken.onCancellationRequested(cancelPost);
						progressCancellationToken.onCancellationRequested(cancelPost);
						vscode.workspace.onDidCloseTextDocument(cancelPost);
					}),
					responseType: 'stream'
				}
				);

				//tracker
				let currentPosition = position;

				response.data.on('data', async (d: Uint8Array) => {
					progress.report({ message: "Generating..." });

					// Get a completion from the response
					const completion: string = JSON.parse(d.toString()).response;

					//complete edit for token
					const edit = new vscode.WorkspaceEdit();
					const range = new vscode.Position(
						currentPosition.line,
						currentPosition.character
					);
					edit.insert(document.uri, range, completion);
					await vscode.workspace.applyEdit(edit);

					// Move the cursor to the end of the completion
					const completionLines = completion.split("\n");
					const newPosition = new vscode.Position(
						currentPosition.line + completionLines.length - 1,
						(completionLines.length > 1 ? 0 : currentPosition.character) + completionLines[completionLines.length - 1].length
					);
					const newSelection = new vscode.Selection(
						newPosition,
						newPosition
					);
					currentPosition = newPosition;

					// completion bar
					progress.report({ message: "Generating...", increment: 1 / (numPredict / 100) });

					// move cursor
					const editor = vscode.window.activeTextEditor;
					if (editor) editor.selection = newSelection;
				});

				// Keep cancel window available
				const finished = new Promise((resolve) => {
					response.data.on('end', () => {
						progress.report({ message: "Ollama completion finished." });
						resolve(true);
					});
				});

				await finished;

			} catch (err: any) {
				// Show an error message
				vscode.window.showErrorMessage(
					"Ollama encountered an error: " + err.message
				);
				console.log(err);
			}
		}
	);
}

// This method is called when extension is activated
function activate(context: vscode.ExtensionContext) {
	// Register a completion provider for JavaScript files
	const completionProvider = vscode.languages.registerCompletionItemProvider("*", {
		async provideCompletionItems(document, position, cancellationToken) {
			// Create a completion item
			const item = new vscode.CompletionItem("Autocomplete with Ollama");
			// Set the insert text to a placeholder
			item.insertText = new vscode.SnippetString('${1:}');
			// Set the documentation to a message
			item.documentation = new vscode.MarkdownString('Press `Enter` to get a completion from Ollama');
			// Set the command to trigger the completion
			item.command = {
				command: 'ollama-autocoder.autocomplete-internal',
				title: 'Ollama',
				arguments: [document, position, cancellationToken]
			};
			// Return the completion item
			return [item];
		},
	},
		" "
	);

	// Register command passthrough for completionProvider
	const internalAutocompleteCommand = vscode.commands.registerCommand(
		"ollama-autocoder.autocomplete-internal",
		autocompleteCommand
	);

	// Register a command for getting a completion from Ollama through command/keybind
	const externalAutocompleteCommand = vscode.commands.registerTextEditorCommand(
		"ollama-autocoder.autocomplete",
		(textEditor) => {
			// no cancellation token from here
			autocompleteCommand(textEditor.document, textEditor.selection.active);
		}
	);

	// Add the commands & completion provider to the context
	context.subscriptions.push(completionProvider);
	context.subscriptions.push(internalAutocompleteCommand);
	context.subscriptions.push(externalAutocompleteCommand);

}

// This method is called when extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate,
};
