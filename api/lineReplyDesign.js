// api/lineReplyDesign.js
const axios = require('axios');

/**
 * Global 變數與函數: 管理對於同來源的呼叫頻率，避免過於頻繁的查詢造成系統負擔
 */
// 限制對於同來源不能過於頻繁使用查詢的功能
// 對於Memory, Network I/O動作進行保護
let lastCalling = {
    "status": null,
    "channelid": null,
    "chatid": null,
    "other": null
};

async function getLastCallingTime(source) {
    let normSource = await elementMappingNorm(source);
    return lastCalling[normSource] ?? 0;
}
async function updateLastCalling(source) {
    const currentTime = new Date(); 
    let normSource = await elementMappingNorm(source);
    lastCalling[normSource] = currentTime;
}
async function elementMappingNorm(source) {
    let lowcaseSource = source.toLowerCase();
    let normSource = lowcaseSource;
    switch (lowcaseSource) {
        case 'status':
        case 'channelid':
        case 'chatid':
            break;
        default:
            normSource = 'other';
    }
    return normSource;
}

let deviceStatus = {
    cpu: 0,
    ram: 0,
    disk: 0,
    FollowUpCount: 0
};

const queries = {
    cpu: '100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
    ram: '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100',
    disk: '(1 - (node_filesystem_free_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) * 100'
};

let lastIDCheck = {
    channelid: null,
    chatid: null,
    personalid: null
}

async function lineReplyDesign(source, message, targetUrl) {
    let results = {
        type: 'text',
        text: '' // 這裡會被後續的 Prometheus 查詢結果填充
    };
    // 動態判斷來源是群組還是個人
    const sourceId = source.groupId || source.roomId || source.userId;
    const currentTime = new Date();

    // 這裡可以根據 message.text 的內容來決定要執行什麼任務
    if ((message.text.toLowerCase().includes("status")) || (message.text.toLowerCase().includes("狀態"))) {
        const lastTime = await getLastCallingTime("status");
        if (lastTime && (currentTime - lastTime) < 2 * 60 * 1000) { // 2分鐘內
            // pass，使用上次的數據，不進行新的查詢
            deviceStatus.FollowUpCount = (deviceStatus.FollowUpCount || 0) + 1; // 記錄追蹤次數
        }
        else {
            // 同時抓取三個指標
            let values = {};
            await Promise.all(Object.keys(queries).map(async (key) => {
                const resp = await axios.get(targetUrl, { params: { query: queries[key] } });
                // Prometheus 回傳格式為 [timestamp, value]，取 index 1
                const val = resp.data.data.result[0]?.value[1] || 0;
                values[key] = parseFloat(val).toFixed(2);
            }));
            deviceStatus = values; // 更新全局狀態
            deviceStatus.FollowUpCount = 0; // 初始化追蹤次數
        }

        await updateLastCalling("status");
        results.text = `💡 受理: ${message.text}\n\n 📊 最新指標數值: \nCPU 使用率: ${deviceStatus.cpu}%\nRAM 使用率: ${deviceStatus.ram}%\nDisk 使用率: ${deviceStatus.disk}%\n\n🔁 兩分鐘內追看次數: ${deviceStatus.FollowUpCount}`;
    }
    else if ((message.text.toLowerCase().includes("channelid")) || 
    (message.text.toLowerCase().includes("chatid")) || 
    (message.text.toLowerCase().includes("頻道id")) || 
    (message.text.toLowerCase().includes("聊天室id"))) {
        // 回傳動態 ID 給使用者，讓他知道要填什麼給 Grafana

        // 確定身分，優先級: 個人 > 頻道 ~= 聊天室 > 其他(不理會)
        let role = "other";
        role = ((message.text.toLowerCase().includes("channelid")) || (message.text.toLowerCase().includes("頻道id"))) ? "channelid" : (((message.text.toLowerCase().includes("chatid")) || (message.text.toLowerCase().includes("聊天室id"))) ? "chatid" : "other");
        if ("U" === sourceId[0]) {
            role = "personalid"; // 和機器人單獨詢問的時候，測試的後門，不受頻率限制
        }

        if (role === "other") {
            results.type = 'deny';
            results.text = `💡 不受理: ${message.text}\n\n 你並非從 個人 或是 頻道/聊天室 發起詢問`;
        }
        else if (role === "personalid") {
            // 個人詢問，直接回傳 ID，不受頻率限制
            lastIDCheck[role] = sourceId;
            results.text = `💡 受理: ${message.text}\n\n 🛠️ 這是你的個人對話 ID 是: \n${lastIDCheck[role]}\n\n你可以把這個 ID 填到 Grafana 的 LINE 通知設定裡，這樣 Grafana 就知道要發通知到哪裡了！`;
        }
        else {
            const lastTime = await getLastCallingTime(role);
            if (!lastTime || (currentTime - lastTime) >= 60 * 60 * 1000) {
                // 【情況 B】超過一小時或無紀錄：更新為最新的 ID
                lastIDCheck[role] = sourceId; 
                await updateLastCalling(role); // 這裡面應該也要存入新的 sourceId
            }
            else {
                // 【情況 A】一小時內：維持原本的 ID 不變，避免頻繁更新
                //  增加防呆，以免紀錄資訊不存在，那就強制更新一次吧
                if (lastIDCheck[role] === null) {
                    lastIDCheck[role] = sourceId; 
                }
            }
            results.text = `💡 受理: ${message.text}\n\n 🛠️ 這個聊天室的動態 ID 是: \n${lastIDCheck[role]}\n\n你可以把這個 ID 填到 Grafana 的 LINE 通知設定裡，這樣 Grafana 就知道要發通知到哪裡了！`;
        }
    }
    else if ((message.text.toLowerCase().includes("help")) || (message.text.toLowerCase().includes("說明"))) {
        // 說明互動使用方式
        results.text = `💡 受理: ${message.text}\n\n 這個聊天室的互動指令表: \nchannelid/chatid 查詢當前頻道的對應 ID\nstatus 查詢設備狀態\nhelp 說明 顯示此說明`;
    }
    else {
        // 其他文字訊息可以在這裡處理，或直接回傳原文
        results.type = 'deny';
        results.text = `💡 不受理: ${message.text}\n\n 請輸入有效的指令`;
    }

    return results;
}

module.exports = { lineReplyDesign };