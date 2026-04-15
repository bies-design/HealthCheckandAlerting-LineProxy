const express = require('express');
const line = require('@line/bot-sdk');
require('dotenv').config();
// --------------------
const { verifySignature } = require('#api/verifySignature');
const { grafana2LineMsgConverter } = require('#api/grafana2LineMsgConverter');

// 建立一個小工具函數：專門用來脫掉環境變數頭尾的引號與空白
function cleanEnv(value) {
    if (!value) return undefined;
    // 移除頭尾可能出現的單引號、雙引號，以及多餘的空白字元
    return value.replace(/^["']|["']$/g, '').trim();
}

// 初始化設定 (加入自動清理機制)
const config = {
    channelAccessToken: cleanEnv(process.env.LINE_CHANNEL_ACCESS_TOKEN),
    channelSecret: cleanEnv(process.env.LINE_CHANNEL_SECRET)
};

// 建立 Messaging API 客戶端
const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: config.channelAccessToken
});

const app = express();
const PORT = process.env.PORT || 3000;

// ────────────────────────────────────────
// 1. 處理來自 LINE 的 Webhook 
// line.middleware 會自動處理 X-Line-Signature 加密驗證！
// ────────────────────────────────────────
// app.post('/line', line.middleware(config), (req, res) => {
//     Promise
//         .all(req.body.events.map(handleLineEvent))
//         .then((result) => res.json(result))
//         .catch((err) => {
//             console.error('LINE Webhook Error:', err);
//             res.status(500).end();
//         });
// });
// ------------------------------------------
// 改成手動驗證，這樣就能同時處理來自 LINE 和 Grafana 的請求了
// ------------------------------------------
// 注意：不要在全域對 /line 使用 express.json()，
// 我們在路由內部手動獲取原始資料 (Raw Body)
// Webhook Router
app.post('/line', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['x-line-signature'];
    const body = req.body.toString(); // 這是原始字串，驗證簽章必須用它

    // 1. 手動驗證簽章 (取代 line.middleware)
    if (!verifySignature(config.channelSecret, signature, body)) {
        console.error('⚠️ [LINE] 簽章驗證失敗！');
        return res.status(401).send('Invalid Signature');
    }

    // 2. 驗證成功後，手動轉成 JSON
    const data = JSON.parse(body);
    
    // 3. 處理事件 (原本的邏輯)
    try {
        if (!data.events || data.events.length === 0) {
            // LINE Verify 測試會發送空事件，直接回傳 OK
            console.log('✅ [LINE] 收到 Verify 測試訊號');
            return res.sendStatus(200);
        }

        const result = await Promise.all(data.events.map(handleLineEvent));
        res.json(result);
    } catch (err) {
        console.error('🚨[LINE] 處理事件出錯:', err);
        res.status(500).end();
    }
});

async function handleLineEvent(event) {
    // 處理加入好友/群組事件
    if (event.type === 'follow' || event.type === 'join') {
        // 動態判斷來源是群組還是個人
        const sourceId = event.source.groupId || event.source.roomId || event.source.userId;

        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `感謝加入！請使用本群組的 ID :${sourceId} \n來設定 Grafana 告警。` }]
        });
    }
    // 處理文字訊息 (Echo Bot)，順便印出動態 ID 讓你知道要填什麼給 Grafana
    else if (event.type === 'message' && event.message.type === 'text') {
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
    else {
        // 其他事件類型可以在這裡處理，或直接忽略
        console.log('🛠️ [LINE] Received unsupported event type:', event.type);
        console.log('🛠️ [LINE] Event details:', JSON.stringify(event, null, 2));  
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
        // 例如: http://localhost:3000/grafana?to=U1234567890abcdef...
        const lineBotAuthUserId = req.query.to; 
        
        if (!lineBotAuthUserId) {
            return res.status(400).send("Missing 'to' query parameter. Example: /grafana?to=YOUR_ID");
        }

        // 1. 轉換 Grafana 的 Payload 成 LINE 訊息格式
        const alertMessage = await grafana2LineMsgConverter(req.body);

        // 使用 Push API 發送給動態指定的 ID
        await client.pushMessage({
            to: lineBotAuthUserId,
            messages: [{ type: 'text', text: alertMessage.trim().substring(0, 4900) }]
        });

        res.status(200).send('Alert forwarded to LINE successfully.');
    } catch (error) {
        console.error('🚨 [LINE] Grafana Forwarding Error:', error.message);
        res.status(200).send('Received, but failed to send to LINE.');
    }
});

// 健康檢查 Endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => {
    console.log(`🚨 channel Access Token ${config.channelAccessToken}`);
    console.log(`💡 channel Secret ${config.channelSecret}`);
    console.log(`🚀 Proxy running on port ${PORT}`);
});