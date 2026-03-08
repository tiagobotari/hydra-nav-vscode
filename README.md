# Hydra Config Navigator

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-green)

Ctrl+click navigation for [Hydra](https://hydra.cc/) config files in VSCode. Jump from YAML configs to Python source code and navigate between config references — just like you would in Python.

## Features

### `_target_` → Python Source

Ctrl+click on any `_target_` value to jump directly to the class or function definition.

```yaml
_target_: src.methods.melime_method.MeLIMEAttribution  # Ctrl+click → opens the class
_partial_: true
```

### Config Cross-References

Ctrl+click on config references to open the corresponding YAML file.

```yaml
methods:
  - melime_mnist    # Ctrl+click → opens method/melime_mnist.yaml
  - lime_mnist      # Ctrl+click → opens method/lime_mnist.yaml
```

### Hydra Defaults Navigation

Ctrl+click on values in `defaults` lists, including Hydra's override syntax.

```yaml
defaults:
  - override /dataset: mnist       # Ctrl+click → opens dataset/mnist.yaml
  - override /model: cnn_mnist     # Ctrl+click → opens model/cnn_mnist.yaml
  - override /metrics: all         # Ctrl+click → opens metrics/all.yaml
```

### Nested Key Paths

Supports nested config group paths for deeply organized config structures.

```yaml
defaults:
  - override /dataset/transforms: augment  # Ctrl+click → opens dataset/transforms/augment.yaml
```

### Inline Value References

Ctrl+click on inline config values that reference other config files.

```yaml
dataset: mnist          # Ctrl+click → opens dataset/mnist.yaml
model: cnn_mnist        # Ctrl+click → opens model/cnn_mnist.yaml
```

### Hover Previews

Hover over any reference to see a preview of the target file contents without navigating away.

- **Config references**: Shows the first 20 lines of the target YAML file with the file path
- **`_target_` references**: Shows the Python class/function definition and docstring

### Autocomplete

Get suggestions for valid config names as you type.

- Under a `methods:` key, suggests all files in the `method/` directory
- In `defaults` lists, suggests files matching the config group
- Inline values suggest files from the matching config group

### Automatic Workspace Scanning

- Scans the entire workspace for YAML files on activation
- Builds an index mapping filenames, directories, and nested paths
- Automatically refreshes when YAML files are created or deleted
- Resolves references using singular/plural directory name variants (e.g., `methods` key → `method/` directory)

## Installation

### From Source (Local)

```bash
git clone https://github.com/tiagobotari/hydra-nav-vscode.git
cd hydra-nav-vscode
npm install
npm run compile
```

Then symlink into your VSCode extensions:

```bash
ln -s /path/to/hydra-nav-vscode ~/.vscode/extensions/hydra-nav
```

Reload VSCode (`Ctrl+Shift+P` → "Developer: Reload Window").

## How It Works

1. **`_target_` resolution**: Parses the dotted Python path, converts it to a file path, searches the workspace for the file, then finds the `class` or `def` definition by name.

2. **Config reference resolution**: On activation, indexes all `*.yaml` files in the workspace by filename and parent directory. When you Ctrl+click a reference, it looks up the filename in the index and uses the parent YAML key (with singular/plural variants) to disambiguate when multiple files share the same name.

## Requirements

- VSCode 1.80.0 or later
- A project using [Hydra](https://hydra.cc/) configuration

## Author

**Tiago Botari**

## License

[CC BY-NC 4.0](LICENSE) — Free to use, share, and adapt for non-commercial purposes.
