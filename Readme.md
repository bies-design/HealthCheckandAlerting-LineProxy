# Proxy for Grafana Webhook to LINE Messaging API

made by: Gemini.Pro <br/>
owner: mark.hsieh <br/>
last update: 2026/04/15 pm 04:10 CST
version: v1.2.1

## How to use

1. 修改/增加 .env
```makefile
# 對外開放Port
PORT=3000
# 請替換為你的 LINE Bot Channel Access Token
LINE_ACCESS_TOKEN=your_channel_access_token_here
# 請替換為接收通知的 User ID, Group ID 或 Room ID
LINE_TARGET_ID=your_user_or_group_id_here
# 預設低威脅度的警報只會紀錄Log, 同樣的來源的允許紀錄間隔時間
LOG_RATE_LIMIT_MS=43200000
PROMETHEUS_API_URL=http://localhost:9090/api/v1/query
```

2. docker compose way <br/>

確認網路卡隸屬，因為本服務是為了Grafana Alert Notice設計的輔助，所以預設是掛在monitor<br/>
```yml
    networks:
      - monitor
      
networks:
  monitor:
    external: true #認為已經存在，不用建立
```
然後使用 docker command 啟動 <br/>
```bash
/~: $ sudo docker network create monitor    # 如果沒有這個網卡
/~: $ sudo docker-compose -f docker-compose.yml up -d
```

3. docker pure way <br/>

然後使用 docker command 啟動 <br/>
```bash
/~: $ sudo docker network create monitor    # 如果沒有這個網卡
/~: $ sudo docker build -t grafana-line-proxy .
/~: $ sudo docker run -d \
  --name grafana-line-proxy \
  -p 3000:3000 \
  --network monitor \
  --env-file ./.env \
  --restart unless-stopped \
  grafana-line-proxy
```