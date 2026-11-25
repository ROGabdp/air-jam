# Air Jam（空中即興）

## 這個專案在做什麼

給大家玩的手勢音樂遊戲：讓**不會演奏樂器的人**，也能跟著自己喜歡的歌享受即興演出的快樂。用筆電鏡頭追蹤雙手（MediaPipe），在空中演奏「空中樂器」。遊戲會先分析歌曲的拍點和和弦，再把玩家彈的音吸附到目前和弦上（Feel Sync 式），所以怎麼彈都和諧。

- **第一個樂器是「空中弦」**：雙手捏住拉出一條會留在空中的弦，弦的長度決定音高，用食指撥弦。之後會加入其他樂器（空中鼓、空中琴、空中特雷門琴、空中貝斯）。
- **定位：**先做成給一般玩家的完整遊戲，品質以真正玩家的體驗為準：手感、音色、穩定度。之後會從這個專案拆出簡化版本當教學材料，也歡迎學生一起貢獻，但**現在不要為了教學降低設計或程式品質**，也不用寫給初學者看的註解。

## 文件

- `docs/設計說明.md`：**主要規格**。第 0 節是架構，第 1～14 節是第一版（空中弦），第 15～16 節是之後的音色、模式和樂器。功能有變動時要同步更新這份文件。
- `docs/背景研究與討論.md`：Casio CT-FS1／Feel Sync 的研究（含來源）、空中弦影片的靈感、電吉他音效合成、吉他曲風發想、命名決定。

## 已確定的設定（要改先問使用者）

- **純前端**，不加後端；音樂檔和鏡頭畫面只在玩家的瀏覽器裡處理，**不上傳**。
- 原生 ES module，**沒有建置步驟**，執行時不依賴 npm 套件。之後會發布到靜態網站（例如 GitHub Pages）。
- 手部追蹤：`@mediapipe/tasks-vision@0.10.14`，從 jsDelivr CDN 載入（HandLandmarker、VIDEO 模式）。
- 聲音：只用 Web Audio API（不用 Tone.js）。撥弦用 Karplus-Strong。
- 架構：共用模組（聽歌分析、手勢、和弦吸附、節奏判定與計分、特效）和樂器模組分開；音色和效果鏈也和樂器分開。新樂器要能直接接上共用模組。
- 畫面左右翻轉成鏡像，**手的座標要用同一套翻轉**。
- 介面文字先用繁體中文，集中管理，之後方便加英文。
- 主要支援 Chrome／Edge 桌機，但不要寫死只能在 Chrome 跑的寫法。
- 一定要有**滑鼠模式**（`M` 鍵或 `?mouse=1`），沒有鏡頭也能玩，也拿來做自動測試。

## 命名與標註

- 遊戲名 **Air Jam**（資料夾和網址用 `air-jam`），中文「空中即興」。樂器名例如「空中弦」。
- **不要**把「Pikasso／畢卡索」或「Feel Sync」當成產品、模式、功能或樂器的名稱（分別屬於 Pat Metheny 的吉他和 Casio），例如不能有「Feel Sync 模式」「畢卡索弦」。
- 但是**標註靈感來源時一定要寫出這些名字**：公開的地方（README、開始畫面最下面的 credits、之後的關於頁面）要標註手勢弦樂器影片的作者、Pat Metheny 的畢卡索吉他、Casio CT-FS1 的 Feel Sync，並說明 Air Jam 與他們沒有關係。介面上稱呼這個功能時用「和弦吸附」。
- 「Air Jam」可能和其他作品同名；這是非營利的遊戲，擁有者決定不處理撞名（2026-11-25）。
- 和弦是程式猜的，要在介面或說明裡誠實告訴玩家。

## 怎麼執行

- **最簡單（Windows）：**雙擊 `開始玩.bat`（需要 Python）。它呼叫 `tools/start.ps1`，在 127.0.0.1 開伺服器（預設 8020，被佔用就往上找），強制 `.js`／`.mjs` 用 `text/javascript`、`.wasm` 用 `application/wasm`，再打開預設瀏覽器；加 `-NoBrowser` 不開瀏覽器。這兩個檔案由使用者維護，不要改。
- 開發和自動測試：在專案根目錄執行 `python -m http.server 8010`（ES module 不能直接雙擊 `index.html`），再打開 http://localhost:8010 。沒有鏡頭時加 `?mouse=1`，`?tone=nylon` 可以指定音色。
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
  core/analysis/           dsp.js（FFT、降取樣、STFT）、analysis.js（拍點、和弦、調性；純函式）
  core/song/               demo-song.js（示範曲與答案比對）、backing-synth.js（純 JS 伴奏合成）
  core/music/              theory.js（音名、和弦、顏色）、pitch-snap.js（和弦吸附）
  core/game/               song-map.js（時間 → 和弦／拍點）、scoring.js（判定、連擊、計分）
  core/audio/              engine.js（播放、發聲上限、壓縮器）、karplus.js、tones.js（音色＋效果鏈）
  core/hands/              tracker.js（鏡頭、MediaPipe、鏡像座標）、gestures.js、mouse.js、draw.js
  core/fx/effects.js       粒子、浮動文字、拍點閃光
  instruments/             instrument.js（介面與登錄表）、air-strings/（空中弦、穿越判定）
tests/
  analysis.test.mjs        合成歌曲 → 分析 → 和答案比對（BPM、每拍和弦、拍點誤差、第一拍）
  realistic-song.mjs       比較像真實錄音的測試樂團（七和弦、轉位、人聲、搖擺、變速、鼓前奏）
  instrument.test.mjs      撥弦合成、手勢、穿越判定、吸附、計分、空中弦邏輯（18 項）
docs/                      設計說明、背景研究
```

## 怎麼測試

```bash
node tests/analysis.test.mjs      # 約 5 秒；加 --verbose 印出每小節的答案與猜測
node tests/instrument.test.mjs
```

（需要 Node 18 以上，不用安裝套件；`npm test` 會兩個都跑。）

- 歌曲分析（拍點、和弦、調性）要寫成純函式（輸入 `Float32Array` 和 sampleRate），用 `tests/` 裡的 Node 腳本測試。合成的 C–G–Am–F、100 BPM 示範曲應該要分析出正確的結果。改了分析程式就要重跑，並回報數字。
- 瀏覽器測試用滑鼠模式加內建示範曲：console 沒有錯誤、分析能完成、能拉弦和撥弦、和弦顯示會更新、計分和結束畫面正常。
- **鏡頭手勢無法自動測試**，要請使用者本人實際試，回報時要說清楚哪些項目沒有驗證。

## 分工：哪個模型做什麼

- **Fable：**只負責推理、規劃、設計挑戰、審查與批評（例如檢查設計說明的漏洞、提出架構方案、評估測試結果）。**不要**交給 Fable 寫程式。
- **Opus：**負責執行，包括寫程式、修改程式、跑測試、commit。
- 常見流程：Fable 規劃或挑戰設計 → Opus 照計畫實作 → 必要時 Fable 審查成果。

## Git

- 遠端：https://github.com/ROGabdp/air-jam （公開 repo），作者用 `ROGabdp <ROGabdp@users.noreply.github.com>`（已設在 repo 的 git config）。推送前要先問擁有者。
- commit 訊息用英文，結尾加上 attribution 行。

## 已知限制

- **和弦分析：**簡單的三和弦伴奏幾乎全對；七和弦＋轉位約 44%，人聲很大聲時只有 16%（數字和原因見設計說明第 6.3 節）。只有 24 個大小三和弦、整首一個調性。
- **速度：**沒有鼓的慢歌（約 70 BPM）會猜成兩倍速度；拍點仍然對得上，但每小節的第一拍會錯。假設 4/4 拍。
- **還沒驗證：**鏡頭手勢（捏、撥、握拳）的實際手感、聲音實際聽起來如何、真的 MP3／M4A 歌曲、Safari 和 Firefox。這些都要使用者本人測。
- 歌曲上限 15 分鐘（`maxSongMinutes`）。分析在主執行緒分段執行，5 分鐘的歌約 2 秒。
- 只有滑鼠和鏡頭輸入，沒有觸控；手機還不支援。

## 目前狀態

- 2026-11-25：建立專案和設計說明。
- 2026-11-25：第一版完成（空中弦＋共用模組，設計說明第 0～14 節）。實作時加的部分（暖身階段、純 JS 示範曲、連擊規則、延遲補償、按鍵、古典吉他音色等）已經寫回設計說明。審查後修正了：選檔案時聲音沒解鎖可能卡住、切到滑鼠模式後鏡頭還開著、超長檔案、視窗縮放後誤撥；分析加了泛音抑制和更接近真實音樂的測試歌。
- 下一步：請使用者實際用鏡頭玩、用自己的歌測，依回饋調整手勢門檻、音色和分析。
