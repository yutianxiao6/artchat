/**
 * heartbeat.js - 前端心跳机制
 * 定期向后端发送心跳请求，保持连接活跃
 * 当页面关闭或长时间无活动时，后端会自动关闭
 */
(function() {
  "use strict";

  var HEARTBEAT_INTERVAL = 3000; // 页面可见时 3 秒
  var HIDDEN_HEARTBEAT_INTERVAL = 30000; // 页面隐藏时 30 秒，避免浏览器节流让后端误判闲置
  var heartbeatTimer = null;
  var isPageVisible = true;

  function sendHeartbeat() {
    fetch("/api/heartbeat", {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    }).catch(function(err) {
      console.warn("心跳请求失败:", err);
    });
  }

  function startHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }

    // 立即发送一次
    sendHeartbeat();

    // 定期发送（即使页面隐藏也要发，否则长时间生图过程中后端会因闲置自杀）
    var interval = isPageVisible ? HEARTBEAT_INTERVAL : HIDDEN_HEARTBEAT_INTERVAL;
    heartbeatTimer = setInterval(sendHeartbeat, interval);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // 监听页面可见性变化：切换可见性时重启心跳以应用新的间隔
  document.addEventListener("visibilitychange", function() {
    isPageVisible = !document.hidden;
    startHeartbeat();
  });

  // 页面加载时启动心跳
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startHeartbeat);
  } else {
    startHeartbeat();
  }

  // 页面卸载时停止心跳
  window.addEventListener("beforeunload", function() {
    stopHeartbeat();
  });

  // 暴露到全局，方便调试
  window.HeartbeatManager = {
    start: startHeartbeat,
    stop: stopHeartbeat,
    send: sendHeartbeat
  };
})();
