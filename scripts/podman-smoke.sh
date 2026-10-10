#!/usr/bin/env bash
# Real-Podman validation of the nanoclaw session topology. NOT run in CI; used
# on the server for Spike A/B. Needs the podman group (or root) and local images
# `busybox` and `alpine` (podman pulls them if the host has registry access).
#
# Builds the same shape the PodmanSessionDriver builds:
#   nanogate-svc (internal)  <-  relay (busybox nc stand-in)  ->  session net (internal, isolate)  <-  agent
# and asserts that the agent reaches relay-alias:8080 but NOT 1.1.1.1, the host
# IP, or the AWG gateway 10.201.0.1.
#
# Also asserts (as the driver sets them up): the agent cgroup sits under nanoclaw.slice
# (--cgroup-parent), /etc/hosts has localhost but no host.containers.internal (--no-hosts),
# the relay alias resolves through aardvark to an address on the session subnet, and, when a
# node image is available (NODE_IMAGE, default docker.io/library/node:22-alpine), that
# `fetch('https://example.com')` works with NODE_USE_ENV_PROXY=1 + HTTPS_PROXY through a CONNECT
# stand-in relay (svc net + a NAT uplink). That last block needs internet on the host.
#
# usage: scripts/podman-smoke.sh [--host-ip <ip>]
set -uo pipefail

PODMAN="${PODMAN:-podman --remote --url ${NANOCLAW_PODMAN_URL:-unix:///run/podman/podman.sock}}"
SVC_NET="${SVC_NET:-smoke-nanogate-svc}"
SVC_SUBNET="${SVC_SUBNET:-10.91.250.0/28}"
SESSION_NET="smoke-session"
SESSION_SUBNET="${SESSION_SUBNET:-10.90.250.0/28}"
RELAY="smoke-relay"
AGENT="smoke-agent"
PROXY="smoke-proxy"
NODE_AGENT="smoke-node-agent"
NODE_IMAGE="${NODE_IMAGE:-docker.io/library/node:22-alpine}"
CGROUP_PARENT="${SMOKE_CGROUP_PARENT:-nanoclaw.slice}"
HOST_IP="${HOST_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)}"
[ "${1:-}" = "--host-ip" ] && HOST_IP="$2"

pass=0; fail=0
ok()   { echo "PASS  $*"; pass=$((pass+1)); }
bad()  { echo "FAIL  $*"; fail=$((fail+1)); }

cleanup() {
  $PODMAN rm --force "$NODE_AGENT" "$PROXY" "$AGENT" "$RELAY" >/dev/null 2>&1
  $PODMAN network rm "$SESSION_NET" "$SVC_NET" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

set -e
# the "nanogate-svc" uplink: internal, no route out
$PODMAN network create --internal --subnet "$SVC_SUBNET" "$SVC_NET" >/dev/null
# the session network, exactly as the driver creates it
$PODMAN network create --internal --opt isolate=true --subnet "$SESSION_SUBNET" "$SESSION_NET" >/dev/null

# relay: uplink on the svc net, then joined to the session net under its alias
$PODMAN create --rm --name "$RELAY" --cap-drop=ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp:rw,size=16m --memory 64m --cpus 0.25 --pids-limit 64 \
  --network "$SVC_NET" busybox sh -c 'while true; do echo ok | nc -l -p 8080; done' >/dev/null
$PODMAN network connect --alias nanorelay "$SESSION_NET" "$RELAY"
$PODMAN start "$RELAY" >/dev/null

# agent: only the session network
$PODMAN create --rm --name "$AGENT" --cap-drop=ALL --security-opt no-new-privileges --init \
  --cgroup-parent "$CGROUP_PARENT" --no-hosts \
  --tmpfs /tmp:rw,size=64m --network "$SESSION_NET" alpine sleep 120 >/dev/null
$PODMAN start "$AGENT" >/dev/null
set +e

echo "--- topology"
nets="$($PODMAN inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$AGENT")"
[ "$(echo $nets)" = "$SESSION_NET" ] && ok "agent is on exactly the session network ($nets)" || bad "agent networks: $nets"
$PODMAN network inspect "$SESSION_NET" --format '{{.Internal}} {{index .Options "isolate"}}' | grep -q '^true ' \
  && ok "session network is internal + isolated" || bad "session network not internal/isolated"

echo "--- cgroup, /etc/hosts, DNS"
cgp="$($PODMAN inspect --format '{{.HostConfig.CgroupParent}}' "$AGENT")"
[ "$cgp" = "$CGROUP_PARENT" ] && ok "agent cgroup parent is $cgp" || bad "agent cgroup parent is '$cgp', expected $CGROUP_PARENT"
cid="$($PODMAN inspect --format '{{.Id}}' "$AGENT")"
if [ -d "/sys/fs/cgroup/$CGROUP_PARENT" ]; then
  [ -n "$(find "/sys/fs/cgroup/$CGROUP_PARENT" -maxdepth 3 -name "*$cid*" 2>/dev/null | head -1)" ] \
    && ok "agent container cgroup is under /sys/fs/cgroup/$CGROUP_PARENT" \
    || bad "no cgroup of $cid under /sys/fs/cgroup/$CGROUP_PARENT (container not in the slice)"
else
  echo "SKIP  /sys/fs/cgroup/$CGROUP_PARENT not visible here (run on the server)"
fi
hosts="$($PODMAN exec "$AGENT" cat /etc/hosts 2>/dev/null)"
echo "$hosts" | grep -q 'localhost' && ok "/etc/hosts has localhost" || bad "/etc/hosts lacks localhost"
echo "$hosts" | grep -q 'host.containers.internal' && bad "/etc/hosts names host.containers.internal" || ok "/etc/hosts has no host.containers.internal"
relay_ip="$($PODMAN exec "$AGENT" sh -c 'getent hosts nanorelay' 2>/dev/null | awk '{print $1}' | head -1)"
case "$relay_ip" in
  10.90.250.*) ok "nanorelay alias resolves on the --internal network ($relay_ip)" ;;
  *) bad "nanorelay alias did not resolve to the session subnet (got '${relay_ip}')" ;;
esac

echo "--- reachability from the agent"
# DNS: aardvark on an internal network is the open question the smoke test answers.
$PODMAN exec "$AGENT" sh -c 'nc -w 3 nanorelay 8080 </dev/null' 2>/dev/null | grep -q ok \
  && ok "agent reaches nanorelay:8080 (alias resolves, relay answers)" \
  || bad "agent cannot reach nanorelay:8080 (is dns_enabled false on internal networks?)"

deny() {  # deny <description> <host> <port>
  if $PODMAN exec "$AGENT" sh -c "nc -w 3 -z $2 $3" >/dev/null 2>&1; then bad "agent REACHED $1 ($2:$3)"; else ok "agent cannot reach $1 ($2:$3)"; fi
}
deny "the internet" 1.1.1.1 443
deny "the AWG gateway" 10.201.0.1 22
[ -n "$HOST_IP" ] && deny "the host IP" "$HOST_IP" 22 || echo "SKIP  host IP unknown (pass --host-ip)"
deny "the svc network gateway/other subnets" 10.91.250.1 8080

echo "--- relay reaches the svc side, not the world"
$PODMAN exec "$RELAY" sh -c 'nc -w 3 -z 1.1.1.1 443' >/dev/null 2>&1 \
  && bad "relay reached the internet via the internal svc net" || ok "relay has no direct internet (svc net is internal)"

echo "--- node fetch through the relay (NODE_USE_ENV_PROXY=1)"
if $PODMAN image exists "$NODE_IMAGE" 2>/dev/null || $PODMAN pull -q "$NODE_IMAGE" >/dev/null 2>&1; then
  set -e
  # CONNECT stand-in for nanorelay -> nanogate: svc net (internal) + the default NAT bridge as "internet"
  $PODMAN create --rm --name "$PROXY" --cap-drop=ALL --security-opt no-new-privileges --network "$SVC_NET" "$NODE_IMAGE" node -e "
const net=require('net');
require('http').createServer((q,r)=>{r.writeHead(405);r.end()}).on('connect',(q,s,h)=>{
  const i=q.url.lastIndexOf(':');const u=net.connect(+q.url.slice(i+1)||443,q.url.slice(0,i),()=>{s.write('HTTP/1.1 200 OK\\r\\n\\r\\n');u.write(h);u.pipe(s);s.pipe(u)});
  u.on('error',()=>s.destroy());s.on('error',()=>u.destroy());
}).listen(3128)" >/dev/null
  $PODMAN network connect --alias nanorelay-proxy "$SESSION_NET" "$PROXY"
  $PODMAN network connect podman "$PROXY"
  $PODMAN start "$PROXY" >/dev/null
  $PODMAN create --rm --name "$NODE_AGENT" --cap-drop=ALL --security-opt no-new-privileges --init \
    --cgroup-parent "$CGROUP_PARENT" --no-hosts --tmpfs /tmp:rw,size=64m --network "$SESSION_NET" \
    -e NODE_USE_ENV_PROXY=1 -e HTTPS_PROXY=http://nanorelay-proxy:3128 -e HTTP_PROXY=http://nanorelay-proxy:3128 \
    "$NODE_IMAGE" sleep 120 >/dev/null
  $PODMAN start "$NODE_AGENT" >/dev/null
  set +e
  sleep 2
  out="$($PODMAN exec "$NODE_AGENT" node -e "fetch('https://example.com').then(r=>r.text()).then(t=>{console.log(/Example Domain/.test(t)?'FETCH_OK':'FETCH_BAD');}).catch(e=>{console.log('FETCH_ERR '+(e.cause&&e.cause.code||e.message))})" 2>&1)"
  echo "$out" | grep -q FETCH_OK && ok "node fetch https://example.com works via HTTPS_PROXY (NODE_USE_ENV_PROXY=1)" || bad "node fetch through the relay failed: $out"
  out="$($PODMAN exec -e NODE_USE_ENV_PROXY= "$NODE_AGENT" node -e "fetch('https://example.com').then(()=>console.log('DIRECT_OK')).catch(e=>console.log('DIRECT_ERR'))" 2>&1)"
  echo "$out" | grep -q DIRECT_OK && bad "node reached the internet WITHOUT the proxy flag" || ok "node without the proxy flag cannot reach the internet (internal net)"
else
  echo "SKIP  node image $NODE_IMAGE unavailable (set NODE_IMAGE)"
fi

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
