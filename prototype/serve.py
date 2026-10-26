"""Local-only, dependency-free server for the throwaway Hejian prototype."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class PrototypeHandler(SimpleHTTPRequestHandler):
    # Windows registry may map SVG to image/svg; nosniff browsers require SVG XML.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".svg": "image/svg+xml"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    server = ThreadingHTTPServer(("127.0.0.1", 4173), partial(PrototypeHandler, directory=str(root)))
    print("Hejian prototype: http://127.0.0.1:4173/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
