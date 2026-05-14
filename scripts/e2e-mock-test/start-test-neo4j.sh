#!/usr/bin/env bash
# 给 e2e-mock-test 起一个隔离 Neo4j Docker 容器(端口 7688,避开本机 7687)。
# 凭证硬编码在 run-all.ts 里。
#
# 用法:
#   scripts/e2e-mock-test/start-test-neo4j.sh         # 启动 + 等就绪
#   scripts/e2e-mock-test/start-test-neo4j.sh stop    # 停 + 删容器
#   scripts/e2e-mock-test/start-test-neo4j.sh logs    # 看日志
set -euo pipefail

NAME="e2e-test-neo4j"
PORT_BOLT=7688
PORT_HTTP=7475
PASSWORD="testpassword123"

case "${1:-start}" in
  start)
    if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
      echo "[neo4j-test] already running"
      exit 0
    fi
    if docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
      docker start "$NAME"
    else
      docker run -d --name "$NAME" \
        -p ${PORT_BOLT}:7687 \
        -p ${PORT_HTTP}:7474 \
        -e "NEO4J_AUTH=neo4j/${PASSWORD}" \
        neo4j:5
    fi
    echo "[neo4j-test] waiting for bolt port ${PORT_BOLT} to accept ..."
    for _ in $(seq 1 30); do
      if nc -z localhost ${PORT_BOLT} 2>/dev/null; then
        echo "[neo4j-test] ready"
        echo "  bolt: bolt://localhost:${PORT_BOLT}"
        echo "  http: http://localhost:${PORT_HTTP}"
        echo "  auth: neo4j / ${PASSWORD}"
        exit 0
      fi
      sleep 1
    done
    echo "[neo4j-test] timed out waiting"
    exit 1
    ;;
  stop)
    if docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
      docker stop "$NAME" || true
      docker rm "$NAME" || true
    fi
    echo "[neo4j-test] stopped"
    ;;
  logs)
    docker logs -f "$NAME"
    ;;
  *)
    echo "usage: $0 {start|stop|logs}"
    exit 2
    ;;
esac
