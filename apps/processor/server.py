"""Internal container API: one serialized full refresh job per request."""
import json
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

from job import refresh


class Handler(BaseHTTPRequestHandler):
    def respond(self, body, status=200):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            # A timed-out Workflow request may disconnect after publication; retries are idempotent.
            pass

    def do_POST(self):
        if urlparse(self.path).path != "/refresh":
            self.respond({"error": "Not found"}, 404)
            return
        try:
            size = int(self.headers["Content-Length"])
            body = json.loads(self.rfile.read(size))
            self.respond(refresh(body.get("cutoff"), body.get("window")))
        except Exception as error:
            traceback.print_exc()
            self.respond({"error": f"{type(error).__name__}: {error}"}, 502)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self.respond({"ok": True, "source": "dynamical.org"})
        else:
            self.respond({"error": "Not found"}, 404)


if __name__ == "__main__":
    # HTTPServer deliberately serializes jobs, preventing overlapping publication from this container.
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
