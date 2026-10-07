/**
 * Notification Relay Client
 * Connects rustminus to notificationsrelay.trylocalhost.com to dispatch
 * Rust+ game events, raid alarms, and team notifications to Telegram.
 */

class NotificationRelayClient {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.relayUrl = config.relayUrl || process.env.RELAY_URL || "https://notificationsrelay.trylocalhost.com/api/send";
    this.apiKey = config.apiKey || process.env.RELAY_API_KEY || "";
  }

  async send(payload) {
    if (!this.enabled) return null;
    try {
      const res = await fetch(this.relayUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      return data;
    } catch (err) {
      console.warn("[NotificationRelay] Failed to forward to relay:", err.message);
      return { success: false, error: err.message };
    }
  }

  async sendAlert(title, message, details = {}) {
    return this.send({
      type: "alert",
      title,
      message,
      details,
      level: "info"
    });
  }

  async sendRaidAlert(alarmName, entityId, serverName = "Active Server", extra = {}) {
    return this.send({
      type: "raid",
      title: `Smart Alarm "${alarmName}" (ID: ${entityId})`,
      message: `🚨 RAID ALERT TRIGGERED on ${serverName}!`,
      details: {
        "Alarm Name": alarmName,
        "Entity ID": entityId,
        "Server": serverName,
        ...extra
      },
      level: "critical"
    });
  }

  async sendTeamChat(senderName, message, color = "#55ff55") {
    return this.send({
      type: "teamchat",
      title: senderName,
      message: message,
      details: { "Chat Color": color },
      level: "info"
    });
  }

  getStatus() {
    return {
      enabled: this.enabled,
      relayUrl: this.relayUrl,
      hasApiKey: !!this.apiKey,
      serviceDomain: "notificationsrelay.trylocalhost.com"
    };
  }
}

module.exports = NotificationRelayClient;
