async function grafana2LineMsgConverter(reqBody) {

    const payload = reqBody;

    const customTitle = payload.commonAnnotations?.summary || "Grafana Alert";
    const customMessage = payload.commonAnnotations?.description || "";

    const statusIcon = (payload.status === 'firing') ? '🚨' : '✅';
    const statusText = (payload.status) ? payload.status.toUpperCase() : 'UNKNOWN';
    
    let alertMessage = `${statusIcon} [${statusText}] Grafana Alert\n`;
    alertMessage = `${customTitle}\n`;
    alertMessage += `----------------------------\n`;
    alertMessage += `${customMessage}\n`;

    if (payload.alerts && payload.alerts.length > 0 && !customMessage) {
        payload.alerts.forEach((alert, index) => {
            alertMessage += `\n🔹 告警 ${index + 1}: ${alert.labels?.alertname || 'Unnamed'}`;
        });
    }

    return alertMessage;
}

module.exports = { grafana2LineMsgConverter };