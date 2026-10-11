#!/usr/bin/env python3
"""Serve the original application with an isolated local preview bootstrap."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
from urllib.parse import unquote

PREVIEW_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = PREVIEW_ROOT.parent / "trade-order-system"


class PreviewHandler(SimpleHTTPRequestHandler):
    seed_path = PREVIEW_ROOT / "seed.json"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "connect-src 'self'; worker-src 'none'")
        super().end_headers()

    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0])
        if "\\" in path or "\x00" in path or any(part in ("..", ".") for part in path.split("/")):
            self.send_error(404, "File not found")
            return
        if path in ("/", "/index.html"):
            html = (SOURCE_ROOT / "index.html").read_text(encoding="utf-8")
            html = re.sub(r"connect-src [^;]*;", "connect-src 'self';", html)
            html = html.replace(
                "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
                "/__preview/vendor/chart.umd.min.js",
            ).replace(
                "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
                "/__preview/vendor/xlsx.full.min.js",
            )
            html = re.sub(r'\s*<script src="js/cloudbase-sdk\.js[^\"]*"></script>', "", html)
            html = re.sub(
                r'<script type="module">.*?</script>',
                '<script type="module" src="/__preview/bootstrap.js"></script>',
                html,
                flags=re.DOTALL,
            )
            html = re.sub(r'<script type="module" src="js/backend-bootstrap[^"]*"></script>', '<script type="module" src="/__preview/bootstrap.js"></script>', html)
            self.send_content(html.encode("utf-8"), "text/html; charset=utf-8")
            return
        preview_files = {
            "/__preview/bootstrap.js": ("bootstrap.js", "text/javascript; charset=utf-8"),
            "/__preview/vendor/chart.umd.min.js": ("vendor/chart.umd.min.js", "text/javascript; charset=utf-8"),
            "/__preview/vendor/xlsx.full.min.js": ("vendor/xlsx.full.min.js", "text/javascript; charset=utf-8"),
        }
        if path.startswith('/vendor/'):
            name = path.rsplit('/', 1)[-1]
            if name in ('chart.umd.min.js', 'xlsx.full.min.js'):
                self.send_content((PREVIEW_ROOT / 'vendor' / name).read_bytes(), 'text/javascript; charset=utf-8')
                return
        if path == "/__preview/seed.json":
            self.send_content(self.seed_path.read_bytes(), "application/json; charset=utf-8")
            return
        if path in preview_files:
            filename, content_type = preview_files[path]
            self.send_content((PREVIEW_ROOT / filename).read_bytes(), content_type)
            return
        if path == "/sw.js":
            self.send_error(404, "Service workers are disabled in local preview")
            return
        allowed = (
            path == "/manifest.json"
            or (path.startswith("/css/") and Path(path).suffix == ".css")
            or (path.startswith("/js/") and Path(path).suffix == ".js" and path not in ("/js/cloudbase-sdk.js", "/js/tcb.js"))
            or (path.startswith("/assets/") and Path(path).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".gif"))
        )
        if not allowed:
            self.send_error(404, "File not found")
            return
        super().do_GET()

    def send_content(self, content, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3086)
    parser.add_argument("--dataset", choices=("auto", "cloudbase", "example"), default="auto")
    args = parser.parse_args()
    cloud_seed = PREVIEW_ROOT / "data" / "current" / "seed.json"
    if args.dataset == "cloudbase" and not cloud_seed.is_file():
        parser.error("No imported CloudBase snapshot. Run import_cloudbase_snapshot.py first.")
    if args.dataset == "cloudbase" or (args.dataset == "auto" and cloud_seed.is_file()):
        PreviewHandler.seed_path = cloud_seed
    handler = partial(PreviewHandler, directory=str(SOURCE_ROOT))
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Local preview: http://127.0.0.1:{args.port}", flush=True)
        print(f"Original source: {SOURCE_ROOT}", flush=True)
        print(f"Local seed: {PreviewHandler.seed_path}", flush=True)
        print("Data stays in the browser. CloudBase requests are blocked.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
