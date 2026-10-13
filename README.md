# Ollama Autocoder

A simple, fast Ollama autocompletion engine built for newer local models: real
system prompting, a replacement-keyword marker with lookahead, token streaming, and
a git-diff-style proposal box for multi-line completions.

![example](example.gif)

## Requirements

- Ollama must be serving on the API endpoint configured in settings. It defaults to
  the **chat API** (`http://localhost:11434/api/chat`). For installing Ollama, visit
  [ollama.ai](https://ollama.ai).
- Ollama must have the `model` from settings installed. The current default is
  `ornith-1.5:9b`. Any modern instruction- or code-tuned model works; because
  completions now go through the chat API with a system prompt, a model that follows a
  chat structure produces the best results.
- The `prompt window size` should be in line with the model's maximum context window.
  It counts **characters, not tokens**, so setting it larger than the model's token
  limit is fine and often recommended.

## How to Use

### Single-line ("line") completion — inline, unchanged

1. In a text document, press space *(or any character in the `completion keys`
   setting)*. The `Autocomplete with Ollama` option — or a preview of its first line —
   will appear. Press `enter` to start generation.
   - Alternatively, run the `Autocomplete with Ollama` command from the command
     palette (or on a keybind you set).
2. Tokens stream into the cursor and are left *selected*, so a single `undo` reverts
   the whole completion.
3. To stop early, click "Cancel" on the `Ollama Autocoder` notification or start typing.
4. When generation stops, the notification disappears.

### Multi-line ("block") completion — the diff box

For richer, multi-line completions, ask Ollama for a proposal and review it in a
native **VS Code diff editor** before it touches your file. You can accept, reject, or
modify it.

1. Put the cursor where the new code should go, then run
   `Propose Ollama Completion` (`Ctrl+Alt+I`) from the command palette or keybind.
2. The `Ollama Autocoder` notification streams the completion. A diff editor then opens
   with the **current document on the left** and the **proposed result on the right**.
3. Decide on the proposal:
   - **Accept** — `Ctrl+Enter`, or click the `Ollama proposal` item in the status bar.
   - **Modify** — click into the right (proposed) panel and edit it; your edits are
     applied on accept.
   - **Reject** — `Ctrl+Shift+Enter`, or close the editor. The status-bar item clears
     automatically when the source or proposed document is closed.
4. On accept, the source is replaced with the (possibly modified) proposal, so the diff
   collapses to "no changes" — confirming the edit.

## Settings

All settings live under `Ollama Autocoder` in `settings.json` or the Settings UI.

| Setting | Default | Description |
| --- | --- | --- |
| `endpoint` | `http://localhost:11434/api/chat` | Ollama REST endpoint. Defaults to the chat API; point it at `/api/generate` only if your proxy exposes that instead. |
| `bearer token` | _(unset)_ | Bearer token for reverse proxies that require auth. Not usually needed. Use **Set Ollama API Bearer Token**. |
| `model` | `qwen2.5-coder:latest` | Model used to generate completions. |
| `system prompt` | _(completion prompt)_ | The system prompt sent to the model. The placeholders `{LANG}`, `{FILE_NAME}`, and `{PROJECT_NAME}` are substituted. Keep the same shape if you edit it; leave blank for no system prompt. |
| `max tokens predicted` | `1000` | Maximum number of tokens generated per completion. |
| `prompt window size` | `131072` | How much code before the cursor to include in the prompt, in characters. |
| `replacement keyword` | `<\|COMPLETE\|>` | A marker placed at the cursor that the model completes _from_ and that also acts as a stop sequence, so it is never repeated in the output. Pick something that does not appear in your code. |
| `lookahead` | `512` | How far past the cursor to look for a stop boundary, so a multi-line proposal stops near the following code and slots in instead of overwriting it. `0` proposes to the end of the document. |
| `completion keys` | `[" "]` | Characters that invoke the completion provider. `\n` is parsed as a newline. **Requires reload.** |
| `response preview` | `true` | Use the first line of the response as the inline preview label. Not streamable; disable on slow devices. |
| `preview max tokens` | `50` | Maximum number of tokens generated for the inline preview. |
| `preview delay` | `1` | Seconds to wait before starting the inline preview, to avoid firing the model on every keystroke. |
| `temperature` | `0.4` | Sampling temperature. Lower is generally better than you would use for dialogue. |

## Commands & Keybindings

| Command | Default keybind | Description |
| --- | --- | --- |
| `Autocomplete with Ollama` | _(none)_ | Inline single-line completion at the cursor. |
| `Propose Ollama Completion` | `Ctrl+Alt+I` | Generate a multi-line proposal and open it in the diff box. |
| `Set Ollama API Bearer Token` | _(none)_ | Store or clear the bearer token. |

While a proposal is open, `Ctrl+Enter` **accepts** it and `Ctrl+Shift+Enter`
**rejects** it. _On macOS, `Ctrl` in these keybinds maps to `Cmd`._

## Notes

- For fastest results, an Nvidia GPU or Apple Silicon is recommended. CPU still works on
  small models.
- A completion is grounded only in the code **behind** the cursor (plus the replacement
  marker). The `lookahead` window is used solely to pick where a multi-line proposal should
  stop — it is **not** sent to the model — so following code is never passed to it.
- For CPU-only, low-end, or battery-powered devices, disabling `response preview` is
  recommended, as it otherwise fires the model on the completion key. You can also increase
  `preview delay`.
- The default `endpoint` is now the chat API. If a reverse proxy only exposes
  `/api/generate`, set `endpoint` accordingly; responses are parsed from both the chat
  (`message.content`) and legacy (`response`) shapes.
