# Ollama Autocoder

A simple to use Ollama autocompletion engine with options exposed.

## Requirements

- Ollama must be serving on the API endpoint applied in settings
  - For installation of Ollama, visit [ollama.ai](https://ollama.ai)
- Ollama must have the model applied in settings installed.
- For fastest results, an Nvidia GPU or Apple Silicon is recommended. CPU still works on small models.

## How to Use

1. In a text document, press space or go to a new line. The option `Autocomplete with Ollama` will appear. Press enter to start generation.
2. After startup, the tokens will be streamed to your cursor.
3. To stop the generation early, press the "Cancel" button on the "Ollama Autocoder" notification
4. Once generation stops, the notification will disappear.
