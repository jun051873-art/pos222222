# 1005.1 — 只新增的雲端版本備份

新版程式不再更新或刪除既有 Token 文件，也不更新或刪除既有 Backups 文件。
每次保存以 UUID 建立獨立文件並要求 currentDocument.exists=false。
首次備份時另外建立原始文件的 legacy-original 保留副本並讀回比對；副本亦只允許建立。
成功狀態必須在讀回內容、版本與壓縮完整性核對後才能顯示。
清單使用伺服器 createTime 排序，完整分頁讀取；日期相同以名稱穩定排序。
筆數／原有識別碼／版本衝突保護仍保留；還原歷史版本關閉自動備份，不能直接取代新版。
Backups 無讀取或新增權限時停止操作，絕不回退到原始文件覆寫。
偵測到舊客戶端在新版本後更動原始文件時停止並要求核對。

## 後台上線條件（需讀取目前規則後再調整）
- 保留原有帳戶／店號／Token 的存取限制，不新增公開讀取或放寬驗證。
- 原始 Token 文件允許既有授權者讀取，禁止客戶端 update/delete。
- Backups 子集合：在同等授權範圍內允許 get/list/create，禁止 update/delete。
- 必須檢查重疊／遞迴 match 的 allow，單獨加一條 deny 無法取消另一條 allow。
- 不以正式資料測試寫入或刪除。規則先使用模擬器或測試專案驗證。

2026-10-15 已在 salonpos-system / (default) 發布 firestore.rules。
Firebase 規則測試區：原始 Token update 拒絕、Backups update/delete 拒絕、含 content 字串的 Backups create 獲准、Token 與 Backups get 獲准。全程僅模擬，未對正式資料寫入。
原規則為 /SalonPOS/{document=**} allow read, write: if true；新規則收緊 Token 及備份寫入，沒有新增公開權限。既有無登入驗證架構仍保留，這次防覆寫不等於完成身分驗證。管理員權限不受客戶端安全規則限制。
舊裝置須重新載入至 1005.1，舊版上傳將被拒絕。
版本會持續累積，不做自動清理。原有單文件大小上限仍適用每一個版本。
