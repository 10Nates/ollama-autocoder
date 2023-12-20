// Significant help from GPT4

import * as vscode from "vscode";
import axios from "axios";

const apiEndpoint: string = vscode.workspace.getConfiguration("ollama-coder").get("apiEndpoint") || "http://localhost:11434/api/generate";
const apiModel: string = vscode.workspace.getConfiguration("ollama-coder").get("model") || "deepseek-coder";
const apiSystemMessage: string | undefined = vscode.workspace.getConfiguration("ollama-coder").get("system-message");
const documentRange = 2000;

// This method is called when your extension is activated
function activate(context: vscode.ExtensionContext) {
	console.log("Ollama Coder is Active");
	// Register a completion provider for JavaScript files
	const provider = vscode.languages.registerCompletionItemProvider("javascript", {
		async provideCompletionItems(document, position) {
			// Get the current prompt
			const prompt = document.lineAt(position.line).text.substring(0, position.character);
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
					arguments: [document, position, prompt]
				};
				// Return the completion item
				return [item];
			}
		},
	},
		"."
	);

	// Add the completion provider to the context
	context.subscriptions.push(provider);

	// Register a command for getting a completion from Ollama
	const disposable = vscode.commands.registerCommand(
		"ollama-coder.autocomplete",
		async function (document, position, prompt) {
			// Show a progress message
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Getting a completion from Ollama...",
				},
				async (progress, token) => {
					try {
						// Make a request to the ollama.ai REST API
						const response = await axios.post(apiEndpoint, {
							model: apiModel, // Change this to the model you want to use
							prompt: prompt,
							stream: false,
							system: apiSystemMessage,
							options: {
								num_predict: 100
							}
						}
						);
						// Get the completion from the response
						const completion = response.data.response;
						// Check if the completion is not empty
						if (completion) {
							// Insert the completion into the document
							const edit = new vscode.WorkspaceEdit();
							const range = new vscode.Range(
								position.line,
								position.character,
								position.line,
								position.character
							);
							edit.replace(document.uri, range, completion);
							await vscode.workspace.applyEdit(edit);
							// Move the cursor to the end of the completion
							const newPosition = position.with(
								position.line,
								position.character + completion.length
							);
							const newSelection = new vscode.Selection(
								newPosition,
								newPosition
							);
							const editor = vscode.window.activeTextEditor;
							if (editor) editor.selection = newSelection;
						} else {
							// Show a warning message
							vscode.window.showWarningMessage("Ollama could not generate a completion for this prompt");
							console.log("Ollama could not generate a completion for this prompt");
						}
					} catch (err: any) {
						// Show an error message
						vscode.window.showErrorMessage(
							"Ollama encountered an error: " + err.message
						);
						console.log("Ollama encountered an error: " + err.message);
					}
				}
			);
		}
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
