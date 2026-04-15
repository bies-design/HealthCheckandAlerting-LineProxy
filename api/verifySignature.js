// api/verifySignature.js
// 這個模組專門負責驗證來自 LINE 的 Webhook 請求簽章
// 功能等於 line.middleware 的簽章驗證部分，但我們改成手動驗證，
// 這樣就能同時處理來自 LINE 和 Grafana 的請求了，但此處用途是
// 專門設定除錯能力去校對驗證 LINE 簽章的動作有沒有缺失，或是
// 有沒有被其他中介軟體干擾到。
const crypto = require('node:crypto');

// 1. 定義安全驗證函式
function verifySignature(channelSecret, signature, body) {
    if (!signature) return false;

    try {
        const hash = crypto
            .createHmac('sha256', channelSecret)
            .update(body)
            .digest('base64');

        // 使用 Buffer 比對
        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(hash)
        );
    } catch (err) {
        console.error('VerifySignature 執行出錯:', err);
        return false;
    }
}

// 確保匯出方式正確
module.exports = { verifySignature };