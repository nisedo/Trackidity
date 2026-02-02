const path = require("path");
const fs = require("fs");
const vscode = require("vscode");
const cp = require("child_process");
const solidityWorkspace = require("solidity-workspace");
const ignore = require("ignore");

const WORKFLOWS_VIEW_ID = "trackidity.workflows";
const VARIABLES_VIEW_ID = "trackidity.variables";
const HIDDEN_FILES_KEY = "trackidity.hiddenFiles";
const HIDDEN_ENTRYPOINTS_KEY = "trackidity.hiddenEntrypoints";
const REVIEWED_ENTRYPOINTS_KEY = "trackidity.reviewedEntrypoints";
const MARKED_FILES_KEY = "trackidity.markedFiles";

let jumpHighlightDecoration;
let jumpHighlightTimeout;
let jumpHighlightSeq = 0;

// ============================================================================
// SolidityParser - Parses Solidity files to extract state variables and usages
// ============================================================================

class SolidityParser {
  constructor() {
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((wf) => wf.uri.fsPath) ?? [];
    this._workspace = new solidityWorkspace.Workspace(workspaceFolders);
    this._cancellationTokenSource = null;
  }

  cancelParsing() {
    if (this._cancellationTokenSource) {
      this._cancellationTokenSource.cancel();
      this._cancellationTokenSource.dispose();
      this._cancellationTokenSource = null;
    }
  }

  async parse(document) {
    this.cancelParsing();
    this._cancellationTokenSource = new vscode.CancellationTokenSource();

    try {
      await this._workspace.add(document.fileName, {
        content: document.getText(),
        cancellationToken: this._cancellationTokenSource.token,
      });

      const finished = await this._workspace.withParserReady(document.fileName, true);
      const wantHash = solidityWorkspace.SourceUnit.getHash(document.getText());

      if (
        this._cancellationTokenSource.token.isCancellationRequested ||
        !finished.some(
          (fp) => fp.value && fp.value.filePath === document.fileName && fp.value.hash === wantHash
        )
      ) {
        return null;
      }

      const sourceUnit = this._workspace.get(document.fileName);
      if (!sourceUnit) {
        return null;
      }

      return this._extractStateVariables(sourceUnit);
    } catch (error) {
      console.warn(`Error parsing Solidity file: ${document.fileName}`, error);
      return null;
    }
  }

  _extractStateVariables(sourceUnit) {
    const contracts = [];

    for (const contract of Object.values(sourceUnit.contracts)) {
      const stateVariables = [];
      const inheritedUsages = [];

      // Build set of inherited names
      const inheritedNames = new Set(
        Object.keys(contract.inherited_names).filter(
          (name) => contract.inherited_names[name] && contract.inherited_names[name] !== contract
        )
      );

      // Process state variables declared in this contract
      for (const svar of Object.values(contract.stateVars)) {
        const typeName = this._getTypeName(svar.typeName);
        const usages = [];

        if (svar.extra && svar.extra.usedAt) {
          for (const ident of svar.extra.usedAt) {
            const isShadowed = !!(
              ident.extra.inFunction &&
              ident.extra.inFunction.declarations &&
              ident.extra.inFunction.declarations[ident.name]
            );

            usages.push({
              line: ident.loc.start.line,
              startColumn: ident.loc.start.column,
              endColumn: ident.loc.start.column + ident.name.length,
              isShadowed,
            });
          }
        }

        stateVariables.push({
          name: svar.name,
          type: typeName,
          contract: contract.name,
          isConstant: svar.isDeclaredConst ?? false,
          isImmutable: svar.isImmutable ?? false,
          declarationLocation: {
            line: svar.identifier.loc.start.line,
            startColumn: svar.identifier.loc.start.column,
            endColumn: svar.identifier.loc.start.column + svar.identifier.name.length,
          },
          usages,
        });
      }

      // Process identifiers in functions to find inherited state var usages
      this._extractInheritedUsages(contract, inheritedNames, inheritedUsages);

      contracts.push({
        name: contract.name,
        stateVariables,
        inheritedNames,
        inheritedUsages,
      });
    }

    return {
      filePath: sourceUnit.filePath,
      contracts,
    };
  }

  _extractInheritedUsages(contract, inheritedNames, inheritedUsages) {
    if (contract.functions) {
      for (const func of Object.values(contract.functions)) {
        if (func.identifiers) {
          for (const ident of func.identifiers) {
            this._checkInheritedIdentifier(ident, contract, inheritedNames, inheritedUsages);
          }
        }
      }
    }

    if (contract.modifiers) {
      for (const mod of Object.values(contract.modifiers)) {
        if (mod.identifiers) {
          for (const ident of mod.identifiers) {
            this._checkInheritedIdentifier(ident, contract, inheritedNames, inheritedUsages);
          }
        }
      }
    }
  }

  _checkInheritedIdentifier(ident, contract, inheritedNames, inheritedUsages) {
    if (!ident.name || !ident.loc) {
      return;
    }

    const isInherited = inheritedNames.has(ident.name);
    const isLocalStateVar = !!contract.stateVars[ident.name];

    if (isInherited && !isLocalStateVar) {
      const sourceContract = contract.inherited_names[ident.name];
      const isShadowed = !!(
        ident.extra?.inFunction?.declarations &&
        ident.extra.inFunction.declarations[ident.name]
      );

      inheritedUsages.push({
        name: ident.name,
        sourceContract: sourceContract?.name ?? "unknown",
        line: ident.loc.start.line,
        startColumn: ident.loc.start.column,
        endColumn: ident.loc.start.column + ident.name.length,
        isShadowed,
      });
    }
  }

  _getTypeName(typeName) {
    if (!typeName) {
      return "unknown";
    }

    switch (typeName.type) {
      case "ElementaryTypeName":
        return typeName.name ?? "unknown";
      case "UserDefinedTypeName":
        return typeName.namePath ?? "unknown";
      case "Mapping":
        return `mapping(${this._getTypeName(typeName.keyType)} => ${this._getTypeName(typeName.valueType)})`;
      case "ArrayTypeName":
        return `${this._getTypeName(typeName.baseTypeName)}[]`;
      default:
        return typeName.name ?? typeName.namePath ?? "unknown";
    }
  }

  dispose() {
    this.cancelParsing();
  }
}

// ============================================================================
// StateVarDecorationManager - Manages syntax highlighting for state variables
// ============================================================================

class StateVarDecorationManager {
  constructor(context) {
    this._context = context;
    this._styles = null;
    this._parser = new SolidityParser();
    this._debounceTimer = null;
    this._debounceDelay = 300;
    this._disposables = [];
    this._inheritedVarsMap = new Map();
  }

  init() {
    this._createDecorationStyles();
    this._registerEventListeners();

    // Decorate current editor if it's a Solidity file
    if (
      vscode.window.activeTextEditor &&
      vscode.window.activeTextEditor.document.languageId === "solidity"
    ) {
      this.decorateEditor(vscode.window.activeTextEditor);
    }
  }

  setAnalysisData(analysis) {
    this._inheritedVarsMap.clear();

    if (!analysis || !analysis.variables) {
      return;
    }

    // Build map of inherited variables from Slither analysis
    for (const varFile of analysis.variables) {
      const filePath = varFile.path;
      const contractName = varFile.contract;

      if (!this._inheritedVarsMap.has(filePath)) {
        this._inheritedVarsMap.set(filePath, new Map());
      }

      const contractMap = this._inheritedVarsMap.get(filePath);
      if (!contractMap.has(contractName)) {
        contractMap.set(contractName, []);
      }

      const inheritedVars = contractMap.get(contractName);

      for (const v of varFile.vars) {
        if (v.inherited && v.inheritedFrom) {
          inheritedVars.push({
            name: v.name,
            type: v.type,
            contract: v.contract,
            inheritedFrom: v.inheritedFrom,
            isConstant: v.isConstant ?? false,
            isImmutable: v.isImmutable ?? false,
          });
        }
      }
    }

    // Re-decorate active editor
    if (
      vscode.window.activeTextEditor &&
      vscode.window.activeTextEditor.document.languageId === "solidity"
    ) {
      this.decorateEditor(vscode.window.activeTextEditor);
    }
  }

  _createDecorationStyles() {
    const createDecorationType = (options) => {
      return vscode.window.createTextEditorDecorationType({
        borderWidth: "1px",
        borderStyle: options.borderStyle ?? "dotted",
        light: {
          borderColor: options.borderColor,
        },
        dark: {
          borderColor: options.darkBorderColor ?? options.borderColor,
        },
      });
    };

    this._styles = {
      // Regular state variables - golden
      stateVar: createDecorationType({
        borderColor: "DarkGoldenRod",
        darkBorderColor: "GoldenRod",
      }),
      // Constant state variables - green
      stateVarConstant: createDecorationType({
        borderColor: "darkgreen",
      }),
      // Immutable state variables - purple
      stateVarImmutable: createDecorationType({
        borderColor: "DarkOrchid",
        darkBorderColor: "MediumOrchid",
      }),
      // Inherited state variables - blue
      stateVarInherited: createDecorationType({
        borderColor: "darkblue",
        darkBorderColor: "RoyalBlue",
      }),
      // Shadowed state variables - red solid border (warning)
      stateVarShadowed: createDecorationType({
        borderColor: "red",
        borderStyle: "solid",
      }),
    };

    // Register for disposal
    for (const style of Object.values(this._styles)) {
      this._context.subscriptions.push(style);
    }
  }

  _registerEventListeners() {
    // Listen for active editor changes
    const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === "solidity") {
        this.decorateEditor(editor);
      }
    });

    // Listen for document changes (debounced)
    const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== "solidity") {
        return;
      }

      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document === event.document
      );

      if (editor) {
        this._debounceDecorate(editor);
      }
    });

    this._disposables.push(editorChangeDisposable, documentChangeDisposable);
    this._context.subscriptions.push(editorChangeDisposable, documentChangeDisposable);
  }

  _debounceDecorate(editor) {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    this._debounceTimer = setTimeout(() => {
      this.decorateEditor(editor);
    }, this._debounceDelay);
  }

  async decorateEditor(editor) {
    if (!this._styles) {
      return;
    }

    // Check if highlighting is enabled
    const config = vscode.workspace.getConfiguration("trackidity");
    const enabled = config.get("stateVarHighlighting.enabled", true);

    if (!enabled) {
      this.clearDecorations(editor);
      return;
    }

    const document = editor.document;
    if (document.languageId !== "solidity") {
      return;
    }

    try {
      const parsed = await this._parser.parse(document);
      if (!parsed) {
        return;
      }

      // Get inherited vars for this file from Slither data
      const inheritedVarsForFile = this._getInheritedVarsForFile(document.fileName);

      const decorations = this._buildDecorations(parsed, document, inheritedVarsForFile);
      this._applyDecorations(editor, decorations);
    } catch (error) {
      console.error("Error decorating state variables:", error);
    }
  }

  _getInheritedVarsForFile(filePath) {
    for (const [path, contractMap] of this._inheritedVarsMap.entries()) {
      if (filePath.endsWith(path) || path.endsWith(filePath.split("/").slice(-2).join("/"))) {
        return contractMap;
      }
    }
    return new Map();
  }

  _buildDecorations(parsed, document, inheritedVarsForFile) {
    const decorations = [];

    for (const contract of parsed.contracts) {
      // Get inherited vars for this contract from Slither
      const slitherInheritedVars = inheritedVarsForFile.get(contract.name) || [];
      const inheritedVarNames = new Set(slitherInheritedVars.map((v) => v.name));

      // Process state variables declared in this contract
      for (const svar of contract.stateVariables) {
        // Decoration for the declaration
        const declRange = new vscode.Range(
          new vscode.Position(svar.declarationLocation.line - 1, svar.declarationLocation.startColumn),
          new vscode.Position(svar.declarationLocation.line - 1, svar.declarationLocation.endColumn)
        );

        const styleKey = this._getStyleKeyForVariable(svar, false);
        const hoverMessage = this._buildHoverMessage(svar, document, svar.declarationLocation.line);

        decorations.push({
          range: declRange,
          hoverMessage,
          styleKey,
        });

        // Decorations for usages
        for (const usage of svar.usages) {
          const usageRange = new vscode.Range(
            new vscode.Position(usage.line - 1, usage.startColumn),
            new vscode.Position(usage.line - 1, usage.endColumn)
          );

          const usageStyleKey = usage.isShadowed
            ? "stateVarShadowed"
            : this._getStyleKeyForVariable(svar, false);

          const usageHoverMessage = this._buildHoverMessage(
            svar,
            document,
            svar.declarationLocation.line,
            usage.isShadowed
          );

          decorations.push({
            range: usageRange,
            hoverMessage: usageHoverMessage,
            styleKey: usageStyleKey,
          });
        }
      }

      // Process inherited state variable usages from solidity-workspace
      for (const inheritedUsage of contract.inheritedUsages) {
        const usageRange = new vscode.Range(
          new vscode.Position(inheritedUsage.line - 1, inheritedUsage.startColumn),
          new vscode.Position(inheritedUsage.line - 1, inheritedUsage.endColumn)
        );

        const styleKey = inheritedUsage.isShadowed ? "stateVarShadowed" : "stateVarInherited";

        const hoverMessage = this._buildInheritedHoverMessage(inheritedUsage);

        decorations.push({
          range: usageRange,
          hoverMessage,
          styleKey,
        });
      }

      // Also decorate inherited vars from Slither data by scanning identifiers
      if (slitherInheritedVars.length > 0) {
        this._decorateInheritedVarsFromSlither(
          document,
          contract.name,
          slitherInheritedVars,
          contract.stateVariables.map((s) => s.name),
          decorations
        );
      }
    }

    return decorations;
  }

  _decorateInheritedVarsFromSlither(document, contractName, inheritedVars, localStateVarNames, decorations) {
    const text = document.getText();
    const localVarsSet = new Set(localStateVarNames);

    for (const inheritedVar of inheritedVars) {
      // Skip if there's a local var with the same name (it shadows the inherited one)
      if (localVarsSet.has(inheritedVar.name)) {
        continue;
      }

      // Find all occurrences of this variable name in the document
      const regex = new RegExp(`\\b${inheritedVar.name}\\b`, "g");
      let match;

      while ((match = regex.exec(text)) !== null) {
        const startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + inheritedVar.name.length);

        // Skip if this position is already decorated
        const alreadyDecorated = decorations.some(
          (d) =>
            d.range.start.line === startPos.line &&
            d.range.start.character === startPos.character
        );

        if (alreadyDecorated) {
          continue;
        }

        const range = new vscode.Range(startPos, endPos);
        const hoverMessage = this._buildSlitherInheritedHoverMessage(inheritedVar);

        // Use appropriate style based on variable type
        let styleKey = "stateVarInherited";
        if (inheritedVar.isConstant) {
          styleKey = "stateVarConstant";
        } else if (inheritedVar.isImmutable) {
          styleKey = "stateVarImmutable";
        }

        decorations.push({
          range,
          hoverMessage,
          styleKey,
        });
      }
    }
  }

  _getStyleKeyForVariable(svar, isInherited) {
    if (svar.isConstant) {
      return "stateVarConstant";
    }
    if (svar.isImmutable) {
      return "stateVarImmutable";
    }
    if (isInherited) {
      return "stateVarInherited";
    }
    return "stateVar";
  }

  _buildHoverMessage(svar, document, declarationLine, isShadowed = false) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    let prefix = "";
    if (isShadowed) {
      prefix = "**SHADOWED** ";
    } else if (svar.isConstant) {
      prefix = "**CONST** ";
    } else if (svar.isImmutable) {
      prefix = "**IMMUTABLE** ";
    }

    const declUri = document.uri.toString();
    const declLink = `[Declaration: #${declarationLine}](${declUri}#${declarationLine})`;

    md.appendMarkdown(
      `${prefix}(*${svar.type}*) **StateVar** *${svar.contract}*.**${svar.name}** (${declLink})`
    );

    return md;
  }

  _buildInheritedHoverMessage(usage) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const prefix = usage.isShadowed ? "**SHADOWED** " : "**INHERITED** ";

    md.appendMarkdown(`${prefix}**StateVar** *${usage.sourceContract}*.**${usage.name}**`);

    return md;
  }

  _buildSlitherInheritedHoverMessage(varInfo) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    let prefix = "**INHERITED** ";
    if (varInfo.isConstant) {
      prefix = "**INHERITED CONST** ";
    } else if (varInfo.isImmutable) {
      prefix = "**INHERITED IMMUTABLE** ";
    }

    md.appendMarkdown(
      `${prefix}(*${varInfo.type}*) **StateVar** *${varInfo.inheritedFrom}*.**${varInfo.name}**`
    );

    return md;
  }

  _applyDecorations(editor, decorations) {
    if (!this._styles) {
      return;
    }

    // Group decorations by style
    const groupedDecorations = {
      stateVar: [],
      stateVarConstant: [],
      stateVarImmutable: [],
      stateVarInherited: [],
      stateVarShadowed: [],
    };

    for (const deco of decorations) {
      groupedDecorations[deco.styleKey].push({
        range: deco.range,
        hoverMessage: deco.hoverMessage,
      });
    }

    // Apply each group
    for (const [styleKey, options] of Object.entries(groupedDecorations)) {
      const style = this._styles[styleKey];
      editor.setDecorations(style, options);
    }
  }

  clearDecorations(editor) {
    if (!this._styles) {
      return;
    }

    for (const style of Object.values(this._styles)) {
      editor.setDecorations(style, []);
    }
  }

  dispose() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    this._parser.dispose();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
  }
}

// ============================================================================
// FileMarkingProvider - Manages file marking with 📌 badge in explorer
// ============================================================================

class FileMarkingProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    this._disposables = [];

    // Map of workspace root -> Set of marked file paths (relative to workspace)
    this._markedFilesPerWorkspace = new Map();
  }

  init() {
    // Load marked files from workspace storage
    this._loadMarkedFiles();

    // Register file decoration provider
    const decorationDisposable = vscode.window.registerFileDecorationProvider(this);
    this._disposables.push(decorationDisposable);
    this._context.subscriptions.push(decorationDisposable);

    // Listen for file renames to update marks
    const renameDisposable = vscode.workspace.onDidRenameFiles((e) => {
      this._handleFileRenames(e.files);
    });
    this._disposables.push(renameDisposable);
    this._context.subscriptions.push(renameDisposable);

    // Auto-load scope files if enabled
    const config = vscode.workspace.getConfiguration("trackidity");
    if (config.get("autoLoadScope", true)) {
      this._loadScopeFiles();
    }
  }

  // FileDecorationProvider implementation
  provideFileDecoration(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return null;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const relativePath = path.relative(workspaceRoot, uri.fsPath);
    const markedFiles = this._markedFilesPerWorkspace.get(workspaceRoot);

    if (markedFiles && markedFiles.has(relativePath)) {
      return {
        badge: "📌",
        tooltip: "In Scope",
      };
    }

    return null;
  }

  // Toggle mark state for a file or folder
  async toggleMark(uri) {
    if (!uri) {
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      vscode.window.showWarningMessage("File is not part of a workspace");
      return;
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const relativePath = path.relative(workspaceRoot, uri.fsPath);

    if (!this._markedFilesPerWorkspace.has(workspaceRoot)) {
      this._markedFilesPerWorkspace.set(workspaceRoot, new Set());
    }

    const markedFiles = this._markedFilesPerWorkspace.get(workspaceRoot);

    // Check if it's a directory
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        // For directories, recursively toggle all files inside
        await this._toggleDirectoryMark(uri, workspaceRoot, markedFiles);
      } else {
        // For single files, toggle the mark
        if (markedFiles.has(relativePath)) {
          markedFiles.delete(relativePath);
        } else {
          markedFiles.add(relativePath);
        }
      }
    } catch (e) {
      // Assume it's a file if stat fails
      if (markedFiles.has(relativePath)) {
        markedFiles.delete(relativePath);
      } else {
        markedFiles.add(relativePath);
      }
    }

    this._saveMarkedFiles();
    this._onDidChangeFileDecorations.fire(undefined);
  }

  async _toggleDirectoryMark(dirUri, workspaceRoot, markedFiles) {
    // Find all files in the directory
    const files = await this._getAllFilesInDirectory(dirUri);

    // Check if any file in the directory is already marked
    const relativePaths = files.map((f) => path.relative(workspaceRoot, f.fsPath));
    const anyMarked = relativePaths.some((p) => markedFiles.has(p));

    if (anyMarked) {
      // Unmark all files in the directory
      for (const relPath of relativePaths) {
        markedFiles.delete(relPath);
      }
    } else {
      // Mark all files in the directory
      for (const relPath of relativePaths) {
        markedFiles.add(relPath);
      }
    }
  }

  async _getAllFilesInDirectory(dirUri) {
    const results = [];

    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);

      for (const [name, type] of entries) {
        const childUri = vscode.Uri.joinPath(dirUri, name);

        if (type === vscode.FileType.Directory) {
          // Skip node_modules, .git, and other common excluded directories
          if (name === "node_modules" || name === ".git" || name === ".vscode") {
            continue;
          }
          // Recursively get files from subdirectories
          const subFiles = await this._getAllFilesInDirectory(childUri);
          results.push(...subFiles);
        } else if (type === vscode.FileType.File) {
          results.push(childUri);
        }
      }
    } catch (e) {
      console.warn("Error reading directory:", e);
    }

    return results;
  }

  // Toggle mark for the active editor's file
  toggleActiveFileMark() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.toggleMark(editor.document.uri);
    } else {
      vscode.window.showWarningMessage("No active file to mark");
    }
  }

  // Clear all marked files
  clearAllMarked() {
    this._markedFilesPerWorkspace.clear();
    this._saveMarkedFiles();
    this._onDidChangeFileDecorations.fire(undefined);
    vscode.window.showInformationMessage("Cleared all marked files");
  }

  // Load marked files from scope.txt or scope.md
  async reloadFromScopeFile() {
    await this._loadScopeFiles();
    this._onDidChangeFileDecorations.fire(undefined);
    vscode.window.showInformationMessage("Reloaded scope from scope files");
  }

  async _loadScopeFiles() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    for (const folder of workspaceFolders) {
      const workspaceRoot = folder.uri.fsPath;

      // Try to find scope.txt or scope.md
      const scopeFiles = ["scope.txt", "scope.md"];

      for (const scopeFile of scopeFiles) {
        const scopePath = path.join(workspaceRoot, scopeFile);

        try {
          if (fs.existsSync(scopePath)) {
            const content = fs.readFileSync(scopePath, "utf8");
            const patterns = this._parseScopeFile(content);

            if (patterns.length > 0) {
              await this._markFilesFromPatterns(workspaceRoot, patterns);
              break; // Only use the first scope file found
            }
          }
        } catch (e) {
          console.warn(`Error reading scope file ${scopePath}:`, e);
        }
      }
    }
  }

  _parseScopeFile(content) {
    const patterns = [];
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      // Trim whitespace
      let trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
        continue;
      }

      // Handle markdown list items (- file.sol or * file.sol)
      if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
        trimmed = trimmed.slice(1).trim();
      }

      // Handle markdown code blocks (```file.sol```)
      if (trimmed.startsWith("```")) {
        trimmed = trimmed.slice(3);
      }
      if (trimmed.endsWith("```")) {
        trimmed = trimmed.slice(0, -3);
      }

      // Handle markdown links ([file.sol](path))
      const linkMatch = trimmed.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        trimmed = linkMatch[2]; // Use the link path
      }

      // Skip if empty after processing
      if (!trimmed) {
        continue;
      }

      patterns.push(trimmed);
    }

    return patterns;
  }

  async _markFilesFromPatterns(workspaceRoot, patterns) {
    if (!this._markedFilesPerWorkspace.has(workspaceRoot)) {
      this._markedFilesPerWorkspace.set(workspaceRoot, new Set());
    }

    const markedFiles = this._markedFilesPerWorkspace.get(workspaceRoot);
    const ig = ignore().add(patterns);

    // Find all files in workspace and test against patterns
    const baseUri = vscode.Uri.file(workspaceRoot);
    const allFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(baseUri, "**/*"),
      "**/node_modules/**"
    );

    for (const fileUri of allFiles) {
      const relativePath = path.relative(workspaceRoot, fileUri.fsPath);

      // Check if the file matches any pattern
      if (ig.ignores(relativePath)) {
        markedFiles.add(relativePath);
      }
    }

    this._saveMarkedFiles();
  }

  _handleFileRenames(files) {
    for (const { oldUri, newUri } of files) {
      const oldWorkspace = vscode.workspace.getWorkspaceFolder(oldUri);
      const newWorkspace = vscode.workspace.getWorkspaceFolder(newUri);

      if (oldWorkspace && newWorkspace) {
        const oldRoot = oldWorkspace.uri.fsPath;
        const newRoot = newWorkspace.uri.fsPath;
        const oldRelPath = path.relative(oldRoot, oldUri.fsPath);
        const newRelPath = path.relative(newRoot, newUri.fsPath);

        const oldMarkedFiles = this._markedFilesPerWorkspace.get(oldRoot);
        if (oldMarkedFiles && oldMarkedFiles.has(oldRelPath)) {
          oldMarkedFiles.delete(oldRelPath);

          if (!this._markedFilesPerWorkspace.has(newRoot)) {
            this._markedFilesPerWorkspace.set(newRoot, new Set());
          }
          this._markedFilesPerWorkspace.get(newRoot).add(newRelPath);
        }
      }
    }

    this._saveMarkedFiles();
    this._onDidChangeFileDecorations.fire(undefined);
  }

  _loadMarkedFiles() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    // Load from workspace state (multi-workspace support)
    const storedData = this._context.workspaceState.get(MARKED_FILES_KEY, {});

    for (const folder of workspaceFolders) {
      const workspaceRoot = folder.uri.fsPath;
      const markedArray = storedData[workspaceRoot] || [];
      this._markedFilesPerWorkspace.set(workspaceRoot, new Set(markedArray));
    }
  }

  _saveMarkedFiles() {
    const dataToStore = {};

    for (const [workspaceRoot, markedSet] of this._markedFilesPerWorkspace) {
      dataToStore[workspaceRoot] = Array.from(markedSet);
    }

    this._context.workspaceState.update(MARKED_FILES_KEY, dataToStore);
  }

  dispose() {
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
  }
}

function activate(context) {
  jumpHighlightDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    borderRadius: "2px",
  });
  context.subscriptions.push(jumpHighlightDecoration);

  const workflowsProvider = new WorkflowsProvider(context);
  const variablesProvider = new VariablesProvider(context);

  // Link providers for shared refresh
  workflowsProvider._variablesProvider = variablesProvider;

  context.subscriptions.push(
    vscode.window.createTreeView(WORKFLOWS_VIEW_ID, {
      treeDataProvider: workflowsProvider,
    })
  );

  context.subscriptions.push(
    vscode.window.createTreeView(VARIABLES_VIEW_ID, {
      treeDataProvider: variablesProvider,
      showCollapseAll: true,
    })
  );

  // Fold all (collapse) - collapse all file nodes
  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.foldAll", () => {
      // Use VS Code's built-in collapse command for tree views
      vscode.commands.executeCommand("list.collapseAll");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.openFunction", (location) =>
      openLocation(location)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.reanalyzeWorkflows", () => workflowsProvider.reanalyze())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.hideFile", (item) => workflowsProvider.hideFile(item))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.hideEntrypoint", (item) => workflowsProvider.hideEntrypoint(item))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.unhideAll", () => workflowsProvider.unhideAll())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.markReviewed", (item) => workflowsProvider.markReviewed(item))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.unmarkReviewed", (item) => workflowsProvider.unmarkReviewed(item))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.clearAllReviewed", () => workflowsProvider.clearAllReviewed())
  );

  // Initialize file marking provider
  const fileMarkingProvider = new FileMarkingProvider(context);
  fileMarkingProvider.init();
  context.subscriptions.push({ dispose: () => fileMarkingProvider.dispose() });

  // Register file marking commands
  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.markUnmarkSelectedFile", (uri) =>
      fileMarkingProvider.toggleMark(uri)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.markUnmarkActiveFile", () =>
      fileMarkingProvider.toggleActiveFileMark()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.reloadFromScopeFile", () =>
      fileMarkingProvider.reloadFromScopeFile()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("trackidity.clearAllMarked", () =>
      fileMarkingProvider.clearAllMarked()
    )
  );

  // Initialize state variable highlighting
  const stateVarDecorationManager = new StateVarDecorationManager(context);
  stateVarDecorationManager.init();
  context.subscriptions.push({ dispose: () => stateVarDecorationManager.dispose() });

  // Wire up analysis events for inherited variable highlighting
  context.subscriptions.push(
    workflowsProvider.onAnalysisChanged((analysis) => {
      stateVarDecorationManager.setAnalysisData(analysis);
    })
  );

  // Initial load
  workflowsProvider.load();

  // If there's already analysis data, pass it to the decoration manager
  if (workflowsProvider.analysis) {
    stateVarDecorationManager.setAnalysisData(workflowsProvider.analysis);
  }
}

function deactivate() {}

async function openLocation(location) {
  if (!location || !location.file) {
    return;
  }
  try {
    const uri = vscode.Uri.file(location.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });

    const rawLine = Number(location.line ?? 0);
    const rawCharacter = Number(location.character ?? 0);
    const line0 = Number.isFinite(rawLine) ? Math.max(0, Math.trunc(rawLine)) : 0;
    const character0 = Number.isFinite(rawCharacter) ? Math.max(0, Math.trunc(rawCharacter)) : 0;
    const line = Math.min(line0, Math.max(0, doc.lineCount - 1));

    const pos = new vscode.Position(line, character0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);

    if (jumpHighlightDecoration) {
      const seq = ++jumpHighlightSeq;
      const range = editor.document.lineAt(pos.line).range;
      editor.setDecorations(jumpHighlightDecoration, [range]);
      if (jumpHighlightTimeout) {
        clearTimeout(jumpHighlightTimeout);
      }
      jumpHighlightTimeout = setTimeout(() => {
        if (seq !== jumpHighlightSeq) {
          return;
        }
        try {
          editor.setDecorations(jumpHighlightDecoration, []);
        } catch (e) {
          // ignore
        }
      }, 500);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Trackidity: Failed to open location. ${msg}`);
  }
}

class WorkflowsProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    // Event emitter for when analysis data changes (used by StateVarDecorationManager)
    this._onAnalysisChanged = new vscode.EventEmitter();
    this.onAnalysisChanged = this._onAnalysisChanged.event;

    this._loading = false;
    this._lastError = null;
    this._analysis = null;
    this._workspaceRoot = null;
    this._files = [];
  }

  // Getter for current analysis data
  get analysis() {
    return this._analysis;
  }

  getTreeItem(element) {
    if (element.kind === "message") {
      const item = new vscode.TreeItem(
        element.message,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "trackidity.message";
      return item;
    }

    if (element.kind === "file") {
      const item = new vscode.TreeItem(
        element.fileRel,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.contextValue = "trackidity.file";
      item.iconPath = new vscode.ThemeIcon("file-code");
      item.tooltip = element.fileAbs;
      // Show reviewed progress
      const reviewed = this._context.workspaceState.get(REVIEWED_ENTRYPOINTS_KEY, []);
      const total = element.entrypoints?.length || 0;
      const reviewedCount = (element.entrypoints || []).filter((ep) => reviewed.includes(ep.flowId)).length;
      item.description = `${reviewedCount}/${total} reviewed`;
      return item;
    }

    if (element.kind === "entrypoint") {
      const reviewed = this._context.workspaceState.get(REVIEWED_ENTRYPOINTS_KEY, []);
      const isReviewed = reviewed.includes(element.flowId);
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = isReviewed ? "trackidity.entrypoint.reviewed" : "trackidity.entrypoint";
      item.iconPath = isReviewed
        ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
        : entrypointIcon(element.label);
      item.description = element.inheritedFrom
        ? `from ${element.inheritedFrom}`
        : undefined;
      if (element.location?.file) {
        item.command = {
          command: "trackidity.openFunction",
          title: "Open Function",
          arguments: [element.location],
        };
      }
      item.tooltip = element.tooltip;
      return item;
    }

    const fallback = new vscode.TreeItem(
      "Unknown item",
      vscode.TreeItemCollapsibleState.None
    );
    return fallback;
  }

  getChildren(element) {
    if (this._loading) {
      return [{ kind: "message", message: "Loading entry points..." }];
    }

    if (this._lastError) {
      return [
        { kind: "message", message: `Trackidity error: ${this._lastError}` },
        { kind: "message", message: 'Run "Trackidity: Re-analyze (Slither)" to retry.' },
      ];
    }

    if (!this._files.length) {
      return [{ kind: "message", message: 'No entry points yet. Run "Trackidity: Re-analyze (Slither)".' }];
    }

    if (!element) {
      return this._files;
    }

    if (element.kind === "file") {
      return element.entrypoints;
    }

    return [];
  }

  _getDataFilePath(workspaceRoot) {
    return path.join(workspaceRoot, ".vscode", "trackidity-data.json");
  }

  _loadDataFile(workspaceRoot) {
    const dataPath = this._getDataFilePath(workspaceRoot);
    if (!fs.existsSync(dataPath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(dataPath, "utf8");
      return JSON.parse(content);
    } catch (e) {
      console.error("Trackidity: Failed to parse data file:", e);
      return null;
    }
  }

  _saveDataFile(workspaceRoot, data) {
    const vscodeDir = path.join(workspaceRoot, ".vscode");
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }
    const dataPath = this._getDataFilePath(workspaceRoot);
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
  }

  async load() {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this._files = [];
      this._lastError = "No workspace folder open";
      this._analysis = null;
      this._workspaceRoot = null;
      this._onDidChangeTreeData.fire();
      return;
    }

    this._loading = true;
    this._lastError = null;
    this._onDidChangeTreeData.fire();

    try {
      const raw = this._loadDataFile(workspace.uri.fsPath);

      if (!raw) {
        // No data file found, auto-run analysis
        this._loading = false;
        return this.reanalyze();
      }

      if (!raw.ok) {
        this._analysis = null;
        this._workspaceRoot = workspace.uri.fsPath;
        this._files = [];
        this._lastError = raw.error || "Unknown error";
        this._loading = false;
        this._onDidChangeTreeData.fire();
        return;
      }

      this._analysis = raw;
      this._workspaceRoot = workspace.uri.fsPath;
      this._rebuildFiles();

      // Share analysis with variables provider
      if (this._variablesProvider) {
        this._variablesProvider.setAnalysis(raw, workspace.uri.fsPath);
      }

      // Notify listeners that analysis has changed (for state var highlighting)
      this._onAnalysisChanged.fire(raw);

      this._loading = false;
      this._lastError = null;
      this._onDidChangeTreeData.fire();
    } catch (e) {
      this._files = [];
      this._loading = false;
      this._lastError = e instanceof Error ? e.message : String(e);
      // Notify variables provider of error
      if (this._variablesProvider) {
        this._variablesProvider.setError(this._lastError);
      }
      this._onDidChangeTreeData.fire();
    }
  }

  async reanalyze(options = {}) {
    const { silent } = options;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this._files = [];
      this._lastError = "No workspace folder open";
      this._analysis = null;
      this._workspaceRoot = null;
      this._onDidChangeTreeData.fire();
      return;
    }

    const config = vscode.workspace.getConfiguration("trackidity");
    const targetPathSetting = String(config.get("targetPath") || "").trim();
    const pythonPathSetting = String(config.get("pythonPath") || "").trim();
    const slitherRepoPath = config.get("slitherRepoPath") || "";
    const solcPath = config.get("solcPath") || "";
    const solcArgs = config.get("solcArgs") || "";
    const filterPaths = config.get("filterPaths") || [];
    const excludeDependencies = !!config.get("excludeDependencies");

    const extractor = this._context.asAbsolutePath(
      path.join("python", "extract_workflows.py")
    );

    this._loading = true;
    this._lastError = null;
    this._onDidChangeTreeData.fire();

    try {
      const analysisTarget = await resolveSlitherTarget({
        workspaceRoot: workspace.uri.fsPath,
        targetPathSetting,
      });
      const analysisCwd = resolveAnalysisCwd(analysisTarget);
      const pythonRunner = await resolvePythonPathForSlither({
        workspaceRoot: workspace.uri.fsPath,
        pythonPathSetting,
        slitherRepoPath,
      });

      const raw = await runExtractor(
        pythonRunner,
        extractor,
        analysisTarget,
        workspace.uri.fsPath,
        analysisCwd,
        {
          slitherRepoPath,
          solcPath,
          solcArgs,
          filterPaths,
          excludeDependencies,
        },
        { silent }
      );

      // Save to file regardless of success/failure
      this._saveDataFile(workspace.uri.fsPath, raw);

      if (!raw.ok) {
        this._analysis = null;
        this._workspaceRoot = workspace.uri.fsPath;
        this._files = [];
        this._lastError = raw.error || "Unknown error";
        this._loading = false;
        this._onDidChangeTreeData.fire();
        return;
      }

      this._analysis = raw;
      this._workspaceRoot = workspace.uri.fsPath;
      this._rebuildFiles();

      // Share analysis with variables provider
      if (this._variablesProvider) {
        this._variablesProvider.setAnalysis(raw, workspace.uri.fsPath);
      }

      // Notify listeners that analysis has changed (for state var highlighting)
      this._onAnalysisChanged.fire(raw);

      this._loading = false;
      this._lastError = null;
      this._onDidChangeTreeData.fire();

      vscode.window.showInformationMessage("Trackidity: Analysis saved to .vscode/trackidity-data.json");
    } catch (e) {
      this._files = [];
      this._loading = false;
      this._lastError = e instanceof Error ? e.message : String(e);
      // Notify variables provider of error
      if (this._variablesProvider) {
        this._variablesProvider.setError(this._lastError);
      }
      this._onDidChangeTreeData.fire();
    }
  }

  _rebuildFiles() {
    const workspaceRoot = this._workspaceRoot;
    if (!this._analysis || !workspaceRoot) {
      this._files = [];
      return;
    }

    const hiddenFiles = this._context.workspaceState.get(HIDDEN_FILES_KEY, []);
    const hiddenEntrypoints = this._context.workspaceState.get(HIDDEN_ENTRYPOINTS_KEY, []);

    this._files = (this._analysis.files || [])
      .filter((file) => !hiddenFiles.includes(file.path))
      .map((file) => ({
        kind: "file",
        fileRel: file.path,
        fileAbs: path.isAbsolute(file.path) ? file.path : path.join(workspaceRoot, file.path),
        entrypoints: (file.entrypoints || [])
          .map((ep) => normalizeEntrypoint(ep, workspaceRoot))
          .filter((ep) => !hiddenEntrypoints.includes(ep.flowId)),
      }))
      .filter((fileNode) => (fileNode.entrypoints || []).length > 0);

    this._files.sort((a, b) => a.fileRel.localeCompare(b.fileRel));
    for (const f of this._files) {
      f.entrypoints.sort((a, b) => {
        // Sort by: inherited (false first), then line number, then label
        const ia = a.inherited ? 1 : 0;
        const ib = b.inherited ? 1 : 0;
        if (ia !== ib) {
          return ia - ib;
        }
        const la = Number(a.location?.line ?? Number.POSITIVE_INFINITY);
        const lb = Number(b.location?.line ?? Number.POSITIVE_INFINITY);
        if (la !== lb) {
          return la - lb;
        }
        return String(a.label || "").localeCompare(String(b.label || ""));
      });
    }
  }

  hideFile(item) {
    if (!item || item.kind !== "file") {
      return;
    }
    const hiddenFiles = this._context.workspaceState.get(HIDDEN_FILES_KEY, []);
    if (!hiddenFiles.includes(item.fileRel)) {
      hiddenFiles.push(item.fileRel);
      this._context.workspaceState.update(HIDDEN_FILES_KEY, hiddenFiles);
    }
    this._rebuildFiles();
    this._onDidChangeTreeData.fire();
  }

  hideEntrypoint(item) {
    if (!item || item.kind !== "entrypoint" || !item.flowId) {
      return;
    }
    const hiddenEntrypoints = this._context.workspaceState.get(HIDDEN_ENTRYPOINTS_KEY, []);
    if (!hiddenEntrypoints.includes(item.flowId)) {
      hiddenEntrypoints.push(item.flowId);
      this._context.workspaceState.update(HIDDEN_ENTRYPOINTS_KEY, hiddenEntrypoints);
    }
    this._rebuildFiles();
    this._onDidChangeTreeData.fire();
  }

  unhideAll() {
    this._context.workspaceState.update(HIDDEN_FILES_KEY, []);
    this._context.workspaceState.update(HIDDEN_ENTRYPOINTS_KEY, []);
    this._rebuildFiles();
    this._onDidChangeTreeData.fire();
  }

  markReviewed(item) {
    if (!item || item.kind !== "entrypoint" || !item.flowId) {
      return;
    }
    const reviewed = this._context.workspaceState.get(REVIEWED_ENTRYPOINTS_KEY, []);
    if (!reviewed.includes(item.flowId)) {
      reviewed.push(item.flowId);
      this._context.workspaceState.update(REVIEWED_ENTRYPOINTS_KEY, reviewed);
      this._onDidChangeTreeData.fire();
    }
  }

  unmarkReviewed(item) {
    if (!item || item.kind !== "entrypoint" || !item.flowId) {
      return;
    }
    const reviewed = this._context.workspaceState.get(REVIEWED_ENTRYPOINTS_KEY, []);
    const index = reviewed.indexOf(item.flowId);
    if (index !== -1) {
      reviewed.splice(index, 1);
      this._context.workspaceState.update(REVIEWED_ENTRYPOINTS_KEY, reviewed);
      this._onDidChangeTreeData.fire();
    }
  }

  clearAllReviewed() {
    this._context.workspaceState.update(REVIEWED_ENTRYPOINTS_KEY, []);
    this._onDidChangeTreeData.fire();
  }

}

class VariablesProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    this._analysis = null;
    this._workspaceRoot = null;
    this._variables = [];
    this._lastError = null;
  }

  setAnalysis(analysis, workspaceRoot) {
    this._analysis = analysis;
    this._workspaceRoot = workspaceRoot;
    this._lastError = null;
    this._rebuildVariables();
    this._onDidChangeTreeData.fire();
  }

  setError(error) {
    this._lastError = error;
    this._variables = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    if (element.kind === "message") {
      const item = new vscode.TreeItem(
        element.message,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "trackidity.message";
      return item;
    }

    if (element.kind === "varFile") {
      const item = new vscode.TreeItem(
        element.fileRel,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.contextValue = "trackidity.varFile";
      item.iconPath = new vscode.ThemeIcon("file-code");
      item.description = element.contract;
      item.tooltip = `${element.contract} - ${element.fileAbs}`;
      return item;
    }

    if (element.kind === "variable") {
      const item = new vscode.TreeItem(
        element.name,
        element.modifiers && element.modifiers.length
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "trackidity.variable";
      item.iconPath = new vscode.ThemeIcon("symbol-variable");
      // Show inherited indicator or type as description
      item.description = element.inheritedFrom
        ? `${element.type} • from ${element.inheritedFrom}`
        : element.type;
      item.tooltip = element.inheritedFrom
        ? `${element.contract}.${element.name} (${element.type}) - inherited from ${element.inheritedFrom}`
        : `${element.contract}.${element.name} (${element.type})`;
      if (element.location?.file) {
        item.command = {
          command: "trackidity.openFunction",
          title: "Open Variable",
          arguments: [element.location],
        };
      }
      return item;
    }

    if (element.kind === "modifier") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None
      );
      item.contextValue = "trackidity.modifier";
      item.iconPath = new vscode.ThemeIcon("debug-start");
      item.description = element.contract;
      item.tooltip = `Entry point: ${element.contract}.${element.label}`;
      if (element.location?.file) {
        item.command = {
          command: "trackidity.openFunction",
          title: "Open Entry Point",
          arguments: [element.location],
        };
      }
      return item;
    }

    const fallback = new vscode.TreeItem(
      "Unknown item",
      vscode.TreeItemCollapsibleState.None
    );
    return fallback;
  }

  getChildren(element) {
    if (this._lastError) {
      return [
        { kind: "message", message: `Trackidity error: ${this._lastError}` },
        { kind: "message", message: 'Run "Trackidity: Re-analyze (Slither)" to retry.' },
      ];
    }

    if (!this._variables.length) {
      if (!this._analysis) {
        return [{ kind: "message", message: 'No variables yet. Run "Trackidity: Re-analyze (Slither)".' }];
      }
      return [{ kind: "message", message: "No state variables with modifying entry points found." }];
    }

    if (!element) {
      return this._variables;
    }

    if (element.kind === "varFile") {
      return element.vars || [];
    }

    if (element.kind === "variable") {
      return element.modifiers || [];
    }

    return [];
  }

  _rebuildVariables() {
    const workspaceRoot = this._workspaceRoot;
    if (!this._analysis || !workspaceRoot) {
      this._variables = [];
      return;
    }

    const rawVariables = this._analysis.variables || [];
    this._variables = rawVariables.map((fileEntry) => ({
      kind: "varFile",
      fileRel: fileEntry.path,
      fileAbs: path.isAbsolute(fileEntry.path) ? fileEntry.path : path.join(workspaceRoot, fileEntry.path),
      contract: fileEntry.contract,
      vars: (fileEntry.vars || []).map((v) => ({
        kind: "variable",
        varId: v.varId,
        name: v.name,
        type: v.type,
        contract: v.contract,
        inherited: !!v.inherited,
        inheritedFrom: v.inheritedFrom || null,
        location: normalizeLocation(v.location, workspaceRoot),
        modifiers: (v.modifiers || []).map((m) => ({
          kind: "modifier",
          flowId: m.flowId,
          label: m.label,
          contract: m.contract,
          location: normalizeLocation(m.location, workspaceRoot),
        })),
      })),
    })).filter((f) => f.vars && f.vars.length > 0);

    this._variables.sort((a, b) => a.fileRel.localeCompare(b.fileRel));
  }
}

function entrypointIcon(label) {
  const s = String(label || "").toLowerCase();
  if (s.startsWith("constructor")) {
    return new vscode.ThemeIcon("tools");
  }
  if (s.startsWith("receive")) {
    return new vscode.ThemeIcon("symbol-event");
  }
  if (s.startsWith("fallback")) {
    return new vscode.ThemeIcon("symbol-misc");
  }
  return new vscode.ThemeIcon("debug-start");
}

function isSupportedProjectRoot(dir) {
  return (
    fs.existsSync(path.join(dir, "foundry.toml")) ||
    fs.existsSync(path.join(dir, "hardhat.config.js")) ||
    fs.existsSync(path.join(dir, "hardhat.config.ts")) ||
    fs.existsSync(path.join(dir, "hardhat.config.cjs")) ||
    fs.existsSync(path.join(dir, "hardhat.config.mjs")) ||
    fs.existsSync(path.join(dir, "truffle-config.js")) ||
    fs.existsSync(path.join(dir, "truffle.js")) ||
    fs.existsSync(path.join(dir, "brownie-config.yml")) ||
    fs.existsSync(path.join(dir, "brownie-config.yaml"))
  );
}

async function resolveSlitherTarget({ workspaceRoot, targetPathSetting }) {
  if (targetPathSetting) {
    const resolved = path.isAbsolute(targetPathSetting)
      ? targetPathSetting
      : path.join(workspaceRoot, targetPathSetting);
    if (!fs.existsSync(resolved)) {
      throw new Error(`trackidity.targetPath does not exist: ${resolved}`);
    }
    return resolved;
  }

  if (isSupportedProjectRoot(workspaceRoot)) {
    return workspaceRoot;
  }

  const patterns = [
    "**/foundry.toml",
    "**/hardhat.config.{js,ts,cjs,mjs}",
    "**/truffle-config.js",
    "**/truffle.js",
    "**/brownie-config.{yml,yaml}",
  ];

  const base = vscode.Uri.file(workspaceRoot);
  const hits = [];
  for (const glob of patterns) {
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(base, glob),
      "**/{node_modules,.git}/**",
      25
    );
    hits.push(...found);
  }

  if (!hits.length) {
    return workspaceRoot;
  }

  const dirs = Array.from(new Set(hits.map((u) => path.dirname(u.fsPath))));
  dirs.sort((a, b) => {
    const ra = path.relative(workspaceRoot, a);
    const rb = path.relative(workspaceRoot, b);
    const da = ra.split(path.sep).length;
    const db = rb.split(path.sep).length;
    return da !== db ? da - db : ra.length - rb.length;
  });
  return dirs[0] || workspaceRoot;
}

function resolveAnalysisCwd(analysisTarget) {
  try {
    const stat = fs.statSync(analysisTarget);
    if (stat.isDirectory()) {
      return analysisTarget;
    }
  } catch (e) {
    // ignore
  }
  return path.dirname(analysisTarget);
}

async function resolvePythonPathForSlither({ workspaceRoot, pythonPathSetting, slitherRepoPath }) {
  const candidates = [];

  const slitherPython = await pythonFromSlitherCLI(workspaceRoot);
  if (slitherPython) {
    candidates.push(slitherPython);
  }

  if (pythonPathSetting) {
    candidates.push(pythonPathSetting);
  }

  const pythonConfig = vscode.workspace.getConfiguration("python");
  const defaultInterpreterPath = String(pythonConfig.get("defaultInterpreterPath") || "").trim();
  if (defaultInterpreterPath) {
    candidates.push(defaultInterpreterPath);
  }

  const pythonFromExt = await pythonFromPythonExtension(workspaceRoot);
  if (pythonFromExt) {
    candidates.push(pythonFromExt);
  }

  candidates.push(...pythonFromEnv());

  candidates.push("python3", "python");

  const unique = Array.from(new Set(candidates.filter(Boolean)));

  for (const candidate of unique) {
    const ok = await canImportSlither(candidate, { workspaceRoot, slitherRepoPath });
    if (ok) {
      return { cmd: candidate, args: [] };
    }
  }

  // Try uvx (uv tool) as fallback
  const uvxOk = await canRunSlitherViaUvx(workspaceRoot);
  if (uvxOk) {
    return { cmd: "uvx", args: ["--from", "slither-analyzer", "python"] };
  }

  // Try pipx as fallback
  const pipxOk = await canRunSlitherViaPipx(workspaceRoot);
  if (pipxOk) {
    return { cmd: "pipx", args: ["run", "--spec", "slither-analyzer", "python"] };
  }

  // Best-effort fallback (will surface the extractor error)
  if (pythonPathSetting) {
    return { cmd: pythonPathSetting, args: [] };
  }
  if (slitherPython) {
    return { cmd: slitherPython, args: [] };
  }
  return { cmd: "python3", args: [] };
}

async function canRunSlitherViaUvx(workspaceRoot) {
  try {
    await execFileAsync("uvx", ["--from", "slither-analyzer", "python", "-c", "import slither; print('OK')"], {
      cwd: workspaceRoot,
      timeout: 30000,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function canRunSlitherViaPipx(workspaceRoot) {
  try {
    await execFileAsync("pipx", ["run", "--spec", "slither-analyzer", "python", "-c", "import slither; print('OK')"], {
      cwd: workspaceRoot,
      timeout: 30000,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function canImportSlither(pythonPath, { workspaceRoot, slitherRepoPath }) {
  const repo = String(slitherRepoPath || "").trim();
  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  const code = repo
    ? `import os, sys; sys.path.insert(0, os.environ["TRACKIDITY_SLITHER_REPO"]); import slither; print("OK")`
    : `import slither; print("OK")`;
  if (repo) {
    env.TRACKIDITY_SLITHER_REPO = repo;
  }

  try {
    await execFileAsync(pythonPath, ["-c", code], {
      cwd: workspaceRoot,
      timeout: 5000,
      env,
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function pythonFromSlitherCLI(workspaceRoot) {
  const slitherPath = await findOnPath("slither", workspaceRoot);
  if (!slitherPath) {
    return null;
  }
  try {
    const fd = fs.openSync(slitherPath, "r");
    const buf = Buffer.alloc(256);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf
      .subarray(0, bytes)
      .toString("utf8")
      .split(/\r?\n/)[0]
      .trim();
    if (!firstLine.startsWith("#!")) {
      return null;
    }
    const shebang = firstLine.slice(2).trim();
    const parts = shebang.split(/\s+/).filter(Boolean);
    if (!parts.length) {
      return null;
    }
    // #!/usr/bin/env python3
    if (parts[0].endsWith("/env") && parts.length > 1) {
      return parts[1];
    }
    return parts[0];
  } catch (e) {
    return null;
  }
}

async function pythonFromPythonExtension(workspaceRoot) {
  try {
    const ext = vscode.extensions.getExtension("ms-python.python");
    if (!ext) {
      return null;
    }
    const api = await ext.activate();
    const resource = vscode.Uri.file(workspaceRoot);

    const details =
      api?.settings?.getExecutionDetails?.(resource) ??
      api?.settings?.getExecutionDetails?.(workspaceRoot);

    const execCommand = details?.execCommand;
    if (Array.isArray(execCommand) && execCommand.length > 0 && typeof execCommand[0] === "string") {
      return execCommand[0];
    }

    const envPath = api?.environments?.getActiveEnvironmentPath?.(resource);
    if (envPath && typeof envPath.path === "string" && envPath.path) {
      return envPath.path;
    }

    const env = api?.environments?.getActiveEnvironment?.(resource);
    const envExecutable =
      env?.executable?.uri?.fsPath || env?.executable?.sysPrefix || env?.executable?.path;
    if (typeof envExecutable === "string" && envExecutable) {
      return envExecutable;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function pythonFromEnv() {
  const env = process.env;
  const candidates = [];
  const venv = env.VIRTUAL_ENV || env.CONDA_PREFIX;
  if (venv) {
    const binDir = process.platform === "win32" ? "Scripts" : "bin";
    const exe = process.platform === "win32" ? "python.exe" : "python";
    candidates.push(path.join(venv, binDir, exe));
  }
  return candidates;
}

async function findOnPath(command, cwd) {
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(tool, [command], { cwd, timeout: 2000 });
    const first = String(stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l);
    return first || null;
  } catch (e) {
    return null;
  }
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, options || {}, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function normalizeEntrypoint(ep, workspaceRoot) {
  return {
    kind: "entrypoint",
    flowId: ep.flowId,
    label: ep.label,
    contract: ep.contract,
    tooltip: ep.tooltip,
    inherited: !!ep.inherited,
    inheritedFrom: ep.inheritedFrom || null,
    location: normalizeLocation(ep.location, workspaceRoot),
  };
}

function normalizeLocation(location, workspaceRoot) {
  if (!location || !location.file) {
    return null;
  }
  const file = path.isAbsolute(location.file)
    ? location.file
    : path.join(workspaceRoot, location.file);
  return {
    file,
    line: Number(location.line || 0),
    character: Number(location.character || 0),
  };
}

function buildExtractorArgs(scriptPath, analysisTarget, workspaceRoot, options) {
  const scriptArgs = [
    scriptPath,
    "--target",
    analysisTarget,
    "--workspace-root",
    workspaceRoot,
    "--exclude-dependencies",
    String(!!options.excludeDependencies),
    "--expand-dependencies",
    "False",
    "--max-depth",
    "1",
  ];

  if (options.slitherRepoPath) {
    scriptArgs.push("--slither-repo", options.slitherRepoPath);
  }
  if (options.solcPath) {
    scriptArgs.push("--solc", options.solcPath);
  }
  if (options.solcArgs) {
    scriptArgs.push("--solc-args", options.solcArgs);
  }
  for (const p of options.filterPaths || []) {
    if (typeof p === "string" && p) {
      scriptArgs.push("--filter-path", p);
    }
  }

  return scriptArgs;
}

function runExtractor(
  pythonRunner,
  scriptPath,
  analysisTarget,
  workspaceRoot,
  analysisCwd,
  options,
  progressOptions
) {
  const spawnOnce = (token) =>
    new Promise((resolve, reject) => {
      const scriptArgs = buildExtractorArgs(scriptPath, analysisTarget, workspaceRoot, options);

      // pythonRunner is {cmd, args} where args are prepended to scriptArgs
      const cmd = pythonRunner.cmd;
      const args = [...(pythonRunner.args || []), ...scriptArgs];

      const proc = cp.spawn(cmd, args, {
        cwd: analysisCwd || workspaceRoot,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      });

      let stdout = "";
      let stderr = "";

      const disposeCancel =
        token && typeof token.onCancellationRequested === "function"
          ? token.onCancellationRequested(() => {
              try {
                proc.kill();
              } catch (e) {
                // ignore
              }
            })
          : { dispose: () => {} };

      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      proc.on("error", (err) => {
        disposeCancel.dispose();
        reject(err);
      });

      proc.on("close", (code) => {
        disposeCancel.dispose();
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed);
        } catch (e) {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Extractor exited with code ${code}`));
          } else {
            reject(
              new Error(`Failed to parse extractor output as JSON. stderr: ${stderr.trim()}`)
            );
          }
        }
      });
    });

  if (progressOptions?.silent) {
    return spawnOnce(undefined);
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Trackidity: Analyzing entry points (Slither)…",
      cancellable: true,
    },
    (_progress, token) => spawnOnce(token)
  );
}

module.exports = {
  activate,
  deactivate,
};
