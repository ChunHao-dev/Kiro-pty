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

### 3. Alternate Screen Buffer — @ 檔案選擇器

Terminal 有兩個 screen buffer：
- Main screen：正常的 terminal 內容
- Alternate screen：全螢幕應用（vim、less、htop）用的

我們的 `@` 檔案選擇器利用 alternate screen，這樣不會破壞 kiro-cli 的畫面：

```
正常模式                    @ 模式（alternate screen）
┌────────────────────┐     ┌────────────────────────┐
│ kiro-cli 的輸出    │     │  @ File Reference      │
│ ...                │     │  Search: ext            │
│ ...                │ ──▶ │                         │
│ ...                │     │  ▸ src/extension.ts     │
│ > 使用者輸入_      │     │    package.json         │
└────────────────────┘     │    tsconfig.json        │
                           │                         │
                           │  ↓ 47 more              │
                           └────────────────────────┘
                                    │
                           Enter 或 Esc
                                    │
                                    ▼
                           ┌────────────────────┐
                           │ kiro-cli 的輸出    │
                           │ ...（完全不變）     │
                           │ > /full/path/to/   │
                           │   extension.ts_    │
                           └────────────────────┘
```

切換用 ANSI escape codes：
- `\x1b[?1049h` — 進入 alternate screen
- `\x1b[?1049l` — 離開 alternate screen（main screen 自動恢復）
- `\x1b[?25l` / `\x1b[?25h` — 隱藏/顯示游標

### 4. @ 觸發的智慧判斷

不是每個 `@` 都要觸發檔案選擇器。只有在「看起來像要引用檔案」的位置才觸發：

```
觸發條件：lastCharSent 是 "" 或 " " 或 "\r"

✅ 觸發：
  > @              ← 行首（lastCharSent = ""）
  > 請看 @         ← 空格後（lastCharSent = " "）
  > 第一行\r@      ← 換行後（lastCharSent = "\r"）

❌ 不觸發：
  > email@         ← 字母後（lastCharSent = "l"）
  > user@domain    ← 正常打 email
```

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
                       │   │
                 Enter │   │ Esc
                       ▼   ▼
              ┌────────┐   ┌────────┐
              │Confirm │   │Cancel  │
              │送完整  │   │送 @+   │
              │路徑    │   │query   │
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
3. ✅ 不在 autocomplete 期間送任何東西給 kiro-cli

**最終解法**：autocomplete 模式完全在 extension 端處理，不碰 kiro-cli 的 stdin/stdout。只在確認或取消時才送結果給 kiro-cli。kiro-cli 的 main screen 從頭到尾沒被動過，切回來自然完好。

### 問題 3: VS Code Python extension 注入 source activate

**症狀**：在有 `.venv` 的 workspace 開 kiro-pty，`source .venv/bin/activate` 被當成文字送進 kiro-cli。

**原因**：Python extension 偵測到 `.venv`，呼叫 `terminal.sendText("source .venv/bin/activate")`。對真正的 shell terminal 這沒問題，但我們的 pseudoterminal 把它送進了 `handleInput`，然後轉給 kiro-cli。

**解法**：兩層防護：
1. `handleInput` 裡攔截包含 `activate` + `.venv` 的輸入
2. spawn 時主動設好 `VIRTUAL_ENV` + `PATH`，不需要真的跑 `source activate`

**學到的**：VS Code 的 pseudoterminal 會收到其他 extension 透過 `terminal.sendText()` 送來的東西。如果你的 pseudoterminal 不是 shell，要小心處理這些意外輸入。

### 問題 4: @ 在 email 地址裡也觸發

**症狀**：打 `user@domain` 時 `@` 觸發了檔案選擇器。

**解法**：追蹤 `lastCharSent`，只在行首、空格後、換行後才觸發。

```
lastCharSent 追蹤邏輯：
- 送出 "\r"（Enter）→ 重設為 ""
- 送出普通字元 → 記錄該字元
- @ 觸發條件：lastCharSent ∈ {"", " ", "\r"}
```

### 問題 5: Esc 取消後使用者打的字消失了

**症狀**：使用者打 `@ext` 然後按 Esc，`@ext` 消失了。

**解法**：`acCancel()` 把 `"@" + acQuery` 送回 kiro-cli，保留使用者已經打的內容。

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
  kiro-pty-0.0.1.vsix --force
        │
        ▼
Reload Window                    ← 重新載入 IDE 生效
```
