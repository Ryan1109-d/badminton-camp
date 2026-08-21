/**
 * 台灣大學羽球冬令營 2027 — Google Apps Script 後端
 * （與足球營完全分開：請用新的 Google Sheet + 新的 Apps Script 部署）
 *
 * 部署步驟：
 * 1. Google Sheet 第一列欄位標題（共 27 欄，與下方 appendRow 順序一致）：
 *    報名時間 | 梯次 | 時段 | 學員姓名 | 性別 | 年齡 | 年級 | 收信信箱 | 緊急聯絡人 | 緊急聯絡人電話 | 繳款人姓名 | 繳款人電話 | 繳款人信箱 | 優惠身份 | 推薦人 | 午餐 | 狀態 | 團報成員 | 衣服尺寸 | 備註 | 照片同意 | 健康狀況 | 健康說明 | 緊急醫療授權 | 法定代理人聲明 | 繳費通知 | 系統訊息
 *
 *    ⚠️ 2026-08-17 新增第 15 欄「推薦人」。若 Sheet 已有報名資料，
 *       請用「插入 1 欄」而不是直接改標題，否則第 15 欄之後的既有資料會全部錯位。
 * 2. Sheet 上方選 擴充功能 → Apps Script，貼上本檔案全部內容
 * 3. 修改下方 CONFIG 的 SHEET_ID（網址中 /d/ 和 /edit 之間那串）
 * 4. 部署 → 新增部署作業 → 類型選「網頁應用程式」
 *    - 執行身分：我
 *    - 誰可以存取：所有人
 * 5. 複製 Web App URL，貼到 signup.html 的 GAS_URL
 *
 * 狀態欄位邏輯（2026-08-21 改為以「時段」為單位，不再是三時段合計）：
 * - 名額以時段計算，每個時段上限 CONFIG.CAPACITY 人。
 * - 整天班同時佔用早上與下午兩個時段的名額。
 *   因此早上佔用 = 早上班 + 整天班；下午佔用 = 下午班 + 整天班。
 * - 報名時段還有空位 → 狀態「正取」，寄報名確認信
 * - 報名時段已額滿   → 狀態「候補」，寄候補通知信
 *   （報整天班時，只要早上或下午其中一邊滿了就是候補）
 *
 * 為什麼要這樣改：場地在同一個時間點最多容納 CAPACITY 人，
 * 早上與下午是兩批不同的人，本來就該分開算。舊版三時段合計會過早把人推進候補。
 */
const CONFIG = {
  SHEET_ID: 'YOUR_SHEET_ID_HERE',       // TODO: 換成實際 Sheet ID（只在 Apps Script 填，不要 commit）
  SHEET_NAME: '報名名單',                 // 分頁名稱
  CAPACITY: 50,                          // 每個時段的正取上限（不是三時段合計）
  CAMP_NAME: '台灣大學羽球冬令營 2027',
  CAMP_DATE: '2027/1/25（一）– 1/29（五）',
  REPLY_EMAIL: 'stayyoung985@gmail.com',
  // 早鳥截止（含當日）。此日期前完成報名者，不限身份適用優惠價
  EARLY_BIRD_DEADLINE: '2026-11-20T23:59:59+08:00',
  // 定價（2026-08-17 起）。兩道折扣互相獨立、可以疊加：
  //   ① 優惠身份：早鳥 / 團報 / 台大教職員（三擇一，彼此不疊加）→ 轉帳時直接折抵
  //   ② 推薦人：報名表填了推薦人姓名 → 開課首日現場以現金退還，不先折抵
  //   整天 8500 → 8000（身份）→ 7500（再退推薦 500）
  //   半天 4250 → 4000（身份）→ 3750（再退推薦 250）
  PRICE: { FULL: 8500, HALF: 4250, STEP_FULL: 500, STEP_HALF: 250 },
  // 家長 LINE 社群邀請連結。⚠️ 真值只填在 Apps Script，不要 commit 進 public repo
  //    （這是可公開加入的邀請網址，落在公開 repo 等於任何人都能加進家長群）。
  //    維持佔位字串時，確認信會自動略過整段 LINE 說明，不會寄出壞掉的連結。
  LINE_GROUP_URL: 'YOUR_LINE_GROUP_URL_HERE',
  // ⚠️ 收款資訊：以下為測試值。只要任何一項還是「（測試）」開頭，
  //    sendPaymentNotice() 會拒絕寄給家長，只寄預覽給自己。
  PAYMENT: {
    BANK: '國泰世華銀行 013',
    ACCOUNT_NAME: '（測試）戶名尚未設定',   // ⚠️ 換成真實戶名後才會開始寄繳費通知
    ACCOUNT_NO: '699522993691',
    DEADLINE_DAYS: 7
  }
};
// 欄位索引（0-based，對應 Sheet 欄位順序）
const COL = {
  TIME: 0, SESSION: 1, SLOT: 2, STUDENT: 3, GENDER: 4, AGE: 5, GRADE: 6,
  EMAIL: 7, EMG_NAME: 8, EMG_PHONE: 9,
  PAYER_NAME: 10, PAYER_PHONE: 11, PAYER_EMAIL: 12,
  DISCOUNT: 13, REFERRER: 14, LUNCH: 15, STATUS: 16, GROUP: 17, SHIRT: 18,
  NOTES: 19, PHOTO: 20,
  HEALTH: 21, HEALTH_DETAIL: 22, MEDICAL: 23, GUARDIAN: 24
};
const NOTICE_COL = 26;   // 繳費通知（1-based）
const SYSMSG_COL = 27;   // 系統訊息（1-based）

// 標題列應有的 27 欄，順序即寫入順序。checkSetup() 會拿它逐欄比對。
const EXPECTED_HEADERS = [
  '報名時間','梯次','時段','學員姓名','性別','年齡','年級','收信信箱','緊急聯絡人','緊急聯絡人電話',
  '繳款人姓名','繳款人電話','繳款人信箱','優惠身份','推薦人','午餐','狀態','團報成員','衣服尺寸',
  '備註','照片同意','健康狀況','健康說明','緊急醫療授權','法定代理人聲明','繳費通知','系統訊息'
];

// ⚠️ 以下字串必須與 signup.html 的 <input name="slot"> option value 逐字一致，
//    改前端選項時要同步改這裡，否則合法報名會被擋。
const SLOT_AM   = '早上班（09:00–12:00）';
const SLOT_PM   = '下午班（14:00–17:00）';
const SLOT_FULL = '整天班（09:00–17:00）';
const VALID_SLOTS = [SLOT_AM, SLOT_FULL, SLOT_PM];

/**
 * 計算各時段目前的「正取」佔用數。
 *
 * 整天班的人同時佔用早上與下午，所以：
 *   早上佔用 = 早上班人數 + 整天班人數
 *   下午佔用 = 下午班人數 + 整天班人數
 *
 * 回傳的 am / pm / full 是「各時段各自報了幾個人」，
 * amOcc / pmOcc 才是拿來判斷額滿的佔用數。
 */
function countSlots_(rows) {
  let am = 0, pm = 0, full = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.STATUS]).trim() !== '正取') continue;
    const slot = String(rows[i][COL.SLOT]).trim();
    if (slot === SLOT_AM) am++;
    else if (slot === SLOT_PM) pm++;
    else if (slot === SLOT_FULL) full++;
  }
  return { am: am, pm: pm, full: full, amOcc: am + full, pmOcc: pm + full };
}

/** 報這個時段會不會變成候補 */
function isWaitlisted_(slot, c) {
  if (slot === SLOT_AM)   return c.amOcc >= CONFIG.CAPACITY;
  if (slot === SLOT_PM)   return c.pmOcc >= CONFIG.CAPACITY;
  // 整天班要兩邊都有位子才排得進去
  return c.amOcc >= CONFIG.CAPACITY || c.pmOcc >= CONFIG.CAPACITY;
}

/** 這筆報名在該時段是第幾位（通知信用，讓自己一眼看出擠不擠） */
function seqInSlot_(slot, c) {
  if (slot === SLOT_AM)   return c.amOcc + 1;
  if (slot === SLOT_PM)   return c.pmOcc + 1;
  return Math.max(c.amOcc, c.pmOcc) + 1;
}

/**
 * 取得報名分頁。找不到時丟出「講得出原因」的錯誤，
 * 而不是讓後續程式碰到 null 之後噴 Cannot read properties of null。
 */
function getSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    const names = ss.getSheets().map(s => '「' + s.getName() + '」').join('、');
    throw new Error('找不到分頁「' + CONFIG.SHEET_NAME + '」。這個試算表現有的分頁是：' + names +
                    '。請把報名分頁改名為「' + CONFIG.SHEET_NAME + '」（前後不能有空白），' +
                    '或改掉 CONFIG.SHEET_NAME。');
  }
  return sheet;
}

/**
 * 設定自我檢查。部署完、改完 Sheet 之後手動執行這個，
 * 比送一筆測試報名安全（不會寫資料、不會寄信）。
 */
function checkSetup() {
  const out = [];
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    out.push('✅ SHEET_ID 可開啟：' + ss.getName());
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) {
      out.push('❌ 找不到分頁「' + CONFIG.SHEET_NAME + '」');
      out.push('   現有分頁：' + ss.getSheets().map(s => s.getName()).join('、'));
    } else {
      out.push('✅ 分頁「' + CONFIG.SHEET_NAME + '」存在');
      const lastCol = sheet.getLastColumn();
      const headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
      out.push((headers.length === EXPECTED_HEADERS.length ? '✅' : '❌') +
               ' 標題列欄數 ' + headers.length + '（應為 ' + EXPECTED_HEADERS.length + '）');
      EXPECTED_HEADERS.forEach(function (h, i) {
        const actual = String(headers[i] == null ? '' : headers[i]).trim();
        if (actual !== h) {
          out.push('   ⚠️ 第 ' + (i + 1) + ' 欄應為「' + h + '」，實際是「' + (actual || '(空白)') + '」');
        }
      });
      const n = Math.max(0, sheet.getLastRow() - 1);
      out.push('   目前資料筆數：' + n);
      if (n > 0) {
        const c = countSlots_(sheet.getDataRange().getValues());
        out.push('   正取佔用｜早上 ' + c.amOcc + '／' + CONFIG.CAPACITY +
                 '　下午 ' + c.pmOcc + '／' + CONFIG.CAPACITY +
                 '　（早上班 ' + c.am + '、下午班 ' + c.pm + '、整天班 ' + c.full + '）');
      }
    }
  } catch (e) {
    out.push('❌ ' + e.message);
  }
  out.push(paymentIsPlaceholder() ? '⚠️ 收款資訊仍是測試值，繳費通知會被擋下'
                                  : '✅ 收款資訊已設定，繳費通知可正常寄出');
  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * 確認信裡的 LINE 家長社群段落。
 * LINE_GROUP_URL 還是佔位字串時回傳空字串，整段不會出現在信裡，
 * 避免家長收到「請點選以下連結：YOUR_LINE_GROUP_URL_HERE」。
 */
function lineSection() {
  const url = String(CONFIG.LINE_GROUP_URL || '').trim();
  if (!url || url.indexOf('http') !== 0) return '';
  return '\n\n── 加入家長社群 ──\n' +
         '請加入本營隊的 LINE 家長社群，開班通知、繳費提醒與每日花絮都會在這裡發布：\n' +
         url + '\n' +
         '※ 此連結僅提供給已報名的家長，請勿轉發給無關人士。' + '\n';
}

/**
 * 新報名通知（寄給 Stay Young 自己，不是家長）。
 * 主旨開頭固定帶【羽球】，兩個營隊的通知在收件匣裡不會混淆。
 * 這封信寄失敗絕不能影響報名結果，呼叫端一律包在 try/catch 內。
 */
function notifyOwner_(data, clean, status, seq, counts) {
  const subject = '【羽球】新報名　' + status + ' 第 ' + seq + ' 位　' +
                  safeText(clean.studentName, 20);
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + CONFIG.SHEET_ID + '/edit';
  const ref = String(clean.referrer || '—');
  const dash = function (v) { var s = safeText(v, 40); return s ? s : '—'; };
  // 兩個營隊刻意共用同一組欄位與順序，收件匣裡兩封信長得一模一樣；
  // 該營隊沒有的欄位一律填「—」，不要整行省略，否則行數會對不齊。
  const body =
    CONFIG.CAMP_NAME + '\n' +
    '─────────────────\n' +
    '狀態：' + status + '（該時段第 ' + seq + ' 位，每時段上限 ' + CONFIG.CAPACITY +
      '｜早上 ' + counts.amOcc + '、下午 ' + counts.pmOcc + '）\n' +
    '梯次：' + dash(data.session) + '\n' +
    '時段：' + dash(data.slot) + '\n' +
    '─────────────────\n' +
    '學員：' + safeText(clean.studentName, 20) +
      '（' + dash(clean.gender) + '，' + dash(clean.age) + ' 歲）\n' +
    '年級：' + dash(clean.grade) + '\n' +
    '衣服尺寸：' + dash(clean.shirtSize) + '\n' +
    '健康狀況：' + dash(clean.health) +
      (String(clean.health).trim() === '有特殊狀況'
        ? '　⚠️ ' + safeText(clean.healthDetail, 200) : '') + '\n' +
    '─────────────────\n' +
    '收信信箱：' + safeText(clean.email, 254) + '\n' +
    '緊急聯絡人：' + dash(clean.emgName) + '（' + dash(clean.emgPhone) + '）\n' +
    '繳款人：' + dash(clean.payerName) + '（' + dash(clean.payerPhone) + '）\n' +
    '─────────────────\n' +
    '優惠身份：' + dash(clean.discount) + '\n' +
    '推薦人：' + safeText(ref, 20) + (ref !== '—' ? '　← 需人工核對是否也已報名' : '') + '\n' +
    '午餐：' + dash(clean.lunch) + '\n' +
    '團報成員：' + dash(clean.groupMembers) + '\n' +
    '備註：' + dash(clean.notes) + '\n' +
    '─────────────────\n' +
    '報名名單：' + sheetUrl;
  MailApp.sendEmail({
    to: CONFIG.REPLY_EMAIL,
    subject: subject,
    body: body,
    name: 'Stay Young 報名系統'
  });
}

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
  const t0 = Date.now();
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
    // ⚠️ VALID_SLOTS 定義於檔案上方（與 countSlots_ 共用同一組字串）。
    //    VALID_DISCOUNTS 須與 signup.html 的 <select id="discount"> option value 逐字一致。
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
      // 推薦人為選填。空值一律寫「—」，calcAmount 以此判定不適用推薦優惠。
      referrer:     safeCell(data.referrer, 20) || '—',
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
    const sheet = getSheet_();
    const rows = sheet.getDataRange().getValues();
    const tRead = Date.now();
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
    // ---- 判斷正取或候補（以時段為單位，整天班佔用早上＋下午）----
    const counts = countSlots_(rows);
    const isWaitlist = isWaitlisted_(clean.slot, counts);
    const status = isWaitlist ? '候補' : '正取';
    const seq = seqInSlot_(clean.slot, counts);
    // ---- 寫入 Sheet（共 27 欄）----
    sheet.appendRow([
      new Date(),
      clean.session, clean.slot, clean.studentName, clean.gender, clean.age, clean.grade,
      clean.email, clean.emgName, clean.emgPhone,
      clean.payerName, clean.payerPhone, clean.payerEmail,
      clean.discount, clean.referrer, clean.lunch,
      status,
      clean.groupMembers, clean.shirtSize, clean.notes, clean.photoConsent,
      clean.health, clean.healthDetail, clean.medical, clean.guardian,
      '', ''   // 繳費通知、系統訊息
    ]);
    const tWrite = Date.now();
    // ---- 寫入成功，此時才記錄冷卻 ----
    cache.put(rateKey, '1', 600);
    // ---- 寄信：失敗不得讓家長看到「送出失敗」 ----
    try {
      if (isWaitlist) { sendWaitlistEmail(data); } else { sendConfirmEmail(data); }
    } catch (mailErr) {
      sheet.getRange(sheet.getLastRow(), SYSMSG_COL)
           .setValue('寄信失敗：' + safeCell(mailErr.message, 200));
    }
    const tParentMail = Date.now();
    // ---- 通知自己有新報名（失敗不影響報名，也不寫進系統訊息欄）----
    try {
      notifyOwner_(data, clean, status, seq, counts);
    } catch (notifyErr) {
      Logger.log('新報名通知寄送失敗：' + notifyErr);
    }
    // 效能量測：在 Apps Script 的「執行記錄」可看到每段耗時，用來判斷慢在哪
    Logger.log('doPost 耗時 ms｜讀 Sheet ' + (tRead - t0) +
               '、寫入 ' + (tWrite - tRead) +
               '、家長信 ' + (tParentMail - tWrite) +
               '、通知信 ' + (Date.now() - tParentMail) +
               '、總計 ' + (Date.now() - t0));
    return jsonResponse({ status: 'ok', waitlist: isWaitlist });
  } catch (err) {
    // 內部錯誤不原樣回給家長（可能含 Sheet 結構等資訊）；細節記進執行記錄供排查
    Logger.log('doPost 失敗：' + (err && err.stack ? err.stack : err));
    return jsonResponse({ status: 'error',
      message: '系統忙線或發生問題，請稍後再試一次，或直接來信 ' + CONFIG.REPLY_EMAIL + ' 由我們協助報名。' });
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
若有任何問題，歡迎直接回覆本信。${lineSection()}
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
目前該時段正取名額已滿，您的報名已列入「候補名單」。
若有名額釋出，我們將立即以 email 通知您，屆時再依信中說明完成報名程序即可。
候補期間不會收取任何費用。

※ 其他時段可能仍有名額。若您的時間允許調整，歡迎回覆本信告知，
　 我們可協助改到還有空位的時段。

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

/**
 * 依報名時間、時段、優惠身份、推薦人、午餐計算應繳金額。
 *
 * ⚠️ 午餐費「有」併入轉帳總額：本營隊金流不經學校、不被抽成，與足球營相反。
 *
 * ⚠️ 推薦人優惠不在轉帳金額內先折抵，改為「開課首日現場以現金退還」。
 *    原因：A 推薦 B 時，A 往往已經先繳費了，當下無法預先折抵；
 *    改成報到當天一次結清，不必事後往返核對與匯款。
 *    因此一律先收未折推薦的金額，refundable 為當天要退的現金。
 *    推薦人「不自動查證」，只看欄位有沒有填；若查證不成立，把 Sheet 上
 *    該格清成「—」再重跑即可。
 */
function calcAmount(row) {
  const regTime = row[COL.TIME];
  const early = (regTime instanceof Date) &&
                regTime <= new Date(CONFIG.EARLY_BIRD_DEADLINE);
  const d = String(row[COL.DISCOUNT] || '');
  const hasStatus = early || d === '團報' || d === '台大教職員';
  const ref = String(row[COL.REFERRER] || '').trim();
  const hasReferrer = ref !== '' && ref !== '—';
  // 精確比對（值已於 doPost 通過白名單驗證，格式固定）
  const fullDay = String(row[COL.SLOT] || '').trim() === SLOT_FULL;

  const listPrice = fullDay ? CONFIG.PRICE.FULL : CONFIG.PRICE.HALF;
  const step      = fullDay ? CONFIG.PRICE.STEP_FULL : CONFIG.PRICE.STEP_HALF;
  const base      = listPrice - (hasStatus ? step : 0);
  const refundable = hasReferrer ? step : 0;

  const breakdown = [];
  if (hasStatus) {
    breakdown.push((early ? '早鳥優惠' : '優惠身份（' + d + '）') + '　−NT$ ' + step);
  }

  const meal = (fullDay && String(row[COL.LUNCH] || '').indexOf('代訂') >= 0) ? 500 : 0;
  return { listPrice: listPrice, base: base, meal: meal, total: base + meal,
           refundable: refundable, hasReferrer: hasReferrer, referrer: ref,
           slotLabel: fullDay ? '整天班' : '半天班', breakdown: breakdown,
           label: hasStatus ? (early ? '早鳥優惠價' : '優惠價') : '原價' };
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
原價：NT$ ${amt.listPrice}
${amt.breakdown.length ? amt.breakdown.map(x => '　' + x).join('\n') + '\n' : ''}營隊費用：NT$ ${amt.base}${amt.meal ? '\n代訂午餐：NT$ ' + amt.meal + '（五天）' : ''}
應繳總額：NT$ ${amt.total}
${amt.hasReferrer ? '\n── 推薦人優惠 ──\n您填寫的推薦人：' + amt.referrer + '\n經確認推薦人也完成報名後，可折抵 NT$ ' + amt.refundable + '。\n※ 這筆優惠「不含」在上方轉帳金額內，請先依上方總額轉帳。\n　 折抵金額將於「開課第一天」在報到處以現金退還，不需另外申請。\n' : ''}
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
  const amt = { listPrice: CONFIG.PRICE.FULL, base: 8000, meal: 500, total: 8500,
                refundable: 500, hasReferrer: true, referrer: '陳小美（範例）',
                slotLabel: '整天班', breakdown: ['早鳥優惠　−NT$ 500'],
                label: '早鳥優惠價' };
  const body = buildPaymentBody('王小華（範例）', '第一梯 2027/1/25–1/29',
                                SLOT_FULL, amt);
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
  const sheet = getSheet_();
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
//
// 安裝方式（擇一）：
//   A. 【建議】在上方函式下拉選單選 installDailyBackupTrigger 按執行，一次就裝好。
//   B. 手動：左側「觸發條件」→ 新增 → dailyBackup／時間驅動／日計時器／23:00–00:00
// ══════════════════════════════════════════

/**
 * 一鍵安裝每日備份觸發條件（每天 23:00–00:00 之間跑一次 dailyBackup）。
 * 會先刪掉既有的 dailyBackup 觸發條件，重複執行不會裝出兩個。
 */
function installDailyBackupTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyBackup') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('dailyBackup').timeBased().atHour(23).everyDays(1).create();
  var msg = '已安裝每日備份觸發條件（每天 23:00–00:00）' +
            (removed ? '，並清掉 ' + removed + ' 個舊的。' : '。');
  Logger.log(msg);
  return msg;
}

/** 檢查目前裝了哪些觸發條件（隨時可安全執行） */
function listTriggers() {
  var lines = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction() + '（' + t.getEventType() + '）';
  });
  var msg = lines.length ? '目前的觸發條件：\n' + lines.join('\n') : '目前沒有任何觸發條件。';
  Logger.log(msg);
  return msg;
}

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
  const sheet = getSheet_();
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
