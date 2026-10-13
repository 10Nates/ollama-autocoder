# Changelog

All notable changes to Ollama Autocoder are documented here, tagged with the
releases that introduced them.

## 0.2.0

Modernized the prompt to match the style newer local models expect, and replaced the
inline "insert-and-highlight-to-delete" behavior for multi-line work with a diff-style
proposal box. The single-line ("line") completion is unchanged.

### Added

- **Multi-line diff-box proposal.** A new `Propose Ollama Completion` command
  (`Ctrl+Alt+I`) generates a multi-line completion and opens it in a native VS Code diff
  editor — the current document on the left, an editable proposed copy on the right.
  - **Accept** (`Ctrl+Enter`, or the status-bar item) applies the proposal to the whole
    source document via a `WorkspaceEdit`.
  - **Modify**: edit the proposed (right) side in place, then accept.
  - **Reject** (`Ctrl+Shift+Enter`, or closing the editor) discards it. The active
    proposal is cleaned up automatically when the source or proposed document closes, or
    when a new proposal supersedes it.
- **`replacement keyword`** setting — a marker placed at the cursor that the model
  completes *from*, and that doubles as a stop sequence so it is never repeated in the
  output.
- **`lookahead`** setting — a window past the cursor used to find a stop boundary, so a
  multi-line proposal stops near the following code and slots in instead of overwriting
  it.

### Changed

- Completions now use the Ollama **chat API** (`/api/chat` — the new default `endpoint`)
  with a real **system prompt**, instead of the raw `/api/generate` prompt plus
  `raw: true`. Modern instruction- and code-tuned models run on their chat template,
  which this matches; responses are read from `message.content` (falling back to the
  legacy `response` field for generate-endpoint users).
- Renamed the pseudo-system **`message header`** setting to **`system prompt`** and gave
  it a modern, completion-oriented default that still substitutes `{LANG}`, `{FILE_NAME}`,
  and `{PROJECT_NAME}`.
- The inline ("line") completion now stops at the end of the current line; multi-line
  proposals have moved to the diff box.
- Bumped the extension version requirement target to `^1.86.0` (no newer API is used).

### Removed

- **`continue inline`** — inline generation now always continues (bounded by the end of
  the line), and multi-line work lives in the diff box.

## 0.1.x

Prior releases: inline streaming autocompletion with cursor selection to undo;
bearer-token support for reverse proxies; configurable `completion keys` (with newline
support); a first-line `response preview` with a `preview delay`; and a configurable
`temperature`.
