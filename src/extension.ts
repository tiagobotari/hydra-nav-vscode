import * as vscode from "vscode";

/**
 * Resolves Hydra _target_ strings (e.g. "src.methods.melime_method.MeLIMEAttribution")
 * to the Python source definition.
 */
class HydraTargetDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location | null> {
    const line = document.lineAt(position).text;
    const match = line.match(/_target_:\s*["']?([A-Za-z0-9_.]+)/);
    if (!match) return null;

    const valueStart = line.indexOf(match[1]);
    const valueEnd = valueStart + match[1].length;
    if (position.character < valueStart || position.character > valueEnd)
      return null;

    const target = match[1];
    const parts = target.split(".");
    const symbolName = parts.pop()!;
    const modulePath = parts.join("/") + ".py";

    const files = await vscode.workspace.findFiles(
      `**/${modulePath}`,
      "**/node_modules/**"
    );
    if (files.length === 0) return null;

    const doc = await vscode.workspace.openTextDocument(files[0]);
    for (let i = 0; i < doc.lineCount; i++) {
      if (
        doc.lineAt(i).text.match(new RegExp(`^(class|def)\\s+${symbolName}\\b`))
      ) {
        return new vscode.Location(files[0], new vscode.Position(i, 0));
      }
    }
    return new vscode.Location(files[0], new vscode.Position(0, 0));
  }
}

/**
 * Scans the workspace to build a map of config group directories and their files.
 * This allows resolving references like "melime_mnist" by searching all config
 * directories for a matching YAML file, regardless of naming conventions.
 */
class ConfigIndex {
  // Map from filename (without .yaml) -> full URI
  private fileIndex = new Map<string, vscode.Uri[]>();
  // Map from directory name -> set of filenames
  private dirIndex = new Map<string, Set<string>>();
  private initialized = false;

  async ensureInitialized() {
    if (this.initialized) return;
    await this.refresh();
    this.initialized = true;
  }

  async refresh() {
    this.fileIndex.clear();
    this.dirIndex.clear();

    const yamlFiles = await vscode.workspace.findFiles(
      "**/*.yaml",
      "{**/node_modules/**,**/venv/**,**/.git/**}"
    );

    for (const uri of yamlFiles) {
      const parts = uri.path.split("/");
      const filename = parts[parts.length - 1].replace(/\.yaml$/, "");
      const dirName = parts[parts.length - 2];

      // Index by filename
      const existing = this.fileIndex.get(filename) || [];
      existing.push(uri);
      this.fileIndex.set(filename, existing);

      // Index by directory
      const dirFiles = this.dirIndex.get(dirName) || new Set();
      dirFiles.add(filename);
      this.dirIndex.set(dirName, dirFiles);
    }
  }

  /**
   * Find a config file by reference name and optional parent key hint.
   * Tries to match the parent key to a directory name (singular/plural).
   */
  findFile(refName: string, parentKey: string | null): vscode.Uri | null {
    const candidates = this.fileIndex.get(refName);
    if (!candidates || candidates.length === 0) return null;

    if (candidates.length === 1) return candidates[0];

    // Multiple matches — use parentKey to disambiguate
    if (parentKey) {
      const keyVariants = this.getNameVariants(parentKey);
      for (const variant of keyVariants) {
        for (const uri of candidates) {
          const dirName = uri.path.split("/").slice(-2, -1)[0];
          if (dirName === variant) return uri;
        }
      }
    }

    // Return first match as fallback
    return candidates[0];
  }

  /** Generate singular/plural variants of a name */
  private getNameVariants(name: string): string[] {
    const variants = [name];
    if (name.endsWith("s")) {
      variants.push(name.slice(0, -1)); // methods -> method
      if (name.endsWith("ies")) {
        variants.push(name.slice(0, -3) + "y"); // categories -> category
      }
    } else {
      variants.push(name + "s"); // method -> methods
      if (name.endsWith("y")) {
        variants.push(name.slice(0, -1) + "ies"); // category -> categories
      }
    }
    return variants;
  }
}

/**
 * Resolves config cross-references by scanning the workspace.
 * Handles list items and inline values, matching against all YAML files found.
 */
class HydraConfigRefProvider implements vscode.DefinitionProvider {
  constructor(private index: ConfigIndex) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location | null> {
    await this.index.ensureInitialized();

    const line = document.lineAt(position).text;
    let refName: string | null = null;
    let parentKey: string | null = null;

    // Case 1: Hydra defaults "- override /dataset: mnist" or "- /dataset: mnist" or "- dataset: mnist"
    const defaultsMatch = line.match(
      /^\s*-\s+(?:override\s+)?\/?([\w]+):\s*(\S+)\s*$/
    );
    if (defaultsMatch) {
      parentKey = defaultsMatch[1];
      refName = defaultsMatch[2];
    }

    // Case 2: plain list item "  - melime_mnist"
    if (!refName) {
      const listMatch = line.match(/^\s*-\s+(\S+)\s*$/);
      if (listMatch) {
        refName = listMatch[1];
        for (let i = position.line - 1; i >= 0; i--) {
          const prevLine = document.lineAt(i).text;
          const keyMatch = prevLine.match(/^(\w[\w]*)\s*:/);
          if (keyMatch) {
            parentKey = keyMatch[1];
            break;
          }
        }
      }
    }

    // Case 3: inline value "dataset: iris"
    if (!refName) {
      const inlineMatch = line.match(/^(\w[\w]*)\s*:\s*(\S+)\s*$/);
      if (inlineMatch) {
        parentKey = inlineMatch[1];
        refName = inlineMatch[2];
      }
    }

    if (!refName) return null;
    // Skip non-references
    if (refName.includes(".") || /^(true|false|\d+(\.\d+)?)$/i.test(refName))
      return null;
    if (refName.startsWith("$") || refName.startsWith("{")) return null;

    // Check cursor is on the reference
    const refStart = line.indexOf(refName);
    const refEnd = refStart + refName.length;
    if (position.character < refStart || position.character > refEnd)
      return null;

    const uri = this.index.findFile(refName, parentKey);
    if (!uri) return null;

    // Don't navigate to self
    if (uri.fsPath === document.uri.fsPath) return null;

    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
}

export function activate(context: vscode.ExtensionContext) {
  const yamlSelector: vscode.DocumentSelector = { language: "yaml" };
  const configIndex = new ConfigIndex();

  // Refresh index when YAML files are created/deleted/renamed
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.yaml");
  watcher.onDidCreate(() => configIndex.refresh());
  watcher.onDidDelete(() => configIndex.refresh());

  context.subscriptions.push(
    watcher,
    vscode.languages.registerDefinitionProvider(
      yamlSelector,
      new HydraTargetDefinitionProvider()
    ),
    vscode.languages.registerDefinitionProvider(
      yamlSelector,
      new HydraConfigRefProvider(configIndex)
    )
  );
}

export function deactivate() {}
