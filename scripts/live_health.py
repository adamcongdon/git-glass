import json, socket, subprocess, sys, time, urllib.request

health, port, root = sys.argv[1], int(sys.argv[2]), sys.argv[3]

def listening(p: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", p)) == 0

def fetch(url: str, timeout: float = 5.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, r.read().decode()

if not listening(port):
    print(f"== starting git-glass on :{port} ==")
    started = subprocess.Popen(
        ["bun", "run", "start"],
        cwd=root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        if listening(port):
            break
        if started.poll() is not None:
            err = started.stderr.read().decode() if started.stderr else ""
            sys.exit(f"server exited before listen: {err[-500:]}")
        time.sleep(0.2)
    else:
        started.terminate()
        sys.exit("server did not listen within 15s")

status, body = fetch(health)
print(f"== live {health} ==")
print(status, body)
if status != 200:
    sys.exit(f"health status {status}")
data = json.loads(body)
if data.get("ok") is not True:
    sys.exit(f"health body not ok: {body}")

status, html = fetch(f"http://127.0.0.1:{port}/")
if status != 200 or "<title>Git Glass</title>" not in html:
    sys.exit("GET / did not serve Git Glass shell")
print("== GET / Git Glass shell ok ==")
print("verify: PASS")
