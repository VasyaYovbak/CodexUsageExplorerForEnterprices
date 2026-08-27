# Codex and OpenCode Token Usage

A local VS Code dashboard for inspecting Codex and OpenCode token usage and estimated costs.

## Features

- Weekly, monthly, and custom UTC date ranges
- Live daily usage with the latest turn and today's active sessions
- Status-bar totals for today's credits and estimated USD cost
- Session and per-model-call usage breakdowns
- Fresh input, cached input, output, and reasoning token totals
- Credit and standard API USD estimates
- Daily or weekly activity bars with a Credits/USD toggle
- Local transcript processing with no telemetry collection
- Codex/OpenCode switch with a dedicated OpenCode theme

## Requirements

- Desktop VS Code 1.85 or newer
- Codex session data in `~/.codex`, or another configured directory
- OpenCode 1.18 or newer on `PATH` to view OpenCode usage

The extension supports Linux, macOS, and Windows. In WSL it combines sessions from the Linux and Windows Codex data directories. A configured WSL UNC directory is likewise combined with the default Windows directory when the extension runs on Windows. Remote SSH and development containers read data from their remote environment.

## Installation

Install a packaged extension from the command line:

```sh
code --install-extension codex-token-usage-for-enterprises-0.1.4.vsix
```

Alternatively, open the Extensions view, select **…**, and choose **Install from VSIX…**.

## Configuration

The default Codex data directory is `~/.codex`. To use another location, set:

```json
{
  "codexUsage.codexHome": "/path/to/.codex"
}
```

You can also run **Codex Usage: Configure Codex Home** from the Command Palette.

The configured directory and any available default Codex directories are loaded together. Duplicate session IDs are included only once.

## Privacy and pricing

Session data is processed locally. Codex estimates use cached public OpenAI pricing; OpenCode costs come from its local database through `opencode db`. Estimates may differ from billed amounts.

## Development

Run the checks with:

```sh
npm test
```

Create a VSIX package with:

```sh
npx @vscode/vsce package
```

## License

MIT License
