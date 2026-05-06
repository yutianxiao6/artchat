"""
后台服务生命周期管理
监控浏览器连接，无活动时自动关闭服务
"""
import time
import threading
import logging
import os
import signal

logger = logging.getLogger(__name__)

class LifecycleManager:
    def __init__(self, idle_timeout: int = 300):
        """
        Args:
            idle_timeout: 无活动连接后多少秒自动关闭（默认5分钟）
        """
        self.idle_timeout = idle_timeout
        self.last_activity = time.time()
        self.active_connections = 0
        self.shutdown_timer = None
        self.lock = threading.Lock()
        self.enabled = True

    def record_activity(self):
        """记录用户活动"""
        with self.lock:
            self.last_activity = time.time()

    def add_connection(self):
        """增加活动连接计数"""
        with self.lock:
            self.active_connections += 1
            self.last_activity = time.time()
            logger.info(f"新增连接，当前活动连接数: {self.active_connections}")

    def remove_connection(self):
        """减少活动连接计数"""
        with self.lock:
            self.active_connections = max(0, self.active_connections - 1)
            logger.info(f"连接断开，当前活动连接数: {self.active_connections}")
            if self.active_connections == 0:
                self._schedule_shutdown()

    def _schedule_shutdown(self):
        """调度关闭任务"""
        if not self.enabled:
            return

        if self.shutdown_timer:
            self.shutdown_timer.cancel()

        def check_and_shutdown():
            time.sleep(self.idle_timeout)
            with self.lock:
                if self.active_connections == 0:
                    idle_time = time.time() - self.last_activity
                    if idle_time >= self.idle_timeout:
                        logger.info(f"无活动连接超过 {self.idle_timeout} 秒，自动关闭服务")
                        self._shutdown_server()

        self.shutdown_timer = threading.Thread(target=check_and_shutdown, daemon=True)
        self.shutdown_timer.start()

    def _shutdown_server(self):
        """关闭服务器"""
        try:
            # 发送 SIGTERM 信号给当前进程
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception as e:
            logger.error(f"关闭服务失败: {e}")

    def disable(self):
        """禁用自动关闭功能"""
        self.enabled = False
        if self.shutdown_timer:
            self.shutdown_timer.cancel()

# 全局实例
lifecycle_manager = LifecycleManager(idle_timeout=5)  # 5秒无活动自动关闭（允许1次心跳丢失）
