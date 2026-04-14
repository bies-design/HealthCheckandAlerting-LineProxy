const express = require('express');
const line = require('@line/bot-sdk');

// 初始化設定 (對應你的 Python Configuration)
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 建立 Messaging API 客戶端
const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: config.channelAccessToken
});

const app = express();
const PORT = process.env.PORT || 3000;

// ────────────────────────────────────────
// 1. 處理來自 LINE 的 Webhook (對應你的 Python 範例)
// line.middleware 會自動處理 X-Line-Signature 加密驗證！
// ────────────────────────────────────────
app.post('/line', line.middleware(config), (req, res) => {
    Promise
        .all(req.body.events.map(handleLineEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error('LINE Webhook Error:', err);
            res.status(500).end();
        });
});

async function handleLineEvent(event) {
    // 處理加入好友/群組事件
    if (event.type === 'follow' || event.type === 'join') {
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '感謝加入！請使用本群組的 ID 來設定 Grafana 告警。' }]
        });
    }

    // 處理文字訊息 (Echo Bot)，順便印出動態 ID 讓你知道要填什麼給 Grafana
    if (event.type === 'message' && event.message.type === 'text') {
        // 動態判斷來源是群組還是個人
        const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
        
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ 
                type: 'text', 
                text: `你說了：${event.message.text}\n\n💡 這個聊天室的動態 ID 是：\n${sourceId}` 
            }]
        });
    }
    return Promise.resolve(null);
}

// ────────────────────────────────────────
// 2. 處理來自 Grafana 的 Webhook (主動推播 Push API)
// ────────────────────────────────────────
// 注意：這裡不能用 line.middleware，因為這是 Grafana 打來的，沒有 LINE 的簽章
app.post('/grafana', express.json(), async (req, res) => {
    try {
        // 【核心改變】從 URL Query 動態取得 User ID (對於Line Bot 而言隸屬的使用者身分ID)
        // 例如: http://localhost:3000/grafana?to=C1234567890abcdef...
        const lineBotAuthUserId = req.query.to; 
        
        if (!lineBotAuthUserId) {
            return res.status(400).send("Missing 'to' query parameter. Example: /grafana?to=YOUR_ID");
        }

        const payload = req.body;
        const statusIcon = payload.status === 'firing' ? '🚨' : '✅';
        const statusText = payload.status ? payload.status.toUpperCase() : 'UNKNOWN';
        
        let alertMessage = `${statusIcon} [${statusText}] ${payload.title || 'Grafana Alert'}\n`;

        if (payload.alerts && payload.alerts.length > 0) {
            payload.alerts.forEach((alert, index) => {
                alertMessage += `\n🔹 告警 ${index + 1}: ${alert.labels?.alertname || 'Unnamed'}`;
                if (alert.annotations?.summary) alertMessage += `\n摘要: ${alert.annotations.summary}`;
            });
        }

        // 使用 Push API 發送給動態指定的 ID
        await client.pushMessage({
            to: lineBotAuthUserId,
            messages: [{ type: 'text', text: alertMessage.trim().substring(0, 4900) }]
        });

        res.status(200).send('Alert forwarded to LINE successfully.');
    } catch (error) {
        console.error('Grafana Forwarding Error:', error.message);
        res.status(200).send('Received, but failed to send to LINE.');
    }
});

// 健康檢查 Endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => {
    console.log(`🚀 Proxy running on port ${PORT}`);
});