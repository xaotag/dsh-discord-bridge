#!/usr/bin/env bash
#
# install-privd.sh — 安装 dsh-privd（DSH 提权执行器）
#
# 只需执行一次：sudo ./install-privd.sh
#
# 做四件事：
#   1. 生成 HMAC 共享密钥（DSH 侧与守护进程共用）
#   2. 安装守护进程到 /usr/local/lib/dsh-privd/
#   3. 安装并启用 systemd 服务（以 root 运行）
#   4. 建立请求队列目录并设置权限
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$*"; }
err()  { printf "${RED}✗${NC} %s\n" "$*"; }
info() { printf "${BLUE}·${NC} %s\n" "$*"; }
head2(){ printf "\n${BLUE}==> %s${NC}\n" "$*"; }

DSH_USER="${DSH_USER:-ecs-user}"
DSH_HOME_DIR="${DSH_HOME_DIR:-/home/${DSH_USER}/.dsh}"
PRIV_ROOT="${DSH_HOME_DIR}/privileged"
INSTALL_DIR="/usr/local/lib/dsh-privd"
SERVICE_NAME="dsh-privd"
NODE_BIN="$(command -v node || true)"

# ---------------------------------------------------------------- 前置检查

head2 "前置检查"

if [ "$(id -u)" -ne 0 ]; then
  err "必须以 root 运行：sudo $0"
  exit 1
fi
ok "以 root 运行"

if [ -z "$NODE_BIN" ]; then
  err "未找到 node，请先安装 Node.js"
  exit 1
fi
ok "node: $NODE_BIN ($($NODE_BIN -v))"

if ! id "$DSH_USER" >/dev/null 2>&1; then
  err "用户不存在: $DSH_USER"
  exit 1
fi
ok "目标用户: $DSH_USER"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIVD_SRC="${SCRIPT_DIR}/dsh-privd.cjs"
if [ ! -f "$PRIVD_SRC" ]; then
  err "找不到守护进程源码: $PRIVD_SRC"
  exit 1
fi
ok "守护进程源码: $PRIVD_SRC"

if [ -d "$PRIV_ROOT" ]; then
  warn "已存在 $PRIV_ROOT —— 将复用现有配置"
fi

# ---------------------------------------------------------------- 目录与密钥

head2 "建立请求队列目录"

install -d -m 0750 -o "$DSH_USER" -g "$DSH_USER" "$PRIV_ROOT"
install -d -m 0700 -o root -g root "$PRIV_ROOT/queue"
install -d -m 0700 -o root -g root "$PRIV_ROOT/work"
install -d -m 0755 -o "$DSH_USER" -g "$DSH_USER" "$PRIV_ROOT/done"

# 队列必须由 root 拥有、DSH 用户可写：用 0750 + 组权限不如直接给用户写权限
chmod 0730 "$PRIV_ROOT/queue"
chown root:"$DSH_USER" "$PRIV_ROOT/queue"
chmod 0700 "$PRIV_ROOT/work"
chown root:root "$PRIV_ROOT/work"
chmod 0755 "$PRIV_ROOT/done"
chown "$DSH_USER":"$DSH_USER" "$PRIV_ROOT/done"

ok "queue/ (root:${DSH_USER} 0730) —— DSH 可写，守护进程可读"
ok "work/  (root:root 0700) —— 仅守护进程"
ok "done/  (${DSH_USER} 0755) —— DSH 可读"

head2 "共享密钥"

SECRET_FILE="$PRIV_ROOT/secret"
if [ -s "$SECRET_FILE" ]; then
  ok "密钥已存在，保留: $SECRET_FILE"
else
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$SECRET_FILE"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"
  fi
  ok "已生成 256-bit 密钥: $SECRET_FILE"
fi
chown root:"$DSH_USER" "$SECRET_FILE"
chmod 0640 "$SECRET_FILE"
ok "密钥权限: root:${DSH_USER} 0640（双方可读，其他不可读）"

AUDIT_FILE="$PRIV_ROOT/audit.jsonl"
touch "$AUDIT_FILE"
chown root:"$DSH_USER" "$AUDIT_FILE"
chmod 0640 "$AUDIT_FILE"
ok "审计日志: $AUDIT_FILE"

# ---------------------------------------------------------------- 安装守护进程

head2 "安装守护进程"

install -d -m 0755 "$INSTALL_DIR"
install -m 0755 "$PRIVD_SRC" "$INSTALL_DIR/dsh-privd.cjs"
ok "已安装: $INSTALL_DIR/dsh-privd.cjs"

# ---------------------------------------------------------------- systemd

head2 "安装 systemd 服务"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=DSH privileged executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${INSTALL_DIR}/dsh-privd.cjs
Environment=DSH_HOME=${DSH_HOME_DIR}
Environment=HOME=/root
Restart=always
RestartSec=3
# 该服务本身以 root 运行，因此无需 NoNewPrivileges；不要给它加沙箱限制，
# 否则它无法执行需要 root 的命令。
NoNewPrivileges=no
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF
ok "服务单元: /etc/systemd/system/${SERVICE_NAME}.service"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"
sleep 1

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "服务运行中"
else
  err "服务启动失败，查看日志：journalctl -u ${SERVICE_NAME} -n 30"
  exit 1
fi

# ---------------------------------------------------------------- 自检

head2 "自检"

if [ ! -r "$SECRET_FILE" ]; then
  err "密钥不可读"
  exit 1
fi

SECRET=$(cat "$SECRET_FILE")
TEST_ID="selfcheck-$(date +%s)"
TEST_CMD='id -u'
BODY=$(printf '{"channelId":"selfcheck","command":%s,"createdAt":%s,"cwd":"/","expiresAt":%s,"id":"%s","requestedBy":"install","timeoutMs":10000}' \
  "$(printf '%s' "$TEST_CMD" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
  "$(date +%s%3N)" "$(($(date +%s%3N) + 60000))" "$TEST_ID")

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex 2>/dev/null | sed 's/^.*= //')
if [ -z "$SIG" ]; then
  warn "openssl 计算签名失败，跳过自检"
else
  python3 - "$BODY" "$SIG" "$PRIV_ROOT/queue/${TEST_ID}.json" <<'PY'
import json, sys
body, sig, path = sys.argv[1], sys.argv[2], sys.argv[3]
obj = json.loads(body)
obj['sig'] = sig
# 规范化 JSON 必须与 Node 侧 canonicalize 一致：键排序、无空格
open(path, 'w').write(json.dumps(obj, sort_keys=True, separators=(',', ':')))
PY
  sleep 2
  RESULT_FILE="$PRIV_ROOT/done/${TEST_ID}.json"
  if [ -f "$RESULT_FILE" ]; then
    if grep -q '"status":"ok"' "$RESULT_FILE" && grep -q '"stdout":"0' "$RESULT_FILE"; then
      ok "自检通过：守护进程以 root 执行命令（id -u = 0）"
    else
      warn "自检返回了结果但未确认 root：$(cat "$RESULT_FILE")"
    fi
    rm -f "$RESULT_FILE"
  else
    warn "自检未在 2 秒内返回结果，查看：journalctl -u ${SERVICE_NAME} -n 20"
  fi
fi

head2 "完成"
cat <<EOF

守护进程已安装并运行。

  服务       systemctl status ${SERVICE_NAME}
  日志       journalctl -u ${SERVICE_NAME} -f
  队列       ${PRIV_ROOT}/queue
  审计       ${PRIV_ROOT}/audit.jsonl

DSH 侧用法（在 DSH 里）：
  /dsh system sudo <命令>

每次执行都会先在 Discord 发一张批准卡片，点「批准」后才会以 root 运行。

卸载：
  sudo systemctl disable --now ${SERVICE_NAME}
  sudo rm -rf /etc/systemd/system/${SERVICE_NAME}.service ${INSTALL_DIR}
  sudo systemctl daemon-reload
EOF
