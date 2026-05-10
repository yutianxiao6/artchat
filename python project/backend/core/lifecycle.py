"""
后台服务生命周期管理
基于"最后活动时间"的心跳窗口：后台线程定期检查，超时自动关闭。
"""
import time
import threading
import logging
import os
import signal

logger = logging.getLogger(__name__)


class LifecycleManager:
    def __init__(self, idle_timeout: int = 60, grace_period: int = 20, check_interval: int = 5):
        """
        Args:
            idle_timeout: 最后一次活动后多少秒判定为闲置并关闭
            grace_period: 启动后的宽限期（秒），该段时间内即使没心跳也不关
            check_interval: 后台检查线程的轮询间隔
        """
        self.idle_timeout = idle_timeout
        self.grace_period = grace_period
        self.check_interval = check_interval
        self.started_at = time.time()
        self.last_activity = time.time()
        self.lock = threading.Lock()
        self.enabled = True
        self._watcher_started = False

    def record_activity(self):
        with self.lock:
            self.last_activity = time.time()

    def start_watcher(self):
        """启动后台监控线程（只启动一次）。"""
        with self.lock:
            if self._watcher_started or not self.enabled:
                return
            self._watcher_started = True
        t = threading.Thread(target=self._watch_loop, daemon=True)
        t.start()
        logger.info(
            f"lifecycle watcher started: idle_timeout={self.idle_timeout}s "
            f"grace={self.grace_period}s interval={self.check_interval}s"
        )

    def _watch_loop(self):
        while True:
            time.sleep(self.check_interval)
            with self.lock:
                if not self.enabled:
                    return
                now = time.time()
                if now - self.started_at < self.grace_period:
                    continue
                idle = now - self.last_activity
                if idle >= self.idle_timeout:
                    logger.info(f"无活动 {idle:.0f}s 超过 {self.idle_timeout}s，关闭服务")
                    self._shutdown_server()
                    return

    def _shutdown_server(self):
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception as e:
            logger.error(f"关闭服务失败: {e}")

    def disable(self):
        with self.lock:
            self.enabled = False


# 全局实例：心跳 30s 一次，允许丢 1 次
lifecycle_manager = LifecycleManager(idle_timeout=75, grace_period=30, check_interval=10)
