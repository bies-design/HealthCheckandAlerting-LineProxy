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