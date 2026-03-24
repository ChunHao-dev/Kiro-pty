import * as vscode from "vscode";
import * as ptyLib from "node-pty";
import { execSync } from "child_process";
import { existsSync, readdirSync, statSync, chmodSync } from "fs";
import * as path from "path";

const KIRO_CLI = "/Users/chchen/.local/bin/kiro-cli";
const MAX_VISIBLE = 8;

// Fix spawn-helper permissions on first load
try {
  const helper = path.join(__dirname, "../node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
} catch {}

// --- File index ---
let fileIndex: string[] = [];

function buildFileIndex() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  fileIndex = [];
  const skip = new Set(["node_modules", "out", "dist", ".git", ".next", "__pycache__", "build"]);
  function walk(dir: string, prefix: string) {
    if (fileIndex.length >= 2000) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || skip.has(name)) continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      try {
        if (statSync(full).isDirectory()) {
          fileIndex.push(rel + "/");
          walk(full, rel);
        } else {
          fileIndex.push(rel);
        }
      } catch {}
    }
  }
  walk(root, "");
}

function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function getOpenFiles(): Set<string> {
  const open = new Set<string>();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return open;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = (tab.input as any)?.uri as vscode.Uri | undefined;
      if (uri) {
        const rel = path.relative(root, uri.fsPath);
        if (!rel.startsWith("..")) open.add(rel);
      }
    }
  }
  return open;
}

function filterFiles(query: string): string[] {
  const candidates = query ? fileIndex.filter(f => fuzzyMatch(query, f)) : fileIndex;
  const open = getOpenFiles();
  const opened: string[] = [];
  const rest: string[] = [];
  for (const f of candidates) {
    (open.has(f) ? opened : rest).push(f);
  }
  return [...opened, ...rest].slice(0, 50);
}

// --- Per-terminal state ---
interface KiroSession {
  pty: ptyLib.IPty;
  terminal: vscode.Terminal;
  writeEmitter: vscode.EventEmitter<string>;
  acActive: boolean;
  acQuery: string;
  acResults: string[];
  acSelected: number;
  acScrollOffset: number;
  acLines: number;
  inputBuffer: string;
  termRows: number;
  termCols: number;
}

const sessions = new Map<vscode.Terminal, KiroSession>();
let sessionCounter = 0;

function activeSession(): KiroSession | undefined {
  const t = vscode.window.activeTerminal;
  return t ? sessions.get(t) : undefined;
}

// --- Clipboard helpers ---
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

function updateContext() {
  vscode.commands.executeCommand("setContext", "kiro-pty.active", sessions.size > 0);
}

// --- Autocomplete ---
function acRender(s: KiroSession) {
  s.acResults = filterFiles(s.acQuery);
  s.acSelected = Math.min(s.acSelected, Math.max(0, s.acResults.length - 1));
  if (s.acSelected < s.acScrollOffset) s.acScrollOffset = s.acSelected;
  if (s.acSelected >= s.acScrollOffset + MAX_VISIBLE) s.acScrollOffset = s.acSelected - MAX_VISIBLE + 1;

  const visible = s.acResults.slice(s.acScrollOffset, s.acScrollOffset + MAX_VISIBLE);

  let out = "";
  // On re-render, move cursor up to start of overlay and clear
  if (s.acLines > 0) {
    for (let i = 0; i < s.acLines; i++) out += "\x1b[A\x1b[2K";
  } else {
    // First render: newline to separate from prompt
    out += "\r\n";
  }

  out += `\x1b[38;5;244m  @${s.acQuery}\x1b[0m (↑↓ Enter Esc)\r\n`;

  if (visible.length === 0) {
    out += "\x1b[38;5;244m  (no matches)\x1b[0m\r\n";
  } else {
    if (s.acScrollOffset > 0) out += `\x1b[38;5;244m  ↑ ${s.acScrollOffset} more\x1b[0m\r\n`;
    for (let i = 0; i < visible.length; i++) {
      const gi = s.acScrollOffset + i;
      out += gi === s.acSelected
        ? `\x1b[46m\x1b[30m  ▸ ${visible[i]} \x1b[0m\r\n`
        : `\x1b[38;5;244m    ${visible[i]}\x1b[0m\r\n`;
    }
    const rem = s.acResults.length - s.acScrollOffset - visible.length;
    if (rem > 0) out += `\x1b[38;5;244m  ↓ ${rem} more\x1b[0m\r\n`;
  }

  // Count only the overlay lines (not the initial \r\n)
  let lines = 1 + (visible.length || 1); // search line + results
  if (s.acScrollOffset > 0) lines++;
  const rem = s.acResults.length - s.acScrollOffset - visible.length;
  if (rem > 0) lines++;
  s.acLines = lines;

  s.writeEmitter.fire(out);
}

function acEnter(s: KiroSession) {
  s.acActive = true;
  s.acQuery = "";
  s.acSelected = 0;
  s.acScrollOffset = 0;
  s.acLines = 0;
  s.writeEmitter.fire("\x1b[?25l"); // hide cursor
  acRender(s);
}

function acClear(s: KiroSession): Promise<void> {
  let out = "";
  for (let i = 0; i < s.acLines + 1; i++) out += "\x1b[A\x1b[2K";
  out += "\x1b[?25h";
  s.writeEmitter.fire(out);
  // Resize trick to force kiro-cli to redraw prompt
  const cols = s.termCols || 120;
  const rows = s.termRows || 30;
  s.pty.resize(cols, rows - 1);
  return new Promise(r => setTimeout(() => {
    s.pty.resize(cols, rows);
    // Wait for kiro-cli to finish redrawing after resize
    setTimeout(r, 100);
  }, 50));
}

async function acExit(s: KiroSession) {
  s.acActive = false;
  await acClear(s);
}

async function acConfirm(s: KiroSession) {
  const picked = s.acResults[s.acSelected];
  await acExit(s);
  if (picked) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const text = "@" + (root ? path.join(root, picked) : picked);
    s.pty.write(text);
    s.inputBuffer += text;
  }
}

async function acCancel(s: KiroSession) {
  const text = "@" + s.acQuery;
  await acExit(s);
  s.pty.write(text);
  s.inputBuffer += text;
}

function acHandleInput(s: KiroSession, data: string): boolean {
  if (!s.acActive) return false;
  if (data === "\r" || data === "\t") { acConfirm(s); return true; }
  if (data === "\x1b" || data === "\x03") { acCancel(s); return true; }
  if (data === "\x1b[A") { s.acSelected = Math.max(0, s.acSelected - 1); acRender(s); return true; }
  if (data === "\x1b[B") { s.acSelected = Math.min(Math.max(0, s.acResults.length - 1), s.acSelected + 1); acRender(s); return true; }
  if (data === "\x7f") {
    if (s.acQuery.length > 0) { s.acQuery = s.acQuery.slice(0, -1); s.acSelected = 0; s.acScrollOffset = 0; acRender(s); }
    else acCancel(s);
    return true;
  }
  if (data.length === 1 && data >= " ") { s.acQuery += data; s.acSelected = 0; s.acScrollOffset = 0; acRender(s); return true; }
  acCancel(s);
  return false;
}

// --- Terminal ---
function startKiro() {
  const we = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || "/";

  buildFileIndex();

  const env = { ...process.env } as { [key: string]: string };
  for (const k of Object.keys(env)) {
    if (k.startsWith("VSCODE_") || k === "PYTHONSTARTUP") delete env[k];
  }
  const venvDir = path.join(cwd, ".venv");
  if (existsSync(path.join(venvDir, "bin", "activate"))) {
    env.VIRTUAL_ENV = venvDir;
    env.PATH = path.join(venvDir, "bin") + ":" + (env.PATH || "");
  }

  const pty = ptyLib.spawn(KIRO_CLI, ["chat"], {
    name: "xterm-256color", cols: 120, rows: 30, cwd, env,
  });

  // Session will be set after terminal is created
  let session: KiroSession;

  pty.onData((data: string) => { we.fire(data); });

  pty.onExit(() => {
    closeEmitter.fire(0);
    sessions.delete(session.terminal);
    updateContext();
  });

  const pseudoTerminal: vscode.Pseudoterminal = {
    onDidWrite: we.event,
    onDidClose: closeEmitter.event,
    open(dim) {
      if (dim) { session.termRows = dim.rows; session.termCols = dim.columns; pty.resize(dim.columns, dim.rows); }
    },
    close() { pty.kill(); },
    handleInput(data: string) {
      if (data.includes("activate") && data.includes(".venv")) return;
      if (acHandleInput(session, data)) return;
      const prev = session.inputBuffer.length > 0 ? session.inputBuffer[session.inputBuffer.length - 1] : "";
      if (data === "@" && (prev === "" || prev === " ")) {
        acEnter(session);
        return;
      }
      pty.write(data);
      if (data === "\r") session.inputBuffer = "";
      else if (data === "\x7f") session.inputBuffer = session.inputBuffer.slice(0, -1);
      else session.inputBuffer += data;
    },
    setDimensions(dim) { session.termRows = dim.rows; session.termCols = dim.columns; pty.resize(dim.columns, dim.rows); },
  };

  sessionCounter++;
  const name = sessionCounter === 1 ? "Kiro Chat" : `Kiro Chat ${sessionCounter}`;
  const terminal = vscode.window.createTerminal({ name, pty: pseudoTerminal });

  session = {
    pty, terminal, writeEmitter: we,
    acActive: false, acQuery: "", acResults: [], acSelected: 0, acScrollOffset: 0, acLines: 0,
    inputBuffer: "", termRows: 30, termCols: 120,
  };
  sessions.set(terminal, session);
  terminal.show();
  updateContext();
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("kiro-pty.terminal-profile", {
      provideTerminalProfile: () => {
        startKiro();
        return undefined as any;
      },
    }),

    vscode.window.onDidCloseTerminal((t) => {
      const s = sessions.get(t);
      if (s) { s.pty.kill(); sessions.delete(t); updateContext(); }
    }),

    vscode.commands.registerCommand("kiro-pty.start", startKiro),

    vscode.commands.registerCommand("kiro-pty.paste", async () => {
      const s = activeSession();
      if (!s) { vscode.commands.executeCommand("workbench.action.terminal.paste"); return; }
      try {
        const info = execSync(`osascript -e 'clipboard info' 2>/dev/null`, { timeout: 500, encoding: "utf-8" }).trim();
        if (info.includes("«class furl»")) {
          const files = clipboardFilePaths();
          if (files.length > 0) { s.pty.write(files.join(" ")); return; }
        }
        if (info.includes("TIFF")) {
          const p = saveClipboardImage();
          if (p) { s.pty.write(p); return; }
        }
      } catch {}
      const text = await vscode.env.clipboard.readText();
      if (text) s.pty.write(text);
    }),

    vscode.commands.registerCommand("kiro-pty.atFile", async () => {
      const s = activeSession();
      if (!s) return;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const items: vscode.QuickPickItem[] = fileIndex.map(f => ({
        label: f.endsWith("/") ? `📁 ${f}` : f,
        description: path.join(root, f),
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select file to reference..." });
      if (picked) s.pty.write(picked.description!);
    }),

    vscode.commands.registerCommand("kiro-pty.sendSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText(editor.selection);
      if (!text) return;
      // Find any session to send to — prefer active, fallback to first
      const s = activeSession() || sessions.values().next().value;
      if (!s) return;
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      s.pty.write(`${filePath}:${startLine}-${endLine}`);
      s.terminal.show();
    }),
  );
}

export function deactivate() {
  for (const s of sessions.values()) s.pty.kill();
}
