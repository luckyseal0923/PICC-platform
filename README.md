# PICC-platform

院內 PICC 建案、預約施打與施打回報平台。新版以 Supabase 作為正式資料後端；本機提供獨立的假資料預覽，n8n 的 LINE 群組通知留待後續串接。

## 三個手機入口

| 網址路徑 | 內容 |
| --- | --- |
| `/picc-create/` | 填寫床號、病歷號、姓名與選填備註；支援自起單、自回報。 |
| `/picc-booking/` | 只列待預約案件，選擇施打人後預約；可取消施打。 |
| `/picc-report/` | 只列待施打案件，顯示接單者與等待時間；在同頁完成回報或取消。 |

**三個入口不需要個人登入或身分認證。** 開啟後直接操作，施打者由下拉名單選擇。操作歷程記為「內部共用入口（未驗證操作者）」；個人施打量依選定的實際施打者與完成日期計算。

取消會保留原單、原因與時間。需要再次施打時建立新單，連結原取消案件，原單不會重新開啟。統計使用臺灣時間；舊資料缺少完成日期時會保留「未記錄」，不以起單日期代替。

「預約」沿用原系統的成員接單流程，目前不含日期／時段排程。

## 本機開啟

需求：Python 3.11 以上、Node.js 20 以上。

首次準備：

```powershell
python -m pip install --target .vendor -r requirements.txt
npm ci
npm run build:client
```

在 **Windows 檔案總管**雙擊 `開啟新版網站.cmd`。在程式編輯器點該檔案只會顯示內容，不會執行。

- 預設開啟：[PICC 建案](http://127.0.0.1:8765/picc-create/)
- [預約施打](http://127.0.0.1:8765/picc-booking/)
- [施打回報](http://127.0.0.1:8765/picc-report/)
- [完整管理工作站](http://127.0.0.1:8765/workspace/)：管理與統計，保留管理者權限；本機可選示範管理者。

測試後執行 `停止新版網站.cmd`，假資料會保留。Python 預覽只綁定這台電腦的 `127.0.0.1`；手機無法直接使用這個本機網址。

其他作業系統可執行：

```sh
python app.py --demo --port 8765
```

## Supabase 前後端

- `client/`：手機入口控制器與 Supabase 轉接器。
- `static/`：前端原始畫面與預覽資產。
- `dist/`：建置後可部署的靜態前端。
- `supabase/migrations/202610140001_picc_v2.sql`：資料表、狀態轉換、稽核、統計、權限與共用入口 API。
- `app.py`：本機示範伺服器，使用獨立 SQLite 假資料庫；正式版直接串接 Supabase，不需要用 Python 取代 Supabase。

Supabase 共用入口使用 `public.picc_v2_entry_api`，僅提供名單、建案、待預約／待施打清單、預約、回報與取消。完整管理 API 使用 `public.picc_v2_api`，保留個別權限。兩者共用同一個資料庫交易引擎，避免重複計量與競爭接單。

### 正式串接步驟

1. 在 PICC-booking 專用資料庫套用 SQL migration。它使用獨立的 `picc_v2_private` schema，不修改舊 MySQL 或 n8n。
2. 於新版成員表建立施打者名單。這些施打者可以只有姓名，不需要 LINE 或 Supabase Auth 帳號。例如：

   ```sql
   insert into picc_v2_private.members(name, role)
   values ('施打者甲', 'operator');
   ```

3. 在 `static/config.js` 填入確認過的 Supabase API URL 與公開 anon／publishable key。**不要填 service-role／secret key。** 本版本的 key 保持空白。
4. 執行 `npm run build:client`，將 `dist/` 部署到院內受限的網站環境。各頁適用放在網域根目錄；本專案尚未設定 GitHub Pages 發布。
5. 在實際環境用假資料驗證建案 → 預約 → 回報、取消 → 重新建案、施打量與備份還原。

**免登入入口的存取範圍依賴網路限制。** 正式病人資料應置於院內網路或 VPN 的限制範圍，前端與 Supabase API 都必須受限；只有公開網址或把連結留在群組，不能限制外部存取。本次僅上傳程式碼，沒有套用遠端 SQL、部署網站、匯入病人資料或啟用 LINE 通知。

## 測試

```sh
npm run test:entries
node tests/adapter.test.mjs
npm run test:supabase
python -m unittest discover -s tests -p test_workflows.py -v
```

測試範圍：

- 三入口免個人登入、清單分流、CSRF 與管理功能邊界。
- 重送識別碼、過期版本、競爭接單、取消與重新建案。
- 實際施打者與臺灣完成日期統計、CSV 舊資料處理。
- 可拋棄假資料庫中的真實 HTTP 控制器流程。
- 本機 PGlite PostgreSQL 中的 SQL、資料權限及匿名共用入口。

本機測試不代表已完成遠端 Supabase、手機實機、正式備份或 LINE 通知驗收。瀏覽器畫面測試需另行完成。

## 資料與原系統

本專案只包含新版程式與明確標示的合成測試資料，不包含病人資料、n8n API key、本機資料庫、登入憑證或執行紀錄。舊版 GitHub 專案、n8n 流程及病人資料未被修改。
