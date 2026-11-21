#!/usr/bin/env python3
"""The MCP proxy outlives the app: away answers while no socket, a cut call answered, reconnect with the token."""
import json, os, socket, subprocess, sys, threading, time, signal
signal.alarm(40)

exe = sys.argv[1]
d = "/tmp/coool-host-proxytest"
os.makedirs(d, exist_ok=True)
sock = os.path.join(d, "device.sock")
if os.path.exists(sock):
    os.remove(sock)
env = dict(os.environ, COOOL_DEVICE_SOCKET=sock, COOOL_DEVICE_TOKEN="tok123")
p = subprocess.Popen([exe, "--coool-device-mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True, bufsize=1)
print("proxy pid", p.pid)

def send(m):
    p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()

def recv():
    return json.loads(p.stdout.readline())

ok = True
def check(c, what):
    global ok
    print(("PASS " if c else "FAIL ") + what)
    ok &= c

# 1. No app: a call gets the away answer, as a tool error.
send({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "x"}})
r = recv()
check(r["id"] == 1 and r["result"]["isError"] and "restarting" in r["result"]["content"][0]["text"], "away answer with no app")
send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
r = recv()
check(r["id"] == 2 and "error" in r, "rpc error for a non-call while away")

# 2. An app appears: the proxy connects, sends the token, relays.
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); srv.bind(sock); srv.listen(4)
srv.settimeout(5)
c, _ = srv.accept()
f = c.makefile("rw")
hello = json.loads(f.readline())
check(hello == {"token": "tok123"}, "token sent first on reconnect")
send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "y"}})
req = json.loads(f.readline())
check(req["id"] == 3, "call relayed to the app")
f.write(json.dumps({"jsonrpc": "2.0", "id": 3, "result": {"content": []}}) + "\n"); f.flush()
r = recv()
check(r["id"] == 3 and "isError" not in r["result"], "answer relayed back")

# 3. A call in flight when the app goes: answered with the away error.
send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "slow"}})
json.loads(f.readline())
f.close(); c.close(); srv.close(); os.remove(sock)
r = recv()
check(r["id"] == 4 and r["result"]["isError"], "cut call answered as away")

# 4. A new app that doesn't know the token yet refuses it; the proxy retries until it does.
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); srv.bind(sock); srv.listen(4); srv.settimeout(10)
c, _ = srv.accept(); f = c.makefile("rw"); f.readline()
f.write(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": "coool-device: unknown token"}}) + "\n"); f.flush(); f.close(); c.close()
c, _ = srv.accept(); f = c.makefile("rw")
check(json.loads(f.readline()) == {"token": "tok123"}, "retried after a refusal")
send({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "z"}})
check(json.loads(f.readline())["id"] == 5, "relays again after the retry")
f.write(json.dumps({"jsonrpc": "2.0", "id": 5, "result": {"content": []}}) + "\n"); f.flush()
r = recv(); print(r); check(r["id"] == 5, "answer after the retry")

p.stdin.close()
p.wait(timeout=5)
check(p.returncode == 0, "exits with the CLI's stdin")
f.close(); c.close(); srv.close(); os.remove(sock); os.rmdir(d)
sys.exit(0 if ok else 1)
