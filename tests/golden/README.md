# Golden Transcripts

This directory contains "golden transcript" test fixtures that represent
expected input/output pairs for MCP tool calls. These are used for regression
testing to ensure tool behavior remains consistent across changes.

## Structure

Each transcript is a JSON file containing:

- `tool`: Tool name
- `input`: Input parameters
- `expected_output`: Expected output structure (partial match)
- `description`: Human-readable description of the test case

## Usage

Run golden transcript tests with:

```bash
npm run test:golden
```

## Adding New Transcripts

1. Capture a successful tool call's input/output
2. Create a new JSON file: `{tool_name}_{scenario}.json`
3. Remove sensitive data
4. Add to appropriate subdirectory
