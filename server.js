const express = require('express');
const line = require('@line/bot-sdk');
require('dotenv').config();
// --------------------
const { verifySignature } = require('#api/verifySignature');
const { grafana2LineMsgConverter } = require('#api/grafana2LineMsgConverter');
const { lineReplyDesign } = require('#api/lineReplyDesign');

// 建立一個小工具函數：專門用來脫掉環境變數頭尾的引號與空白
function cleanEnv(value) {
    if (!value) return undefined;
    // 移除頭尾可能出現的單引號、雙引號，以及多餘的空白字元
    return value.replace(/^["']|["']$/g, '').trim();
}

// 初始化設定 (加入自動清理機制)
const config = {
    channelAccessToken: cleanEnv(process.env.LINE_CHANNEL_ACCESS_TOKEN),
    channelSecret: cleanEnv(process.env.LINE_CHANNEL_SECRET),
    logRateLimit: cleanEnv(process.env.LOG_RATE_LIMIT_MS) || "43200000", // 預設 12 小時
    promethusApiUrl: cleanEnv(process.env.PROMETHEUS_API_URL) || "http://localhost:9090/api/v1/query"
};

// 建立 Messaging API 客戶端
const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: config.channelAccessToken
});

const app = express();
const PORT = process.env.PORT || 3000;

// 管理單純紀錄Log 的低威脅度資訊，不觸發警報
// 但是被限制同來源只能在長時間內只能記錄一次
let lastCalling = {
    "cpu": null,
    "mem": null,
    "disk": null,
    "network": null,
    "other": null
};

async function elementMappingNorm(source) {
    let lowcaseSource = source.toLowerCase();
    let normSource = lowcaseSource;
    switch (lowcaseSource) {
        case 'cpu':
        case 'mem':
        case 'disk':
        case 'network':
        case 'other':
            break;
        default:
            normSource = 'other';
    }
    return normSource;
}
async function getLastCallingTime(source) {
    let normSource = await elementMappingNorm(source);
    // 如果沒有紀錄過，回傳 0，代表從未被呼叫過，避免虛值（Falsy values）誤判
    return lastCalling[normSource] ?? 0; 
}
async function updateLastCalling(source) {
    const currentTime = new Date(); 
    let normSource = await elementMappingNorm(source);
    lastCalling[normSource] = currentTime;
}

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
// 改成手動驗證，這樣就能檢查 LINE 的簽章驗證過程
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

        if (result === null || result.every(r => r === null)) {
            // 如果所有事件都沒有回覆訊息，直接回傳 200 OK，不需要回傳空陣列
            return res.sendStatus(200);
        }
        else if (result.replyToken === null) {
            // 如果有任何事件被拒絕處理，回傳 200 OK 給 LINE 主機，但不回覆給使用者
            console.warn('⚠️ [LINE] 有事件被拒絕處理，已記錄但不回覆給使用者');
            console.log('🛠️ [LINE] 被拒絕的事件細節:', JSON.stringify(result.messages[0], null, 2));
            return res.sendStatus(200);
        }
        else {
            res.json(result);
        }
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

        const alertData = await lineReplyDesign(event.source, event.message, config.promethusApiUrl);
        if (alertData.type === 'text') {
            return client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ 
                    type: alertData.type || 'text', 
                    text: alertData.text || `收到你的訊息了！ ${event.message.text}`
                }]
            });
        }
        else if (alertData.type === 'deny') {
            // 如果訊息被拒絕處理，回覆拒絕的訊息給使用者
            // 為了節省回復次數，只回復收到請求的訊息給Line 主機，
            // 不回復給使用者，讓使用者自己看 Log 就好
            return client.replyMessage({
                replyToken: null, // 不回復給使用者
                messages: [{ type: 'text', text: alertData.text }]
            });
        } 
        else {
            // 其他類型的回覆可以在這裡處理，或直接忽略
            console.log('🛠️ [LINE] Received unsupported command:', event.message.text);
            console.log('🛠️ [LINE] Message details:', JSON.stringify(event.message, null, 2));  
            // return Promise.resolve(null); // 不回復任何訊息
        }
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

// ────────────────────────────────────────
// 2. 處理來自 Grafana 的 Webhook (主動推播 Push API)
// ────────────────────────────────────────
// 純粹用來記錄 Grafana 發過來的資料，並且回傳 200 給 Grafana，讓它知道我們收到了
app.post('/logs', express.json(), async (req, res) => {
    try {
        const lineBotAuthUserId = req.query.to; 
        if (!lineBotAuthUserId) {
            return res.status(400).send("Missing 'to' query parameter. Example: /grafana?to=YOUR_ID");
        }

        const whosCalling = req.query.from || 'unknown';
        const currentTime = new Date();
        const lastTime = await getLastCallingTime(whosCalling);
        const logRateLimitNum = parseInt(config.logRateLimit);
        if (lastTime && (currentTime - lastTime < logRateLimitNum)) {
            // console.log(`⏳ [${whosCalling}] Log rate limited. Skipping log entry.`);
            return res.status(200).send('Log received but rate limited.');
        }
        else {
            await updateLastCalling(whosCalling);
        }

        // 1. 轉換 Grafana 的 Payload 成 LINE 訊息格式
        const alertMessage = await grafana2LineMsgConverter(req.body);

        // 留下Log紀錄 Grafana 發過來的資料，此處是過半量使用的紀錄，輕度提醒紀錄而已
        console.log('📢 [Grafana:logs] Received Alert:\n', JSON.stringify(req.body, null, 2));
        console.log('📢 [Grafana:logs] Converted LINE Message:\n', alertMessage);

        res.status(200).send('Alert forwarded to LINE successfully.');
    } catch (error) {
        console.error('🚨 [Grafana:logs] Grafana Forwarding Error:', error.message);
        res.status(200).send('Received, but failed to send to LINE.');
    }
});

// 健康檢查 Endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => {
    console.log(`🚨 [G2L-MsgConvert] channel Access Token ${config.channelAccessToken}`);
    console.log(`💡 [G2L-MsgConvert] channel Secret ${config.channelSecret}`);
    console.log(`🚀 [G2L-MsgConvert] Proxy running on port ${PORT}`);
});