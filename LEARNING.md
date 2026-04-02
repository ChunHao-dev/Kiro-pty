# kiro-pty 學習文件

## 這是什麼

kiro-wrapper 的進化版。用 `node-pty` 建立真正的 pseudoterminal，完全控制 kiro-cli 的輸入輸出。
解決了 kiro-wrapper 無法攔截單一按鍵的根本限制。

## 架構總覽

```
┌──────────────────────────────────────────────────────────────────┐
│  Kiro IDE                                                        │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  VS Code Pseudoterminal (我們完全控制)                       │ │
│  │                                                             │ │
│  │  使用者鍵盤輸入                                              │ │
│  │       │                                                     │ │
│  │       ▼                                                     │ │
│  │  handleInput(data)                                          │ │
│  │       │                                                     │ │
│  │       ├─ "source .venv/bin/activate" → 丟掉 (攔截注入)      │ │
│  │       ├─ "@" (行首/空格後) → 進入 autocomplete 模式          │ │
│  │       ├─ autocomplete 模式中 → acHandleInput() 處理         │ │
│  │       └─ 其他 → kiroPty.write(data) 送給 kiro-cli           │ │
│  │                                                             │ │
│  │  ┌──────────────┐        ┌──────────────────────────┐       │ │
│  │  │ node-pty     │        │  kiro-cli (native binary)│       │ │
│  │  │              │ stdin  │                          │       │ │
│  │  │ kiroPty      │───────▶│  chat mode               │       │ │
│  │  │ .write()     │        │                          │       │ │
│  │  │              │ stdout │                          │       │ │
│  │  │ .onData()    │◀───────│  ANSI output             │       │ │
│  │  └──────────────┘        └──────────────────────────┘       │ │
│  │       │                                                     │ │
│  │       ▼                                                     │ │
│  │  writeEmitter.fire(data) → terminal 畫面顯示                │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## kiro-wrapper vs kiro-pty 對比

```
┌──────────────────┬──────────────────────┬──────────────────────┐
│                  │  kiro-wrapper        │  kiro-pty            │
├──────────────────┼──────────────────────┼──────────────────────┤
│ Terminal 類型    │ 真正的 shell         │ Pseudoterminal       │
│                  │ (VS Code 管理)       │ (我們完全控制)       │
├──────────────────┼──────────────────────┼──────────────────────┤
│ 輸入控制        │ 只能攔截快捷鍵       │ 每個按鍵都經過       │
│                  │                      │ handleInput          │
├──────────────────┼──────────────────────┼──────────────────────┤
│ 送文字給 kiro   │ terminal.sendText()  │ kiroPty.write()      │
├──────────────────┼──────────────────────┼──────────────────────┤
│ @ 檔案選擇      │ QuickPick popup      │ Alternate screen     │
│                  │ (Cmd+Shift+A)        │ inline TUI           │
├──────────────────┼──────────────────────┼──────────────────────┤
│ 攔截 @ 按鍵     │ ❌ 不可能            │ ✅ handleInput       │
├──────────────────┼──────────────────────┼──────────────────────┤
│ 讀 terminal 內容│ ❌ 不可能            │ ✅ 我們控制輸出      │
├──────────────────┼──────────────────────┼──────────────────────┤
│ 額外依賴        │ 無                   │ node-pty (~15MB)     │
├──────────────────┼──────────────────────┼──────────────────────┤
│ 複雜度          │ 低                   │ 高                   │
└──────────────────┴──────────────────────┴──────────────────────┘
```

## 核心概念

### 1. Pseudoterminal — 假裝自己是 terminal

VS Code 的 `Pseudoterminal` 介面讓 extension 假裝自己是一個 terminal：

```
VS Code 認為：
  "這是一個 terminal，使用者打字我就呼叫 handleInput，
   它 fire writeEmitter 我就顯示在畫面上"

實際上：
  handleInput → 我們的程式碼 → 決定要不要送給 kiro-cli
  kiro-cli 輸出 → 我們的程式碼 → 決定要不要顯示
```

關鍵介面：

```typescript
{
  onDidWrite: Event<string>    // 我們 → VS Code（顯示在畫面）
  onDidClose: Event<number>    // 通知 VS Code terminal 結束
  open(dim)                    // VS Code 告訴我們 terminal 大小
  close()                      // 使用者關閉 terminal
  handleInput(data: string)    // 使用者按鍵 → 我們處理
  setDimensions(dim)           // terminal 大小改變
}
```

### 2. node-pty — 真正的 PTY

`node-pty` 建立一個真正的 pseudoterminal device（`/dev/ptmx`），然後 fork+exec kiro-cli。
kiro-cli 以為自己連接到一個真正的 terminal，所以它的 TUI（顏色、游標移動等）都能正常運作。

```
資料流：

使用者鍵盤 → handleInput() → kiroPty.write() → PTY master fd
                                                      │
                                                      ▼
                                                 PTY slave fd
                                                      │
                                                      ▼
                                                 kiro-cli stdin
                                                      │
                                                 kiro-cli 處理
                                                      │
                                                      ▼
                                                 kiro-cli stdout
                                                      │
                                                      ▼
                                                 PTY slave fd
                                                      │
                                                      ▼
                                                 PTY master fd
                                                      │
                                              kiroPty.onData()
                                                      │
                                                      ▼
                                              writeEmitter.fire()
                                                      │
                                                      ▼
                                              VS Code 畫面顯示
```

### 3. Inline Overlay — @ 檔案選擇器（v0.0.2）

早期版本用 alternate screen buffer，但切回來 kiro-cli 不會重繪（見問題 2）。
v0.0.2 改用 inline overlay — 直接在 main screen 的 prompt 下方畫選單：

```
正常模式                    @ 模式（inline overlay）
┌────────────────────┐     ┌────────────────────────┐
│ kiro-cli 的輸出    │     │ kiro-cli 的輸出        │
│ ...                │     │ ...                    │
│ > 使用者輸入_      │ ──▶ │ > 使用者輸入           │
│                    │     │   @ext (↑↓ Enter Esc)  │
│                    │     │   ▸ src/extension.ts   │
└────────────────────┘     │     package.json       │
                           │   ↓ 5 more             │
                           └────────────────────────┘
                                    │
                           Enter 或 Esc
                                    │
                                    ▼
                           ┌────────────────────────┐
                           │ kiro-cli 的輸出        │
                           │ ...（resize trick 重繪）│
                           │ > @/full/path/to/      │
                           │   extension.ts_        │
                           └────────────────────────┘
```

**渲染機制**：
- 首次渲染：`\r\n` 換行，然後畫選單
- 重繪：用 `\x1b[A`（cursor up）× `acLines` 行 + `\x1b[2K`（clear line）回到起點再重畫
- 退出：同樣方式清掉 overlay，然後 resize trick 讓 kiro-cli 重繪 prompt

**vs Alternate screen**：
- Alternate screen：乾淨，但切回來別人的 TUI 不重繪
- Inline overlay：要自己管行數，但不切 buffer，kiro-cli 的 main screen 不受影響

### 3.5. Open File 優先排序

`filterFiles()` 會把目前在 VS Code 中開啟的檔案排到前面：

```typescript
const open = getOpenFiles(); // 從 tabGroups 取得開啟的檔案
for (const f of candidates) {
  (open.has(f) ? opened : rest).push(f);
}
return [...opened, ...rest].slice(0, 50);
```

`getOpenFiles()` 透過 `vscode.window.tabGroups.all` 取得所有開啟的 tab，轉成相對路徑。
這讓 `@` 選擇器的行為更像 IDE — 你正在看的檔案最容易找到。

### 3.6. Smart Paste — clipboard info 先探測再行動

v0.0.2 改善了 `Cmd+V` 的邏輯。原本是依序嘗試（先試 file、再試 image、最後 text），
但這樣如果 clipboard 裡是純文字，`clipboardFilePaths()` 和 `clipboardHasImage()` 會白跑。

改成先用 `osascript -e 'clipboard info'` 探測 clipboard 內容類型：

```typescript
const info = execSync(`osascript -e 'clipboard info'`, { timeout: 500, encoding: "utf-8" });
if (info.includes("«class furl»")) { /* Finder 檔案 */ }
if (info.includes("TIFF"))         { /* 圖片 */ }
// 都不是 → 純文字
```

**clipboard info 回傳格式**：
```
«class furl», 120        ← Finder 複製的檔案
«class TIFF», 845000     ← 截圖或圖片
«class ut16», 48         ← Unicode 文字
```

**學到的**：macOS 的 clipboard 可以同時包含多種格式。`clipboard info` 是最快的探測方式，不用真的讀出內容。

### 3.7. Terminal Profile — 在 terminal dropdown 出現

v0.0.2 註冊了 `TerminalProfileProvider`，讓 Kiro PTY 出現在 VS Code 的 terminal 下拉選單：

```typescript
vscode.window.registerTerminalProfileProvider("kiro-pty.terminal-profile", {
  provideTerminalProfile: () => { startKiro(); return undefined as any; },
});
```

**學到的**：`provideTerminalProfile` 應該回傳 `TerminalProfile`，但我們的 terminal 是自己建的（`createTerminal({ pty })`），不是標準 shell。回傳 `undefined as any` 是 hack — VS Code 不會再建一個 terminal，而我們已經在 `startKiro()` 裡建好了。

### 4. @ 觸發的智慧判斷

不是每個 `@` 都要觸發檔案選擇器。只有在「看起來像要引用檔案」的位置才觸發：

```
觸發條件：inputBuffer 的最後一個字元是 "" 或 " "

✅ 觸發：
  > @              ← 行首（inputBuffer = ""）
  > 請看 @         ← 空格後（inputBuffer 尾端 = " "）

❌ 不觸發：
  > email@         ← 字母後（inputBuffer 尾端 = "l"）
  > user@domain    ← 正常打 email
```

**v0.0.2 改動**：從 `lastCharSent`（只記一個字元）改成 `inputBuffer`（記整行）。
`inputBuffer` 在 Enter 時清空，Backspace 時刪尾，其他字元追加。
好處是更準確 — 之前 `\r` 也算觸發條件，但其實 Enter 後 kiro-cli 會處理指令，不該觸發。

### 5. Autocomplete 狀態機

```
                    ┌──────────┐
                    │  Normal  │
                    │  Mode    │
                    └────┬─────┘
                         │ @ (行首/空格後)
                         ▼
                    ┌──────────┐
              ┌────▶│   AC     │◀────┐
              │     │  Active  │     │
              │     └──┬───┬───┘     │
              │        │   │         │
         打字/刪除     │   │     ↑↓ 選擇
         → 更新搜尋    │   │     → 重新渲染
         ←→ 忽略       │   │
                       │   │
                 Enter │   │ Esc
                       ▼   ▼
              ┌────────┐   ┌────────┐
              │Confirm │   │Cancel  │
              │送 @+   │   │送 @+   │
              │完整路徑│   │query   │
              └───┬────┘   └───┬────┘
                  │            │
                  ▼            ▼
              回到 Normal Mode
```

狀態變數：
- `acActive` — 是否在 autocomplete 模式
- `acQuery` — 目前搜尋字串
- `acResults` — 過濾後的檔案列表
- `acSelected` — 目前選中的 index
- `acScrollOffset` — 捲動偏移（viewport 只顯示 8 個）
- `acLines` — 目前 overlay 佔了幾行（用來重繪時清除）
- `inputBuffer` — 目前這一行使用者打了什麼（用來判斷 @ 觸發）
- `termRows` / `termCols` — terminal 尺寸（用來截斷長路徑）

### 6. 環境變數處理 — venv 與 VS Code 注入

```
process.env（繼承自 VS Code）
    │
    ▼
┌─────────────────────────────────────┐
│ 清理：刪除 VSCODE_* 和 PYTHONSTARTUP│
│ → 防止 VS Code 的東西干擾 kiro-cli  │
├─────────────────────────────────────┤
│ 注入：如果 cwd/.venv 存在           │
│ → VIRTUAL_ENV = cwd/.venv           │
│ → PATH = cwd/.venv/bin:$PATH        │
│ → kiro-cli 子程序能用 venv 工具     │
└─────────────────────────────────────┘
    │
    ▼
ptyLib.spawn(kiro-cli, ["chat"], { env })
```

另外在 `handleInput` 裡攔截 Python extension 的 `source .venv/bin/activate` 注入：

```
handleInput("source /path/.venv/bin/activate\r")
    │
    ├─ 包含 "activate" 且包含 ".venv"？
    │   → Yes → return（丟掉，不送給 kiro-cli）
    │
    └─ No → 正常處理
```

## 碰到的問題與解法

### 問題 0: 檔案索引建立方式 — 手寫 walk vs ripgrep

**原始做法**：手寫 `walk()` 遞迴掃目錄，硬編碼 skip list（`node_modules`, `.git`, `dist` 等），上限 2000 個檔案。

**問題**：
- Skip list 不完整 — 每個專案有不同的忽略規則
- 不尊重 `.gitignore` — 會掃到 build artifacts、generated files
- 2000 上限太低 — 中型專案就超過了
- 效能差 — Node.js 的 `readdirSync` + `statSync` 每個檔案兩次 syscall

**v0.0.2 改動**：改用 `rg --files`（ripgrep）：

```typescript
const result = execSync("/opt/homebrew/bin/rg --files", {
  cwd: root, timeout: 3000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024
}).trim();
fileIndex = result ? result.split("\n") : [];
```

**好處**：
- 自動尊重 `.gitignore`、`.ignore`、`.rgignore` — 不用自己維護 skip list
- 速度快很多 — ripgrep 是 Rust 寫的，平行掃描
- `maxBuffer: 10MB` 大概能裝 10-20 萬個檔案路徑
- `timeout: 3000ms` 防止超大 repo 卡住
- 失敗時 graceful fallback — `fileIndex = []` + 顯示安裝提示

**Trade-off**：多了一個外部依賴（ripgrep）。但 macOS 開發者幾乎都有裝。

**學到的**：不要自己寫 file walker — 用現成的工具（rg、fd、find）幾乎總是更好。它們處理了 symlink loop、permission error、gitignore parsing 等你不想自己處理的邊界情況。

### 問題 0.5: filterFiles 大量檔案效能

**症狀**：超大 repo（5 萬+ 追蹤檔案）下，每次按鍵 fuzzy match 整個 `fileIndex` 可能有延遲。

**原始做法**：`fileIndex.filter(f => fuzzyMatch(query, f))` 掃完全部，再 `slice(0, 50)`。

**改動**：提早中斷 — 找到 200 個 match 就停：

```typescript
for (const f of fileIndex) {
  if (query && !fuzzyMatch(query, f)) continue;
  (open.has(f) ? opened : rest).push(f);
  if (opened.length + rest.length >= 200) break;
}
return [...opened, ...rest].slice(0, 50);
```

**為什麼 200 不是 50**：因為 open files 要排前面。如果只找 50 個就停，可能漏掉排在後面的 open files。200 給了足夠的 buffer。

**學到的**：使用者只看得到 50 個結果，沒必要掃完 5 萬個檔案。提早中斷是最簡單的效能優化。

### 問題 0.6: 長路徑在 autocomplete 選單中換行

**症狀**：深層目錄的檔案路徑超過 terminal 寬度，導致選單行換行、排版壞掉。

**解法**：根據 `termCols` 截斷，保留尾端（檔名比目錄重要）：

```typescript
const maxW = (s.termCols || 120) - 6; // 6 = "  ▸ " prefix + margin
const label = visible[i].length > maxW
  ? "…" + visible[i].slice(-(maxW - 1))
  : visible[i];
```

**學到的**：TUI 元件一定要考慮 terminal 寬度。`termCols` 在 `open()` 和 `setDimensions()` 時更新，隨時可用。

### 問題 0.7: 左右方向鍵在 autocomplete 中造成亂象

**症狀**：在 `@` 選擇器中按左右鍵，ANSI escape sequence 被當成搜尋字元，選單壞掉。

**解法**：直接吃掉左右鍵：

```typescript
if (data === "\x1b[C" || data === "\x1b[D") return true;
```

**學到的**：TUI 的 input handler 要明確處理所有可能的按鍵，不能只處理「想要的」然後讓其他的 fall through。

### 問題 1: node-pty spawn-helper 沒有執行權限

**症狀**：`ptyLib.spawn()` 噴 `posix_spawnp` 錯誤。

**原因**：`node-pty` 的 prebuild binary 裡有個 `spawn-helper` 輔助程式，npm install 後在 macOS 上沒有 `+x` 權限。

**解法**：extension 載入時直接 `chmodSync`：

```typescript
const helper = path.join(__dirname,
  "../node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
if (existsSync(helper)) chmodSync(helper, 0o755);
```

**學到的**：npm 不保證 prebuild binary 的檔案權限。如果用到有 native binary 的套件，要自己確認權限。

### 問題 2: Alternate screen 切換後 kiro-cli 畫面壞掉

**症狀**：從 `@` 選擇器回到 main screen 後，kiro-cli 的 TUI 沒有重繪，畫面殘留。

**原因**：kiro-cli 不知道我們切了 alternate screen，它不會主動重繪。

**嘗試過的方法**：
1. ❌ 送 `SIGWINCH` 給 kiro-cli → 沒反應
2. ❌ resize 再 resize 回來 → 有時有效有時沒效
3. ❌ 用 alternate screen（`\x1b[?1049h/l`）→ 切回來 kiro-cli 不重繪
4. ✅ Inline overlay + resize trick

**最終解法（v0.0.2）**：完全不用 alternate screen。改用 inline overlay：
- 進入 autocomplete 時，直接在 prompt 下方畫選單（`\r\n` + 內容）
- 重繪時，用 `\x1b[A`（cursor up）+ `\x1b[2K`（clear line）回到 overlay 起點再重畫
- 退出時，用同樣方式清掉 overlay 行，然後用 resize trick 讓 kiro-cli 重繪 prompt：

```typescript
// 縮小 1 行再恢復，觸發 kiro-cli 的 SIGWINCH 重繪
s.pty.resize(cols, rows - 1);
setTimeout(() => s.pty.resize(cols, rows), 50);
```

**學到的**：
- Alternate screen 對「我們控制的 TUI」很好用，但如果底下跑的是別人的 TUI（kiro-cli），切回來它不會重繪。
- Inline overlay 更適合這種場景 — 不切 screen buffer，只在 main screen 上畫東西再清掉。
- `acLines` 追蹤 overlay 佔了幾行，清除時才知道要往上移幾行。
- Resize trick 是讓 kiro-cli 重繪的唯一可靠方法（它會收到 `SIGWINCH`）。

### 問題 3: VS Code Python extension 注入 source activate

**症狀**：在有 `.venv` 的 workspace 開 kiro-pty，`source .venv/bin/activate` 被當成文字送進 kiro-cli。

**原因**：Python extension 偵測到 `.venv`，呼叫 `terminal.sendText("source .venv/bin/activate")`。對真正的 shell terminal 這沒問題，但我們的 pseudoterminal 把它送進了 `handleInput`，然後轉給 kiro-cli。

**解法**：兩層防護：
1. `handleInput` 裡攔截包含 `activate` + `.venv` 的輸入
2. spawn 時主動設好 `VIRTUAL_ENV` + `PATH`，不需要真的跑 `source activate`

**學到的**：VS Code 的 pseudoterminal 會收到其他 extension 透過 `terminal.sendText()` 送來的東西。如果你的 pseudoterminal 不是 shell，要小心處理這些意外輸入。

### 問題 4: @ 在 email 地址裡也觸發

**症狀**：打 `user@domain` 時 `@` 觸發了檔案選擇器。

**解法**：追蹤 `inputBuffer`，只在行首或空格後才觸發。

```
inputBuffer 追蹤邏輯：
- 送出 "\r"（Enter）→ 清空 inputBuffer
- 送出 "\x7f"（Backspace）→ 刪掉最後一個字元
- 送出普通字元 → 追加到 inputBuffer
- @ 觸發條件：inputBuffer 尾端 ∈ {"", " "}
```

**v0.0.2 改動**：從 `lastCharSent`（只記一個字元）改成 `inputBuffer`（記整行）。
這樣 Backspace 也能正確追蹤 — 刪掉空格後再打 `@` 不會誤觸發。

### 問題 5: Esc 取消後使用者打的字消失了

**症狀**：使用者打 `@ext` 然後按 Esc，`@ext` 消失了。

**解法**：`acCancel()` 把 `"@" + acQuery` 送回 kiro-cli，並追加到 `inputBuffer`，保留使用者已經打的內容。
同樣 `acConfirm()` 也會把 `"@" + fullPath` 追加到 `inputBuffer`，這樣後續的 `@` 觸發判斷才正確。

### 問題 6: Extension 打包 15MB 太大

**原因**：`node-pty` 的 prebuilds 包含所有平台（linux-x64、win32-x64、darwin-x64、darwin-arm64...）。

**可用解法**：`.vsixignore` 排除不需要的平台：

```
node_modules/node-pty/prebuilds/linux-*
node_modules/node-pty/prebuilds/win32-*
node_modules/node-pty/prebuilds/darwin-x64
```

（目前還沒做，但可以把 15MB 降到 ~3MB）

## 關鍵 API 速查

| API | 用途 |
|-----|------|
| `vscode.window.createTerminal({ pty })` | 建立 pseudoterminal |
| `writeEmitter.fire(data)` | 輸出到 terminal 畫面 |
| `kiroPty.write(data)` | 送資料到 kiro-cli stdin |
| `kiroPty.onData(cb)` | 接收 kiro-cli stdout |
| `kiroPty.resize(cols, rows)` | 調整 PTY 大小 |
| `setContext(key, value)` | 設定 when clause 條件 |
| `execSync("swift -e '...'")` | 呼叫 macOS 原生 API |

## 開發與部署流程

```
編輯 src/extension.ts
        │
        ▼
npx tsc                          ← 編譯 TypeScript
        │
        ▼
npx vsce package                 ← 打包成 .vsix
  --allow-missing-repository
        │
        ▼
kiro --install-extension         ← 安裝到 Kiro IDE
  kiro-pty-0.0.2.vsix --force
        │
        ▼
Reload Window                    ← 重新載入 IDE 生效
```
