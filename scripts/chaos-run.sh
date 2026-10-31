#!/bin/bash
# Day 5 chaos runs against the live stack. Prints a summary at the end.
set -u
ROOT=/Users/praneetkumardutta/Desktop/Code/dispatch-engine
cd "$ROOT"
psql() { docker compose exec -T postgres psql -U dispatch -tA -c "$1"; }
rcli() { docker compose exec -T redis redis-cli "$@"; }
stop_app() { for pid in $(pgrep -f "src/index.ts"); do cwd=$(lsof -a -d cwd -p $pid 2>/dev/null | awk 'NR==2{print $NF}'); case "$cwd" in *apps/$1) kill ${2:-} $pid 2>/dev/null;; esac; done; }
start_app() { (cd "apps/$1" && shift && env "$@" nohup pnpm start >> "/tmp/claude-$APP.log" 2>&1 &); }
stamp() { echo "[$(date +%H:%M:%S)] $*"; }

# --- fresh start -------------------------------------------------------------
for a in simulator dispatcher api; do stop_app $a; done
sleep 2
psql "TRUNCATE requests, request_events, offers" >/dev/null
rcli FLUSHDB >/dev/null
: > /tmp/claude-api.log; : > /tmp/claude-dispatcher.log; : > /tmp/claude-simulator.log
APP=api start_app api LOG_LEVEL=warn
APP=dispatcher start_app dispatcher LOG_LEVEL=warn
sleep 5
APP=simulator start_app simulator CALLS_PER_MIN=40 CHAOS_KILL_AT_SEC=120 CHAOS_KILL_PCT=0.1 CHAOS_DROP_PCT=0.02 CHAOS_DELAY_PCT=0.02 CHAOS_DELAY_MS=8000
stamp "stack up, warming for 120 s (kill at t=120 s)"

# --- run A: kill 10% of unit devices under load --------------------------------
sleep 118
DRIVING_BEFORE=$(psql "SELECT count(*) FROM requests WHERE state IN ('ASSIGNED','EN_ROUTE')")
stamp "just before kill: $DRIVING_BEFORE calls with a unit driving to them"
sleep 4
grep 'CHAOS' /tmp/claude-simulator.log | tail -1
stamp "waiting 60 s for heartbeats to expire (15 s) and the sweeper to react (every 5 s)"
sleep 60
REASSIGNED=$(psql "SELECT count(*) FROM request_events WHERE reason LIKE '%went silent%'")
# Calls still pointing at a unit with no heartbeat = stuck. Must be 0.
STUCK=0
for agent in $(psql "SELECT assigned_agent_id FROM requests WHERE state IN ('ASSIGNED','EN_ROUTE')"); do
  [ "$(rcli EXISTS agent:$agent:hb)" = "0" ] && STUCK=$((STUCK+1))
done
OFFLINE=$(rcli HVALS agents:status | grep -c OFFLINE)
REASSIGNED_NOW_COVERED=$(psql "SELECT count(*) FROM requests r WHERE EXISTS (SELECT 1 FROM request_events e WHERE e.request_id=r.id AND e.reason LIKE '%went silent%') AND r.state IN ('OFFERED','ASSIGNED','EN_ROUTE','ARRIVED','COMPLETED')")
REASSIGN_DELAY=$(psql "SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s)::numeric,1) || ' s p50 / ' || round(max(s)::numeric,1) || ' s max' FROM (SELECT extract(epoch FROM (n.at - e.at)) s FROM request_events e JOIN LATERAL (SELECT at FROM request_events n WHERE n.request_id=e.request_id AND n.id>e.id AND n.to_state='OFFERED' ORDER BY n.id LIMIT 1) n ON true WHERE e.reason LIKE '%went silent%') t")
stamp "RUN A: reassigned=$REASSIGNED, re-offered/covered=$REASSIGNED_NOW_COVERED, stuck-with-dead-unit=$STUCK, units OFFLINE=$OFFLINE, lost-unit→new-offer: $REASSIGN_DELAY"
grep 'sweeper repaired' /tmp/claude-dispatcher.log | head -3

# --- run B: kill -9 the dispatcher mid-load, restart after 20 s ----------------
stamp "RUN B: kill -9 dispatcher"
stop_app dispatcher -9
sleep 20
CREATED_WHILE_DOWN=$(psql "SELECT count(*) FROM requests WHERE state='CREATED'")
PENDING_WHILE_DOWN=$(psql "SELECT count(*) FROM offers WHERE outcome='PENDING'")
stamp "dispatcher down 20 s: $CREATED_WHILE_DOWN calls waiting in CREATED, $PENDING_WHILE_DOWN offers pending"
APP=dispatcher start_app dispatcher LOG_LEVEL=warn
stamp "dispatcher restarted; waiting 50 s"
sleep 50
STALE_CREATED=$(psql "SELECT count(*) FROM requests WHERE state='CREATED' AND created_at < now() - interval '30 seconds'")
STALE_MATCHING=$(psql "SELECT count(*) FROM requests WHERE state='MATCHING' AND updated_at < now() - interval '30 seconds'")
OVERDUE=$(psql "SELECT count(*) FROM offers WHERE outcome='PENDING' AND expires_at < now() - interval '10 seconds'")
DOUBLE=$(psql "SELECT count(*) FROM (SELECT assigned_agent_id FROM requests WHERE state IN ('ASSIGNED','EN_ROUTE','ARRIVED') GROUP BY 1 HAVING count(*)>1) d")
EXPIRED=$(psql "SELECT count(*) FROM requests WHERE state='EXPIRED'")
stamp "RUN B after restart: stuck CREATED>30s=$STALE_CREATED, stuck MATCHING>30s=$STALE_MATCHING, overdue offers=$OVERDUE, units on 2 live calls=$DOUBLE, expired calls=$EXPIRED"
echo "--- final"
psql "SELECT state, count(*) FROM requests GROUP BY 1 ORDER BY 1"
tail -1 /tmp/claude-dispatcher.log | cut -c1-400
grep -c '"job failed"' /tmp/claude-dispatcher.log | xargs echo "failed jobs logged:"
grep '"job failed"' /tmp/claude-dispatcher.log | head -3 | cut -c1-300
