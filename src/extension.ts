import * as vscode from "vscode";
import * as ptyLib from "node-pty";
import { execSync } from "child_process";
import { existsSync, readdirSync, statSync, chmodSync } from "fs";
import * as path from "path";

const KIRO_CLI = "/Users/chchen/.local/bin/kiro-cli";

let kiroPty: ptyLib.IPty | undefined;
let kiroTerminal: vscode.Terminal | undefined;
let writeEmitter: vscode.EventEmitter<string>;

// Fix spawn-helper permissions on first load
try {
  const helper = path.join(__dirname, "../node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch {}

function nextImgPath(): string {
  let i = 1;
  while (existsSync(`/tmp/kiro-img${i}.png`)) i++;
  return `/tmp/kiro-img${i}.png`;
}

function clipboardFilePaths(): string[] {
  try {
    const script = `
import Cocoa
let pb = NSPasteboard.general
if let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] {
    for u in urls { print(u.path) }
}`;
    const result = execSync(`swift -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 2000, encoding: "utf-8" }).trim();
    return result ? result.split("\n").filter(f => existsSync(f)) : [];
  } catch { return []; }
}

function clipboardHasImage(): boolean {
  try {
    return execSync(`osascript -e 'clipboard info' 2>/dev/null | grep -q 'TIFF' && echo 1 || echo 0`, { timeout: 500, encoding: "utf-8" }).trim() === "1";
  } catch { return false; }
}

function saveClipboardImage(): string | undefined {
  try {
    const imgPath = nextImgPath();
    const script = `
import Cocoa
let pb = NSPasteboard.general
if let img = pb.readObjects(forClasses: [NSImage.self], options: nil)?.first as? NSImage,
   let tiff = img.tiffRepresentation,
   let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
    try! png.write(to: URL(fileURLWithPath: "${imgPath}"))
    print("${imgPath}")
}`;
    const result = execSync(`swift -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000, encoding: "utf-8" }).trim();
    return result && existsSync(result) ? result : undefined;
  } catch { return undefined; }
}

function writeToKiro(text: string) {
  kiroPty?.write(text);
}

function updateContext() {
  vscode.commands.executeCommand("setContext", "kiro-pty.active", !!kiroPty);
}

async function showFilePicker(): Promise<string | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  const items: vscode.QuickPickItem[] = [];
  function walk(dir: string, prefix: string) {
    if (items.length >= 1000) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules" || name === "out" || name === "dist") continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      try {
        if (statSync(full).isDirectory()) {
          items.push({ label: `📁 ${rel}`, description: full });
          walk(full, rel);
        } else {
          items.push({ label: rel, description: full });
        }
      } catch {}
    }
  }
  walk(root, "");

  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select file to reference..." });
  return picked?.description;
}

function startKiro() {
  writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || "/";

  kiroPty = ptyLib.spawn(KIRO_CLI, ["chat"], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env } as { [key: string]: string },
  });

  kiroPty.onData((data: string) => {
    writeEmitter.fire(data);
  });

  kiroPty.onExit(({ exitCode }) => {
    closeEmitter.fire(exitCode);
    kiroPty = undefined;
    kiroTerminal = undefined;
    updateContext();
  });

  const pseudoTerminal: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open(dim) {
      if (dim && kiroPty) kiroPty.resize(dim.columns, dim.rows);
    },
    close() {
      kiroPty?.kill();
      kiroPty = undefined;
    },
    handleInput(data: string) {
      if (data === "@") {
        // Send @ to kiro-cli first
        writeToKiro("@");
        // Show file picker
        showFilePicker().then(filePath => {
          if (filePath) {
            // Delete the @ then send path
            writeToKiro("\x7f");
            writeToKiro(filePath);
          }
        });
        return;
      }
      writeToKiro(data);
    },
    setDimensions(dim) {
      kiroPty?.resize(dim.columns, dim.rows);
    },
  };

  kiroTerminal = vscode.window.createTerminal({ name: "Kiro Chat", pty: pseudoTerminal });
  kiroTerminal.show();
  updateContext();
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t === kiroTerminal) {
        kiroPty?.kill();
        kiroPty = undefined;
        kiroTerminal = undefined;
        updateContext();
      }
    }),

    vscode.commands.registerCommand("kiro-pty.start", () => {
      if (kiroTerminal) { kiroTerminal.show(); return; }
      startKiro();
    }),

    vscode.commands.registerCommand("kiro-pty.paste", () => {
      if (!kiroPty) {
        vscode.commands.executeCommand("workbench.action.terminal.paste");
        return;
      }
      const files = clipboardFilePaths();
      if (files.length > 0) { writeToKiro(files.join(" ")); return; }
      if (clipboardHasImage()) {
        const p = saveClipboardImage();
        if (p) { writeToKiro(p); return; }
      }
      vscode.env.clipboard.readText().then(text => { if (text) writeToKiro(text); });
    }),

    vscode.commands.registerCommand("kiro-pty.atFile", async () => {
      if (!kiroPty) return;
      const filePath = await showFilePicker();
      if (filePath) writeToKiro(filePath);
    }),

    vscode.commands.registerCommand("kiro-pty.sendSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !kiroPty) return;
      const text = editor.document.getText(editor.selection);
      if (!text) return;

      const filePath = editor.document.uri.fsPath;
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      writeToKiro(`${filePath}:${startLine}-${endLine}\n\`\`\`\n${text}\n\`\`\``);
      kiroTerminal?.show();
    }),
  );
}

export function deactivate() { kiroPty?.kill(); }
