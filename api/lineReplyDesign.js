// api/lineReplyDesign.js
const axios = require('axios');

const queries = {
    cpu: '100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
    ram: '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100',
    disk: '(1 - (node_filesystem_free_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) * 100'
};

async function lineReplyDesign(source, message, targetUrl) {
    let results = {
        type: 'text',
        text: '' // 這裡會被後續的 Prometheus 查詢結果填充
    };
    // 動態判斷來源是群組還是個人
    const sourceId = source.groupId || source.roomId || source.userId;

    // 這裡可以根據 message.text 的內容來決定要執行什麼任務
    if (message.text.toLowerCase().includes("status")) {
        // 同時抓取三個指標
        let values = {};
        await Promise.all(Object.keys(queries).map(async (key) => {
            const resp = await axios.get(targetUrl, { params: { query: queries[key] } });
            // Prometheus 回傳格式為 [timestamp, value]，取 index 1
            const val = resp.data.data.result[0]?.value[1] || 0;
            values[key] = parseFloat(val).toFixed(2);
        }));
        results.text = `💡 受理: ${message.text}\n\n 📊 最新指標數值：\nCPU 使用率: ${values.cpu}%\nRAM 使用率: ${values.ram}%\nDisk 使用率: ${values.disk}%`;
    }
    else {
        // 其他文字訊息可以在這裡處理，或直接回傳原文
        results.text = `你說了：${message.text}\n\n💡 這個聊天室的動態 ID 是：\n${sourceId}`;
    }

    return results;
}

module.exports = { lineReplyDesign };