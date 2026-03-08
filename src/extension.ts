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
        doc
          .lineAt(i)
          .text.match(new RegExp(`^(class|def)\\s+${symbolName}\\b`))
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
  // Map from relative path (e.g. "dataset/transforms/augment") -> URI
  private pathIndex = new Map<string, vscode.Uri>();
  // All indexed URIs for reading content
  private allFiles: vscode.Uri[] = [];
  private initialized = false;

  async ensureInitialized() {
    if (this.initialized) return;
    await this.refresh();
    this.initialized = true;
  }

  async refresh() {
    this.fileIndex.clear();
    this.dirIndex.clear();
    this.pathIndex.clear();
    this.allFiles = [];

    const yamlFiles = await vscode.workspace.findFiles(
      "**/*.yaml",
      "{**/node_modules/**,**/venv/**,**/.git/**}"
    );

    this.allFiles = yamlFiles;

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

      // Index by nested path — find the configs root and store relative path
      // e.g. .../configs/dataset/transforms/augment.yaml -> "dataset/transforms/augment"
      const configsIdx = parts.indexOf("configs");
      if (configsIdx >= 0) {
        const relParts = parts.slice(configsIdx + 1);
        const relPath =
          relParts.slice(0, -1).join("/") +
          "/" +
          relParts[relParts.length - 1].replace(/\.yaml$/, "");
        this.pathIndex.set(relPath, uri);
      }
    }
  }

  /**
   * Find a config file by reference name and optional parent key hint.
   * Supports nested paths like "dataset/transforms/augment".
   */
  findFile(refName: string, parentKey: string | null): vscode.Uri | null {
    // Try nested path resolution first (e.g. parentKey="dataset", refName="transforms/augment")
    if (parentKey) {
      const keyVariants = this.getNameVariants(parentKey);
      for (const variant of keyVariants) {
        const nestedPath = `${variant}/${refName}`;
        const uri = this.pathIndex.get(nestedPath);
        if (uri) return uri;
      }
    }

    // Try direct path lookup (refName might already contain the full nested path)
    const directPath = this.pathIndex.get(refName);
    if (directPath) return directPath;

    // Fall back to filename-only lookup
    const baseName = refName.includes("/")
      ? refName.split("/").pop()!
      : refName;
    const candidates = this.fileIndex.get(baseName);
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

    return candidates[0];
  }

  /** Get all filenames within a config group directory */
  getFilesInGroup(groupKey: string): string[] {
    const results: string[] = [];
    const variants = this.getNameVariants(groupKey);
    for (const variant of variants) {
      const files = this.dirIndex.get(variant);
      if (files) {
        for (const f of files) results.push(f);
      }
    }
    return results;
  }

  /** Get all config group directory names */
  getGroups(): string[] {
    return Array.from(this.dirIndex.keys());
  }

  /** Get URI by filename */
  getUri(filename: string, parentKey: string | null): vscode.Uri | null {
    return this.findFile(filename, parentKey);
  }

  /** Generate singular/plural variants of a name */
  getNameVariants(name: string): string[] {
    const variants = [name];
    if (name.endsWith("s")) {
      variants.push(name.slice(0, -1));
      if (name.endsWith("ies")) {
        variants.push(name.slice(0, -3) + "y");
      }
    } else {
      variants.push(name + "s");
      if (name.endsWith("y")) {
        variants.push(name.slice(0, -1) + "ies");
      }
    }
    return variants;
  }
}

/** Shared helper: extract reference info from a YAML line */
interface RefInfo {
  refName: string;
  parentKey: string | null;
}

function extractRef(
  document: vscode.TextDocument,
  position: vscode.Position
): RefInfo | null {
  const line = document.lineAt(position).text;
  let refName: string | null = null;
  let parentKey: string | null = null;

  // Case 1: Hydra defaults "- override /dataset: mnist" or "- /dataset: mnist"
  // Also supports nested: "- override /dataset/transforms: augment"
  const defaultsMatch = line.match(
    /^\s*-\s+(?:override\s+)?\/?([\w/]+):\s*(\S+)\s*$/
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
  if (/^(true|false|\d+(\.\d+)?)$/i.test(refName)) return null;
  if (refName.startsWith("$") || refName.startsWith("{")) return null;

  // Check cursor is on the reference
  const refStart = line.indexOf(refName);
  const refEnd = refStart + refName.length;
  if (position.character < refStart || position.character > refEnd)
    return null;

  return { refName, parentKey };
}

/**
 * Resolves config cross-references by scanning the workspace.
 * Handles list items, inline values, nested paths, and Hydra defaults.
 */
class HydraConfigRefProvider implements vscode.DefinitionProvider {
  constructor(private index: ConfigIndex) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location | null> {
    await this.index.ensureInitialized();

    const ref = extractRef(document, position);
    if (!ref) return null;

    const uri = this.index.findFile(ref.refName, ref.parentKey);
    if (!uri) return null;
    if (uri.fsPath === document.uri.fsPath) return null;

    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
}

/**
 * Shows a hover preview with the first lines of the target config file
 * or Python class docstring for _target_ references.
 */
class HydraHoverProvider implements vscode.HoverProvider {
  constructor(private index: ConfigIndex) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | null> {
    await this.index.ensureInitialized();

    const line = document.lineAt(position).text;

    // Check for _target_ hover
    const targetMatch = line.match(/_target_:\s*["']?([A-Za-z0-9_.]+)/);
    if (targetMatch) {
      const valueStart = line.indexOf(targetMatch[1]);
      const valueEnd = valueStart + targetMatch[1].length;
      if (position.character >= valueStart && position.character <= valueEnd) {
        return this.hoverTarget(targetMatch[1], position, valueStart, valueEnd);
      }
    }

    // Check for config ref hover
    const ref = extractRef(document, position);
    if (!ref) return null;

    const uri = this.index.findFile(ref.refName, ref.parentKey);
    if (!uri || uri.fsPath === document.uri.fsPath) return null;

    return this.hoverConfigFile(uri, line, ref.refName);
  }

  private async hoverTarget(
    target: string,
    position: vscode.Position,
    valueStart: number,
    valueEnd: number
  ): Promise<vscode.Hover | null> {
    const parts = target.split(".");
    const symbolName = parts.pop()!;
    const modulePath = parts.join("/") + ".py";

    const files = await vscode.workspace.findFiles(
      `**/${modulePath}`,
      "**/node_modules/**"
    );
    if (files.length === 0) return null;

    const doc = await vscode.workspace.openTextDocument(files[0]);
    let preview = "";
    let found = false;

    for (let i = 0; i < doc.lineCount; i++) {
      const lineText = doc.lineAt(i).text;
      if (
        lineText.match(new RegExp(`^(class|def)\\s+${symbolName}\\b`))
      ) {
        // Grab the definition + next lines (docstring, params)
        const endLine = Math.min(i + 15, doc.lineCount);
        const lines: string[] = [];
        for (let j = i; j < endLine; j++) {
          lines.push(doc.lineAt(j).text);
          // Stop after closing triple quotes of docstring
          if (j > i && doc.lineAt(j).text.trim().match(/^['\"]{3}/)) break;
        }
        preview = lines.join("\n");
        found = true;
        break;
      }
    }

    if (!found) return null;

    const md = new vscode.MarkdownString();
    md.appendCodeblock(preview, "python");
    const range = new vscode.Range(
      position.line,
      valueStart,
      position.line,
      valueEnd
    );
    return new vscode.Hover(md, range);
  }

  private async hoverConfigFile(
    uri: vscode.Uri,
    line: string,
    refName: string
  ): Promise<vscode.Hover | null> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const maxLines = Math.min(doc.lineCount, 20);
    const lines: string[] = [];
    for (let i = 0; i < maxLines; i++) {
      lines.push(doc.lineAt(i).text);
    }
    let preview = lines.join("\n");
    if (doc.lineCount > 20) {
      preview += "\n# ...";
    }

    // Get relative path for the header
    const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relPath = wsFolder
      ? uri.fsPath.replace(wsFolder.uri.fsPath + "/", "")
      : uri.fsPath;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${relPath}**\n\n`);
    md.appendCodeblock(preview, "yaml");
    return new vscode.Hover(md);
  }
}

/**
 * Provides autocomplete suggestions for config references.
 * When typing under a key like "methods:", suggests all files in the method/ directory.
 */
class HydraCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private index: ConfigIndex) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | null> {
    await this.index.ensureInitialized();

    const line = document.lineAt(position).text;
    const items: vscode.CompletionItem[] = [];

    // Case 1: typing after "- override /group: " or "- " under a parent key
    // Detect if we're in a defaults list with a group
    const defaultsTyping = line.match(
      /^\s*-\s+(?:override\s+)?\/?([\w/]+):\s*$/
    );
    if (defaultsTyping) {
      const groupKey = defaultsTyping[1];
      // For nested paths like "dataset/transforms", use the full path
      const files = this.index.getFilesInGroup(
        groupKey.includes("/") ? groupKey.split("/").pop()! : groupKey
      );
      for (const f of files) {
        const item = new vscode.CompletionItem(
          f,
          vscode.CompletionItemKind.File
        );
        item.detail = `${groupKey}/${f}.yaml`;
        // Add hover doc preview
        const uri = this.index.getUri(f, groupKey);
        if (uri) {
          item.documentation = new vscode.MarkdownString(
            `Config file: \`${f}.yaml\``
          );
        }
        items.push(item);
      }
      return items;
    }

    // Case 2: typing a list item "  - " under a parent key
    const listTyping = line.match(/^\s*-\s+\w*$/);
    if (listTyping) {
      let parentKey: string | null = null;
      for (let i = position.line - 1; i >= 0; i--) {
        const prevLine = document.lineAt(i).text;
        const keyMatch = prevLine.match(/^(\w[\w]*)\s*:/);
        if (keyMatch) {
          parentKey = keyMatch[1];
          break;
        }
      }
      if (parentKey) {
        const files = this.index.getFilesInGroup(parentKey);
        for (const f of files) {
          const item = new vscode.CompletionItem(
            f,
            vscode.CompletionItemKind.File
          );
          item.detail = `${parentKey} config`;
          items.push(item);
        }
        return items.length > 0 ? items : null;
      }
    }

    // Case 3: typing an inline value "key: "
    const inlineTyping = line.match(/^(\w[\w]*)\s*:\s*\w*$/);
    if (inlineTyping) {
      const key = inlineTyping[1];
      // Skip common non-reference keys
      if (
        [
          "_target_",
          "_partial_",
          "_recursive_",
          "_convert_",
          "name",
          "version",
        ].includes(key)
      )
        return null;

      const files = this.index.getFilesInGroup(key);
      for (const f of files) {
        const item = new vscode.CompletionItem(
          f,
          vscode.CompletionItemKind.File
        );
        item.detail = `${key} config`;
        items.push(item);
      }
      return items.length > 0 ? items : null;
    }

    return null;
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
    ),
    vscode.languages.registerHoverProvider(
      yamlSelector,
      new HydraHoverProvider(configIndex)
    ),
    vscode.languages.registerCompletionItemProvider(
      yamlSelector,
      new HydraCompletionProvider(configIndex),
      "-",
      ":",
      " ",
      "/"
    )
  );
}

export function deactivate() {}
