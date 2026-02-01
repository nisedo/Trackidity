# Trackidity

A VSCode extension for exploring Solidity smart contract entry points using [Slither](https://github.com/crytic/slither).

## Features

- **Entry Points View**: Lists all public/external state-changing functions grouped by file
  - Shows inherited functions with their origin contract
  - Mark functions as reviewed to track audit progress
  - Hide files or individual entry points to reduce noise

- **Variables View**: Shows state variables and which entry points can modify them
  - Traces writes through internal call chains
  - Displays variable types and inheritance info

## Requirements

- [Slither](https://github.com/crytic/slither) installed and accessible from Python
- A Solidity project with a supported framework (Foundry, Hardhat, Truffle, or Brownie)

### Installing Slither

```bash
# Using uv
uv tool install slither-analyzer
```

## Usage

1. Open a Solidity project in VSCode
2. Click the Trackidity icon in the Activity Bar (left sidebar)
3. The extension auto-detects your project and runs Slither analysis
4. Browse entry points and variables in the tree views

### Commands

- **Trackidity: Re-analyze (Slither)** - Re-run analysis after code changes
- **Trackidity: Unhide All** - Restore hidden files and entry points
- **Trackidity: Clear All Reviewed** - Reset review progress

### Context Menu Actions

Right-click on items in the Entry Points view:

- **Hide File** - Hide all entry points from a file
- **Hide** - Hide a specific entry point
- **Mark as Reviewed** / **Unmark as Reviewed** - Track review progress

## Configuration

| Setting                          | Description                                                   | Default |
| -------------------------------- | ------------------------------------------------------------- | ------- |
| `trackidity.targetPath`          | Analysis target (folder or .sol file). Auto-detects if empty. | `""`    |
| `trackidity.pythonPath`          | Python interpreter for Slither. Auto-detects if empty.        | `""`    |
| `trackidity.slitherRepoPath`     | Path to Slither source checkout (for development).            | `""`    |
| `trackidity.solcPath`            | Solc binary path passed to Slither.                           | `""`    |
| `trackidity.solcArgs`            | Solc arguments (e.g., `--via-ir`).                            | `""`    |
| `trackidity.filterPaths`         | Paths to filter from analysis.                                | `[]`    |
| `trackidity.excludeDependencies` | Hide functions from lib/node_modules/test folders.            | `true`  |

## How It Works

Trackidity runs a Python script that uses Slither to analyze your Solidity project:

1. Detects project type and locates the compilation target
2. Runs Slither to build the AST and call graph
3. Extracts public/external functions that modify state
4. Maps state variables to entry points that can write to them
5. Stores results in `.vscode/trackidity-data.json` for fast reloads

The extension automatically tries multiple strategies to find a working Python environment with Slither installed.
