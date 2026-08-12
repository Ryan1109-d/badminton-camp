/**
 * 台灣大學羽球冬令營 2027 — Google Apps Script 後端
 * （與足球營完全分開：請用新的 Google Sheet + 新的 Apps Script 部署）
 *
 * 部署步驟：
 * 1. Google Sheet 第一列欄位標題（共 20 欄，與下方 appendRow 順序一致）：
 *    報名時間 | 梯次 | 時段 | 學員姓名 | 性別 | 年齡 | 年級 | 收信信箱 | 緊急聯絡人 | 緊急聯絡人電話 | 繳款人姓名 | 繳款人電話 | 繳款人信箱 | 優惠身份 | 午餐 | 狀態 | 團報成員 | 衣服尺寸 | 備註 | 照片同意
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
  REPLY_EMAIL: 'stayyoung985@gmail.com',
  // 早鳥截止（含當日）。此日期前完成報名者，不限身份適用優惠價
  EARLY_BIRD_DEADLINE: '2026-11-30T23:59:59+08:00',
  // ⚠️ 收款資訊：以下為測試值。只要任何一項還是「（測試）」開頭，
  //    sendPaymentNotice() 會拒絕寄給家長，只寄預覽給自己。
  PAYMENT: {
    BANK: '（測試）台灣銀行 004',
    ACCOUNT_NAME: '（測試）戶名尚未設定',
    ACCOUNT_NO: '（測試）0000000000000',
    DEADLINE_DAYS: 5
  }
};
// 欄位索引（0-based，對應 Sheet 欄位順序）
const COL = {
  TIME: 0, SESSION: 1, SLOT: 2, STUDENT: 3, GENDER: 4, AGE: 5, GRADE: 6,
  EMAIL: 7, EMG_NAME: 8, EMG_PHONE: 9,
  PAYER_NAME: 10, PAYER_PHONE: 11, PAYER_EMAIL: 12,
  DISCOUNT: 13, LUNCH: 14, STATUS: 15, GROUP: 16, SHIRT: 17,
  NOTES: 18, PHOTO: 19
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
      data.shirtSize,
      data.notes || '—',
      data.photoConsent || '同意'
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
衣服尺寸：${data.shirtSize}${data.notes && data.notes !== '—' ? '\n備註：' + data.notes : ''}
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

// ══════════════════════════════════════════
// 繳費通知信
// NOTICE_COL：Sheet 第 21 欄（第一列標題請加「繳費通知」）
// ══════════════════════════════════════════
const NOTICE_COL = 21;

/** 收款資訊是否還是測試值 */
function paymentIsPlaceholder() {
  const p = CONFIG.PAYMENT;
  return [p.BANK, p.ACCOUNT_NAME, p.ACCOUNT_NO]
    .some(v => String(v).indexOf('（測試）') === 0);
}

/** 依報名時間、時段、優惠身份、午餐計算應繳金額 */
function calcAmount(row) {
  const regTime = row[COL.TIME];
  const early = (regTime instanceof Date) &&
                regTime <= new Date(CONFIG.EARLY_BIRD_DEADLINE);
  const d = String(row[COL.DISCOUNT] || '');
  const discounted = early || d === '團報' || d === '台大教職員';
  const fullDay = String(row[COL.SLOT] || '').indexOf('整天') >= 0;
  const base = fullDay ? (discounted ? 7000 : 7600)
                       : (discounted ? 3500 : 4000);
  const meal = String(row[COL.LUNCH] || '').indexOf('代訂') >= 0 ? 500 : 0;
  return { base: base, meal: meal, total: base + meal,
           slotLabel: fullDay ? '整天班' : '半天班',
           label: discounted ? (early ? '早鳥優惠價' : '優惠價') : '原價' };
}

/** 組繳費通知信內容 */
function buildPaymentBody(studentName, session, slot, amt) {
  const p = CONFIG.PAYMENT;
  const due = new Date();
  due.setDate(due.getDate() + p.DEADLINE_DAYS);
  const dueStr = Utilities.formatDate(due, 'Asia/Taipei', 'yyyy/MM/dd');
  return `您好：

${CONFIG.CAMP_NAME} 已達開班標準，確定開班！
以下是 ${studentName} 的繳費資訊，敬請於期限內完成轉帳。

── 費用明細 ──
梯次：${session}
時段：${slot}（${amt.slotLabel}）
營隊費用：NT$ ${amt.base}（${amt.label}）${amt.meal ? '\n代訂午餐：NT$ ' + amt.meal + '（五天）' : ''}
應繳總額：NT$ ${amt.total}

── 轉帳資訊 ──
銀行：${p.BANK}
戶名：${p.ACCOUNT_NAME}
帳號：${p.ACCOUNT_NO}
繳費期限：${dueStr}（收到通知後 ${p.DEADLINE_DAYS} 天內）

── 完成轉帳後 ──
請直接回覆本信，告知「轉帳帳號末五碼」與「轉帳日期」，
我們核帳後會回覆確認，即完成報名程序。

── 逾期提醒 ──
逾期未完成繳費者，名額將由候補學員遞補，敬請留意繳費期限。
如有特殊狀況需要協調，請於期限前回覆本信與我們聯繫。

Stay Young 台灣大學羽球冬令營
${CONFIG.REPLY_EMAIL}`;
}

/** 預覽：只寄一封範例信給自己，不讀 Sheet、不動任何資料 */
function previewPaymentNotice() {
  const amt = { base: 7000, meal: 500, total: 7500,
                slotLabel: '整天班', label: '早鳥優惠價' };
  const body = buildPaymentBody('王小華（範例）', '第一梯 2027/1/25–1/29',
                                '整天班（09:00–17:00）', amt);
  MailApp.sendEmail({
    to: CONFIG.REPLY_EMAIL,
    subject: `【預覽】${CONFIG.CAMP_NAME} 繳費通知信`,
    body: (paymentIsPlaceholder()
            ? '⚠️ 目前收款資訊仍是測試值，正式寄送會被擋下。\n\n───────────\n\n'
            : '✅ 收款資訊已設定，正式寄送不會被擋。\n\n───────────\n\n') + body,
    replyTo: CONFIG.REPLY_EMAIL,
    name: 'Stay Young 台灣大學羽球冬令營'
  });
  return '預覽信已寄至 ' + CONFIG.REPLY_EMAIL;
}

/** 正式寄送：挑出「正取」且尚未寄過繳費通知的人，寄信並回填時間 */
function sendPaymentNotice() {
  if (paymentIsPlaceholder()) {
    throw new Error('收款資訊仍是測試值，已中止。請先把 CONFIG.PAYMENT 換成真實資料，' +
                    '或改用 previewPaymentNotice() 預覽。');
  }
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
  const rows = sheet.getDataRange().getValues();
  let sent = 0, skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[COL.STATUS]).trim() !== '正取') { skipped++; continue; }
    if (String(r[NOTICE_COL - 1] || '').trim() !== '') { skipped++; continue; }
    const payerEmail = String(r[COL.PAYER_EMAIL] || '').trim();
    if (!payerEmail) { skipped++; continue; }
    const amt = calcAmount(r);
    const body = buildPaymentBody(r[COL.STUDENT], r[COL.SESSION], r[COL.SLOT], amt);
    const opts = {
      to: payerEmail,
      subject: `【${CONFIG.CAMP_NAME}】確定開班・繳費通知`,
      body: body,
      replyTo: CONFIG.REPLY_EMAIL,
      name: 'Stay Young 台灣大學羽球冬令營'
    };
    const notifyEmail = String(r[COL.EMAIL] || '').trim();
    if (notifyEmail && notifyEmail !== payerEmail) opts.cc = notifyEmail;
    MailApp.sendEmail(opts);
    sheet.getRange(i + 1, NOTICE_COL)
         .setValue(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm'));
    sent++;
  }
  return '已寄送 ' + sent + ' 封，略過 ' + skipped + ' 筆。';
}
