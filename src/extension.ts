// Significant help from GPT4

import * as vscode from "vscode";
import axios, { AxiosResponse } from "axios";

const VSConfig = vscode.workspace.getConfiguration("ollama-coder");
const apiEndpoint: string = VSConfig.get("apiEndpoint") || "http://localhost:11434/api/generate";
const apiModel: string = VSConfig.get("model") || "deepseek-coder";
let apiSystemMessage: string | undefined = VSConfig.get("system-message");
if (apiSystemMessage == "DEFAULT") apiSystemMessage = undefined;
const numPredict: number = VSConfig.get("max-tokens-predicted") || 500;
const promptWindowSize: number = VSConfig.get("prompt-window-size") || 2000;

// Function called on ollama-coder.autocomplete
async function autocompleteCommand(document: vscode.TextDocument, position: vscode.Position, prompt: string, cancellationToken: vscode.CancellationToken) {
	// Show a progress message
	vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Getting a completion from Ollama...",
			cancellable: true,
		},
		async (progress, progressCancellationToken) => {
			try {
				// Make a request to the ollama.ai REST API
				const response = await axios.post(apiEndpoint, {
					model: apiModel, // Change this to the model you want to use
					prompt: prompt,
					stream: true,
					system: apiSystemMessage,
					options: {
						num_predict: numPredict
					},
				}, {
					cancelToken: new axios.CancelToken((c) => {
						const cancelPost = function () {
							c("Autocompletion request terminated");
						};
						cancellationToken.onCancellationRequested(cancelPost);
						progressCancellationToken.onCancellationRequested(cancelPost);
						vscode.workspace.onDidCloseTextDocument(cancelPost);
					}),
					responseType: 'stream'
				}
				);

				//tracker
				let currentPosition = position;

				response.data.on('data', async (d: Uint8Array) => {
					// Get a completion from the response
					const completion: string = JSON.parse(d.toString()).response;

					//complete edit for token
					const edit = new vscode.WorkspaceEdit();
					const range = new vscode.Range(
						currentPosition.line,
						currentPosition.character,
						currentPosition.line,
						currentPosition.character
					);
					edit.replace(document.uri, range, completion);
					await vscode.workspace.applyEdit(edit);

					// Move the cursor to the end of the completion
					const completionLines = completion.split("\n");
					const newPosition = position.with(
						currentPosition.line + completionLines.length,
						(completionLines.length > 0 ? 0 : currentPosition.character) + completionLines[completionLines.length - 1].length
					);
					const newSelection = new vscode.Selection(
						newPosition,
						newPosition
					);
					currentPosition = newPosition;

					// completion bar
					progress.report({ increment: 1 / (numPredict/100) });

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
			}
		}
	);
}

// This method is called when your extension is activated
function activate(context: vscode.ExtensionContext) {
	// Register a completion provider for JavaScript files
	const provider = vscode.languages.registerCompletionItemProvider("*", {
		async provideCompletionItems(document, position, cancellationToken) {
			// Get the current prompt
			let prompt = document.getText(new vscode.Range(document.lineAt(0).range.start, position));
			prompt = prompt.substring(Math.max(0, prompt.length - promptWindowSize), prompt.length);
			// Check if the prompt is not empty and ends with a dot
			if (prompt) {
				// Create a completion item
				const item = new vscode.CompletionItem("Autocomplete with Ollama");
				// Set the insert text to a placeholder
				item.insertText = new vscode.SnippetString('${1:}');
				// Set the documentation to a message
				item.documentation = new vscode.MarkdownString('Press `Enter` to get a completion from Ollama');
				// Set the command to trigger the completion
				item.command = {
					command: 'ollama-coder.autocomplete',
					title: 'Ollama',
					arguments: [document, position, prompt, cancellationToken]
				};
				// Return the completion item
				return [item];
			}
		},
	},
		"\n", " "
	);

	// Add the completion provider to the context
	context.subscriptions.push(provider);

	// Register a command for getting a completion from Ollama
	const disposable = vscode.commands.registerCommand(
		"ollama-coder.autocomplete",
		autocompleteCommand
	);

	// Add the command to the context
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate,
};
