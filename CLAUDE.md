# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Trackidity is a VSCode extension that analyzes Solidity smart contracts using Slither to display entry points (public/external functions) and state variables with their modifying functions in a sidebar tree view.

## Architecture

**Extension Entry Point**: `extension.js` (Node.js/CommonJS)
- `WorkflowsProvider`: Tree data provider for entry points view, handles hide/unhide, mark reviewed
- `VariablesProvider`: Tree data provider for state variables view
- `SolidityParser`: Uses `solidity-workspace` to parse Solidity files and extract state variable usages
- `StateVarDecorationManager`: Applies syntax highlighting decorations to state variables
- `FileMarkingProvider`: File decoration provider for marking files as "in scope" with 📌 badges
- Python resolution logic: Detects Slither installation via multiple strategies (slither CLI shebang, VSCode Python extension, venv, uvx, pipx)

**Analysis Backend**: `python/extract_workflows.py`
- Uses Slither to parse Solidity projects (Foundry, Hardhat, Truffle, Brownie)
- `_is_state_changing_entrypoint()`: Filters to public/external non-view functions
- `_extract_variables()`: Maps state variables to entry points that can modify them
- `_serialize_call_tree()`: Builds call graph with cycle detection
- Handles inheritance: shows inherited functions in concrete contracts with origin tracking

**Data Flow**:
1. Extension spawns Python script with project path and options
2. Script runs Slither, extracts entry points and variables, outputs JSON to stdout
3. Extension parses JSON, stores in `.vscode/trackidity-data.json`, populates tree views

## Development Commands

```bash
# Package the extension
npx @vscode/vsce package

# Python linting and type checking (ALWAYS run after Python changes)
uvx ruff check python/
uvx ty check python/
```

## Python Standards

- Always use `uv` as the package manager for all Python tasks
- After ANY changes to Python code, run both `uvx ruff check` and `uvx ty check`

## Key Configuration Settings (in package.json)

- `trackidity.targetPath`: Override auto-detected project path
- `trackidity.pythonPath`: Explicit Python interpreter for Slither
- `trackidity.slitherRepoPath`: Path to Slither source checkout
- `trackidity.excludeDependencies`: Hide functions from lib/dependencies folders
- `trackidity.stateVarHighlighting.enabled`: Enable/disable state variable syntax highlighting
- `trackidity.autoLoadScope`: Auto-load marked files from scope.txt/scope.md on workspace open

## Extension Views

- `trackidity.workflows`: Entry points grouped by file, with reviewed/hidden state
- `trackidity.variables`: State variables grouped by contract, showing modifier entry points
