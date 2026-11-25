# Air Jam（空中即興）

## 這個專案在做什麼

給大家玩的手勢音樂遊戲：讓**不會演奏樂器的人**，也能跟著自己喜歡的歌享受即興演出的快樂。用筆電鏡頭追蹤雙手（MediaPipe），在空中演奏「空中樂器」。遊戲會先分析歌曲的拍點和和弦，再把玩家彈的音吸附到目前和弦上（Feel Sync 式），所以怎麼彈都和諧。

- **第一個樂器是「空中弦」**：雙手捏住拉出一條會留在空中的弦，弦的長度決定音高，用食指撥弦。之後會加入其他樂器（空中鼓、空中琴、空中特雷門琴、空中貝斯）。
- **定位：**先做成給一般玩家的完整遊戲，品質以真正玩家的體驗為準：手感、音色、穩定度。之後會從這個專案拆出簡化版本當教學材料，也歡迎學生一起貢獻，但**現在不要為了教學降低設計或程式品質**，也不用寫給初學者看的註解。

## 文件

- `docs/設計說明.md`：**主要規格**。第 0 節是架構，第 1～14 節是第一版（空中弦），第 15～16 節是之後的音色、模式和樂器。功能有變動時要同步更新這份文件。
- `docs/背景研究與討論.md`：Casio CT-FS1／Feel Sync 的研究（含來源）、空中弦影片的靈感、電吉他音效合成、吉他曲風發想、命名決定。
- `docs/交接.md`：**開始工作前先讀。**現在在哪裡、下一步、等擁有者決定的事、資料狀況。
- `docs/決定紀錄.md`：做過的決定（D-001…）、理由和沒選的選項。
- `docs/獨奏模式_設計挑戰.md`：Fable 對獨奏模式「捏弦」草案（設計說明 15.2.1）的挑戰，建議改用遊戲擺好的獨奏弦。**還沒有決定。**
- `docs/搖滾獨奏_設計挑戰.md`：Fable 對「配搖滾範例的獨奏與和弦玩法」提案的挑戰，含對 `samples/` 的量測。第 0 階段（拍子）已實作，**其餘還沒有決定。**
- `docs/效果器研究.md`：經典效果器的原理、瀏覽器裡怎麼做、授權和商標（Opus 上網研究）。
- `docs/效果器_設計挑戰.md`：Fable 對效果器計畫的挑戰與分階段計畫；第 0～2 階段（音色實驗室、丁＋過載破音、效果器板介面）已實作。

## 收尾對照表（stage-wrap 用）

收尾技能在 `.claude/skills/stage-wrap/`，只放在擁有者的電腦上，不提交。說「階段收尾」或輸入 `/stage-wrap` 觸發。

| 用途 | 位置 |
|---|---|
| 交接（整份覆寫） | `docs/交接.md` |
| 工作日誌（新的在上面，只增加；**不公開**，已被 `.gitignore` 排除，可以記擁有者原話） | `docs/工作日誌.md` |
| 決定紀錄（只增加；公開，不貼原話） | `docs/決定紀錄.md` |
| 研究、分析數字、試過沒用的做法 | `docs/背景研究與討論.md` |
| 規格 | `docs/設計說明.md` |
| 挑戰／提案文件 | `docs/*_設計挑戰.md`（開頭要有狀態） |
| 給玩家看的 | `README.md` |

- 測試：`node tests/analysis.test.mjs`、`node tests/instrument.test.mjs`、`node tests/tone-lab.test.mjs`、`node tests/pedalboard.test.mjs`、`node tests/electric-rig.test.mjs`、`node tests/menu.test.mjs`、`node tests/wah.test.mjs`、`node tests/post-fx.test.mjs`、`node tests/chorus.test.mjs`、`node tests/delay.test.mjs`、`node tests/reverb.test.mjs`；本機另有 `node tests/samples.test.mjs`；音色量測 `node tools/tone-lab/measure.mjs`（`--set wah` 量娃娃音，`--set sustain` 量延音）
- 不可提交：`samples/`（只記檔名、大小、用途和分析出來的數字）、`docs/工作日誌.md`、`.claude/skills/`
- 敏感字樣：在技能資料夾的 `敏感字樣.txt`（不提交）
- 推送：公開 repo，每次都先問擁有者
- 冷讀測試：只在擁有者要求時做

## 已確定的設定（要改先問使用者）

> 這一節的技術限制目前是**沿用，擁有者還沒有逐條確認**（[D-004](docs/決定紀錄.md)），預定之後討論；在那之前照著做，但不要當成不能改的定案。

- **純前端**，不加後端；音樂檔和鏡頭畫面只在玩家的瀏覽器裡處理，**不上傳**。
- 原生 ES module，**沒有建置步驟**，執行時不依賴 npm 套件。已經發布在 GitHub Pages（https://rogabdp.github.io/air-jam/），見下方「Git」。
- 手部追蹤：`@mediapipe/tasks-vision@0.10.14`，從 jsDelivr CDN 載入（HandLandmarker、VIDEO 模式）。
- 聲音：只用 Web Audio API（不用 Tone.js）。撥弦用 Karplus-Strong。
- 架構：共用模組（聽歌分析、手勢、和弦吸附、節奏判定與計分、特效）和樂器模組分開；音色和效果鏈也和樂器分開。新樂器要能直接接上共用模組。
- 畫面左右翻轉成鏡像，**手的座標要用同一套翻轉**。
- 介面文字先用繁體中文，集中管理，之後方便加英文。
- 主要支援 Chrome／Edge 桌機，但不要寫死只能在 Chrome 跑的寫法。
- 一定要有**滑鼠模式**（開始畫面的「操作方式」、`M` 鍵或 `?mouse=1`），沒有鏡頭也能玩，也拿來做自動測試。
- **玩家要用的功能都要有畫面上的按鈕**（擁有者 2026-11-25：不要用網址切換）。按鍵只當快捷鍵、寫在按鈕上；網址參數只給開發者，玩家不需要。按鈕改的設定要記在 `localStorage`（`src/app/prefs.js`）。

## 命名與標註

- 遊戲名 **Air Jam**（資料夾和網址用 `air-jam`），中文「空中即興」。樂器名例如「空中弦」。
- **不要**把「Pikasso／畢卡索」或「Feel Sync」當成產品、模式、功能或樂器的名稱（分別屬於 Pat Metheny 的吉他和 Casio），例如不能有「Feel Sync 模式」「畢卡索弦」。
- 但是**標註靈感來源時一定要寫出這些名字**：公開的地方（README、開始畫面最下面的 credits、之後的關於頁面）要標註手勢弦樂器影片的作者、Pat Metheny 的畢卡索吉他、Casio CT-FS1 的 Feel Sync，並說明 Air Jam 與他們沒有關係。介面上稱呼這個功能時用「和弦吸附」。
- 「Air Jam」可能和其他作品同名；這是非營利的遊戲，擁有者決定不處理撞名（2026-11-25）。
- 和弦是程式猜的，要在介面或說明裡誠實告訴玩家。

## 怎麼執行

- **最簡單（Windows）：**雙擊 `開始玩.bat`（需要 Python）。它呼叫 `tools/start.ps1`，在 127.0.0.1 開伺服器（預設 8020，被佔用就往上找），強制 `.js`／`.mjs` 用 `text/javascript`、`.wasm` 用 `application/wasm`，再打開預設瀏覽器；加 `-NoBrowser` 不開瀏覽器。這兩個檔案由使用者維護，不要改。
- 開發和自動測試：在專案根目錄執行 `python -m http.server 8010`（ES module 不能直接雙擊 `index.html`），再打開 http://localhost:8010 。玩家用的設定都在畫面上：開始畫面的「操作方式」（鏡頭／滑鼠）和「音色實驗室」，準備／演奏時右上角「設定」面板（音色、音高、效果器、拍子、手的骨架、根音保護…），選了會記在 `localStorage`（`airJam.prefs.v1`）。開發用的網址參數（只在這一次有效、不會寫回去）：`?mouse=1`、`?tone=steel|nylon|electric|labA～labD`（電吉他＝實驗室的丁＋效果器；實驗室音色只能這樣開）、`?keyguard=off`、`?pedals=0|1`、`?lab=1`（可加 `&song=samples/sample%2021.mp3` 直接載入本機範例）。自動測試若要乾淨的狀態，先清掉 `localStorage` 的 `airJam.prefs.v1` 和 `airJam.pedalboard.v1`。效果器板預設顯示；六顆效果器都已接上聲音（設計說明 15.1.3、15.1.4、15.1.7～15.1.9）；之後如果有還沒有聲音的效果器，在 `src/core/pedals/availability.js` 標成不能用（設計說明 15.1.2）。娃娃音的直條在不刷弦的那隻手那邊（預設左邊；設定面板的「慣用手」選左手換到右邊，記在 `airJam.prefs.v1`）；滑鼠模式下游標不在旋鈕上時，滾輪控制娃娃音的踏板。調整畫面的第三顆大旋鈕「延音」（進階模式在「音箱」裡）讓和弦響久一點，預設 0＝原本的聲音（設計說明 15.1.5）。
- 鏡頭模式需要網路（從 jsDelivr 和 Google 下載 MediaPipe），而且必須是 localhost 或 https 才能開鏡頭。
- 在 console 裡可以用 `airJam` 看目前的狀態（`state`、`song.analysis`、`instrument.strings`、`scorer.state`…）。

## 檔案結構

```
index.html, style.css      畫面骨架與樣式（影片用 CSS 鏡像，canvas 不翻轉）
開始玩.bat, tools/start.ps1 Windows 一鍵啟動（使用者維護）
src/
  main.js                  進入點，掛上 window.airJam
  settings.js              所有可調整的數值（SETTINGS）
  i18n/                    介面文字（zh-Hant），t() 與 data-i18n
  app/app.js               遊戲外殼：畫面流程、載入與分析、主迴圈、按鍵、共用服務接線
  app/hud.js               DOM：畫面切換、HUD、結束畫面
  app/menu.js              畫面上的按鈕：開始畫面的操作方式／實驗室、設定面板（齒輪），顯示目前狀態、接到 app 的動作
  app/prefs.js             記住玩家用按鈕選的設定（localStorage），和開發用網址參數合併（純函式）
  app/hand-buttons.js      鏡頭模式用「捏一下」按畫面按鈕；手在按鈕上時不給效果器板和樂器（純函式）
  core/analysis/           dsp.js（FFT、降取樣、STFT）、analysis.js（拍點、和弦、調性；純函式）
  core/song/               demo-song.js（示範曲與答案比對）、backing-synth.js（純 JS 伴奏合成）
  core/music/              theory.js（音名、和弦、顏色）、pitch-snap.js（和弦吸附）、power-chords.js（強力和弦、調內根音保護）
  core/game/               song-map.js（時間 → 和弦／拍點）、scoring.js（判定、連擊、計分）
  core/audio/              engine.js（播放、聲部、發聲上限、換和弦收音、壓縮器、輸出上限）、karplus.js（含每條弦的延音器）、tones.js（音色＋效果鏈）、distortion.js（削波曲線、收音時間）、
                           stages.js（效果鏈寫成資料：建 Web Audio 節點／Node 模擬／小訊號響應；兩份交叉淡化的可切換鏈）、voice-params.js（撥弦參數）、tone-lab.js（實驗室音色甲乙丙丁）、electric-rig.js（電吉他＝丁＋娃娃音、過載、破音：旋鈕對應、預設組的值、自動配平、發聲規則）、wah.js（娃娃音：旋鈕對應、音量補償、手控／跟刷弦／跟拍子的位置控制）
  core/audio/post-fx/      後段效果匯流排（每個聲部一條，在兩軌加起來之後）：index.js（固定順序合聲→延遲→空間、接線、Node 模型、模組的接口；設計說明 15.1.6）、chorus.js（合聲：LFO 推兩條短延遲；設計說明 15.1.7）、delay.js（延遲：跟脈動的回音、換和弦收舊回音、兩條迴圈換時間不變調；設計說明 15.1.8）、reverb.js（空間：程式產生的 IR、四種大小各一個卷積器、關掉時尾巴自然收；設計說明 15.1.9）
  core/hands/              tracker.js（鏡頭、MediaPipe、鏡像座標）、gestures.js、mouse.js、draw.js
  core/fx/effects.js       粒子、浮動文字、拍點閃光
  core/pedals/             效果器板（預設顯示）：model.js（資料、預設組、存檔）、gestures.js（捏一下／拖旋鈕）、layout.js、draw.js、pedalboard.js（誰收到手）、audio-binding.js（聲音接口：交給引擎的 applyPedals）、availability.js（哪幾顆能用，其他變暗「即將推出」）、wheel.js（滑鼠模式的滾輪→娃娃音踏板）
  instruments/             instrument.js（介面與登錄表）、air-strings/（空中弦、穿越判定）
  lab/                     音色實驗室（開始畫面或設定面板的按鈕，或 ?lab=1）：lab.js（畫面與排程）、performances.js（固定刷法）、metrics.js（量測定義）、offline-render.js（OfflineAudioContext）
tools/tone-lab/            model.mjs（引擎的 Node 模型）、measure.mjs（預設組或甲乙丙丁的量測表）、calibrate-level.mjs（重量自動配平的表）
tests/
  analysis.test.mjs        合成歌曲 → 分析 → 和答案比對（BPM、每拍和弦、拍點誤差、第一拍）
  realistic-song.mjs       比較像真實錄音的測試樂團（七和弦、轉位、人聲、搖擺、變速、鼓前奏）
  samples.test.mjs         本機才跑：真實歌曲的拍子是否落在脈動上（讀 samples/*.wav，沒有就跳過）
  pedalboard.test.mjs      效果器板：資料、捏一下／捏住／拖的分辨、旋鈕放開時的值、防連按、腳踏區裡不能拉弦或撥弦
  menu.test.mjs            記住的設定和網址參數的合併（含慣用手）、還沒有聲音的效果器不能開關、用手按按鈕（捏一下、防連按、手在按鈕上不會撥弦或拉弦）
  post-fx.test.mjs         後段效果匯流排：順序、直通完全一樣、設定傳得到而且不重建、速度／換和弦／刷弦通知
  chorus.test.mjs          合聲：旋鈕對應、LFO 延遲範圍和音高偏移上限、平滑、關著時完全一樣、開關不爆音、左右寬度、濕聲的高低通、引擎接線、示範曲的峰值（AIRJAM_SAMPLES 指到 samples 資料夾時再用 s14、s21）
  delay.test.mjs           延遲：脈動的倍數落在 280～450 ms（速度減半加倍不變）、換和弦 ≥ 20 dB、回授穩定、改時間不變調、關著完全直通、尾巴、峰值（有 AIRJAM_SAMPLES 或 samples/ 就加測範例歌）
  reverb.test.mjs          空間：IR 可重現、每種大小的殘響時間、衰減單調、越來越暗、左右不相關、沒有直流、旋鈕對應、不重建、換大小不跳、關掉有尾巴、配歌峰值（有 samples/ 或 AIRJAM_SAMPLES 就用真實歌曲）
  wah.test.mjs             娃娃音：頻率和 Q 的對應、平滑的上限、跟刷弦的包絡、跟拍子在改速度時對齊、音量補償、引擎接線、滑鼠滾輪
  instrument.test.mjs      撥弦合成、手勢、穿越判定、吸附、強力和弦、調內保護、破音曲線、換和弦收音、計分、空中弦邏輯（22 項）
  tone-lab.test.mjs        硬削波曲線、雙二階濾波器、效果鏈模擬、甲的鏈沒變、撥弦參數、實驗室音色、刷法、Node 模型
  electric-rig.test.mjs    電吉他效果器：旋鈕對應、預設組（搖滾＝丁）、自動配平、切換平滑、發聲規則、分段撥弦、引擎（假的 AudioContext）、延音
  fake-audio-context.mjs   測試用：在 Node 裡跑引擎的假 AudioContext
docs/                      交接、決定紀錄、設計說明、背景研究、設計挑戰（工作日誌只在本機）
```

## 怎麼測試

```bash
node tests/analysis.test.mjs      # 約 7 秒；加 --verbose 印出每小節的答案與猜測
node tests/instrument.test.mjs
node tests/tone-lab.test.mjs
node tests/pedalboard.test.mjs
node tests/electric-rig.test.mjs
node tests/menu.test.mjs
node tests/wah.test.mjs
node tests/post-fx.test.mjs
node tests/chorus.test.mjs        # 合聲（設計說明 15.1.7）
node tests/delay.test.mjs         # 延遲（設計說明 15.1.8）
node tests/reverb.test.mjs        # 空間（設計說明 15.1.9）
node tools/tone-lab/measure.mjs   # 四個預設組和破音範圍兩端的量測表（--set lab：甲乙丙丁；--set wah：娃娃音；--set sustain：延音；有 samples/s14.wav、s21.wav 就用，沒有用示範曲）
node tests/samples.test.mjs       # 只在本機：真實歌曲的拍子（讀 samples/s14.wav、s21.wav，沒有就跳過）
```

- `samples.test.mjs` 不解碼 MP3，要先用 ffmpeg 轉成 WAV（轉出來的檔案也在 `samples/` 裡，一樣不能提交）：
  `ffmpeg -i "samples/sample 14.mp3" -ac 2 -ar 44100 samples/s14.wav`（s21 同理）。它檢查一拍是整數個脈動（s21 約 571 ms，s14 375 或 750 ms）、≥ 90% 的拍點落在獨立擬合的脈動格線 ±40 ms 內，並印出 BPM、調性、小節長度和和弦段落。

（需要 Node 18 以上，不用安裝套件；`npm test` 跑 analysis、instrument、tone-lab、pedalboard、electric-rig、menu、wah、post-fx、chorus、delay、reverb 十一組，samples 要另外跑。）

- 歌曲分析（拍點、和弦、調性）要寫成純函式（輸入 `Float32Array` 和 sampleRate），用 `tests/` 裡的 Node 腳本測試。合成的 C–G–Am–F、100 BPM 示範曲應該要分析出正確的結果。改了分析程式就要重跑，並回報數字。
- 瀏覽器測試用滑鼠模式加內建示範曲：console 沒有錯誤、分析能完成、能拉弦和撥弦、和弦顯示會更新、計分和結束畫面正常。用畫面上的按鈕切換（開始畫面選「滑鼠」、設定面板），不靠網址參數。
- **鏡頭手勢無法自動測試**，要請使用者本人實際試，回報時要說清楚哪些項目沒有驗證。
- **真實歌曲範例：**`samples/` 放擁有者提供的範例音樂（目前是兩首搖滾演奏曲：`sample 14.mp3` A 小調、`sample 21.mp3` A 藍調搖滾；速度見下方「已知限制」和 [背景研究](docs/背景研究與討論.md) 第 7 節）。它們有版權，已經用 `.gitignore` 排除，**不可以提交或推送**，也不要複製到其他會被提交的位置。改分析程式或設計獨奏、和弦玩法時，要用這些真實歌曲驗證，不能只靠合成的測試歌。

## 分工：哪個模型做什麼

- **Fable：**只負責推理、規劃、設計挑戰、審查與批評（例如檢查設計說明的漏洞、提出架構方案、評估測試結果）。**不要**交給 Fable 寫程式。
- **Opus：**負責執行，包括寫程式、修改程式、跑測試、commit。
- 常見流程：Fable 規劃或挑戰設計 → Opus 照計畫實作 → 必要時 Fable 審查成果。


## 和擁有者溝通

- 需要擁有者確認或決定的事，用**選擇題**問（AskUserQuestion），附上建議的選項，盡量一次問完。
- 解釋技術狀況時用白話，少用術語。
- 推送、刪除、改寫歷史一律先問。
- **玩家會用到的功能一定要有畫面上的按鈕**（滑鼠和手都能按），不能只靠網址參數或快捷鍵；網址參數只當開發者選項（[D-018](docs/決定紀錄.md)）。

## 同時派多個 agent

- 擁有者希望能平行就平行。兩個以上會寫程式的 agent 同時做時，每個用自己的 git worktree 和分支（例如 `../air-jam-<主題>`），最後由主對話合併、重跑全部測試、在瀏覽器確認後再刪掉 worktree。
- 交代時寫清楚哪些共用檔案（`src/app/app.js`、`style.css`、`src/i18n/`、`README.md`、`CLAUDE.md`、`package.json`）要少改，方便合併。
- 停止測試用的伺服器時**用 PID 結束**，不要用指令內容比對（曾經比對到自己的 shell 把自己結束掉）。

## Git

- 遠端：https://github.com/ROGabdp/air-jam （公開 repo），作者用 `ROGabdp <ROGabdp@users.noreply.github.com>`（已設在 repo 的 git config）。推送前要先問擁有者。
- commit 訊息用英文，結尾加上 attribution 行。
- **GitHub Pages 直接從 `main` 分支的根目錄發布（沒有建置流程）：推送到 `main` 就等於更新給所有玩家。**推送前要確認遊戲能正常執行、測試都通過。

## 已知限制

- **和弦分析：**簡單的三和弦伴奏幾乎全對；七和弦＋轉位約 44%，人聲很大聲時只有 16%（數字和原因見設計說明第 6.3 節）。只有 24 個大小三和弦、整首一個調性。
- **速度：**先找脈動、再決定一拍是 1／2／4（或 3）個脈動，所以拍點一定落在脈動上（設計說明 6.2）。兩首範例：s21 104.9 BPM（舊版 140，錯）、s14 160 BPM（舊版 107；160 或 80 還要擁有者用耳朵確認）。慢的歌（約 70～80 BPM，有鼓的搖滾也會，例如合成測試的 80 BPM 搖滾被判成 160）常常猜成兩倍速度；拍點對得上，但每小節的第一拍會錯。假設 4/4 拍（三拍子分組當 12/8）。玩家可以手動修正（設定面板的「拍子」按鈕，或 `[` `]` `;` `'` `,` `.` `0`，`K` 節拍器）。
- **和弦（s21）：**拍子修好後，s21 的和弦段落邊界全部落在小節線或半小節上，而且每 12 小節重複同樣的位置；但標籤仍然亂（A、F#m、Am、G、Em、D 混著），因為整首貝斯都在 A、節奏吉他是 A5–A6–A7 的 boogie 音型，加上鼓的雜訊。這是和弦辨識的問題，不是格線的問題。電吉他音色的調內根音保護也改不了它：這些根音都在 A 大調允許的級數裡（設計說明 15.1.1）。
- **還沒驗證：**用鏡頭操作效果器板（腳踏區在畫面最下方，追蹤最不穩）和畫面按鈕；Safari 和 Firefox。（2026-11-25 擁有者用鏡頭實測捏、撥、刷、握拳刪除，10 次都成功、畫面順暢；用滑鼠玩過兩首範例 MP3 和效果器，覺得效果不錯。）
- 歌曲上限 15 分鐘（`maxSongMinutes`）。分析在主執行緒分段執行，5 分鐘的歌約 2 秒。
- 只有滑鼠和鏡頭輸入，沒有觸控；手機還不支援。
- **效果器：**六顆效果器都有聲音；合聲、延遲、空間沒有人聽過。空間在空閒之前就轉到「教堂」會卡一次約 30～50 ms（設計說明 15.1.9）；延遲換和弦收舊回音時，新和弦的回音少了開頭約 30 ms（設計說明 15.1.8）；進階模式的效果鏈順序還沒影響聲音；增益很大時新的一刷要 50～60 ms 才收乾淨（設計說明 15.1.3）。電吉他的新聲音（丁、四個預設組、粗糙削波、娃娃音）還沒有人實際聽過。娃娃音的音量補償在預設範圍內 ±1.1 dB，「範圍」轉到兩端時最多差 2.7 dB；跟拍子的掃動在畫面每格更新一次，分頁在背景時會停住；用鏡頭在直條上控制還沒試過（設計說明 15.1.4）。滑鼠滾輪控制娃娃音只用合成的滾輪事件試過，真的滑鼠和觸控板的手感還沒試。延音（設計說明 15.1.5）沒有人聽過；開到最大時，有破音的新一刷要多幾 ms 才收乾淨（50 ms 時仍 ≥ 40 dB），清音配歌時長和弦會大聲 5～7 dB，每刷 8 條弦在 Chrome 多花約 0.3～0.5 ms。

## 目前狀態

開始工作前先讀 [docs/交接.md](docs/交接.md)（現在在哪裡、下一步、等擁有者決定的事、資料狀況）。做過的決定和理由在 [docs/決定紀錄.md](docs/決定紀錄.md)。進度和歷史不寫在這裡。
