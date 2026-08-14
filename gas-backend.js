/**
 * 台灣大學羽球冬令營 2027 — Google Apps Script 後端
 * （與足球營完全分開：請用新的 Google Sheet + 新的 Apps Script 部署）
 *
 * 部署步驟：
 * 1. Google Sheet 第一列欄位標題（共 26 欄，與下方 appendRow 順序一致）：
 *    報名時間 | 梯次 | 時段 | 學員姓名 | 性別 | 年齡 | 年級 | 收信信箱 | 緊急聯絡人 | 緊急聯絡人電話 | 繳款人姓名 | 繳款人電話 | 繳款人信箱 | 優惠身份 | 午餐 | 狀態 | 團報成員 | 衣服尺寸 | 備註 | 照片同意 | 健康狀況 | 健康說明 | 緊急醫療授權 | 法定代理人聲明 | 繳費通知 | 系統訊息
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
  SHEET_ID: 'YOUR_SHEET_ID_HERE',       // TODO: 換成實際 Sheet ID（只在 Apps Script 填，不要 commit）
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
    DEADLINE_DAYS: 7
  }
};
// 欄位索引（0-based，對應 Sheet 欄位順序）
const COL = {
  TIME: 0, SESSION: 1, SLOT: 2, STUDENT: 3, GENDER: 4, AGE: 5, GRADE: 6,
  EMAIL: 7, EMG_NAME: 8, EMG_PHONE: 9,
  PAYER_NAME: 10, PAYER_PHONE: 11, PAYER_EMAIL: 12,
  DISCOUNT: 13, LUNCH: 14, STATUS: 15, GROUP: 16, SHIRT: 17,
  NOTES: 18, PHOTO: 19,
  HEALTH: 20, HEALTH_DETAIL: 21, MEDICAL: 22, GUARDIAN: 23
};
const NOTICE_COL = 25;   // 繳費通知（1-based）
const SYSMSG_COL = 26;   // 系統訊息（1-based）

/** 給 Sheet 儲存格用：前置單引號讓 Sheets 視為純文字，防公式注入 */
function safeCell(v, maxLen) {
  var s = String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}
/** 給 email 內文用：拿掉換行與控制字元，限長，防信件標頭注入 */
function safeText(v, maxLen) {
  var s = String(v == null ? '' : v).replace(/[\r\n\u0000-\u001F\u007F]+/g, ' ').trim();
  return (maxLen && s.length > maxLen) ? s.slice(0, maxLen) : s;
}
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return jsonResponse({ status: 'error', message: '系統忙碌中，請稍後再送出一次' });
  }
  try {
    const data = JSON.parse(e.postData.contents);
    // ── 防濫用 1：honeypot（欄名須與 signup.html 的 .hp-field 一致）──
    if (data.contact_pref_2 && String(data.contact_pref_2).trim() !== '') {
      return jsonResponse({ status: 'ok', waitlist: false });
    }
    // ── 防濫用 2：重複送出保護 ──
    const cache = CacheService.getScriptCache();
    const rateKey = 'rl_' + [
      String(data.email || '').toLowerCase().trim(),
      String(data.studentName || '').trim(),
      String(data.session || '').trim()
    ].join('|');
    if (cache.get(rateKey)) {
      return jsonResponse({ status: 'error',
        message: '這筆報名剛剛已經送出成功了，請稍候幾分鐘再試，或直接來信確認報名狀態。' });
    }
    // ---- 基本驗證 ----
    const required = ['session', 'slot', 'studentName', 'gender', 'age', 'email',
                      'emgName', 'emgPhone', 'payerName', 'payerPhone', 'payerEmail',
                      'discount', 'lunch', 'shirtSize', 'healthStatus', 'photoConsent'];
    for (const key of required) {
      if (!data[key] || String(data[key]).trim() === '') {
        return jsonResponse({ status: 'error', message: '缺少必填欄位：' + key });
      }
    }
    if (String(data.healthStatus).trim() === '有特殊狀況' &&
        (!data.healthDetail || String(data.healthDetail).trim() === '')) {
      return jsonResponse({ status: 'error', message: '請填寫健康狀況說明' });
    }
    if (!data.medicalConsent) {
      return jsonResponse({ status: 'error', message: '請勾選緊急醫療授權' });
    }
    if (!data.guardianConsent) {
      return jsonResponse({ status: 'error', message: '請勾選法定代理人聲明' });
    }
    // ---- 信箱格式驗證 ----
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
    if (!EMAIL_RE.test(String(data.email).trim())) {
      return jsonResponse({ status: 'error', message: '信箱格式有誤，請確認後再送出' });
    }
    if (!EMAIL_RE.test(String(data.payerEmail).trim())) {
      return jsonResponse({ status: 'error', message: '繳款人信箱格式有誤，請確認後再送出' });
    }
    // ---- 時段與優惠資格白名單驗證 ----
    // ⚠️ 以下字串必須與 signup.html 的 <input name="slot"> / <select id="discount">
    //    option value 逐字一致，改前端選項時要同步改這裡，否則合法報名會被擋。
    const VALID_SLOTS = ['早上班（09:00–12:00）', '整天班（09:00–17:00）', '下午班（14:00–17:00）'];
    const VALID_DISCOUNTS = ['一般報名', '團報', '台大教職員'];
    if (!VALID_SLOTS.includes(String(data.slot).trim())) {
      return jsonResponse({ status: 'error', message: '報名時段資料有誤，請重新選擇後送出' });
    }
    if (data.discount && !VALID_DISCOUNTS.includes(String(data.discount).trim())) {
      return jsonResponse({ status: 'error', message: '優惠資格資料有誤，請重新選擇後送出' });
    }
    // ---- 電話格式驗證 ----
    const PHONE_RE = /^0\d{1,3}-?\d{6,8}$/;
    if (!PHONE_RE.test(String(data.emgPhone).trim())) {
      return jsonResponse({ status: 'error', message: '緊急聯絡人電話格式有誤，請確認後再送出' });
    }
    if (!PHONE_RE.test(String(data.payerPhone).trim())) {
      return jsonResponse({ status: 'error', message: '繳款人電話格式有誤，請確認後再送出' });
    }
    // ---- 淨化（比對與寫入都用這組值）----
    const clean = {
      session:      safeCell(data.session, 40),
      slot:         safeCell(data.slot, 40),
      studentName:  safeCell(data.studentName, 20),
      gender:       safeCell(data.gender, 20),
      age:          safeCell(data.age, 20),
      grade:        safeCell(data.grade, 20) || '—',
      email:        safeCell(data.email, 254),
      emgName:      safeCell(data.emgName, 20),
      emgPhone:     safeCell(data.emgPhone, 15),
      payerName:    safeCell(data.payerName, 20),
      payerPhone:   safeCell(data.payerPhone, 15),
      payerEmail:   safeCell(data.payerEmail, 254),
      discount:     safeCell(data.discount, 20),
      lunch:        safeCell(data.lunch, 30),
      groupMembers: safeCell(data.groupMembers, 200) || '—',
      shirtSize:    safeCell(data.shirtSize, 20),
      notes:        safeCell(data.notes, 200) || '—',
      photoConsent: safeCell(data.photoConsent, 10),
      health:       safeCell(data.healthStatus, 20),
      healthDetail: safeCell(data.healthDetail, 200) || '—',
      medical:      data.medicalConsent ? '同意' : '',
      guardian:     data.guardianConsent ? '同意' : ''
    };
    const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    const rows = sheet.getDataRange().getValues();
    // ---- 重複報名檢查（用淨化後的值比對）----
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][COL.EMAIL]).trim() === clean.email &&
          String(rows[i][COL.STUDENT]).trim() === clean.studentName &&
          String(rows[i][COL.SESSION]).trim() === clean.session) {
        return jsonResponse({ status: 'error', message: '此學員已使用相同信箱報名過' });
      }
    }
    // ---- 報名關閉時間檢查：1/25 開課，前一天截止 ----
    const CAMP_START = new Date('2027-01-25T00:00:00+08:00');
    // 關閉點 = 開課日前一天 23:59:59（開課日零時的前一秒）。
    // 注意：不可寫成 -24h，那會變成 1/24 00:00:00，等於整個 1/24 都不能報名。
    const CLOSE_TIME = new Date(CAMP_START.getTime() - 1000);
    const now = new Date();
    if (now > CLOSE_TIME) {
      return jsonResponse({ status: 'error', message: '很抱歉，本梯次報名已截止。如有候補需求請直接來信 stayyoung985@gmail.com' });
    }
    // ---- 判斷正取或候補（同梯次三時段合計，只計算「正取」）----
    let sessionCount = 0;
    for (let i = 1; i < rows.length; i++) {
      const st = String(rows[i][COL.STATUS]).trim();
      if (String(rows[i][COL.SESSION]).trim() === clean.session && st === '正取') sessionCount++;
    }
    const isWaitlist = sessionCount >= CONFIG.CAPACITY;
    const status = isWaitlist ? '候補' : '正取';
    // ---- 寫入 Sheet（共 26 欄）----
    sheet.appendRow([
      new Date(),
      clean.session, clean.slot, clean.studentName, clean.gender, clean.age, clean.grade,
      clean.email, clean.emgName, clean.emgPhone,
      clean.payerName, clean.payerPhone, clean.payerEmail,
      clean.discount, clean.lunch,
      status,
      clean.groupMembers, clean.shirtSize, clean.notes, clean.photoConsent,
      clean.health, clean.healthDetail, clean.medical, clean.guardian,
      '', ''   // 繳費通知、系統訊息
    ]);
    // ---- 寫入成功，此時才記錄冷卻 ----
    cache.put(rateKey, '1', 600);
    // ---- 寄信：失敗不得讓家長看到「送出失敗」 ----
    try {
      if (isWaitlist) { sendWaitlistEmail(data); } else { sendConfirmEmail(data); }
    } catch (mailErr) {
      sheet.getRange(sheet.getLastRow(), SYSMSG_COL)
           .setValue('寄信失敗：' + safeCell(mailErr.message, 200));
    }
    return jsonResponse({ status: 'ok', waitlist: isWaitlist });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  } finally {
    lock.releaseLock();
  }
}
/** 報名確認信（正取） */
function sendConfirmEmail(data) {
  const subject = `【${CONFIG.CAMP_NAME}】報名確認信`;
  const body =
`您好：
已收到 ${safeText(data.studentName,20)} 的報名資料，報名登記完成！
── 報名資訊 ──
營隊：${CONFIG.CAMP_NAME}
梯次：${safeText(data.session,40)}
時段：${safeText(data.slot,40)}
學員：${safeText(data.studentName,20)}（${safeText(data.gender,20)}，${safeText(data.age,20)} 歲）
緊急聯絡人：${safeText(data.emgName,20)}（${safeText(data.emgPhone,15)}）
優惠身份：${safeText(data.discount,20)}
午餐：${safeText(data.lunch,30)}
衣服尺寸：${safeText(data.shirtSize,20)}${String(data.healthStatus).trim() === '有特殊狀況' ? '\n健康狀況：' + safeText(data.healthDetail,200) : ''}${data.notes && data.notes !== '—' ? '\n備註：' + safeText(data.notes,200) : ''}
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
感謝您為 ${safeText(data.studentName,20)} 報名 ${CONFIG.CAMP_NAME}（${safeText(data.session,40)}／${safeText(data.slot,40)}）。
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
// NOTICE_COL / SYSMSG_COL 定義於檔案上方
// ══════════════════════════════════════════

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
  // 精確比對（值已於 doPost 通過白名單驗證，格式固定）
  const fullDay = String(row[COL.SLOT] || '').trim() === '整天班（09:00–17:00）';
  const base = fullDay ? (discounted ? 7200 : 7800)
                       : (discounted ? 3600 : 3900);
  const meal = (fullDay && String(row[COL.LUNCH] || '').indexOf('代訂') >= 0) ? 500 : 0;
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

如需延長繳費期限或有任何問題，請直接回覆本信與我們聯繫。

Stay Young 台灣大學羽球冬令營
${CONFIG.REPLY_EMAIL}`;
}

/** 預覽：只寄一封範例信給自己，不讀 Sheet、不動任何資料 */
function previewPaymentNotice() {
  const amt = { base: 7200, meal: 500, total: 7700,
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
    if (notifyEmail && notifyEmail !== payerEmail) opts.bcc = notifyEmail;
    MailApp.sendEmail(opts);
    sheet.getRange(i + 1, NOTICE_COL)
         .setValue(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm'));
    sent++;
  }
  return '已寄送 ' + sent + ' 封，略過 ' + skipped + ' 筆。';
}

// ══════════════════════════════════════════
// 每日自動備份
// 安裝：Apps Script 左側「觸發條件」→ 新增 → dailyBackup／時間驅動／日計時器／23:00–00:00
// ══════════════════════════════════════════
function dailyBackup() {
  // 資料夾必須與足球站分開，否則兩站的 slice(14) 會互刪對方的備份，保留天數砍半
  const FOLDER_NAME = 'StayYoung 報名備份_羽球';
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
  const src = DriveApp.getFileById(CONFIG.SHEET_ID);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  const copy = src.makeCopy('【備份】羽球冬令營報名_' + stamp, folder);
  const files = folder.getFiles();
  const list = [];
  while (files.hasNext()) list.push(files.next());
  list.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  list.slice(14).forEach(f => f.setTrashed(true));
  return copy.getId();
}

// ══════════════════════════════════════════
// 取消開班通知（未達開班門檻時手動執行）
// ══════════════════════════════════════════
function sendCancelNotice(sessionName) {
  if (!sessionName) throw new Error('請傳入梯次名稱，例如 sendCancelNotice("第一梯 2027/1/25–1/29")');
  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
  const rows = sheet.getDataRange().getValues();
  let sent = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.SESSION]).trim() !== String(sessionName).trim()) continue;
    if (String(rows[i][COL.STATUS]).trim() === '已取消通知') continue;
    MailApp.sendEmail({
      to: rows[i][COL.EMAIL],
      subject: '【' + CONFIG.CAMP_NAME + '】' + sessionName + ' 未達開班人數通知',
      body:
'您好：\n\n' +
'感謝您為 ' + rows[i][COL.STUDENT] + ' 報名 ' + CONFIG.CAMP_NAME + '（' + sessionName + '）。\n\n' +
'很遺憾，本梯次報名人數未達開班標準，經評估後將不予開班，在此向您致上最深的歉意。\n\n' +
'由於本營隊採「確認開班後才收費」的方式，您並未被收取任何費用，無需辦理退費手續。\n\n' +
'若後續有加開梯次或其他營隊資訊，我們會第一時間通知您。\n' +
'造成您的不便，我們深感抱歉。\n\n' +
'Stay Young 運動團隊\n' + CONFIG.REPLY_EMAIL,
      replyTo: CONFIG.REPLY_EMAIL,
      name: 'Stay Young 運動團隊'
    });
    sheet.getRange(i + 1, COL.STATUS + 1).setValue('已取消通知');
    sent++;
  }
  return sent + ' 封已寄出';
}
