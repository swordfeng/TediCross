#!/usr/bin/python3

from tgs.exporters import exporters
from tgs.importers import importers
import socketserver
import os
import atexit
import io
import sys

importer = None
exporter = None

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        exporter.process(importer.process(io.BytesIO(self.rfile.read())), self.wfile)

if __name__ == '__main__':
    importer = importers.get('lottie')
    exporter = exporters.get('gif')
    path = sys.argv[1]
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    atexit.register(os.remove, path)
    with socketserver.UnixStreamServer(path, Handler) as server:
        print('Started serving requests')
        server.serve_forever()
