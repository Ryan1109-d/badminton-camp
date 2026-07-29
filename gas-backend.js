/**
 * 台灣大學羽球冬令營 2027 — Google Apps Script 後端
 * （與足球營完全分開：請用新的 Google Sheet + 新的 Apps Script 部署）
 *
 * 部署步驟：
 * 1. Google Sheet 第一列欄位標題（共 18 欄，與下方 appendRow 順序一致）：
 *    報名時間 | 梯次 | 時段 | 學員姓名 | 性別 | 年齡 | 年級 | 收信信箱 | 緊急聯絡人 | 緊急聯絡人電話 | 繳款人姓名 | 繳款人電話 | 繳款人信箱 | 優惠身份 | 午餐 | 狀態 | 團報成員 | 衣服尺寸
 * 2. Sheet 上方選 擴充功能 → Apps Script，貼上本檔案全部內容
 * 3. 修改下方 CONFIG 的 SHEET_ID（網址中 /d/ 和 /edit 之間那串）
 * 4. 部署 → 新增部署作業 → 類型選「網頁應用程式」
 *    - 執行身分：我
 *    - 誰可以存取：所有人
 * 5. 複製 Web App URL，貼到 signup.html 的 GAS_URL
 *
 * 狀態欄位邏輯：
 * - 同梯次總報名數（三時段合計）第 1–50 位 → 狀態「正取」，寄報名確認信
 * - 第 51 位起 → 狀態「候補」，寄候補通知信
 */
const CONFIG = {
  SHEET_ID: 'YOUR_SHEET_ID_HERE',       // TODO: 換成實際 Sheet ID
  SHEET_NAME: '報名名單',                 // 分頁名稱
  CAPACITY: 50,                          // 正取上限（三時段合計）
  CAMP_NAME: '台灣大學羽球冬令營 2027',
  CAMP_DATE: '2027/1/25（一）– 1/29（五）',
  REPLY_EMAIL: 'stayyoung985@gmail.com'
};
// 欄位索引（0-based，對應 Sheet 欄位順序）
const COL = {
  TIME: 0, SESSION: 1, SLOT: 2, STUDENT: 3, GENDER: 4, AGE: 5, GRADE: 6,
  EMAIL: 7, EMG_NAME: 8, EMG_PHONE: 9,
  PAYER_NAME: 10, PAYER_PHONE: 11, PAYER_EMAIL: 12,
  DISCOUNT: 13, LUNCH: 14, STATUS: 15, GROUP: 16, SHIRT: 17
};
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    // ---- 基本驗證 ----
    const required = ['session', 'slot', 'studentName', 'gender', 'age', 'grade', 'email',
                      'emgName', 'emgPhone', 'payerName', 'payerPhone', 'payerEmail',
                      'discount', 'lunch', 'shirtSize'];
    for (const key of required) {
      if (!data[key] || String(data[key]).trim() === '') {
        return jsonResponse({ status: 'error', message: '缺少必填欄位：' + key });
      }
    }
    const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    // ---- 重複報名檢查（同收信信箱 + 同學員姓名 + 同梯次）----
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][COL.EMAIL] === data.email &&
          rows[i][COL.STUDENT] === data.studentName &&
          rows[i][COL.SESSION] === data.session) {
        return jsonResponse({ status: 'error', message: '此學員已使用相同信箱報名過' });
      }
    }
    // ---- 判斷正取或候補（以同梯次總人數計算，三時段合計）----
    let sessionCount = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][COL.SESSION] === data.session) sessionCount++;
    }
    const isWaitlist = sessionCount >= CONFIG.CAPACITY;
    const status = isWaitlist ? '候補' : '正取';
    // ---- 寫入 Sheet（順序 = 欄位標題順序）----
    sheet.appendRow([
      new Date(),
      data.session,
      data.slot,
      data.studentName,
      data.gender,
      data.age,
      data.grade,
      data.email,
      data.emgName,
      data.emgPhone,
      data.payerName,
      data.payerPhone,
      data.payerEmail,
      data.discount,
      data.lunch,
      status,
      data.groupMembers || '—',
      data.shirtSize
    ]);
    // ---- 寄信 ----
    if (isWaitlist) {
      sendWaitlistEmail(data);
    } else {
      sendConfirmEmail(data);
    }
    return jsonResponse({ status: 'ok', waitlist: isWaitlist });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}
/** 報名確認信（正取） */
function sendConfirmEmail(data) {
  const subject = `【${CONFIG.CAMP_NAME}】報名確認信`;
  const body =
`您好：
已收到 ${data.studentName} 的報名資料，報名登記完成！
── 報名資訊 ──
營隊：${CONFIG.CAMP_NAME}
梯次：${data.session}
時段：${data.slot}
學員：${data.studentName}（${data.grade}，${data.gender}，${data.age} 歲）
緊急聯絡人：${data.emgName}（${data.emgPhone}）
優惠身份：${data.discount}
午餐：${data.lunch}
衣服尺寸：${data.shirtSize}
── 接下來的流程 ──
1. 報名人數達開班標準並確認開班後，我們會寄送「繳費通知」至繳款人信箱
2. 依通知的帳號完成轉帳繳費後即確認錄取
3. 開課前會再寄送行前通知信
開班確認前不會收取任何費用，請安心等候通知。
若有任何問題，歡迎直接回覆本信。
Stay Young 台灣大學羽球冬令營
${CONFIG.REPLY_EMAIL}`;
  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    body: body,
    replyTo: CONFIG.REPLY_EMAIL,
    name: 'Stay Young 台灣大學羽球冬令營'
  });
}
/** 候補通知信（額滿後） */
function sendWaitlistEmail(data) {
  const subject = `【${CONFIG.CAMP_NAME}】候補登記通知`;
  const body =
`您好：
感謝您為 ${data.studentName} 報名 ${CONFIG.CAMP_NAME}（${data.session}／${data.slot}）。
目前正取名額已滿，您的報名已列入「候補名單」。
若有名額釋出，我們將立即以 email 通知您，屆時再依信中說明完成報名程序即可。
候補期間不會收取任何費用。
若有任何問題，歡迎直接回覆本信。
Stay Young 台灣大學羽球冬令營
${CONFIG.REPLY_EMAIL}`;
  MailApp.sendEmail({
    to: data.email,
    subject: subject,
    body: body,
    replyTo: CONFIG.REPLY_EMAIL,
    name: 'Stay Young 台灣大學羽球冬令營'
  });
}
/** 統一 JSON 回應 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
/**
 * doGet 保留給之後的後台（?admin）使用
 * 細節等後台設計討論時再實作
 */
function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'API alive' });
}
