/**
 * heartbeat.js - 前端心跳机制
 * 定期向后端发送心跳请求，保持连接活跃
 * 当页面关闭或长时间无活动时，后端会自动关闭
 */
(function() {
  "use strict";

  var HEARTBEAT_INTERVAL = 3000; // 3秒发送一次心跳
  var heartbeatTimer = null;
  var isPageVisible = true;

  function sendHeartbeat() {
    // 只在页面可见时发送心跳
    if (!isPageVisible) {
      return;
    }

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

    // 定期发送
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // 监听页面可见性变化
  document.addEventListener("visibilitychange", function() {
    isPageVisible = !document.hidden;

    if (isPageVisible) {
      console.log("页面可见，启动心跳");
      startHeartbeat();
    } else {
      console.log("页面隐藏，停止心跳");
      stopHeartbeat();
    }
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
