#!/usr/bin/env bash
# suno-api 一键 重新编译 + 后台启动 + 日志查看
#
# 用法:
#   ./deploy.sh          # 重新编译并启动（默认）
#   ./deploy.sh build    # 仅重新编译
#   ./deploy.sh start    # 仅启动（不重新编译）
#   ./deploy.sh logs     # 实时查看日志（Ctrl+C 退出）
#   ./deploy.sh stop     # 停止服务
#   ./deploy.sh status   # 查看运行状态
#   ./deploy.sh restart  # 停止 + 重新编译 + 启动

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/app.log"
ERR_FILE="$LOG_DIR/app-err.log"
PID_FILE="$ROOT/.suno-api.pid"
PORT=8005

red()  { echo -e "\033[0;31m$*\033[0m"; }
green(){ echo -e "\033[0;32m$*\033[0m"; }
cyan() { echo -e "\033[0;36m$*\033[0m"; }
step() { echo; cyan "[$(date '+%H:%M:%S')] $*"; }

get_env_value() {
    local key="$1"
    local value="${!key:-}"
    if [ -z "$value" ] && [ -f "$ROOT/.env" ]; then
        value=$(grep -E "^${key}=" "$ROOT/.env" | tail -1 | cut -d '=' -f2- | tr -d '"' | tr -d "'")
    fi
    echo "$value"
}

start_command() {
    if [ "$(get_env_value BROWSER_HEADLESS)" = "false" ]; then
        if ! command -v xvfb-run >/dev/null 2>&1; then
            red "BROWSER_HEADLESS=false 需要安装 xvfb：sudo apt-get update && sudo apt-get install -y xvfb"
            exit 1
        fi
        echo "xvfb-run -a npm run start"
        return
    fi
    echo "npm run start"
}

# ── 停止服务 ──────────────────────────────────────────
do_stop() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            step "停止旧进程 (PID: $PID)..."
            kill "$PID" && sleep 1
        fi
        rm -f "$PID_FILE"
    fi
    # 兜底：释放端口
    PORTPID=$(lsof -ti tcp:"$PORT" 2>/dev/null | head -1)
    if [ -n "$PORTPID" ]; then
        kill -9 "$PORTPID" 2>/dev/null || true
    fi
}

# ── 状态 ──────────────────────────────────────────────
do_status() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            green "运行中 (PID: $PID)"
        else
            red "进程已退出（PID 文件残留: $PID）"
        fi
    else
        red "未运行"
    fi
}

# ── 编译 ──────────────────────────────────────────────
do_build() {
    cd "$ROOT"
    step "安装依赖..."
    npm install
    step "编译项目..."
    npm run build
    green "编译成功 ✓"
}

# ── 启动 ──────────────────────────────────────────────
do_start() {
    cd "$ROOT"
    step "停止旧实例..."
    do_stop

    mkdir -p "$LOG_DIR"

    CMD="$(start_command)"
    step "在后台启动 suno-api（端口 $PORT）：$CMD"
    nohup bash -lc "$CMD" >"$LOG_FILE" 2>"$ERR_FILE" &
    echo $! > "$PID_FILE"
    green "启动成功 ✓  PID: $(cat "$PID_FILE")"
    echo
    echo "  查看日志：  ./deploy.sh logs"
    echo "  停止服务：  ./deploy.sh stop"
    echo "  访问地址：  http://localhost:$PORT"
    echo "  API 文档：  http://localhost:$PORT/docs"
    echo

    # 等几秒后打印启动日志
    sleep 3
    if [ -f "$LOG_FILE" ]; then
        echo "──── 最新日志 ────"
        tail -10 "$LOG_FILE"
        echo "──────────────────"
    fi
}

# ── 查看日志 ─────────────────────────────────────────
do_logs() {
    if [ ! -f "$LOG_FILE" ]; then
        red "日志文件不存在: $LOG_FILE"
        exit 1
    fi
    cyan "实时跟踪日志（Ctrl+C 退出）：$LOG_FILE"
    echo
    # -n 0：只跟新日志、不回读历史，避免历史中的超长单行被 tail 整行读入内存而触发 OOM 被杀
    # -F：日志被轮转/重建后仍能继续跟随
    tail -n 0 -F "$LOG_FILE"
}

# ── 入口 ─────────────────────────────────────────────
CMD="${1:-deploy}"

case "$CMD" in
    build)   do_build ;;
    start)   do_start ;;
    stop)    do_stop;   green "已停止。" ;;
    status)  do_status ;;
    logs)    do_logs ;;
    restart) do_build; do_stop; do_start ;;
    deploy)  do_build; do_stop; do_start ;;
    *)
        echo "未知命令: $CMD"
        echo "用法: ./deploy.sh [build|start|stop|status|logs|restart|deploy]"
        exit 1
        ;;
esac
